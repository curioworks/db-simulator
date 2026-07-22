import { mulberry32 } from './prng.ts';
import { noCompaction, type CompactionStrategy } from './compaction/strategy.ts';
import { createStcs } from './compaction/stcs.ts';
import { createTwcs } from './compaction/twcs.ts';
import { buildSkewModel } from './skew.ts';
import { createSubSharder, type ShardTick } from './subshard.ts';
import { computeVerdicts } from './verdicts.ts';
import type { MetricsSnapshot, SimConfig, SimResult, SSTable } from './types.ts';

/**
 * Tick loop: accumulate memtable → flush at the threshold → age data across
 * TTL → run the compaction strategy → emit a metrics snapshot.
 *
 * Writes arrive at a continuous constant rate within a tick, so flush moments
 * are interpolated to the exact ms; this keeps minTs/maxTs honest for the
 * time-windowed strategies later (TWCS). Data + tombstone ingest share the
 * memtable; each flushed SSTable splits its bytes by the two rates.
 *
 * TTL aging assumes data inside an SSTable is uniformly distributed over
 * [minTs, maxTs] (true by construction for flushes: constant rate, contiguous
 * spans; an approximation for compacted tables, whose spans may also overlap
 * neighbours). A pointer over the minTs-ordered list skips the fully-expired
 * prefix, keeping aging amortized O(1) per tick in the flush-only case and
 * proportional to the handful of cutoff-straddling tables otherwise.
 */
export function simulate(config: SimConfig, strategy?: CompactionStrategy): SimResult {
  const { startTime, tickMs, ticks, writeRatePerSec, onDiskRowBytes, memtableFlushBytes } = config;
  const ttlMs = config.ttlMs ?? 0;
  const deleteRatePerSec = config.deleteRatePerSec ?? 0;
  const tombstoneRowBytes = config.tombstoneRowBytes ?? 0;
  const gcGraceMs = config.gcGraceMs ?? 0;
  const queryWindowMs = config.queryWindowMs ?? 86_400_000;
  const compactionCapPerSec = config.compactionThroughputBytesPerSec ?? 0;
  // Partition-key storage: charged once per partition (see SimConfig), so a flat
  // constant on the disk line, applied only while the table holds data.
  const partitionOverheadBytes = config.partitionOverheadBytes ?? 0;
  // An explicit strategy argument (tests, custom strategies) wins over the
  // serializable spec that arrives through the worker boundary.
  strategy ??=
    config.compaction?.strategy === 'stcs'
      ? createStcs(config.compaction)
      : config.compaction?.strategy === 'twcs'
        ? createTwcs(config.compaction)
        : noCompaction;

  if (tickMs <= 0) throw new RangeError(`tickMs must be > 0, got ${tickMs}`);
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative integer, got ${ticks}`);
  }
  if (writeRatePerSec < 0) throw new RangeError(`writeRatePerSec must be ≥ 0, got ${writeRatePerSec}`);
  if (onDiskRowBytes < 0) throw new RangeError(`onDiskRowBytes must be ≥ 0, got ${onDiskRowBytes}`);
  if (memtableFlushBytes <= 0) {
    throw new RangeError(`memtableFlushBytes must be > 0, got ${memtableFlushBytes}`);
  }
  if (ttlMs < 0) throw new RangeError(`ttlMs must be ≥ 0, got ${ttlMs}`);
  if (deleteRatePerSec < 0) throw new RangeError(`deleteRatePerSec must be ≥ 0, got ${deleteRatePerSec}`);
  if (tombstoneRowBytes < 0) throw new RangeError(`tombstoneRowBytes must be ≥ 0, got ${tombstoneRowBytes}`);
  if (gcGraceMs < 0) throw new RangeError(`gcGraceMs must be ≥ 0, got ${gcGraceMs}`);
  if (queryWindowMs <= 0) throw new RangeError(`queryWindowMs must be > 0, got ${queryWindowMs}`);
  if (compactionCapPerSec < 0) {
    throw new RangeError(`compactionThroughputBytesPerSec must be ≥ 0, got ${compactionCapPerSec}`);
  }
  if ((config.diskPerNodeBytes ?? 0) < 0) {
    throw new RangeError(`diskPerNodeBytes must be ≥ 0, got ${config.diskPerNodeBytes}`);
  }
  if (partitionOverheadBytes < 0) {
    throw new RangeError(`partitionOverheadBytes must be ≥ 0, got ${partitionOverheadBytes}`);
  }

  const rng = mulberry32(config.seed);
  // Skew (M6): with constant write shares and one uniform TTL, every
  // partition holds exactly its share of the totals at all times, so the
  // per-tick figures are two fixed fractions of diskBytes (see SkewModel).
  // Sub-sharding (M8) is what makes a share stop being constant, so the
  // figures come from the sub-sharder — which collapses back to exactly those
  // two fractions when the mitigation is off.
  const skew = config.skew ? buildSkewModel(config.skew, config.seed) : undefined;
  const sharder =
    skew && config.skew
      ? createSubSharder(config.skew, skew, config.seed, startTime)
      : undefined;
  const noSkew: ShardTick = {
    maxPartitionBytes: 0,
    hotNodeBytes: 0,
    hotNode: 0,
    hotNodeFrac: 0,
    hotPartitionShards: 1,
  };
  const dataPerMs = (writeRatePerSec * onDiskRowBytes) / 1000;
  const tombPerMs = (deleteRatePerSec * tombstoneRowBytes) / 1000;
  const bytesPerMs = dataPerMs + tombPerMs;
  const dataFrac = bytesPerMs > 0 ? dataPerMs / bytesPerMs : 0;

  let sstables: SSTable[] = [];
  let memtableBytes = 0;
  /** Timestamp of the oldest data sitting in the memtable; null when empty. */
  let memtableMinTs: number | null = null;
  /** Index of the first SSTable that is not yet fully expired. */
  let agePtr = 0;
  // Running totals over `sstables`, maintained incrementally: flushes and
  // aging apply deltas, and a full re-sum happens only on ticks where the
  // strategy actually changed the set (signalled by returning a new array —
  // see the CompactionStrategy contract). Re-summing every tick is
  // O(ticks × SSTables) and blows the milliseconds budget at high write rates.
  let liveBytes = 0;
  let expiredBytes = 0;
  let tombstoneBytes = 0;
  // Read amp (M5): a table is touched by a query over [now − window, now] iff
  // its maxTs ≥ the cutoff (minTs ≤ now always holds). The list is minTs-
  // sorted, and STCS can leave maxTs non-monotone in it (a merged table can
  // hold newer data than an unmerged neighbour after it), so the count runs
  // over a sorted mirror of maxTs values instead: flushes append in maxTs
  // order (flush moments only move forward, and no compacted table can exceed
  // a past `now`), the cutoff only advances, so a pointer sweeps the mirror
  // once — amortized O(1) per tick. Compaction-change ticks rebuild the
  // mirror; those ticks are already O(n) by the strategy contract.
  let maxTsSorted: number[] = [];
  let queryPtr = 0;
  // Compaction saturation (M7): a shadow queue beside the simulation. The
  // strategy above still compacts unthrottled and instantly — the disk line
  // shows what a cluster that kept up would look like — while this queue
  // measures whether it could have. Work arrives as the bytes each merge
  // writes and drains at the per-node cap; a queue that never empties again
  // is a cluster that never recovers.
  //
  // The fullest node is also the most write-loaded: constant shares and one
  // uniform TTL make a node's share of writes and its share of disk the same
  // fraction (see SkewModel), so the sharder's hotNodeFrac serves both. Under
  // sub-sharding that fraction moves during the run, so it is read per tick —
  // relieving the hot node is exactly how the mitigation reaches this verdict.
  const capPerTick = (compactionCapPerSec * tickMs) / 1000;
  let backlogBytes = 0;
  let tickCompactionBytes = 0;
  const onWrite = (bytes: number) => {
    tickCompactionBytes += bytes;
  };
  const snapshots: MetricsSnapshot[] = [];
  // The hot node's share of disk each tick, kept so the saturation backlog can
  // be rebuilt against the fleet compaction total (per-node write-amp × nodes)
  // once the sub-run below has measured it. See the fleet block after the loop.
  const hotFracs: number[] = [];

  for (let i = 0; i < ticks; i++) {
    const tickStart = startTime + i * tickMs;
    const tickEnd = tickStart + tickMs;

    // Pour this tick's writes into the memtable, flushing every time the
    // threshold is crossed. cursor tracks the in-tick write clock.
    let remaining = bytesPerMs * tickMs;
    let cursor = tickStart;
    while (bytesPerMs > 0 && memtableBytes + remaining >= memtableFlushBytes) {
      const needed = memtableFlushBytes - memtableBytes;
      const flushAt = cursor + needed / bytesPerMs;
      const flushLive = memtableFlushBytes * dataFrac;
      const flushTomb = memtableFlushBytes - flushLive;
      sstables.push({
        createdAt: flushAt,
        minTs: memtableMinTs ?? cursor,
        maxTs: flushAt,
        liveBytes: flushLive,
        expiredBytes: 0,
        tombstoneBytes: flushTomb,
      });
      liveBytes += flushLive;
      tombstoneBytes += flushTomb;
      maxTsSorted.push(flushAt);
      remaining -= needed;
      cursor = flushAt;
      memtableBytes = 0;
      memtableMinTs = null;
    }
    if (remaining > 0) {
      memtableMinTs ??= cursor;
      memtableBytes += remaining;
    }

    // Age flushed data across the TTL. The list is minTs-ordered, so
    // everything before agePtr is fully expired and each SSTable is fully
    // expired exactly once. Flush-only spans are contiguous (the cutoff
    // straddles at most one table); compacted spans can overlap, so all
    // straddling tables past the prefix get the partial treatment.
    if (ttlMs > 0) {
      const cutoff = tickEnd - ttlMs;
      while (agePtr < sstables.length && sstables[agePtr].maxTs <= cutoff) {
        const s = sstables[agePtr];
        expiredBytes += s.liveBytes;
        liveBytes -= s.liveBytes;
        s.expiredBytes += s.liveBytes;
        s.liveBytes = 0;
        agePtr++;
      }
      for (let j = agePtr; j < sstables.length && sstables[j].minTs < cutoff; j++) {
        const s = sstables[j];
        const dataTotal = s.liveBytes + s.expiredBytes;
        const target =
          s.maxTs <= cutoff
            ? dataTotal
            : dataTotal * ((cutoff - s.minTs) / (s.maxTs - s.minTs));
        const delta = target - s.expiredBytes;
        if (delta > 0) {
          s.expiredBytes = target;
          s.liveBytes = dataTotal - target;
          expiredBytes += delta;
          liveBytes -= delta;
        }
      }
    }

    tickCompactionBytes = 0;
    const compacted = strategy.compact(sstables, { now: tickEnd, ttlMs, gcGraceMs, rng, onWrite });
    if (compacted !== sstables) {
      sstables = [...compacted];
      liveBytes = 0;
      expiredBytes = 0;
      tombstoneBytes = 0;
      agePtr = sstables.length;
      for (let j = sstables.length - 1; j >= 0; j--) {
        const s = sstables[j];
        liveBytes += s.liveBytes;
        expiredBytes += s.expiredBytes;
        tombstoneBytes += s.tombstoneBytes;
        // agePtr's invariant is only that everything before it is fully
        // expired; the first live table bounds that from above. Strategies
        // must keep the list minTs-sorted.
        if (s.liveBytes > 0) agePtr = j;
      }
      maxTsSorted = sstables.map((s) => s.maxTs).sort((a, b) => a - b);
      queryPtr = 0;
    }

    const queryCutoff = tickEnd - queryWindowMs;
    while (queryPtr < maxTsSorted.length && maxTsSorted[queryPtr] < queryCutoff) queryPtr++;

    const diskBytes = liveBytes + expiredBytes + tombstoneBytes;

    // How much write history the disk is still holding, in ms of ingest. This
    // is what sub-sharding's generations age against (M8): a table whose
    // compaction strands weeks of expired data is still holding the wide
    // partition it was re-keyed away from weeks ago, and this measures that
    // from the disk line itself rather than assuming it equals the TTL.
    const elapsed = tickEnd - startTime;
    const retentionMs =
      bytesPerMs > 0 ? Math.min(elapsed, Math.max(tickMs, diskBytes / bytesPerMs)) : elapsed;
    const shard = sharder ? sharder.step(tickEnd, diskBytes, retentionMs) : noSkew;

    if (capPerTick > 0) {
      backlogBytes = Math.max(0, backlogBytes + shard.hotNodeFrac * tickCompactionBytes - capPerTick);
    }
    hotFracs.push(shard.hotNodeFrac);

    // The partition-key overhead is a flat constant that exists only while the
    // table holds data. It rides on the live band (partition keys don't expire
    // while their partition has rows), keeping diskBytes = live + expired +
    // tombstone in the snapshot. The internal totals above stay pure so the
    // sharder and aging see real row bytes, not this metadata offset.
    const partOverhead = diskBytes > 0 ? partitionOverheadBytes : 0;

    snapshots.push({
      t: tickEnd,
      liveBytes: liveBytes + partOverhead,
      expiredBytes,
      tombstoneBytes,
      diskBytes: diskBytes + partOverhead,
      memtableBytes,
      sstableCount: sstables.length,
      readSstables: maxTsSorted.length - queryPtr,
      maxPartitionBytes: shard.maxPartitionBytes,
      hotNodeBytes: shard.hotNodeBytes,
      hotNode: shard.hotNode,
      hotPartitionShards: shard.hotPartitionShards,
      compactionBytes: tickCompactionBytes,
      compactionBacklogBytes: backlogBytes,
    });
  }

  // Three of the per-tick metrics are *structural* — they describe the shape of
  // a store, not a byte total — and the aggregate loop above is a single
  // cluster-wide store, not a real node. Every node runs its own compaction on
  // its own 1/nodes share of the writes, so the honest per-node figures come
  // from compacting one average node's share and scaling by the node count.
  // This is not a flat × nodes: without compaction the structure is
  // volume-driven (so a single store's figure is node-independent and this
  // collapses back to the aggregate) while under TWCS/STCS it is structure-
  // driven (so it genuinely grows with, or is set by, the ring). Running the
  // per-node share through the same mechanics gets every regime right; the
  // sub-run is cheaper than the main one (a node flushes 1/nodes as often) and,
  // with skew stripped, recurses no further.
  //
  //  - sstableCount   is a *fleet* total: per-node table count × nodes (the
  //    cluster holds `nodes` independent stores, so ≥ nodes once all have flushed).
  //  - readSstables   is *per replica*: the tables one replica touches for a
  //    time-bounded read, which is the per-node figure itself (a read hits one
  //    replica's local store, not the whole ring). Structural strategies leave
  //    it ≈ the aggregate; without compaction it is the aggregate ÷ nodes.
  //  - compactionBytes is a *fleet* total: each node compacts its own share with
  //    its own (per-node) write amplification, so cluster compaction volume is
  //    per-node × nodes — not the aggregate domain's, whose larger single store
  //    inflates size-driven write-amp (STCS) and would overstate the saturation
  //    backlog. TWCS is structural, so this is a near-no-op there.
  const nodes = config.skew?.nodes ?? 1;
  if (nodes > 1) {
    const perNode = simulate({
      ...config,
      writeRatePerSec: writeRatePerSec / nodes,
      deleteRatePerSec: deleteRatePerSec / nodes,
      skew: undefined,
    });
    let backlog = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const pn = perNode.snapshots[i];
      s.sstableCount = pn.sstableCount * nodes;
      s.readSstables = pn.readSstables;
      s.compactionBytes = pn.compactionBytes * nodes;
      // Rebuild the shadow backlog against the corrected (fleet) arrival rate:
      // the hot node's share of the cluster's real compaction work, drained at
      // the per-node cap. Verdicts read these snapshots, so this must land
      // before computeVerdicts below.
      if (capPerTick > 0) {
        backlog = Math.max(0, backlog + hotFracs[i] * s.compactionBytes - capPerTick);
        s.compactionBacklogBytes = backlog;
      }
    }
  }

  // The model handed back describes the horizon, not the start: promotions
  // move shares, replica sets and shard counts as the run goes on.
  const finalSkew = skew && sharder ? { ...skew, ...sharder.finalModel() } : skew;
  return {
    snapshots,
    sstables,
    skew: finalSkew,
    verdicts: computeVerdicts(snapshots, config, finalSkew),
  };
}
