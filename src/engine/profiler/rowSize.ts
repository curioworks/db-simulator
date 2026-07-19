import type { SizeModel, SizeModelInput } from './types.ts';

export const DEFAULT_CELL_OVERHEAD_BYTES = 12;
export const DEFAULT_ROW_OVERHEAD_BYTES = 10;

/**
 * Manual-schema size model:
 *
 *   rawRowBytes = Σ(valueBytes + cellOverhead) + clusteringKeyBytes + rowOverhead
 *   onDiskRowBytes = rawRowBytes × (1 - compressionRatio) × replicationFactor
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
  if (schema.clusteringKeyBytes < 0) {
    throw new RangeError(`clusteringKeyBytes must be ≥ 0, got ${schema.clusteringKeyBytes}`);
  }

  let cellBytes = 0;
  for (const col of schema.columns) {
    if (col.valueBytes < 0) {
      throw new RangeError(`column "${col.name}": valueBytes must be ≥ 0, got ${col.valueBytes}`);
    }
    cellBytes += col.valueBytes + (col.cellOverheadBytes ?? DEFAULT_CELL_OVERHEAD_BYTES);
  }

  const rawRowBytes =
    cellBytes + schema.clusteringKeyBytes + (schema.rowOverheadBytes ?? DEFAULT_ROW_OVERHEAD_BYTES);
  const compressedRowBytes = rawRowBytes * (1 - compressionRatio);
  const onDiskRowBytes = compressedRowBytes * replicationFactor;

  return { rawRowBytes, compressedRowBytes, onDiskRowBytes };
}
