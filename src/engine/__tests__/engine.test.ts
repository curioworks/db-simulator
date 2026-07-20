import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import type { SimConfig } from '../types.ts';

/**
 * Hand-validated write-only growth, hourly ticks.
 *
 *   onDiskRowBytes 105 (see rowSize.test.ts) × 100 rows/s = 10,500 B/s
 *     → bytesPerMs = 10.5
 *     → per 1h tick: 10.5 × 3,600,000 = 37,800,000 B
 *   memtable flush threshold: 64 MiB = 67,108,864 B
 *
 *   tick 1: memtable 37,800,000 < threshold            → disk 0, 0 SSTables
 *   tick 2: 75,600,000 ≥ threshold → flush 67,108,864  → memtable 8,491,136
 *           flush moment: needs 67,108,864 − 37,800,000 = 29,308,864 B
 *           → 29,308,864 / 10.5 ms ≈ 2,791,320.38 ms into tick 2
 *   tick 3: 8,491,136 + 37,800,000 = 46,291,136 < threshold → memtable only
 */
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const TICK_BYTES = 37_800_000;
const FLUSH = 67_108_864;

const config: SimConfig = {
  seed: 42,
  startTime: START,
  tickMs: HOUR,
  ticks: 720, // 30 days
  writeRatePerSec: 100,
  onDiskRowBytes: 105,
  memtableFlushBytes: FLUSH,
};

describe('simulate — write-only growth', () => {
  const { snapshots, sstables } = simulate(config);

  it('matches the hand-computed first three ticks exactly', () => {
    expect(snapshots[0]).toEqual({
      t: START + HOUR,
      liveBytes: 0,
      expiredBytes: 0,
      tombstoneBytes: 0,
      diskBytes: 0,
      memtableBytes: TICK_BYTES,
      sstableCount: 0,
      readSstables: 0,
      maxPartitionBytes: 0,
      hotNodeBytes: 0,
      hotNode: 0,
      hotPartitionShards: 1,
      compactionBytes: 0,
      compactionBacklogBytes: 0,
    });

    expect(snapshots[1].diskBytes).toBe(FLUSH);
    expect(snapshots[1].sstableCount).toBe(1);
    expect(snapshots[1].memtableBytes).toBe(8_491_136);

    expect(snapshots[2].diskBytes).toBe(FLUSH);
    expect(snapshots[2].sstableCount).toBe(1);
    expect(snapshots[2].memtableBytes).toBe(46_291_136);
  });

  it('interpolates the flush moment inside the tick', () => {
    const first = sstables[0];
    // Data in the first SSTable spans from the very first write to the flush.
    expect(first.minTs).toBe(START);
    expect(first.createdAt).toBeCloseTo(START + HOUR + 29_308_864 / 10.5, 6);
    expect(first.maxTs).toBe(first.createdAt);
    expect(first.liveBytes).toBe(FLUSH);
    expect(first.expiredBytes).toBe(0);
    expect(first.tombstoneBytes).toBe(0);
  });

  it('conserves bytes: disk + memtable = everything written so far', () => {
    snapshots.forEach((s, i) => {
      expect(s.diskBytes + s.memtableBytes).toBe((i + 1) * TICK_BYTES);
    });
  });

  it('ends with the expected SSTable count', () => {
    // 720 × 37,800,000 = 27,216,000,000 written; ⌊… / 67,108,864⌋ = 405 flushes.
    expect(sstables.length).toBe(405);
    expect(snapshots.at(-1)!.sstableCount).toBe(405);
  });

  it('is deterministic for the same seed and config', () => {
    expect(simulate(config)).toEqual(simulate(config));
  });

  it('handles a zero write rate without flushing or dividing by zero', () => {
    const idle = simulate({ ...config, writeRatePerSec: 0, ticks: 10 });
    expect(idle.sstables).toEqual([]);
    expect(idle.snapshots.at(-1)).toMatchObject({ diskBytes: 0, memtableBytes: 0, sstableCount: 0 });
  });

  it('stays inside the milliseconds budget at scale (5y, ~250K SSTables)', () => {
    // Design budget: "simulating 5 years of a 10TB table must take
    // milliseconds." 1,000 rows/s × 105 B over 1,825 daily ticks ≈ 246K
    // flushes (~16 TB). The bound is loose to stay CI-safe; the O(ticks ×
    // SSTables) re-sum this guards against took >1s for half this load.
    const t0 = performance.now();
    const big = simulate({
      ...config,
      writeRatePerSec: 1000,
      tickMs: 86_400_000,
      ticks: 1825,
      ttlMs: 7 * 86_400_000,
      deleteRatePerSec: 100,
      tombstoneRowBytes: 45,
    });
    const elapsed = performance.now() - t0;
    expect(big.sstables.length).toBeGreaterThan(200_000);
    expect(elapsed).toBeLessThan(1000);
  });

  it('flushes multiple SSTables within one tick when writes outpace the threshold', () => {
    // 10× the write rate: 378,000,000 B/tick → ⌊378e6 / 67,108,864⌋ = 5 flushes in tick 1.
    const hot = simulate({ ...config, writeRatePerSec: 1000, ticks: 1 });
    expect(hot.sstables.length).toBe(5);
    expect(hot.snapshots[0].memtableBytes).toBeCloseTo(378_000_000 - 5 * FLUSH, 6);
  });
});
