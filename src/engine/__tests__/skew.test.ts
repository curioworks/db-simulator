import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import { buildSkewModel, harmonic } from '../skew.ts';
import type { SimConfig, SkewConfig } from '../types.ts';

/**
 * Skew model (M6): writes spread across partitions on a Zipf curve; the top-K
 * partitions are tracked individually, the rest pool into a tail bucket, and
 * each hot partition's token pins it to RF ring-consecutive nodes.
 *
 * Zipf hand math for partitionCount 4, exponent 1:
 * H = 1 + 1/2 + 1/3 + 1/4 = 25/12, so the shares are 12/25 = 0.48,
 * 6/25 = 0.24, 4/25 = 0.16, 3/25 = 0.12.
 */
const START = Date.UTC(2026, 0, 1);

const fourPartitions: SkewConfig = {
  partitionCount: 4,
  zipfExponent: 1,
  topK: 2,
  nodes: 4,
  replicationFactor: 2,
};

/** One 100,000 B SSTable per 1,000 ms tick — same exact setup as the M5 tests. */
const perTickFlush: SimConfig = {
  seed: 1,
  startTime: START,
  tickMs: 1000,
  ticks: 10,
  writeRatePerSec: 1000,
  onDiskRowBytes: 100,
  memtableFlushBytes: 100_000,
};

describe('harmonic — the Zipf normalizer', () => {
  const bruteForce = (n: number, s: number) => {
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += i ** -s;
    return sum;
  };

  it('matches a brute-force sum past the exact-terms crossover', () => {
    // 10,000 terms are summed exactly; beyond that it is Euler–Maclaurin.
    for (const s of [0.3, 0.5, 1, 1.1, 1.4, 2]) {
      for (const n of [9_999, 10_000, 10_001, 50_000, 250_000]) {
        expect(harmonic(n, s)).toBeCloseTo(bruteForce(n, s), 9);
      }
    }
  });

  it('is exact for the trivial cases', () => {
    expect(harmonic(1, 1.1)).toBe(1);
    expect(harmonic(1_000_000, 0)).toBe(1_000_000); // s = 0 → every term is 1
    expect(harmonic(3, 1)).toBeCloseTo(1 + 1 / 2 + 1 / 3, 12);
  });

  it('stays O(1) past the crossover — 100M partitions must not cost 100M iterations', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      buildSkewModel(
        { partitionCount: 100_000_000, zipfExponent: 1.1, topK: 8, nodes: 6, replicationFactor: 3 },
        42,
      );
    }
    // 200 builds of the largest legal ring; a per-partition loop would be
    // 2×10^10 iterations. The sim re-runs on every slider drag.
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('buildSkewModel — Zipf weights and replica placement', () => {
  it('computes the hand-checked Zipf shares and tail', () => {
    const model = buildSkewModel(fourPartitions, 42);
    expect(model.hotWeights).toHaveLength(2);
    expect(model.hotWeights[0]).toBeCloseTo(0.48, 12);
    expect(model.hotWeights[1]).toBeCloseTo(0.24, 12);
    expect(model.tailWeight).toBeCloseTo(0.28, 12);
  });

  it('degenerates to uniform shares at exponent 0', () => {
    const model = buildSkewModel(
      { ...fourPartitions, partitionCount: 10, topK: 3, zipfExponent: 0 },
      42,
    );
    expect(model.hotWeights).toEqual([0.1, 0.1, 0.1]);
    expect(model.tailWeight).toBeCloseTo(0.7, 12);
  });

  it('clamps topK to the partition count, leaving an empty tail', () => {
    const model = buildSkewModel(
      { partitionCount: 4, zipfExponent: 0, topK: 8, nodes: 4, replicationFactor: 2 },
      42,
    );
    expect(model.hotWeights).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(model.tailWeight).toBe(0);
    expect(model.hotReplicas).toHaveLength(4);
  });

  it('places each hot partition on RF ring-consecutive nodes, deterministically per seed', () => {
    const config: SkewConfig = { ...fourPartitions, topK: 4, nodes: 5, replicationFactor: 3 };
    const model = buildSkewModel(config, 42);
    for (const replicas of model.hotReplicas) {
      expect(replicas).toHaveLength(3);
      expect(new Set(replicas).size).toBe(3);
      for (const node of replicas) {
        expect(node).toBeGreaterThanOrEqual(0);
        expect(node).toBeLessThan(5);
      }
      expect(replicas[1]).toBe((replicas[0] + 1) % 5);
      expect(replicas[2]).toBe((replicas[0] + 2) % 5);
    }
    expect(buildSkewModel(config, 42)).toEqual(model);
    expect(buildSkewModel(config, 43).hotReplicas).not.toEqual(model.hotReplicas);
  });

  it('node shares sum to 1 and the tail spreads evenly at uniform skew', () => {
    const skewed = buildSkewModel(
      { partitionCount: 1000, zipfExponent: 1.1, topK: 8, nodes: 6, replicationFactor: 3 },
      42,
    );
    expect(skewed.nodeShare).toHaveLength(6);
    expect(skewed.nodeShare.reduce((a, s) => a + s, 0)).toBeCloseTo(1, 12);
    for (const share of skewed.nodeShare) expect(share).toBeGreaterThan(0);

    // 8 hot partitions of 1e-6 each are noise: every node sits at ~1/8.
    const uniform = buildSkewModel(
      { partitionCount: 1_000_000, zipfExponent: 0, topK: 8, nodes: 8, replicationFactor: 3 },
      42,
    );
    for (const share of uniform.nodeShare) expect(share).toBeCloseTo(1 / 8, 4);
  });

  it('rejects invalid configs', () => {
    const bad = (patch: Partial<SkewConfig>) => () =>
      buildSkewModel({ ...fourPartitions, ...patch }, 42);
    expect(bad({ partitionCount: 0 })).toThrow(RangeError);
    expect(bad({ partitionCount: 2.5 })).toThrow(RangeError);
    expect(bad({ zipfExponent: -0.1 })).toThrow(RangeError);
    expect(bad({ topK: 0 })).toThrow(RangeError);
    expect(bad({ nodes: 0 })).toThrow(RangeError);
    expect(bad({ replicationFactor: 5 })).toThrow(RangeError); // > nodes
    // …and the same through the engine boundary.
    expect(() =>
      simulate({ ...perTickFlush, skew: { ...fourPartitions, partitionCount: 0 } }),
    ).toThrow(RangeError);
  });
});

describe('simulate — skew fields in snapshots', () => {
  it('reports the hottest partition as its exact share of disk bytes', () => {
    // RF 1 on 2 nodes: per-replica bytes of the top partition are simply
    // 0.48 × diskBytes, and diskBytes at tick i is exactly 100,000 × i.
    const { snapshots, skew } = simulate({
      ...perTickFlush,
      skew: { partitionCount: 4, zipfExponent: 1, topK: 2, nodes: 2, replicationFactor: 1 },
    });
    expect(skew).toBeDefined();
    const hotShare = Math.max(...skew!.nodeShare);
    snapshots.forEach((s, i) => {
      const disk = 100_000 * (i + 1);
      expect(s.diskBytes).toBe(disk);
      expect(s.maxPartitionBytes).toBeCloseTo(0.48 * disk, 6);
      expect(s.hotNodeBytes).toBeCloseTo(hotShare * disk, 6);
    });
    expect(skew!.nodeShare.reduce((a, s) => a + s, 0)).toBeCloseTo(1, 12);
  });

  it('emits zeros and no model when skew is not configured', () => {
    const { snapshots, skew } = simulate(perTickFlush);
    expect(skew).toBeUndefined();
    for (const s of snapshots) {
      expect(s.maxPartitionBytes).toBe(0);
      expect(s.hotNodeBytes).toBe(0);
    }
  });

  it('keeps the hottest node between the cluster average and the total, above the hottest partition', () => {
    const config: SimConfig = {
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
      compaction: { strategy: 'twcs', windowMs: 86_400_000 },
      skew: { partitionCount: 10_000, zipfExponent: 1.1, topK: 8, nodes: 6, replicationFactor: 3 },
    };
    const { snapshots } = simulate(config);
    for (const s of snapshots) {
      if (s.diskBytes === 0) continue;
      expect(s.hotNodeBytes).toBeGreaterThanOrEqual(s.diskBytes / 6);
      expect(s.hotNodeBytes).toBeLessThanOrEqual(s.diskBytes);
      expect(s.maxPartitionBytes).toBeLessThanOrEqual(s.diskBytes / 3);
      expect(s.hotNodeBytes).toBeGreaterThanOrEqual(s.maxPartitionBytes);
    }
  });

  it('turning the skew dial up concentrates bytes into the top partition', () => {
    const base: SimConfig = {
      ...perTickFlush,
      ticks: 20,
      skew: { partitionCount: 10_000, zipfExponent: 0, topK: 8, nodes: 6, replicationFactor: 3 },
    };
    const uniform = simulate(base).snapshots.at(-1)!;
    const skewed = simulate({
      ...base,
      skew: { ...base.skew!, zipfExponent: 1.2 },
    }).snapshots.at(-1)!;
    expect(skewed.maxPartitionBytes).toBeGreaterThan(50 * uniform.maxPartitionBytes);
    expect(uniform.maxPartitionBytes).toBeCloseTo(uniform.diskBytes / 10_000 / 3, 6);
  });
});
