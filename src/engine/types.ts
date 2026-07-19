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
}

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
