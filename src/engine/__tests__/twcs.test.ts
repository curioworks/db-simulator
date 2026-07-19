import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import { createTwcs } from '../compaction/twcs.ts';
import { type CompactionContext } from '../compaction/strategy.ts';
import { mulberry32 } from '../prng.ts';
import type { SimConfig, SSTable } from '../types.ts';

const ctx = (now: number, ttlMs = 0, gcGraceMs = 0): CompactionContext => ({
  now,
  ttlMs,
  gcGraceMs,
  rng: mulberry32(1),
});

const table = (partial: Partial<SSTable> & Pick<SSTable, 'minTs' | 'maxTs'>): SSTable => ({
  createdAt: partial.maxTs,
  liveBytes: 0,
  expiredBytes: 0,
  tombstoneBytes: 0,
  ...partial,
});

describe('TWCS windowing', () => {
  it('returns the input array by identity when every window is stable', () => {
    const twcs = createTwcs({ windowMs: 100 });
    const tables = [
      table({ minTs: 210, maxTs: 220, liveBytes: 100 }),
      table({ minTs: 220, maxTs: 230, liveBytes: 100 }),
      table({ minTs: 230, maxTs: 240, liveBytes: 100 }),
    ];
    expect(twcs.compact(tables, ctx(250))).toBe(tables);
  });

  it('compacts each closed window to a single SSTable, leaving the current window alone', () => {
    const twcs = createTwcs({ windowMs: 100 });
    const w0 = [
      table({ minTs: 0, maxTs: 50, liveBytes: 100 }),
      table({ minTs: 50, maxTs: 90, liveBytes: 100 }),
    ];
    const w1 = [
      table({ minTs: 100, maxTs: 140, liveBytes: 100 }),
      table({ minTs: 140, maxTs: 180, liveBytes: 100 }),
    ];
    const current = table({ minTs: 210, maxTs: 240, liveBytes: 100 });
    const out = twcs.compact([...w0, ...w1, current], ctx(250));

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      createdAt: 250,
      minTs: 0,
      maxTs: 90,
      liveBytes: 200,
      expiredBytes: 0,
      tombstoneBytes: 0,
    });
    expect(out[1]).toEqual({
      createdAt: 250,
      minTs: 100,
      maxTs: 180,
      liveBytes: 200,
      expiredBytes: 0,
      tombstoneBytes: 0,
    });
    // The current window is below minThreshold: same struct, untouched.
    expect(out[2]).toBe(current);
  });

  it('never pools tables across windows for size-tiering', () => {
    const twcs = createTwcs({ windowMs: 100, minSstableSizeBytes: 0 });
    // Four equal-size tables that plain STCS would merge — but one lives in a
    // closed window, so no bucket reaches minThreshold and nothing happens.
    const tables = [
      table({ minTs: 20, maxTs: 50, liveBytes: 100 }),
      table({ minTs: 200, maxTs: 210, liveBytes: 100 }),
      table({ minTs: 210, maxTs: 220, liveBytes: 100 }),
      table({ minTs: 220, maxTs: 230, liveBytes: 100 }),
    ];
    expect(twcs.compact(tables, ctx(250))).toBe(tables);
  });

  it('runs STCS inside the current window: four equal flushes merge into one', () => {
    const twcs = createTwcs({ windowMs: 1000 });
    const tables = [0, 1, 2, 3].map((i) =>
      table({ minTs: i * 10, maxTs: (i + 1) * 10, liveBytes: 100, tombstoneBytes: 8 }),
    );
    // gc_grace larger than now keeps the tombstones: pure merge arithmetic.
    const out = twcs.compact(tables, ctx(50, 0, 100));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      createdAt: 50,
      minTs: 0,
      maxTs: 40,
      liveBytes: 400,
      expiredBytes: 0,
      tombstoneBytes: 32,
    });
  });
});

describe('TWCS whole-SSTable expiry drops', () => {
  it('drops tables whose whole span is past the gc_grace gate, keeps the rest by identity', () => {
    const twcs = createTwcs();
    // now = 1000, ttl = 100, gc = 50 → data droppable when maxTs ≤ 850,
    // tombstones droppable when maxTs ≤ 950.
    const droppedData = table({ minTs: 700, maxTs: 800, expiredBytes: 100 });
    const keptData = table({ minTs: 800, maxTs: 900, expiredBytes: 100 });
    const droppedTomb = table({ minTs: 900, maxTs: 940, tombstoneBytes: 20 });
    const keptTomb = table({ minTs: 920, maxTs: 960, tombstoneBytes: 20 });
    const out = twcs.compact([droppedData, keptData, droppedTomb, keptTomb], ctx(1000, 100, 50));

    expect(out).toHaveLength(2);
    expect(out).toContain(keptData);
    expect(out).toContain(keptTomb);
  });

  it('never drops data-bearing tables when TTL is off', () => {
    const twcs = createTwcs();
    const tables = [table({ minTs: 0, maxTs: 10, liveBytes: 100 })];
    expect(twcs.compact(tables, ctx(1_000_000_000, 0, 0))).toBe(tables);
  });
});

describe('TWCS in the engine', () => {
  const writeOnly: SimConfig = {
    seed: 42,
    startTime: Date.UTC(2026, 0, 1),
    tickMs: 86_400_000,
    ticks: 365,
    writeRatePerSec: 100,
    onDiskRowBytes: 105,
    memtableFlushBytes: 67_108_864,
  };
  const withTtl: SimConfig = {
    ...writeOnly,
    ttlMs: 30 * 86_400_000,
    deleteRatePerSec: 20,
    tombstoneRowBytes: 45,
    gcGraceMs: 10 * 86_400_000,
    compaction: { strategy: 'twcs', windowMs: 30 * 86_400_000 },
  };

  it('write-only: window majors conserve every byte', () => {
    const none = simulate(writeOnly);
    const twcs = simulate(writeOnly, createTwcs());
    twcs.snapshots.forEach((s, i) => {
      const base = none.snapshots[i].diskBytes;
      expect(Math.abs(s.diskBytes - base)).toBeLessThanOrEqual(base * 1e-9);
    });
    expect(twcs.snapshots.at(-1)!.sstableCount).toBeLessThan(400); // ~1/window + current
  });

  it('TTL: disk stays bounded via periodic whole-window drops', () => {
    const none = simulate({ ...withTtl, compaction: { strategy: 'none' } });
    const twcs = simulate(withTtl);
    const finalNone = none.snapshots.at(-1)!;
    const finalTwcs = twcs.snapshots.at(-1)!;
    expect(finalTwcs.diskBytes).toBeLessThan(finalNone.diskBytes * 0.5);
    // Live data is untouchable: only expired/tombstone bytes may be dropped.
    expect(Math.abs(finalTwcs.liveBytes - finalNone.liveBytes)).toBeLessThanOrEqual(
      finalNone.liveBytes * 1e-9,
    );
    // The reclaim signature: several distinct ticks where disk shrinks
    // (windows aging out), not one late cliff.
    const dropTicks = twcs.snapshots.filter(
      (s, i) => i > 0 && s.diskBytes < twcs.snapshots[i - 1].diskBytes,
    );
    expect(dropTicks.length).toBeGreaterThanOrEqual(3);
  });

  it('window ≈ TTL holds more disk than a small window (the M4 preset story)', () => {
    const mistake = simulate(withTtl);
    const fix = simulate({
      ...withTtl,
      compaction: { strategy: 'twcs', windowMs: 86_400_000 },
    });
    const avg = (r: typeof mistake) => {
      const tail = r.snapshots.slice(-60);
      return tail.reduce((sum, s) => sum + s.diskBytes, 0) / tail.length;
    };
    expect(avg(fix)).toBeLessThan(avg(mistake) * 0.9);
  });

  it('resolves the serializable compaction spec to the same result as an explicit strategy', () => {
    const viaSpec = simulate(withTtl);
    const viaArg = simulate(
      { ...withTtl, compaction: undefined },
      createTwcs({ windowMs: 30 * 86_400_000 }),
    );
    expect(viaSpec.snapshots).toEqual(viaArg.snapshots);
    expect(viaSpec.sstables).toEqual(viaArg.sstables);
  });

  it('is deterministic for the same seed and config', () => {
    expect(simulate(withTtl)).toEqual(simulate(withTtl));
  });

  it('rejects a non-positive window and bad inherited STCS tuning', () => {
    expect(() => createTwcs({ windowMs: 0 })).toThrow(RangeError);
    expect(() => createTwcs({ minThreshold: 1 })).toThrow(RangeError);
  });
});
