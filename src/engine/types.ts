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

export type CompactionSpec = { strategy: 'none' } | ({ strategy: 'stcs' } & StcsTuning);

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
}

export interface SimResult {
  snapshots: MetricsSnapshot[];
  /** Final SSTable set, mostly for tests and debugging views. */
  sstables: SSTable[];
}
