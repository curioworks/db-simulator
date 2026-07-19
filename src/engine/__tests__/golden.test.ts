import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import type { SimConfig, SimResult } from '../types.ts';

/**
 * Golden-file test: fixed seed + config → exact committed time series.
 * Any change to flush/compaction math must show up as a diff here.
 *
 * Regenerate deliberately with:  UPDATE_GOLDEN=1 npm test
 */
const goldenPath = fileURLToPath(new URL('./golden/m1-write-only-growth.json', import.meta.url));

const config: SimConfig = {
  seed: 42,
  startTime: Date.UTC(2026, 0, 1),
  tickMs: 86_400_000, // 1d ticks
  ticks: 365, // one year
  writeRatePerSec: 100,
  onDiskRowBytes: 105,
  memtableFlushBytes: 67_108_864, // 64 MiB
};

describe('golden: M1 write-only growth, daily ticks × 365', () => {
  it('reproduces the committed time series exactly', () => {
    const actual = simulate(config);

    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(goldenPath, JSON.stringify({ config, ...actual }, null, 2) + '\n');
    }
    expect(existsSync(goldenPath), 'golden file missing — run with UPDATE_GOLDEN=1').toBe(true);

    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as SimResult & { config: SimConfig };
    expect(golden.config).toEqual(config);
    // toEqual on JSON-round-tripped numbers is exact: JS serializes doubles
    // with round-trip precision.
    expect(actual.snapshots).toEqual(golden.snapshots);
    expect(actual.sstables).toEqual(golden.sstables);
  });
});
