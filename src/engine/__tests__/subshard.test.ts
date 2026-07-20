import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import { buildSkewModel } from '../skew.ts';
import { PROMOTION_TRIGGER_BYTES } from '../subshard.ts';
import type { SimConfig, SkewConfig, Verdict, VerdictId } from '../types.ts';

/**
 * Sub-sharding with step-up promotion (M8): the mitigation. A hot partition
 * doubles its shard count when it outgrows the trigger, re-keying onto fresh
 * tokens — and crucially does not take the rows already written with it.
 */
const START = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const MiB = 1024 * 1024;

const find = <T extends VerdictId>(verdicts: Verdict[], id: T) => {
  const v = verdicts.find((x) => x.id === id);
  if (!v) throw new Error(`no ${id} verdict`);
  return v as Extract<Verdict, { id: T }>;
};

const skewOf = (patch: Partial<SkewConfig> = {}): SkewConfig => ({
  partitionCount: 100,
  zipfExponent: 1,
  topK: 8,
  nodes: 6,
  replicationFactor: 3,
  ...patch,
});

/**
 * Ingest heavy enough to blow past the 50 MB trigger inside a few ticks, with
 * a memtable big enough that the flush count — which is what simulation cost
 * actually tracks — stays small.
 */
const growing: SimConfig = {
  seed: 1,
  startTime: START,
  tickMs: HOUR,
  ticks: 200,
  writeRatePerSec: 20_000,
  onDiskRowBytes: 300,
  memtableFlushBytes: 64 * MiB,
  skew: skewOf(),
};

const widest = (config: SimConfig) => simulate(config).snapshots.map((s) => s.maxPartitionBytes);

describe('sub-sharding — the mitigation is off by default', () => {
  it('leaves every skew figure untouched when maxSubShards is absent or 1', () => {
    const off = simulate(growing);
    const one = simulate({ ...growing, skew: skewOf({ maxSubShards: 1 }) });
    expect(one.snapshots).toEqual(off.snapshots);
    expect(one.skew).toEqual(off.skew);
    for (const s of off.snapshots) expect(s.hotPartitionShards).toBe(1);
    expect(off.skew!.subShards).toEqual(Array(8).fill(1));
  });

  it('reports the hottest partition as its plain Zipf share while unpromoted', () => {
    // The M6 collapse: constant shares, so bytes are share × disk ÷ RF.
    const { snapshots, skew } = simulate({ ...growing, ticks: 3 });
    for (const s of snapshots) {
      expect(s.maxPartitionBytes).toBeCloseTo((skew!.hotWeights[0] * s.diskBytes) / 3, 6);
    }
  });

  it('rejects a shard cap that is not a positive integer', () => {
    const bad = (maxSubShards: number) => () => buildSkewModel(skewOf({ maxSubShards }), 42);
    expect(bad(0)).toThrow(RangeError);
    expect(bad(-2)).toThrow(RangeError);
    expect(bad(2.5)).toThrow(RangeError);
    expect(() => simulate({ ...growing, skew: skewOf({ maxSubShards: 0 }) })).toThrow(RangeError);
  });
});

describe('step-up promotion', () => {
  it('doubles the shard count past the trigger and stops at the cap', () => {
    const { snapshots } = simulate({ ...growing, skew: skewOf({ maxSubShards: 8 }) });
    const counts = [...new Set(snapshots.map((s) => s.hotPartitionShards))];
    expect(counts).toEqual([1, 2, 4, 8]); // stepped, in order, and capped
    expect(snapshots.at(-1)!.hotPartitionShards).toBe(8);
  });

  it('honours a cap that is not the maximum', () => {
    for (const cap of [2, 4]) {
      const { snapshots, skew } = simulate({ ...growing, skew: skewOf({ maxSubShards: cap }) });
      expect(Math.max(...snapshots.map((s) => s.hotPartitionShards))).toBe(cap);
      for (const n of skew!.subShards) expect(n).toBeLessThanOrEqual(cap);
    }
  });

  it('does not promote a partition that never reaches the trigger', () => {
    // Spread thin enough that no single partition gets anywhere near 50 MB.
    const { snapshots, skew } = simulate({
      ...growing,
      ticks: 20,
      skew: skewOf({ partitionCount: 10_000_000, zipfExponent: 0.2, maxSubShards: 8 }),
    });
    expect(Math.max(...snapshots.map((s) => s.maxPartitionBytes))).toBeLessThan(
      PROMOTION_TRIGGER_BYTES,
    );
    expect(skew!.subShards).toEqual(Array(8).fill(1));
  });

  it('is deterministic per seed, and places shards differently on another seed', () => {
    const config: SimConfig = { ...growing, skew: skewOf({ maxSubShards: 8 }) };
    expect(simulate(config)).toEqual(simulate(config));
    expect(simulate({ ...config, seed: 2 }).skew!.nodeShare).not.toEqual(
      simulate(config).skew!.nodeShare,
    );
  });
});

describe('promotion is not retroactive — the rows already written do not move', () => {
  /**
   * The heart of the model. Re-keying a table does not rewrite history: the
   * old partition keeps every byte it had and only sheds them as TTL and
   * compaction get to them. So with nothing ever leaving disk, a promotion
   * must make the widest partition go *flat*, never smaller. A model that
   * divided the current size by the new shard count would show an instant
   * cliff here — which is the comforting lie this test exists to prevent.
   */
  const noReclaim: SimConfig = { ...growing, skew: skewOf({ maxSubShards: 4 }) };

  it('never shrinks the widest partition when nothing is ever reclaimed', () => {
    const series = widest(noReclaim);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] - 1e-6);
    }
  });

  it('goes flat at the promotion, then grows again at the divided rate', () => {
    const { snapshots } = simulate(noReclaim);
    const at = snapshots.findIndex((s) => s.hotPartitionShards === 4);
    expect(at).toBeGreaterThan(0);
    const before = snapshots[at - 1].maxPartitionBytes;
    // Flat across the promotion: the old generation is still exactly as wide.
    expect(snapshots[at].maxPartitionBytes).toBeGreaterThanOrEqual(before);
    expect(snapshots[at].maxPartitionBytes).toBeLessThan(before * 1.01);

    // …and once the new shards have outgrown it, the partition is climbing at
    // exactly a quarter of the slope it would have had. The reference slope
    // has to come from the unpromoted run: by the tick before this promotion
    // the *first* one had already flattened this series.
    const slopeOf = (s: { maxPartitionBytes: number }[]) =>
      s.at(-1)!.maxPartitionBytes - s.at(-2)!.maxPartitionBytes;
    const quarter = slopeOf(simulate({ ...growing, skew: skewOf() }).snapshots) / 4;
    // A hair under a quarter rather than exactly it, and never over: the
    // frozen old generation holds a sliver of the history window that the new
    // shards never get back.
    expect(slopeOf(snapshots)).toBeLessThanOrEqual(quarter);
    expect(slopeOf(snapshots)).toBeGreaterThan(quarter * 0.99);
  });

  it('keeps the old generation on its original nodes until it has drained', () => {
    // Right after a promotion the partition is on more nodes than RF: the old
    // generation has not left its replicas yet, and the new one has arrived.
    const { skew } = simulate({
      ...growing,
      ticks: 30,
      skew: skewOf({ nodes: 24, maxSubShards: 8 }),
    });
    expect(skew!.hotReplicas[0].length).toBeGreaterThan(3);
  });

  it('drains the old generation once a TTL is actually reclaiming', () => {
    // Same run with a short TTL and windows sized to drop whole: once more
    // than a retention window has passed since the last promotion, only the
    // current generation's shards are left holding bytes.
    const { skew } = simulate({
      ...growing,
      ticks: 600,
      ttlMs: 6 * HOUR,
      gcGraceMs: 0,
      compaction: { strategy: 'twcs', windowMs: HOUR },
      skew: skewOf({ nodes: 24, maxSubShards: 2 }),
    });
    // 2 shards × RF 3 = at most 6 distinct nodes still holding the partition.
    expect(skew!.hotReplicas[0].length).toBeLessThanOrEqual(6);
  });
});

describe('what sub-sharding does and does not fix', () => {
  const config = (maxSubShards: number): SimConfig => ({
    ...growing,
    ticks: 400,
    ttlMs: 24 * HOUR,
    gcGraceMs: 0,
    compaction: { strategy: 'twcs', windowMs: HOUR },
    diskPerNodeBytes: 512 * 1024 * MiB,
    skew: skewOf({ partitionCount: 5_000, zipfExponent: 0.7, maxSubShards }),
  });

  it('walks the wide-partition verdict down as the cap doubles', () => {
    const peaks = [1, 2, 4, 8].map(
      (n) => find(simulate(config(n)).verdicts, 'wide-partition').peak,
    );
    // Each doubling roughly halves the widest partition — 8 shards is 8×, and
    // the point of the panel is that it is only ever exactly that.
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]).toBeLessThan(peaks[i - 1] * 0.6);
    }
  });

  it('pushes the crossing date later rather than pretending it never happened', () => {
    /**
     * Slow enough that the crossings land on distinct days. The verdict's
     * whole output is a date, and a workload that passes 100 MB inside the
     * first hour reports day 0 at every shard count — which would make this
     * test pass for the wrong reason.
     */
    const slow = (maxSubShards: number): SimConfig => ({
      seed: 1,
      startTime: START,
      tickMs: HOUR,
      ticks: 24 * 40,
      writeRatePerSec: 400,
      onDiskRowBytes: 270,
      memtableFlushBytes: 32 * MiB,
      skew: skewOf({ partitionCount: 5_000, zipfExponent: 0.7, maxSubShards }),
    });
    const one = find(simulate(slow(1)).verdicts, 'wide-partition');
    const two = find(simulate(slow(2)).verdicts, 'wide-partition');
    expect(one.warn).not.toBeNull();
    expect(two.warn).not.toBeNull();
    // Both dates move out, and neither crossing is erased: on a table that
    // keeps growing, sub-sharding buys time rather than safety.
    expect(two.warn!.day).toBeGreaterThan(one.warn!.day);
    expect(two.fatal!.day).toBeGreaterThan(one.fatal!.day);
    expect(two.level).toBe('fatal');
  });

  it('reports the promotion that fixed it, and the cap it was allowed', () => {
    const v = find(simulate(config(8)).verdicts, 'wide-partition');
    expect(v.maxSubShards).toBe(8);
    expect(v.subShards).toBe(8);
    expect(v.promoted).not.toBeNull();
    expect(v.promoted!.threshold).toBe(PROMOTION_TRIGGER_BYTES);
    expect(v.promoted!.value).toBeGreaterThanOrEqual(PROMOTION_TRIGGER_BYTES);
    expect(v.promoted!.day).toBeGreaterThanOrEqual(0);
  });

  it('moves no bytes off the cluster — only where they land', () => {
    const off = simulate(config(1));
    const on = simulate(config(8));
    // Identical disk line: this is a schema change, not a capacity one.
    expect(on.snapshots.map((s) => s.diskBytes)).toEqual(
      off.snapshots.map((s) => s.diskBytes),
    );
    expect(find(on.verdicts, 'wide-partition').peak).toBeLessThan(
      find(off.verdicts, 'wide-partition').peak,
    );
  });

  it('keeps node shares a valid distribution across every promotion', () => {
    const { skew, snapshots } = simulate(config(8));
    expect(skew!.nodeShare.reduce((a, s) => a + s, 0)).toBeCloseTo(1, 10);
    for (const s of skew!.nodeShare) expect(s).toBeGreaterThan(0);
    // And the fullest node still bounds the cluster average from above.
    for (const s of snapshots) {
      if (s.diskBytes === 0) continue;
      expect(s.hotNodeBytes).toBeGreaterThanOrEqual(s.diskBytes / 6 - 1e-6);
      expect(s.hotNodeBytes).toBeLessThanOrEqual(s.diskBytes);
    }
  });

  it('relieves the fullest node by spreading the hot key over more replica sets', () => {
    const hotKey = (maxSubShards: number): SimConfig => ({
      ...config(maxSubShards),
      skew: skewOf({ partitionCount: 200, zipfExponent: 1.2, nodes: 12, maxSubShards }),
    });
    const off = simulate(hotKey(1)).snapshots.at(-1)!;
    const on = simulate(hotKey(8)).snapshots.at(-1)!;
    expect(on.hotNodeBytes).toBeLessThan(off.hotNodeBytes);
  });
});
