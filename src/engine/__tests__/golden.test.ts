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
const m1Config: SimConfig = {
  seed: 42,
  startTime: Date.UTC(2026, 0, 1),
  tickMs: 86_400_000, // 1d ticks
  ticks: 365, // one year
  writeRatePerSec: 100,
  onDiskRowBytes: 105,
  memtableFlushBytes: 67_108_864, // 64 MiB
};

const m2Config: SimConfig = {
  ...m1Config,
  ttlMs: 30 * 86_400_000, // 30d TTL
  deleteRatePerSec: 20,
  tombstoneRowBytes: 45,
};

const m3Config: SimConfig = {
  ...m2Config,
  gcGraceMs: 10 * 86_400_000, // 10d gc_grace
  compaction: { strategy: 'stcs' },
};

const m4Config: SimConfig = {
  ...m3Config,
  compaction: { strategy: 'twcs', windowMs: 7 * 86_400_000 }, // 7d windows
};

const m5Config: SimConfig = {
  ...m4Config,
  queryWindowMs: 3 * 86_400_000, // read amp over a 3d query window
};

const m6Config: SimConfig = {
  ...m5Config,
  // Zipf 1.1 over 10K partitions, 8 tracked individually, on a 6-node RF-3 ring.
  skew: {
    partitionCount: 10_000,
    zipfExponent: 1.1,
    topK: 8,
    nodes: 6,
    replicationFactor: 3,
  },
};

const m7Config: SimConfig = {
  ...m6Config,
  // A throughput cap the workload saturates and a node disk it crowds, so the
  // golden pins real crossings rather than three ok verdicts — and lands one
  // verdict on each level: fatal, fatal, warn.
  compactionThroughputBytesPerSec: 4096,
  diskPerNodeBytes: 10 * 1024 * 1024 * 1024,
};

const m8Config: SimConfig = {
  ...m7Config,
  // The same run with the mitigation on. 8 sub-shards is the cap, so the
  // golden pins the promotion ladder — the shard count stepping up, and the
  // widest partition going flat at each step instead of dropping.
  skew: { ...m6Config.skew!, maxSubShards: 8 },
};

function checkGolden(name: string, config: SimConfig) {
  const goldenPath = fileURLToPath(new URL(`./golden/${name}.json`, import.meta.url));
  const actual = simulate(config);

  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(goldenPath, JSON.stringify({ config, ...actual }, null, 2) + '\n');
  }
  expect(existsSync(goldenPath), `golden file ${name} missing — run with UPDATE_GOLDEN=1`).toBe(true);

  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as SimResult & { config: SimConfig };
  expect(golden.config).toEqual(config);
  // toEqual on JSON-round-tripped numbers is exact: JS serializes doubles
  // with round-trip precision.
  expect(actual.snapshots).toEqual(golden.snapshots);
  expect(actual.sstables).toEqual(golden.sstables);
  expect(actual.skew).toEqual(golden.skew);
  expect(actual.verdicts).toEqual(golden.verdicts);
}

describe('golden time series (fixed seed + config → exact committed output)', () => {
  it('M1: write-only growth, daily ticks × 365', () => {
    checkGolden('m1-write-only-growth', m1Config);
  });

  it('M2: 30d TTL + deletes, daily ticks × 365', () => {
    checkGolden('m2-ttl-tombstones', m2Config);
  });

  it('M3: 30d TTL + deletes + STCS with 10d gc_grace, daily ticks × 365', () => {
    checkGolden('m3-stcs-ttl', m3Config);
  });

  it('M4: 30d TTL + deletes + TWCS 7d windows with 10d gc_grace, daily ticks × 365', () => {
    checkGolden('m4-twcs-ttl', m4Config);
  });

  it('M5: same TWCS run with a 3d query window for read amplification', () => {
    checkGolden('m5-readamp', m5Config);
  });

  it('M6: same run with Zipf 1.1 skew over 10K partitions on a 6-node RF-3 ring', () => {
    checkGolden('m6-skew', m6Config);
  });

  it('M7: same run under a compaction cap and a node disk it outgrows', () => {
    checkGolden('m7-verdicts', m7Config);
  });

  it('M8: same run with sub-sharding promoting the hot partitions up to 8 shards', () => {
    checkGolden('m8-subshards', m8Config);
  });
});
