import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import type { CompactionStrategy } from '../compaction/strategy.ts';
import type { SimConfig } from '../types.ts';

/**
 * Read amplification (M5): a query over [now − queryWindowMs, now] touches
 * every SSTable whose [minTs, maxTs] overlaps the window — since maxTs ≤ now
 * always, that is exactly the tables with maxTs ≥ now − queryWindowMs.
 *
 * The base config flushes exactly one SSTable per tick: 1,000 rows/s × 100 B
 * = 100 B/ms → 100,000 B per 1,000 ms tick = the flush threshold. Table i
 * spans [START + (i−1)·1000, START + i·1000], all values exact integers, so
 * every expectation below is an exact hand count.
 */
const START = Date.UTC(2026, 0, 1);

const perTickFlush: SimConfig = {
  seed: 1,
  startTime: START,
  tickMs: 1000,
  ticks: 10,
  writeRatePerSec: 1000,
  onDiskRowBytes: 100,
  memtableFlushBytes: 100_000,
};

const readAmps = (config: SimConfig, strategy?: CompactionStrategy) =>
  simulate(config, strategy).snapshots.map((s) => s.readSstables);

describe('read amplification — SSTables touched per query window', () => {
  it('counts the trailing-window staircase exactly', () => {
    // Window 3,500 ms at tick k: tables with i·1000 ≥ k·1000 − 3500 → the
    // last four (fewer while ramping up).
    expect(readAmps({ ...perTickFlush, queryWindowMs: 3500 })).toEqual([
      1, 2, 3, 4, 4, 4, 4, 4, 4, 4,
    ]);
  });

  it('includes a table whose maxTs sits exactly on the cutoff', () => {
    // Window 3,000 ms puts table k−3's maxTs exactly on the cutoff at every
    // tick k — inclusive, so 4 tables; one ms less excludes it → 3.
    expect(readAmps({ ...perTickFlush, queryWindowMs: 3000 })).toEqual([
      1, 2, 3, 4, 4, 4, 4, 4, 4, 4,
    ]);
    expect(readAmps({ ...perTickFlush, queryWindowMs: 2999 })).toEqual([
      1, 2, 3, 3, 3, 3, 3, 3, 3, 3,
    ]);
  });

  it('defaults the query window to 1 day', () => {
    // One flush per hourly tick → a day-long query touches 25 tables once
    // warmed up (the boundary table sits exactly on the cutoff — inclusive).
    const hourly: SimConfig = {
      ...perTickFlush,
      tickMs: 3_600_000,
      ticks: 48,
      writeRatePerSec: 10,
      memtableFlushBytes: 3_600_000,
    };
    const counts = readAmps(hourly);
    expect(counts[23]).toBe(24);
    expect(counts[24]).toBe(25);
    expect(counts[47]).toBe(25);
  });

  it('recounts correctly after compaction leaves maxTs non-monotone in minTs order', () => {
    // At the end of tick 4 the strategy merges tables 1 and 3 only, so the
    // minTs-ordered list [merged(0…3000), t2(1000…2000), t4(3000…4000)] has
    // maxTs 3000, 2000, 4000 — non-monotone. With a 1,500 ms window the
    // cutoff at tick 4 is 2,500: the merged table and t4 overlap → 2. A scan
    // that assumed maxTs order would stop at t2 and report 1.
    const mergeOneAndThree: CompactionStrategy = {
      name: 'test-merge-1-and-3',
      compact(sstables, ctx) {
        if (ctx.now !== START + 4000) return sstables;
        const [a, b, c, d] = sstables;
        const merged = {
          createdAt: ctx.now,
          minTs: a.minTs,
          maxTs: c.maxTs,
          liveBytes: a.liveBytes + c.liveBytes,
          expiredBytes: a.expiredBytes + c.expiredBytes,
          tombstoneBytes: a.tombstoneBytes + c.tombstoneBytes,
        };
        return [merged, b, d];
      },
    };
    expect(
      readAmps({ ...perTickFlush, ticks: 6, queryWindowMs: 1500 }, mergeOneAndThree),
    ).toEqual([1, 2, 2, 2, 2, 2]);
  });

  it('stays bounded by the table count and drops when compaction merges the window', () => {
    // 100 rows/s × 105 B = 10.5 B/ms with an 8 MiB threshold → a flush every
    // ~13.3 min, ~108 per day. Without compaction a day-long query touches
    // all of yesterday's flushes; STCS/TWCS keep the window merged down.
    const ttlConfig: SimConfig = {
      seed: 42,
      startTime: START,
      tickMs: 3_600_000,
      ticks: 24 * 30,
      writeRatePerSec: 100,
      onDiskRowBytes: 105,
      memtableFlushBytes: 8_388_608,
      ttlMs: 7 * 86_400_000,
      deleteRatePerSec: 10,
      tombstoneRowBytes: 45,
      gcGraceMs: 86_400_000,
    };
    const none = simulate(ttlConfig).snapshots;
    const stcs = simulate({ ...ttlConfig, compaction: { strategy: 'stcs' } }).snapshots;
    const twcs = simulate({
      ...ttlConfig,
      compaction: { strategy: 'twcs', windowMs: 86_400_000 },
    }).snapshots;

    for (const run of [none, stcs, twcs]) {
      for (const s of run) {
        expect(s.readSstables).toBeGreaterThanOrEqual(0);
        expect(s.readSstables).toBeLessThanOrEqual(s.sstableCount);
      }
    }
    // ~108 flushes/day → a day-long read without compaction touches ~109.
    expect(none.at(-1)!.readSstables).toBeGreaterThan(100);
    expect(stcs.at(-1)!.readSstables).toBeLessThan(none.at(-1)!.readSstables / 4);
    expect(twcs.at(-1)!.readSstables).toBeLessThan(none.at(-1)!.readSstables / 4);
  });

  it('rejects a non-positive query window', () => {
    expect(() => simulate({ ...perTickFlush, queryWindowMs: 0 })).toThrow(RangeError);
    expect(() => simulate({ ...perTickFlush, queryWindowMs: -5 })).toThrow(RangeError);
  });
});
