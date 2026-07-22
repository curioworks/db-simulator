/**
 * One column in the table schema. Regular columns are *cells*: value payload
 * plus per-cell metadata (`cellOverheadBytes`). Set `key: true` to mark a
 * column as part of the clustering key instead — stored once as the row's
 * clustering prefix, so it carries no per-cell overhead, and it is the only
 * part of a row that a row-deletion tombstone still has to name.
 */
export interface ColumnSpec {
  name: string;
  /** Average encoded size in bytes of the value payload. */
  valueBytes: number;
  /**
   * Per-cell metadata overhead (timestamp, flags, cell path). Cassandra 3.x+
   * storage engine: ~8B for a bare cell up to ~25B with TTL + complex path.
   * Ignored for clustering-key columns (`key: true`), which are not cells.
   */
  cellOverheadBytes?: number;
  /**
   * True if this column is part of the clustering key: a clustering-prefix
   * component, not a cell — no per-cell timestamp/flags, and counted into the
   * row tombstone. Absent/false = a regular data cell.
   */
  key?: boolean;
}

export interface SchemaProfile {
  /** Every column, regular and clustering-key alike (`ColumnSpec.key`). */
  columns: ColumnSpec[];
  /** Fixed per-row overhead (flags, liveness info, row body header). */
  rowOverheadBytes?: number;
  /**
   * Partition-key size in bytes, stored **once per partition** — not per row.
   * Cassandra writes the partition key into each SSTable's partition header, so
   * its cost is `partitionCount × this` (a flat term), never multiplied by the
   * row count. Deliberately separate from the per-row clustering columns
   * (`ColumnSpec.key`), which are stored as the clustering prefix of every row.
   * 0 or absent = not modelled.
   */
  partitionKeyBytes?: number;
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
  /**
   * Cluster-wide on-disk bytes of one row-deletion tombstone: clustering key +
   * row overhead + deletion marker, compressed × RF. No cell values — a
   * tombstone is a marker, not data.
   */
  tombstoneRowBytes: number;
  /**
   * Cluster-wide on-disk bytes of the partition key for **one** partition:
   * partitionKeyBytes × (1 − compression) × RF. Stored once per partition, so
   * the engine multiplies it by the partition count into a single flat term —
   * it is never part of `onDiskRowBytes`. 0 when no partition key is set.
   */
  partitionKeyOnDiskBytes: number;
}
