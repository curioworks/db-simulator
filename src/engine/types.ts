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
}

/**
 * What "simulating the top-K partitions individually" collapses to: with a
 * constant per-partition share of writes and one uniform TTL, every
 * partition's on-disk bytes are exactly its share of the cluster totals at
 * all times — so the per-partition state is the weights and replica
 * assignments, and per-tick figures are share × running totals.
 */
export interface SkewModel {
  /** Zipf write share of each of the top-K partitions, hottest first. */
  hotWeights: number[];
  /** Combined write share of every partition past the top K. */
  tailWeight: number;
  /** Node ids holding each hot partition — RF ring-consecutive entries each. */
  hotReplicas: number[][];
  /** Fraction of cluster-wide disk bytes on each node; sums to 1. */
  nodeShare: number[];
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
  sstableCount: number;
  /** SSTables whose time span overlaps the trailing query window (M5 read amp). */
  readSstables: number;
  /** Per-replica on-disk bytes of the single hottest partition (M6). 0 without a skew config. */
  maxPartitionBytes: number;
  /** On-disk bytes on the fullest node (M6). 0 without a skew config. */
  hotNodeBytes: number;
}

export interface SimResult {
  snapshots: MetricsSnapshot[];
  /** Final SSTable set, mostly for tests and debugging views. */
  sstables: SSTable[];
  /** Resolved skew model — weights and replica placement (M6); undefined without a skew config. */
  skew?: SkewModel;
}
