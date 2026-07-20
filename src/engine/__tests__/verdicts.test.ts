import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import { createStcs } from '../compaction/stcs.ts';
import { createTwcs } from '../compaction/twcs.ts';
import {
  computeVerdicts,
  DISK_FATAL_FRACTION,
  DISK_WARN_FRACTION,
  WIDE_PARTITION_FATAL_BYTES,
  WIDE_PARTITION_WARN_BYTES,
} from '../verdicts.ts';
import type { MetricsSnapshot, SimConfig, Verdict, VerdictId } from '../types.ts';

/**
 * Failure verdicts (M7). Each is a threshold plus the date it was crossed, so
 * the tests pin both: the level, and the day the crossing is reported on.
 */
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

const find = <T extends VerdictId>(verdicts: Verdict[], id: T) => {
  const v = verdicts.find((x) => x.id === id);
  if (!v) throw new Error(`no ${id} verdict`);
  return v as Extract<Verdict, { id: T }>;
};

/**
 * One 100 KB flush per 1 s tick. Simulation cost tracks the flush count, so
 * fixtures that actually run the engine stay on second-length ticks; the
 * crossing-date tests below build their series by hand on day-length ticks
 * instead, where the day numbers are the point.
 */
const perTickFlush: SimConfig = {
  seed: 1,
  startTime: START,
  tickMs: 1000,
  ticks: 10,
  writeRatePerSec: 1000,
  onDiskRowBytes: 100,
  memtableFlushBytes: 100_000,
};

/** Build a snapshot series directly, to test the crossing scan in isolation. */
function series(values: Array<Partial<MetricsSnapshot>>): MetricsSnapshot[] {
  return values.map((v, i) => ({
    t: START + (i + 1) * DAY,
    liveBytes: 0,
    expiredBytes: 0,
    tombstoneBytes: 0,
    diskBytes: 0,
    memtableBytes: 0,
    sstableCount: 0,
    readSstables: 0,
    maxPartitionBytes: 0,
    hotNodeBytes: 0,
    hotNode: 0,
    hotPartitionShards: 1,
    compactionBytes: 0,
    compactionBacklogBytes: 0,
    ...v,
  }));
}

const baseConfig: SimConfig = { ...perTickFlush, ticks: 0 };

describe('wide-partition verdict', () => {
  const scan = (partitionBytes: number[]) =>
    find(
      computeVerdicts(
        series(partitionBytes.map((maxPartitionBytes) => ({ maxPartitionBytes }))),
        baseConfig,
        undefined,
      ),
      'wide-partition',
    );

  it('stays ok below the 100 MB warn line', () => {
    const v = scan([1e6, 5e6, WIDE_PARTITION_WARN_BYTES - 1]);
    expect(v.level).toBe('ok');
    expect(v.warn).toBeNull();
    expect(v.fatal).toBeNull();
    expect(v.limit).toBe(WIDE_PARTITION_WARN_BYTES);
  });

  it('warns at 100 MB and dates the crossing to the day it happened', () => {
    // Tick i ends on day i+1, so the third snapshot is day 3.
    const v = scan([1e6, 1e6, WIDE_PARTITION_WARN_BYTES, 2e8]);
    expect(v.level).toBe('warn');
    expect(v.warn?.day).toBe(3);
    expect(v.warn?.at).toBe(START + 3 * DAY);
    expect(v.warn?.value).toBe(WIDE_PARTITION_WARN_BYTES);
    expect(v.fatal).toBeNull();
  });

  it('goes fatal past a GB, keeping the earlier warn date', () => {
    const v = scan([1e6, WIDE_PARTITION_WARN_BYTES, 5e8, WIDE_PARTITION_FATAL_BYTES]);
    expect(v.level).toBe('fatal');
    expect(v.warn?.day).toBe(2);
    expect(v.fatal?.day).toBe(4);
  });

  it('reports the first crossing of a sawtooth, not the last', () => {
    // TWCS and STCS both swing: a metric can cross, fall back, and cross again.
    // The honest answer to "when does this break" is the first time it broke.
    const v = scan([2e8, 1e6, 1e6, 3e8]);
    expect(v.warn?.day).toBe(1);
    expect(v.peak).toBe(3e8);
    expect(v.value).toBe(3e8);
  });

  it('reports the peak even when the horizon value looks healthy', () => {
    const v = scan([1e6, 5e8, 1e6]);
    expect(v.value).toBe(1e6);
    expect(v.peak).toBe(5e8);
    expect(v.level).toBe('warn');
  });
});

describe('disk-asymmetry verdict', () => {
  const capacity = 1000;
  const scan = (hotNodeBytes: number[], nodes = 3) =>
    find(
      computeVerdicts(
        series(hotNodeBytes.map((b) => ({ hotNodeBytes: b, diskBytes: b * nodes, hotNode: 1 }))),
        { ...baseConfig, diskPerNodeBytes: capacity },
        {
          hotWeights: [0.4],
          tailWeight: 0.6,
          hotReplicas: [[1]],
          nodeShare: Array.from({ length: nodes }, (_, i) => (i === 1 ? 0.5 : 0.25)),
          subShards: [1],
        },
      ),
      'disk-asymmetry',
    );

  it('warns at 70% and goes fatal at 90% of the node disk', () => {
    const v = scan([100, capacity * DISK_WARN_FRACTION, 800, capacity * DISK_FATAL_FRACTION]);
    expect(v.level).toBe('fatal');
    expect(v.warn?.day).toBe(2);
    expect(v.fatal?.day).toBe(4);
    expect(v.capacityBytes).toBe(capacity);
  });

  it('names the fullest node, not node 0', () => {
    expect(scan([100]).node).toBe(1);
  });

  it('contrasts the fullest node against a still-healthy cluster average', () => {
    // The whole point of the verdict: the hot node is over the line while the
    // average node, measured at the same moment, is comfortable.
    const snapshots = series([{ hotNodeBytes: 900, diskBytes: 1800, hotNode: 1 }]);
    const v = find(
      computeVerdicts(snapshots, { ...baseConfig, diskPerNodeBytes: capacity }, {
        hotWeights: [0.5],
        tailWeight: 0.5,
        hotReplicas: [[1]],
        nodeShare: [0.25, 0.5, 0.25],
        subShards: [1],
      }),
      'disk-asymmetry',
    );
    expect(v.peak).toBe(900); // 90% of the node's disk
    expect(v.averageBytes).toBe(600); // 1800 over 3 nodes — 60%, reassuring
    expect(v.level).toBe('fatal');
  });

  it('takes the cluster average at the peak tick, not at the horizon', () => {
    // A compaction sawtooth moves every node together. Comparing a peak
    // against a horizon average would report asymmetry on an even ring.
    const snapshots = series([
      { hotNodeBytes: 300, diskBytes: 900 },
      { hotNodeBytes: 900, diskBytes: 2700 }, // the peak
      { hotNodeBytes: 300, diskBytes: 900 }, // reclaimed again
    ]);
    const v = find(
      computeVerdicts(snapshots, { ...baseConfig, diskPerNodeBytes: capacity }, {
        hotWeights: [0.34],
        tailWeight: 0.66,
        hotReplicas: [[0]],
        nodeShare: [1 / 3, 1 / 3, 1 / 3],
        subShards: [1],
      }),
      'disk-asymmetry',
    );
    expect(v.peak).toBe(900);
    // 2700/3 = 900 at the peak tick: an even ring, correctly reported as even.
    expect(v.averageBytes).toBe(900);
    expect(v.value).toBe(300); // horizon value, still reported separately
  });

  it('stays ok with no disk capacity configured', () => {
    const v = find(
      computeVerdicts(series([{ hotNodeBytes: 1e15 }]), baseConfig, undefined),
      'disk-asymmetry',
    );
    expect(v.level).toBe('ok');
    expect(v.warn).toBeNull();
  });
});

describe('compaction-saturation verdict', () => {
  const skew = {
    hotWeights: [0.5],
    tailWeight: 0.5,
    hotReplicas: [[0]],
    nodeShare: [1],
    subShards: [1],
  };
  /** One node holding everything, so cluster bytes are node bytes. */
  const scan = (compactionBytes: number[], capBytesPerSec: number) => {
    const config: SimConfig = {
      ...baseConfig,
      tickMs: DAY,
      compactionThroughputBytesPerSec: capBytesPerSec,
    };
    // Re-run the engine's queue so the fixture matches what the loop produces.
    const capPerTick = (capBytesPerSec * DAY) / 1000;
    let backlog = 0;
    const snapshots = series(
      compactionBytes.map((b) => {
        backlog = Math.max(0, backlog + b - capPerTick);
        return { compactionBytes: b, compactionBacklogBytes: backlog };
      }),
    );
    return find(computeVerdicts(snapshots, config, skew), 'compaction-saturation');
  };

  const capPerSec = 1000;
  const capPerDay = capPerSec * 86_400;

  it('stays ok while compaction keeps up', () => {
    const v = scan(Array(8).fill(capPerDay * 0.5), capPerSec);
    expect(v.level).toBe('ok');
    expect(v.value).toBeCloseTo(0.5, 6);
    expect(v.fatal).toBeNull();
  });

  it('goes fatal at ρ > 1 and dates it from the last tick the queue was empty', () => {
    // Four ticks that drain, then four that do not: the cluster was last
    // caught up on day 4, so day 5 is when it stopped recovering.
    const v = scan([...Array(4).fill(capPerDay * 0.5), ...Array(4).fill(capPerDay * 2)], capPerSec);
    expect(v.level).toBe('fatal');
    expect(v.value).toBeGreaterThan(1);
    expect(v.fatal?.day).toBe(5);
    expect(v.backlogBytes).toBeGreaterThan(0);
  });

  it('measures ρ over the final quarter, not the whole run', () => {
    // Write amplification climbs as a table grows, so a cumulative average
    // describes a cluster that no longer exists. 12 quiet ticks then 4 at 2x
    // capacity: the tail is what counts.
    const v = scan([...Array(12).fill(0), ...Array(4).fill(capPerDay * 2)], capPerSec);
    expect(v.value).toBeCloseTo(2, 6);
    expect(v.level).toBe('fatal');
  });

  it('stays ok for a transient spike that fully drains', () => {
    // A burst that the cluster works off and never sees again is not a
    // warning — warning on it would fire on almost every run's first ticks.
    const v = scan([capPerDay * 4, 0, 0, 0, 0, 0, 0, 0], capPerSec);
    expect(v.level).toBe('ok');
    expect(v.warn).toBeNull();
    expect(v.backlogBytes).toBe(0);
    expect(v.peak).toBe(capPerDay * 3); // the queue really did back up
  });

  it('warns when ρ leaves no headroom, dated from the first tick it fell behind', () => {
    // Sustained 0.9x: keeping up on average, with nothing spare for a repair,
    // a bootstrap, or a node down.
    const v = scan([capPerDay * 3, ...Array(11).fill(capPerDay * 0.9)], capPerSec);
    expect(v.level).toBe('warn');
    expect(v.value).toBeCloseTo(0.9, 6);
    expect(v.warn?.day).toBe(1);
    expect(v.fatal).toBeNull();
  });

  it('stays ok with no throughput cap configured', () => {
    const v = scan([1e12, 1e12], 0);
    expect(v.level).toBe('ok');
    expect(v.value).toBe(0);
  });
});

/** 5 flushes per tick over 400 ticks — enough for STCS to cascade tiers. */
const busy: SimConfig = {
  ...perTickFlush,
  ticks: 400,
  writeRatePerSec: 5000,
  memtableFlushBytes: 100_000,
  gcGraceMs: 0,
};

describe('write amplification feeds the queue from real merges', () => {
  it("counts every cascade step, not just the tick's net output", () => {
    // STCS can merge several tiers within one tick. Diffing the tick's input
    // and output sets would miss the intermediate tables, which were really
    // written; the strategy reports each merge instead.
    const { snapshots } = simulate({ ...busy, compaction: { strategy: 'stcs' } }, createStcs());
    const written = snapshots.reduce((a, s) => a + s.compactionBytes, 0);
    const ingested = snapshots.at(-1)!.diskBytes;
    expect(written).toBeGreaterThan(ingested);
  });

  it('charges TWCS less than STCS — dropped windows are never rewritten', () => {
    const ttl = { ...busy, ttlMs: 100_000, gcGraceMs: 0 };
    const stcs = simulate({ ...ttl, compaction: { strategy: 'stcs' } }, createStcs());
    const twcs = simulate(
      { ...ttl, compaction: { strategy: 'twcs', windowMs: 50_000 } },
      createTwcs({ windowMs: 50_000 }),
    );
    const total = (r: typeof stcs) => r.snapshots.reduce((a, s) => a + s.compactionBytes, 0);
    expect(total(twcs)).toBeLessThan(total(stcs));
  });

  it('reports no compaction bytes without a strategy', () => {
    const { snapshots } = simulate(busy);
    expect(snapshots.every((s) => s.compactionBytes === 0)).toBe(true);
  });
});

describe('the queue inside the tick loop', () => {
  const skewed = {
    partitionCount: 1000,
    zipfExponent: 0.5,
    topK: 4,
    nodes: 4,
    replicationFactor: 2,
  };

  const queued = { ...busy, compaction: { strategy: 'stcs' } as const, skew: skewed };

  it('drains at the cap and never goes negative', () => {
    // Generous cap: every tick's work is paid off the same tick.
    const { snapshots } = simulate({ ...queued, compactionThroughputBytesPerSec: 1e9 });
    expect(snapshots.every((s) => s.compactionBacklogBytes === 0)).toBe(true);
  });

  it('grows without bound once arrivals outrun the cap', () => {
    const { snapshots, verdicts } = simulate({ ...queued, compactionThroughputBytesPerSec: 1 });
    const backlog = snapshots.map((s) => s.compactionBacklogBytes);
    expect(backlog.at(-1)!).toBeGreaterThan(backlog[0]);
    expect(find(verdicts, 'compaction-saturation').level).toBe('fatal');
  });

  it('stays empty without a cap, whatever the workload', () => {
    const { snapshots } = simulate(queued);
    expect(snapshots.every((s) => s.compactionBacklogBytes === 0)).toBe(true);
  });

  it('rejects a negative cap or disk size', () => {
    expect(() => simulate({ ...perTickFlush, compactionThroughputBytesPerSec: -1 })).toThrow(
      RangeError,
    );
    expect(() => simulate({ ...perTickFlush, diskPerNodeBytes: -1 })).toThrow(RangeError);
  });
});

describe('simulate returns all three verdicts', () => {
  it('always reports every verdict, ok included', () => {
    const { verdicts } = simulate({ ...perTickFlush, ticks: 5 });
    expect(verdicts.map((v) => v.id)).toEqual([
      'wide-partition',
      'compaction-saturation',
      'disk-asymmetry',
    ]);
    expect(verdicts.every((v) => v.level === 'ok')).toBe(true);
  });

  it('charges the fullest node its own share of compaction, not the average', () => {
    // The hot node both stores and writes more, so it saturates first — the
    // same fraction drives disk and compaction (see SkewModel).
    const config: SimConfig = {
      ...busy,
      compaction: { strategy: 'stcs' },
      compactionThroughputBytesPerSec: 20_000,
    };
    const flat = simulate({
      ...config,
      skew: { partitionCount: 1e6, zipfExponent: 0, topK: 4, nodes: 4, replicationFactor: 1 },
    });
    const hot = simulate({
      ...config,
      skew: { partitionCount: 20, zipfExponent: 1.8, topK: 4, nodes: 4, replicationFactor: 1 },
    });
    expect(find(hot.verdicts, 'compaction-saturation').value).toBeGreaterThan(
      find(flat.verdicts, 'compaction-saturation').value,
    );
  });
});
