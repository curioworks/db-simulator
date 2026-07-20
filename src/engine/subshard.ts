import { mulberry32 } from './prng.ts';
import type { SkewConfig, SkewModel } from './types.ts';

/**
 * Sub-sharding with step-up promotion (M8) — the mitigation.
 *
 * A wide partition is fixed in Cassandra by adding a bucket to the partition
 * key: `PRIMARY KEY ((sensor_id, shard), ts)` with `shard = hash(x) % S`. One
 * logical key becomes S physical partitions, each a fraction of the size and
 * each hashing to its own token — so the bytes land on up to S × RF nodes
 * instead of RF. It is a schema fix for two of the three verdicts at once, and
 * it moves no bytes off the cluster: total disk is exactly what it was.
 *
 * Promotion is step-up rather than a fixed S. A partition doubles its shard
 * count the moment one of its shards passes the trigger, up to the configured
 * cap, so only the keys that actually need splitting pay the read fan-out that
 * comes with it.
 *
 * The thing this must not do is pretend the fix is retroactive. Re-keying a
 * table does not move the rows already written: they stay in the partition
 * they landed in and leave only when TTL and compaction get to them. So every
 * promotion opens a *generation* — writes from that moment land in the new
 * shards while the old generation stops growing and starts draining. A
 * partition's bytes are therefore its share of writes averaged over however
 * much history the disk is still holding, not its share right now.
 *
 * That history window is measured from the disk itself (`diskBytes ÷ ingest`)
 * rather than assumed equal to the TTL, which matters because half the presets
 * here exist to show compaction stranding expired data: when disk holds 3.5×
 * the TTL's worth of writes, the old wide partition really is still there 3.5
 * TTLs later, and the window says so. With no TTL at all the window is the
 * whole run, and the arithmetic lands exactly where it should — an unpromoted
 * generation's bytes stay constant forever, so sub-sharding stops the wide
 * partition growing and never shrinks it.
 */

/**
 * Promote once a single shard passes this per-replica size. Deliberately half
 * of Cassandra's 100 MB guidance rather than at it: a mitigation that waits
 * for the warn line guarantees the warn line is crossed, and the useful
 * question is whether sub-sharding can keep a partition under it at all.
 */
export const PROMOTION_TRIGGER_BYTES = 50 * 1024 * 1024;

/**
 * One re-keying of a partition: the sub-shards writes landed in between
 * `from` and `to`. Generations are never merged or rewritten — they only age
 * out, which is the whole point.
 */
interface Generation {
  /** Epoch ms writes started landing here. */
  from: number;
  /** Epoch ms writes stopped; Infinity for the generation currently taking writes. */
  to: number;
  /** Replica sets, one per sub-shard — RF ring-consecutive node ids each. */
  shards: number[][];
}

/** Per-tick skew figures, recomputed as promotions change who holds what. */
export interface ShardTick {
  /** Per-replica bytes of the widest single sub-shard anywhere in the top K. */
  maxPartitionBytes: number;
  /** Bytes on the fullest node, and which node that is. */
  hotNodeBytes: number;
  hotNode: number;
  /** The fullest node's fraction of cluster disk — the compaction queue's arrival share. */
  hotNodeFrac: number;
  /** Sub-shards the rank-1 partition is currently writing to. */
  hotPartitionShards: number;
}

export interface SubSharder {
  /**
   * Advance to the end of a tick: recompute effective shares for the history
   * the disk is currently holding, then promote any partition whose widest
   * shard has outgrown the trigger. Promotions take effect from `now` onward,
   * so the figures returned are the ones that triggered them.
   */
  step(now: number, diskBytes: number, retentionMs: number): ShardTick;
  /** Horizon shares, replica sets and shard counts, for the returned SkewModel. */
  finalModel(): Pick<SkewModel, 'nodeShare' | 'hotReplicas' | 'subShards'>;
}

/**
 * With the mitigation off, shares never move: hand back the static M6 figures
 * and skip the machine entirely. This keeps every pre-M8 run bit-identical and
 * costs the tick loop nothing.
 */
function staticSharder(model: SkewModel, replicationFactor: number): SubSharder {
  const hotNodeFrac = Math.max(...model.nodeShare);
  const hotNode = model.nodeShare.indexOf(hotNodeFrac);
  const maxPartitionFrac = model.hotWeights[0] / replicationFactor;
  const subShards = model.hotWeights.map(() => 1);
  return {
    step: (_now, diskBytes) => ({
      maxPartitionBytes: maxPartitionFrac * diskBytes,
      hotNodeBytes: hotNodeFrac * diskBytes,
      hotNode,
      hotNodeFrac,
      hotPartitionShards: 1,
    }),
    finalModel: () => ({
      nodeShare: model.nodeShare,
      hotReplicas: model.hotReplicas,
      subShards,
    }),
  };
}

export function createSubSharder(
  config: SkewConfig,
  model: SkewModel,
  seed: number,
  startTime: number,
): SubSharder {
  const { nodes, replicationFactor: rf } = config;
  const maxSubShards = config.maxSubShards ?? 1;
  if (maxSubShards <= 1) return staticSharder(model, rf);

  // A third PRNG stream. The engine's rng drives compaction and skew.ts's
  // drives the initial placement; drawing sub-shard tokens from either would
  // shift a sequence that pre-M8 goldens pin.
  const rng = mulberry32((seed ^ 0x85ebca6b) >>> 0);
  const place = (): number[] => {
    const primary = Math.floor(rng() * nodes);
    return Array.from({ length: rf }, (_, r) => (primary + r) % nodes);
  };

  const k = model.hotWeights.length;
  // Generation 0 is the un-sharded partition: one shard, on the tokens skew.ts
  // already drew for it.
  const generations: Generation[][] = model.hotReplicas.map((replicas) => [
    { from: startTime, to: Infinity, shards: [replicas] },
  ]);
  const subShards = new Array<number>(k).fill(1);
  // Scratch, reused every tick: this runs inside the loop.
  const nodeWeight = new Array<number>(nodes).fill(0);
  const widestShard = new Array<number>(k).fill(0);
  let lastWindow = { lo: startTime, span: 1 };

  /**
   * Effective share of everything, for the window [now − retention, now].
   * A generation contributes its partition's write share in proportion to how
   * much of that window it was taking writes for, split evenly across its
   * shards. Shares still sum to 1: the generations of a partition tile the
   * window exactly, so the integral of "somebody's share" over it is 1.
   */
  const spread = (now: number, retentionMs: number) => {
    const lo = now - retentionMs;
    lastWindow = { lo, span: retentionMs };
    // The tail is every partition past the top K — individually cold, never
    // promoted, and spread evenly by its many random placements.
    nodeWeight.fill((model.tailWeight * rf) / nodes);
    for (let p = 0; p < k; p++) {
      let widest = 0;
      for (const g of generations[p]) {
        const covered = Math.min(g.to, now) - Math.max(g.from, lo);
        if (covered <= 0) continue;
        const perShard = (model.hotWeights[p] * covered) / retentionMs / g.shards.length;
        if (perShard > widest) widest = perShard;
        for (const replicas of g.shards) {
          for (const node of replicas) nodeWeight[node] += perShard;
        }
      }
      widestShard[p] = widest;
    }
  };

  return {
    step(now, diskBytes, retentionMs) {
      spread(now, retentionMs);

      let hotNode = 0;
      for (let n = 1; n < nodes; n++) if (nodeWeight[n] > nodeWeight[hotNode]) hotNode = n;
      let widest = 0;
      for (let p = 0; p < k; p++) if (widestShard[p] > widest) widest = widestShard[p];
      const hotNodeFrac = nodeWeight[hotNode] / rf;
      const tick: ShardTick = {
        maxPartitionBytes: (widest * diskBytes) / rf,
        hotNodeBytes: hotNodeFrac * diskBytes,
        hotNode,
        hotNodeFrac,
        hotPartitionShards: subShards[0],
      };

      // Step up anything that has outgrown the trigger. Doubling rather than
      // jumping straight to the cap is what makes this a *step*: each promotion
      // is re-evaluated on the next tick, so a partition takes only the shards
      // it turns out to need. At most log2(cap) promotions per partition, so
      // the generation lists stay short enough to walk every tick.
      for (let p = 0; p < k; p++) {
        if (subShards[p] >= maxSubShards) continue;
        if ((widestShard[p] * diskBytes) / rf < PROMOTION_TRIGGER_BYTES) continue;
        const next = Math.min(maxSubShards, subShards[p] * 2);
        const gens = generations[p];
        gens[gens.length - 1].to = now;
        gens.push({ from: now, to: Infinity, shards: Array.from({ length: next }, place) });
        subShards[p] = next;
      }
      return tick;
    },

    finalModel() {
      const { lo, span } = lastWindow;
      const now = lo + span;
      return {
        nodeShare: nodeWeight.map((w) => w / rf),
        // Every node still holding bytes of this partition, which after a
        // promotion is more than one replica set — the old generation has not
        // finished draining off its original nodes.
        hotReplicas: generations.map((gens) => {
          const held = new Set<number>();
          for (const g of gens) {
            if (Math.min(g.to, now) - Math.max(g.from, lo) <= 0) continue;
            for (const replicas of g.shards) for (const node of replicas) held.add(node);
          }
          return [...held].sort((a, b) => a - b);
        }),
        subShards: [...subShards],
      };
    },
  };
}
