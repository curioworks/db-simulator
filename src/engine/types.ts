/**
 * The core design decision: simulate metadata, not rows. An SSTable is only
 * this struct — data is never materialized.
 */
export interface SSTable {
  /** Epoch ms when this SSTable came into existence (flush or compaction). */
  createdAt: number;
  /** Oldest data timestamp contained (epoch ms). */
  minTs: number;
  /** Newest data timestamp contained (epoch ms). */
  maxTs: number;
  liveBytes: number;
  /** TTL has passed but the data has not been purged yet (M2+). */
  expiredBytes: number;
  /** Tombstone overhead retained until gc_grace allows dropping (M2+). */
  tombstoneBytes: number;
}

export interface SimConfig {
  seed: number;
  /** Simulation start, epoch ms. */
  startTime: number;
  /** Tick resolution in ms — 1h or 1d. */
  tickMs: number;
  /** Number of ticks to simulate. */
  ticks: number;
  /** Cluster-wide write rate, rows per second. */
  writeRatePerSec: number;
  /** Cluster-wide on-disk bytes per row, from the size profiler. */
  onDiskRowBytes: number;
  /**
   * Memtable flush threshold in the same on-disk-equivalent byte units.
   * (Real memtables are uncompressed and per-replica; the sim folds
   * compression and RF into every byte figure so all units line up.)
   */
  memtableFlushBytes: number;
  /**
   * Row TTL in ms; 0 or absent = no TTL. Data older than `now − ttlMs` counts
   * as expired: still on disk (expired ≠ deleted), droppable only by a
   * compaction that gets past the gc_grace gate (M3+). Data expires only once
   * flushed; memtable residence (≪ any real TTL) is ignored.
   */
  ttlMs?: number;
  /** Row deletions per second, cluster-wide; each writes one tombstone. 0/absent = none. */
  deleteRatePerSec?: number;
  /** Cluster-wide on-disk bytes per tombstone, from the size profiler. */
  tombstoneRowBytes?: number;
  /**
   * gc_grace_seconds as ms; 0 or absent = purge as soon as compaction touches
   * the data. Expired data and tombstones survive compaction until gc_grace
   * has passed on top of the TTL/deletion timestamp.
   */
  gcGraceMs?: number;
  /**
   * Which compaction strategy the engine should run. Serializable (crosses the
   * worker boundary), resolved to a CompactionStrategy inside the engine.
   * Absent = no compaction.
   */
  compaction?: CompactionSpec;
  /**
   * Read-amplification probe (M5): each snapshot counts the SSTables a
   * time-bounded query over [now − queryWindowMs, now] would touch — every
   * table whose [minTs, maxTs] span overlaps the window (Cassandra can skip
   * the rest via SSTable min/max timestamp metadata). Absent = 1 day.
   */
  queryWindowMs?: number;
  /**
   * Partition-skew model (M6). Absent = no skew accounting: the skew fields
   * in every snapshot are 0 and `SimResult.skew` is undefined.
   */
  skew?: SkewConfig;
  /**
   * Per-node compaction throughput cap in bytes/sec — Cassandra's
   * `compaction_throughput` (4.x default: 64 MiB/s). The engine itself still
   * compacts unthrottled; the cap only drives the backlog queue that decides
   * the saturation verdict (M7). Absent or 0 = uncapped, backlog stays empty.
   */
  compactionThroughputBytesPerSec?: number;
  /**
   * Usable disk per node in bytes, for the disk-exhaustion verdict (M7).
   * Absent or 0 = unbounded, verdict always ok.
   */
  diskPerNodeBytes?: number;
}

/**
 * Skew model (M6): writes spread across partitions on a Zipf curve — the
 * top-K hottest partitions are tracked individually, everything past them
 * pools into one aggregate tail bucket. Each hot partition hashes to a token
 * that lands in one node's range; that node plus the next RF−1 clockwise
 * hold its replicas, so hot partitions concentrate on specific nodes while
 * the tail spreads evenly.
 */
export interface SkewConfig {
  /** Distinct partitions the workload writes to (≥ 1). */
  partitionCount: number;
  /** Zipf exponent: 0 = uniform, ≈ 1 = classic hot-key skew. */
  zipfExponent: number;
  /** Hottest partitions tracked individually (clamped to partitionCount). */
  topK: number;
  /** Nodes on the token ring. */
  nodes: number;
  /** Replicas per partition; must be ≤ nodes. */
  replicationFactor: number;
  /**
   * Mitigation (M8): the most sub-shards a hot partition may be split into.
   * 1 or absent = off. A tracked partition doubles its sub-shard count — and
   * so re-keys onto fresh tokens — whenever one of its shards outgrows the
   * promotion trigger, up to this cap.
   */
  maxSubShards?: number;
}

/**
 * What "simulating the top-K partitions individually" collapses to: with a
 * constant per-partition share of writes and one uniform TTL, every
 * partition's on-disk bytes are exactly its share of the cluster totals at
 * all times — so the per-partition state is the weights and replica
 * assignments, and per-tick figures are share × running totals.
 *
 * Sub-sharding (M8) is what breaks that collapse: promoting a partition
 * changes its write share partway through the run, so the disk-share figures
 * below are the ones in force **at the horizon** rather than for all time.
 */
export interface SkewModel {
  /** Zipf write share of each of the top-K partitions, hottest first. */
  hotWeights: number[];
  /** Combined write share of every partition past the top K. */
  tailWeight: number;
  /**
   * Node ids still holding bytes of each hot partition at the horizon. RF
   * ring-consecutive entries without sub-sharding; a promoted partition adds
   * the nodes of every generation that has not finished draining.
   */
  hotReplicas: number[][];
  /** Fraction of cluster-wide disk bytes on each node at the horizon; sums to 1. */
  nodeShare: number[];
  /** Sub-shards each tracked partition ended the run split into (M8); 1 = never promoted. */
  subShards: number[];
}

/** STCS knobs, mirroring Cassandra's defaults; all optional. */
export interface StcsTuning {
  /** Fewest same-bucket SSTables that trigger a merge (Cassandra: 4). */
  minThreshold?: number;
  /** Most SSTables merged at once (Cassandra: 32). */
  maxThreshold?: number;
  /** Bucket membership: size ≥ avg × bucketLow (Cassandra: 0.5). */
  bucketLow?: number;
  /** Bucket membership: size ≤ avg × bucketHigh (Cassandra: 1.5). */
  bucketHigh?: number;
  /** Tables below this size share one bucket regardless of ratio (Cassandra: 50 MiB). */
  minSstableSizeBytes?: number;
}

/**
 * TWCS knobs. Time windows bucket SSTables by their newest data (maxTs);
 * the current window compacts with STCS using the inherited tuning, closed
 * windows compact to one SSTable each, and fully-expired SSTables are
 * dropped whole.
 */
export interface TwcsTuning extends StcsTuning {
  /** Time window size in ms (Cassandra: compaction_window_unit × size; default 1 day). */
  windowMs?: number;
}

export type CompactionSpec =
  | { strategy: 'none' }
  | ({ strategy: 'stcs' } & StcsTuning)
  | ({ strategy: 'twcs' } & TwcsTuning);

/** Emitted once per tick, at the end of the tick. */
export interface MetricsSnapshot {
  /** Epoch ms at the end of the tick. */
  t: number;
  liveBytes: number;
  expiredBytes: number;
  tombstoneBytes: number;
  /** live + expired + tombstone across all SSTables (excludes memtable). */
  diskBytes: number;
  memtableBytes: number;
  /**
   * SSTables across the whole cluster (a fleet total). Each node compacts its
   * own share independently, so once every node has flushed the count is at
   * least the node count; it is the per-node structure times `nodes`, which is
   * volume-driven without compaction (node-independent) and structure-driven
   * under TWCS/STCS (grows with the ring). Not the same as `SimResult.sstables`,
   * which is one aggregate compaction domain used for the byte accounting.
   */
  sstableCount: number;
  /** SSTables whose time span overlaps the trailing query window (M5 read amp). */
  readSstables: number;
  /**
   * Per-replica on-disk bytes of the widest single partition (M6) — of the
   * widest *sub-shard* once sub-sharding is on, which is the thing Cassandra
   * actually materializes. 0 without a skew config.
   */
  maxPartitionBytes: number;
  /** On-disk bytes on the fullest node (M6). 0 without a skew config. */
  hotNodeBytes: number;
  /**
   * Which node that is (M6). Only fixed for the whole run while shares are:
   * promoting a hot partition re-keys it onto fresh tokens, so the fullest
   * node can change hands mid-run (M8).
   */
  hotNode: number;
  /**
   * Sub-shards the hottest partition is writing to at this tick (M8). 1 until
   * its first promotion, and always 1 with the mitigation off.
   */
  hotPartitionShards: number;
  /** Bytes compaction wrote this tick, cluster-wide (M7). 0 without compaction. */
  compactionBytes: number;
  /**
   * Compaction the fullest node owes but the throughput cap has not paid off
   * (M7), in bytes. Stays 0 without a cap or a skew config. A queue that never
   * returns to 0 is the saturation verdict's evidence.
   */
  compactionBacklogBytes: number;
}

export interface SimResult {
  snapshots: MetricsSnapshot[];
  /**
   * Final SSTable set of the aggregate compaction domain (cluster bytes, RF
   * folded in), mostly for tests and debugging views. Its length is the
   * per-domain count, not the fleet total in `MetricsSnapshot.sstableCount`.
   */
  sstables: SSTable[];
  /** Resolved skew model — weights and replica placement (M6); undefined without a skew config. */
  skew?: SkewModel;
  /** Failure verdicts with the date each threshold was first crossed (M7). */
  verdicts: Verdict[];
}

/**
 * Failure verdicts (M7): three ways a cluster is mathematically bound to
 * fail, each a threshold with a date. `ok` is a real answer — it means the
 * metric never reached its warn line inside the simulated horizon, not that
 * the check was skipped.
 */
export type VerdictLevel = 'ok' | 'warn' | 'fatal';

export type VerdictId = 'wide-partition' | 'compaction-saturation' | 'disk-asymmetry';

/** The moment a metric first reached a threshold. */
export interface VerdictCrossing {
  /** Epoch ms of the first snapshot at or past the threshold. */
  at: number;
  /** Whole days from the start of the simulation. */
  day: number;
  /** The metric's value at that snapshot. */
  value: number;
  /** The threshold it reached. */
  threshold: number;
}

interface VerdictBase {
  level: VerdictLevel;
  /** The deciding metric at the horizon, in this verdict's own unit. */
  value: number;
  /**
   * The metric's maximum anywhere in the run, same unit. Not decoration: an
   * STCS sawtooth can peak at twice its horizon value, so a cluster that reads
   * as half full at the end of the run spent every cycle running out of disk.
   * `value` alone would hide that; the verdict is decided on the peak.
   */
  peak: number;
  /** The warn line the metric is read against, same unit — shown even when ok. */
  limit: number;
  warn: VerdictCrossing | null;
  fatal: VerdictCrossing | null;
}

/**
 * Cassandra degrades past ~100 MB in a single partition (repair, read and
 * compaction all materialize a partition at a time) and falls over in the
 * multi-GB range. Measured per replica, which is how the guidance is stated.
 */
export interface WidePartitionVerdict extends VerdictBase {
  id: 'wide-partition';
  /** Partitions the writes spread over — the lever that fixes this verdict. */
  partitionCount: number;
  /** Sub-shards the hottest partition ended on (M8); 1 = never promoted. */
  subShards: number;
  /** The cap sub-sharding was allowed to promote to; 1 = mitigation off. */
  maxSubShards: number;
  /**
   * The last step-up promotion (M8): when it fired and how wide the partition
   * had grown by then. `value` above the warn line means the mitigation was
   * switched on too late to have prevented the crossing it is now fixing.
   */
  promoted: VerdictCrossing | null;
}

/**
 * Compaction is a queue: work arrives at `ingest × writeAmp` and drains at
 * the throughput cap. ρ > 1 means the backlog grows without bound — no
 * amount of time lets it catch up, so the crossing day is a hard date.
 */
export interface CompactionSaturationVerdict extends VerdictBase {
  id: 'compaction-saturation';
  /** Fullest node — the most write-loaded, so the first to saturate. */
  node: number;
  /** That node's sustained compaction write rate over the final quarter, bytes/s. */
  writeRateBytesPerSec: number;
  /** The per-node cap it drains at, bytes/s. */
  capBytesPerSec: number;
  /** Backlog still queued at the horizon, bytes. */
  backlogBytes: number;
  /**
   * Whether a compaction strategy is running at all. Without one the queue is
   * trivially empty, which is not the same answer as "compaction keeps up" —
   * that cluster fails on read amplification instead.
   */
  compacting: boolean;
}

/**
 * The cluster average stays healthy while one replica fills: skew puts more
 * of the data on whichever nodes own the hot partitions' token ranges.
 */
export interface DiskAsymmetryVerdict extends VerdictBase {
  id: 'disk-asymmetry';
  /** Fullest node. */
  node: number;
  /**
   * Cluster-average bytes per node **at the tick the hot node peaked** — the
   * reassuring number, measured at the same moment so the gap between it and
   * `peak` is real asymmetry rather than the sawtooth.
   */
  averageBytes: number;
  /** Usable disk per node. */
  capacityBytes: number;
}

export type Verdict = WidePartitionVerdict | CompactionSaturationVerdict | DiskAsymmetryVerdict;
