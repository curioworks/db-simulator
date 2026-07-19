/** One regular (non-key) column in the table schema. */
export interface ColumnSpec {
  name: string;
  /** Average encoded size in bytes of the value payload. */
  valueBytes: number;
  /**
   * Per-cell metadata overhead (timestamp, flags, cell path). Cassandra 3.x+
   * storage engine: ~8B for a bare cell up to ~25B with TTL + complex path.
   */
  cellOverheadBytes?: number;
}

export interface SchemaProfile {
  columns: ColumnSpec[];
  /** Combined average encoded size of all clustering key columns. */
  clusteringKeyBytes: number;
  /** Fixed per-row overhead (flags, liveness info, row body header). */
  rowOverheadBytes?: number;
}

export interface SizeModelInput {
  schema: SchemaProfile;
  /**
   * Fraction of bytes removed by on-disk compression, in [0, 1).
   * LZ4 on typical time-series data saves ~0.3–0.5.
   */
  compressionRatio: number;
  /** Number of replicas each row is written to (cluster-wide accounting). */
  replicationFactor: number;
}

export interface SizeModel {
  /** Uncompressed bytes per row on a single replica. */
  rawRowBytes: number;
  /** Compressed on-disk bytes per row on a single replica. */
  compressedRowBytes: number;
  /** Cluster-wide on-disk bytes per row: compressed × RF. */
  onDiskRowBytes: number;
}
