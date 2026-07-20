import type {
  CompactionSaturationVerdict,
  DiskAsymmetryVerdict,
  MetricsSnapshot,
  SimConfig,
  SkewModel,
  Verdict,
  VerdictCrossing,
  VerdictLevel,
  WidePartitionVerdict,
} from './types.ts';

/**
 * Failure verdicts (M7). Three ways a Cassandra cluster is mathematically
 * bound to fail, each reduced to a threshold and the date it is crossed.
 *
 * These read the finished time series rather than running inside the tick
 * loop: two of the three want hindsight (the first crossing of a metric that
 * a TWCS sawtooth can cross more than once; a backlog that only counts as
 * unbounded if it never drains again), and keeping them out of the loop keeps
 * the loop's per-tick cost untouched.
 *
 * Verdicts carry numbers, never prose or formatted dates — the UI owns
 * wording and time formatting (see CLAUDE.md conventions).
 */

/** Cassandra's own warning line for a single partition. */
export const WIDE_PARTITION_WARN_BYTES = 100 * 1024 * 1024;
/** Multi-GB partitions take the node down rather than merely slowing it. */
export const WIDE_PARTITION_FATAL_BYTES = 1024 * 1024 * 1024;
/**
 * Disk headroom: compaction needs room to write a merge's output before it
 * can free the inputs, so a node is in trouble well before it is literally
 * full. Past 90% even a small STCS tier has nowhere to land.
 */
export const DISK_WARN_FRACTION = 0.7;
export const DISK_FATAL_FRACTION = 0.9;
/** ρ = arrival ÷ drain. Above 1 the queue is unbounded; 0.8 leaves no burst headroom. */
export const SATURATION_WARN_RHO = 0.8;
export const SATURATION_FATAL_RHO = 1;

const DAY_MS = 86_400_000;

export function computeVerdicts(
  snapshots: readonly MetricsSnapshot[],
  config: SimConfig,
  skew: SkewModel | undefined,
): Verdict[] {
  return [
    widePartition(snapshots, config),
    compactionSaturation(snapshots, config, skew),
    diskAsymmetry(snapshots, config, skew),
  ];
}

/**
 * First snapshot whose metric reaches `threshold`. Metrics are not monotone —
 * a TWCS sawtooth crosses, falls back and crosses again — and the honest
 * answer to "when does this break" is the first time it broke.
 */
function firstCrossing(
  snapshots: readonly MetricsSnapshot[],
  startTime: number,
  threshold: number,
  metric: (s: MetricsSnapshot) => number,
): VerdictCrossing | null {
  if (!(threshold > 0)) return null;
  for (const s of snapshots) {
    const value = metric(s);
    if (value >= threshold) {
      return { at: s.t, day: Math.floor((s.t - startTime) / DAY_MS), value, threshold };
    }
  }
  return null;
}

const levelOf = (warn: VerdictCrossing | null, fatal: VerdictCrossing | null): VerdictLevel =>
  fatal ? 'fatal' : warn ? 'warn' : 'ok';

const peakOf = (
  snapshots: readonly MetricsSnapshot[],
  metric: (s: MetricsSnapshot) => number,
): number => snapshots.reduce((m, s) => Math.max(m, metric(s)), 0);

/** Verdict 1: the wide-partition cliff. */
function widePartition(
  snapshots: readonly MetricsSnapshot[],
  config: SimConfig,
): WidePartitionVerdict {
  const metric = (s: MetricsSnapshot) => s.maxPartitionBytes;
  const warn = firstCrossing(snapshots, config.startTime, WIDE_PARTITION_WARN_BYTES, metric);
  const fatal = firstCrossing(snapshots, config.startTime, WIDE_PARTITION_FATAL_BYTES, metric);
  return {
    id: 'wide-partition',
    level: levelOf(warn, fatal),
    value: snapshots.at(-1)?.maxPartitionBytes ?? 0,
    peak: peakOf(snapshots, metric),
    limit: WIDE_PARTITION_WARN_BYTES,
    warn,
    fatal,
    partitionCount: config.skew?.partitionCount ?? 0,
  };
}

/**
 * Verdict 2: compaction saturation. The engine already ran the queue tick by
 * tick (arrivals from the strategy's own merges, drain at the cap); this
 * turns it into a verdict.
 *
 * ρ comes from the final quarter of the run rather than the whole of it:
 * write amplification climbs as a table grows, so a cumulative average
 * describes a cluster that no longer exists and would understate a workload
 * that has only recently gone unstable.
 */
function compactionSaturation(
  snapshots: readonly MetricsSnapshot[],
  config: SimConfig,
  skew: SkewModel | undefined,
): CompactionSaturationVerdict {
  const cap = config.compactionThroughputBytesPerSec ?? 0;
  const nodeFrac = skew ? Math.max(...skew.nodeShare) : 0;
  const node = skew ? skew.nodeShare.indexOf(Math.max(...skew.nodeShare)) : 0;
  const backlogBytes = snapshots.at(-1)?.compactionBacklogBytes ?? 0;

  const tail = snapshots.slice(-Math.max(1, Math.ceil(snapshots.length / 4)));
  const tailSeconds = (tail.length * config.tickMs) / 1000;
  const writeRateBytesPerSec =
    tailSeconds > 0
      ? (nodeFrac * tail.reduce((sum, s) => sum + s.compactionBytes, 0)) / tailSeconds
      : 0;
  const rho = cap > 0 ? writeRateBytesPerSec / cap : 0;

  // The date comes from the queue, not from ρ: ρ says the backlog is
  // unbounded, the queue says when it stopped draining. The last tick the
  // node was ever caught up is the last moment the cluster was healthy.
  let fatal: VerdictCrossing | null = null;
  if (rho > SATURATION_FATAL_RHO && backlogBytes > 0) {
    let lastEmpty = -1;
    for (let i = 0; i < snapshots.length; i++) {
      if (snapshots[i].compactionBacklogBytes <= 0) lastEmpty = i;
    }
    const s = snapshots[lastEmpty + 1];
    if (s) {
      fatal = {
        at: s.t,
        day: Math.floor((s.t - config.startTime) / DAY_MS),
        value: s.compactionBacklogBytes,
        threshold: 0,
      };
    }
  }

  // Warn is about headroom, not incidents: ρ ≥ 0.8 means compaction only just
  // keeps up, leaving nothing spare for a repair, a bootstrap or a node down.
  // A queue that spiked once and then ran empty for the rest of the run is a
  // healthy cluster, so a transient backlog on its own is deliberately not a
  // warning — it would fire on almost every run's first ticks. The date still
  // comes from the queue: the first time it fell a full tick's capacity behind.
  const capPerTick = (cap * config.tickMs) / 1000;
  const warn =
    fatal || rho >= SATURATION_WARN_RHO
      ? firstCrossing(snapshots, config.startTime, Math.max(capPerTick, 1), (s) => s.compactionBacklogBytes)
      : null;

  return {
    id: 'compaction-saturation',
    level: levelOf(warn, fatal),
    value: rho,
    // ρ is a tail average, so its "peak" is the queue it produced: the most
    // compaction the node was ever behind by.
    peak: peakOf(snapshots, (s) => s.compactionBacklogBytes),
    limit: SATURATION_FATAL_RHO,
    warn,
    fatal,
    node,
    writeRateBytesPerSec,
    capBytesPerSec: cap,
    backlogBytes,
    compacting: (config.compaction?.strategy ?? 'none') !== 'none',
  };
}

/** Verdict 3: the fullest node runs out of disk while the average looks fine. */
function diskAsymmetry(
  snapshots: readonly MetricsSnapshot[],
  config: SimConfig,
  skew: SkewModel | undefined,
): DiskAsymmetryVerdict {
  const capacity = config.diskPerNodeBytes ?? 0;
  const nodes = skew?.nodeShare.length ?? 0;
  const node = skew ? skew.nodeShare.indexOf(Math.max(...skew.nodeShare)) : 0;
  const last = snapshots.at(-1);
  const metric = (s: MetricsSnapshot) => s.hotNodeBytes;
  // The cluster average is taken at the tick the hot node peaked, not at the
  // horizon. Comparing a peak-over-time against a horizon value would read as
  // node asymmetry even on a perfectly even ring, where the whole gap is
  // really the compaction sawtooth moving every node up and down together.
  const peakTick = snapshots.reduce(
    (best, s) => (s.hotNodeBytes > (best?.hotNodeBytes ?? -1) ? s : best),
    undefined as MetricsSnapshot | undefined,
  );
  const warn = nodes > 0
    ? firstCrossing(snapshots, config.startTime, capacity * DISK_WARN_FRACTION, metric)
    : null;
  const fatal = nodes > 0
    ? firstCrossing(snapshots, config.startTime, capacity * DISK_FATAL_FRACTION, metric)
    : null;

  return {
    id: 'disk-asymmetry',
    level: levelOf(warn, fatal),
    value: last?.hotNodeBytes ?? 0,
    peak: peakOf(snapshots, metric),
    limit: capacity * DISK_WARN_FRACTION,
    warn,
    fatal,
    node,
    averageBytes: peakTick && nodes > 0 ? peakTick.diskBytes / nodes : 0,
    capacityBytes: capacity,
  };
}
