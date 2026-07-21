import type { SizeModel, SizeModelInput } from './types.ts';

export const DEFAULT_CELL_OVERHEAD_BYTES = 12;
export const DEFAULT_ROW_OVERHEAD_BYTES = 10;
/** Deletion info on a row tombstone: markedForDeleteAt (8B) + localDeletionTime (4B). */
export const TOMBSTONE_MARKER_BYTES = 12;

/**
 * Manual-schema size model. Columns split into regular *cells* (value + per-
 * cell overhead) and clustering-key columns (`key: true`), which are the row's
 * clustering prefix — value bytes only, no per-cell overhead:
 *
 *   keyBytes       = Σ_key(valueBytes)
 *   cellBytes      = Σ_regular(valueBytes + cellOverhead)
 *   rawRowBytes    = cellBytes + keyBytes + rowOverhead
 *   onDiskRowBytes = rawRowBytes × (1 - compressionRatio) × replicationFactor
 *
 * A row-deletion tombstone names the clustering key but carries no cell values,
 * so it costs keyBytes + rowOverhead + marker.
 *
 * (A sampling-based profiler over CSV/JSON rows lands later; it must produce
 * the same SizeModel shape.)
 */
export function buildSizeModel(input: SizeModelInput): SizeModel {
  const { schema, compressionRatio, replicationFactor } = input;

  if (!(compressionRatio >= 0 && compressionRatio < 1)) {
    throw new RangeError(`compressionRatio must be in [0, 1), got ${compressionRatio}`);
  }
  if (!Number.isInteger(replicationFactor) || replicationFactor < 1) {
    throw new RangeError(`replicationFactor must be a positive integer, got ${replicationFactor}`);
  }

  let cellBytes = 0;
  let keyBytes = 0;
  for (const col of schema.columns) {
    if (col.valueBytes < 0) {
      throw new RangeError(`column "${col.name}": valueBytes must be ≥ 0, got ${col.valueBytes}`);
    }
    if (col.key) {
      keyBytes += col.valueBytes;
    } else {
      cellBytes += col.valueBytes + (col.cellOverheadBytes ?? DEFAULT_CELL_OVERHEAD_BYTES);
    }
  }

  const rowOverhead = schema.rowOverheadBytes ?? DEFAULT_ROW_OVERHEAD_BYTES;
  const rawRowBytes = cellBytes + keyBytes + rowOverhead;
  const compressedRowBytes = rawRowBytes * (1 - compressionRatio);
  const onDiskRowBytes = compressedRowBytes * replicationFactor;

  const rawTombstoneBytes = keyBytes + rowOverhead + TOMBSTONE_MARKER_BYTES;
  const tombstoneRowBytes = rawTombstoneBytes * (1 - compressionRatio) * replicationFactor;

  return { rawRowBytes, compressedRowBytes, onDiskRowBytes, tombstoneRowBytes };
}
