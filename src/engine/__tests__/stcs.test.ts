import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import { createStcs, mergeSSTables } from '../compaction/stcs.ts';
import { noCompaction, type CompactionContext } from '../compaction/strategy.ts';
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

describe('STCS bucketing', () => {
  it('returns the input array by identity when no bucket reaches minThreshold', () => {
    const stcs = createStcs();
    const tables = [
      table({ minTs: 0, maxTs: 10, liveBytes: 100 }),
      table({ minTs: 10, maxTs: 20, liveBytes: 100 }),
      table({ minTs: 20, maxTs: 30, liveBytes: 100 }),
    ];
    expect(stcs.compact(tables, ctx(50))).toBe(tables);
  });

  it('keeps size tiers apart: dissimilar sizes land in different buckets', () => {
    const stcs = createStcs({ minSstableSizeBytes: 0 });
    const small = [0, 1, 2, 3].map((i) =>
      table({ minTs: i * 10, maxTs: (i + 1) * 10, liveBytes: 100 }),
    );
    const big = [4, 5, 6].map((i) =>
      table({ minTs: i * 10, maxTs: (i + 1) * 10, liveBytes: 10_000 }),
    );
    const out = stcs.compact([...small, ...big], ctx(100));

    // The four smalls merge; the three bigs are under threshold and survive
    // untouched (same struct identities — strategies never mutate inputs).
    expect(out).toHaveLength(4);
    const merged = out.find((s) => !big.includes(s))!;
    expect(merged.liveBytes).toBe(400);
    expect(merged.minTs).toBe(0);
    expect(merged.maxTs).toBe(40);
    expect(merged.createdAt).toBe(100);
    for (const b of big) expect(out).toContain(b);
  });

  it('merges four equal flushes into one table with summed bytes and the union span', () => {
    const stcs = createStcs();
    const tables = [0, 1, 2, 3].map((i) =>
      table({ minTs: i * 10, maxTs: (i + 1) * 10, liveBytes: 100, tombstoneBytes: 8 }),
    );
    // gc_grace larger than now keeps the tombstones: this asserts pure
    // merge arithmetic. (With gc 0 they would rightly all purge.)
    const out = stcs.compact(tables, ctx(50, 0, 100));
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

  it('cascades within one call: 16 equal tables collapse to 1 at maxThreshold 4', () => {
    const stcs = createStcs({ maxThreshold: 4 });
    const tables = Array.from({ length: 16 }, (_, i) =>
      table({ minTs: i * 10, maxTs: (i + 1) * 10, liveBytes: 100 }),
    );
    const out = stcs.compact(tables, ctx(200));
    expect(out).toHaveLength(1);
    expect(out[0].liveBytes).toBe(1600);
    expect(out[0].minTs).toBe(0);
    expect(out[0].maxTs).toBe(160);
  });
});

describe('STCS purge math (gc_grace gate)', () => {
  /**
   * Hand-computed: now = 100, ttl = 40, gc = 10
   *   → data purge cutoff  = 100 − 40 − 10 = 50
   *   → tomb purge cutoff  = 100 − 10      = 90
   * Table spans [0, 100] uniformly, 100 B of data aged to 60 % expired
   * (aging cutoff now − ttl = 60), plus 50 B of tombstones:
   *   purged data = 100 × 50/100 = 50  → 10 B expired survive, 40 B live
   *   purged tomb =  50 × 90/100 = 45  →  5 B tombstones survive
   *   minTs advances to the data purge cutoff (50), maxTs stays 100
   */
  it('purges exactly the pre-cutoff fractions and advances minTs', () => {
    const input = table({ minTs: 0, maxTs: 100, liveBytes: 40, expiredBytes: 60, tombstoneBytes: 50 });
    const out = mergeSSTables([input], ctx(100, 40, 10));
    expect(out).toEqual({
      createdAt: 100,
      minTs: 50,
      maxTs: 100,
      liveBytes: 40,
      expiredBytes: 10,
      tombstoneBytes: 5,
    });
  });

  it('holds every byte while gc_grace has not passed', () => {
    const input = [
      table({ minTs: 0, maxTs: 10, liveBytes: 0, expiredBytes: 100, tombstoneBytes: 20 }),
      table({ minTs: 10, maxTs: 20, liveBytes: 50, expiredBytes: 50, tombstoneBytes: 20 }),
    ];
    // gc so large that both cutoffs land before all data: nothing purges.
    const out = mergeSSTables(input, ctx(100, 40, 1_000_000))!;
    expect(out.liveBytes).toBe(50);
    expect(out.expiredBytes).toBe(150);
    expect(out.tombstoneBytes).toBe(40);
    expect(out.minTs).toBe(0);
    expect(out.maxTs).toBe(20);
  });

  it('drops the output entirely when everything is purgeable', () => {
    const input = table({ minTs: 0, maxTs: 10, liveBytes: 0, expiredBytes: 100, tombstoneBytes: 30 });
    expect(mergeSSTables([input], ctx(1000, 40, 10))).toBeNull();
  });

  it('never purges data when TTL is off, even with gc_grace at zero', () => {
    const input = table({ minTs: 0, maxTs: 10, liveBytes: 100 });
    const out = mergeSSTables([input], ctx(1000, 0, 0))!;
    expect(out.liveBytes).toBe(100);
    expect(out.minTs).toBe(0);
  });
});

describe('STCS in the engine', () => {
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
    compaction: { strategy: 'stcs' },
  };

  it('write-only: merging conserves every byte and bounds the SSTable count', () => {
    const none = simulate(writeOnly);
    const stcs = simulate(writeOnly, createStcs());
    stcs.snapshots.forEach((s, i) => {
      const base = none.snapshots[i].diskBytes;
      expect(Math.abs(s.diskBytes - base)).toBeLessThanOrEqual(base * 1e-9);
    });
    const finalNone = none.snapshots.at(-1)!;
    const finalStcs = stcs.snapshots.at(-1)!;
    expect(finalNone.sstableCount).toBeGreaterThan(4000); // one table per flush
    expect(finalStcs.sstableCount).toBeLessThan(40); // log-structured tiers
  });

  it('TTL + gc_grace: compaction reclaims most of the expired backlog', () => {
    const none = simulate({ ...withTtl, compaction: { strategy: 'none' } });
    const stcs = simulate(withTtl);
    const finalNone = none.snapshots.at(-1)!;
    const finalStcs = stcs.snapshots.at(-1)!;
    // Without compaction disk = everything ever written; STCS holds roughly
    // ttl + gc worth (40d of 365d ≈ 11 %) plus un-merged lumps. Assert the
    // conservative half-way bound; the golden file pins the exact series.
    expect(finalStcs.diskBytes).toBeLessThan(finalNone.diskBytes * 0.5);
    expect(finalStcs.liveBytes).toBeGreaterThan(0);
    // Live data is untouchable: only expired/tombstone bytes may be dropped.
    expect(Math.abs(finalStcs.liveBytes - finalNone.liveBytes)).toBeLessThanOrEqual(
      finalNone.liveBytes * 1e-9,
    );
  });

  it('resolves the serializable compaction spec to the same result as an explicit strategy', () => {
    const viaSpec = simulate(withTtl);
    const viaArg = simulate({ ...withTtl, compaction: undefined }, createStcs());
    expect(viaSpec.snapshots).toEqual(viaArg.snapshots);
    expect(viaSpec.sstables).toEqual(viaArg.sstables);
  });

  it('is deterministic for the same seed and config', () => {
    expect(simulate(withTtl)).toEqual(simulate(withTtl));
  });

  it('still honours the identity contract via noCompaction with a spec of none', () => {
    const a = simulate({ ...writeOnly, compaction: { strategy: 'none' } });
    const b = simulate(writeOnly, noCompaction);
    expect(a.snapshots).toEqual(b.snapshots);
  });

  it('rejects a negative gcGraceMs', () => {
    expect(() => simulate({ ...withTtl, gcGraceMs: -1 })).toThrow(RangeError);
  });
});
