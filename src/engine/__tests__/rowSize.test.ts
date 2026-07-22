import { describe, expect, it } from 'vitest';
import { buildSizeModel } from '../profiler/rowSize.ts';
import type { SchemaProfile } from '../profiler/types.ts';

/**
 * Hand-validated baseline: a sensor-reading table.
 *
 *   sensor_value double:   8B value + 12B cell overhead = 20
 *   status text (~20B):   20B value + 12B cell overhead = 32
 *   ts (clustering key):   8B value, no cell overhead   =  8
 *   row overhead: 10
 *   ─────────────────────────────────────────────
 *   raw        = 20 + 32 + 8 + 10 = 70
 *   compressed = 70 × (1 − 0.5)   = 35
 *   on disk    = 35 × RF 3        = 105
 */
const sensorSchema: SchemaProfile = {
  columns: [
    { name: 'sensor_value', valueBytes: 8, cellOverheadBytes: 12 },
    { name: 'status', valueBytes: 20, cellOverheadBytes: 12 },
    { name: 'ts', valueBytes: 8, key: true },
  ],
  rowOverheadBytes: 10,
};

describe('buildSizeModel', () => {
  it('matches the hand-computed sensor table baseline', () => {
    const m = buildSizeModel({ schema: sensorSchema, compressionRatio: 0.5, replicationFactor: 3 });
    expect(m.rawRowBytes).toBe(70);
    expect(m.compressedRowBytes).toBe(35);
    expect(m.onDiskRowBytes).toBe(105);
  });

  it('applies default cell (12B) and row (10B) overheads', () => {
    // 1 column: 8 + 12 default = 20; no key column; row overhead default 10 → 30
    const m = buildSizeModel({
      schema: { columns: [{ name: 'v', valueBytes: 8 }] },
      compressionRatio: 0,
      replicationFactor: 1,
    });
    expect(m.rawRowBytes).toBe(30);
    expect(m.onDiskRowBytes).toBe(30);
    // No partition key set → no flat term.
    expect(m.partitionKeyOnDiskBytes).toBe(0);
  });

  it('charges the partition key once per partition, apart from the row', () => {
    const m = buildSizeModel({
      schema: { columns: [{ name: 'v', valueBytes: 8 }], partitionKeyBytes: 16 },
      compressionRatio: 0.5,
      replicationFactor: 3,
    });
    // The row body is untouched by the partition key: 8 + 12 + 10 = 30 raw.
    expect(m.rawRowBytes).toBe(30);
    expect(m.onDiskRowBytes).toBe(45); // 30 × 0.5 × 3
    // Partition key is its own per-partition cost: 16 × 0.5 × 3 = 24, never
    // folded into the row.
    expect(m.partitionKeyOnDiskBytes).toBe(24);
  });

  it('treats key columns as clustering prefix: value only, and drives tombstone size', () => {
    // one 8B data cell (8 + 12 default = 20), one 8B key column (8, no cell
    // overhead), row overhead default 10.
    const m = buildSizeModel({
      schema: {
        columns: [
          { name: 'v', valueBytes: 8 },
          { name: 'ts', valueBytes: 8, key: true },
        ],
      },
      compressionRatio: 0,
      replicationFactor: 1,
    });
    // raw = 20 + 8 + 10 = 38 (the key column adds no per-cell overhead)
    expect(m.rawRowBytes).toBe(38);
    // tombstone names the clustering key only: keyBytes 8 + row 10 + marker 12
    expect(m.tombstoneRowBytes).toBe(30);
  });

  it('rejects out-of-range inputs', () => {
    const schema = sensorSchema;
    expect(() => buildSizeModel({ schema, compressionRatio: 1, replicationFactor: 3 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: -0.1, replicationFactor: 3 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: 0.5, replicationFactor: 0 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: 0.5, replicationFactor: 1.5 })).toThrow(RangeError);
    expect(() =>
      buildSizeModel({
        schema: { columns: [{ name: 'v', valueBytes: -1 }] },
        compressionRatio: 0,
        replicationFactor: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildSizeModel({
        schema: { columns: [{ name: 'v', valueBytes: 8 }], partitionKeyBytes: -1 },
        compressionRatio: 0,
        replicationFactor: 1,
      }),
    ).toThrow(RangeError);
  });
});
