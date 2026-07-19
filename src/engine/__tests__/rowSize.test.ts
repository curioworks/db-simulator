import { describe, expect, it } from 'vitest';
import { buildSizeModel } from '../profiler/rowSize.ts';
import type { SchemaProfile } from '../profiler/types.ts';

/**
 * Hand-validated baseline: a sensor-reading table.
 *
 *   sensor_value double:  8B value + 12B cell overhead = 20
 *   status text (~20B):  20B value + 12B cell overhead = 32
 *   clustering key (timestamp): 8
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
  ],
  clusteringKeyBytes: 8,
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
    // 1 column: 8 + 12 default = 20; clustering 0; row overhead default 10 → 30
    const m = buildSizeModel({
      schema: { columns: [{ name: 'v', valueBytes: 8 }], clusteringKeyBytes: 0 },
      compressionRatio: 0,
      replicationFactor: 1,
    });
    expect(m.rawRowBytes).toBe(30);
    expect(m.onDiskRowBytes).toBe(30);
  });

  it('rejects out-of-range inputs', () => {
    const schema = sensorSchema;
    expect(() => buildSizeModel({ schema, compressionRatio: 1, replicationFactor: 3 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: -0.1, replicationFactor: 3 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: 0.5, replicationFactor: 0 })).toThrow(RangeError);
    expect(() => buildSizeModel({ schema, compressionRatio: 0.5, replicationFactor: 1.5 })).toThrow(RangeError);
    expect(() =>
      buildSizeModel({
        schema: { columns: [{ name: 'v', valueBytes: -1 }], clusteringKeyBytes: 0 },
        compressionRatio: 0,
        replicationFactor: 1,
      }),
    ).toThrow(RangeError);
  });
});
