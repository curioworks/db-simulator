import { DAY_MS, HOUR_MS, type ScenarioConfig } from './scenario.ts';

const sensorSchema: ScenarioConfig['schema'] = {
  columns: [
    { name: 'sensor_value', valueBytes: 8, cellOverheadBytes: 12 },
    { name: 'status', valueBytes: 20, cellOverheadBytes: 12 },
  ],
  clusteringKeyBytes: 8,
  rowOverheadBytes: 10,
};

/**
 * Baseline preset — the same numbers as the hand-validated tests:
 * 70 B raw → 35 B compressed → 105 B on disk (RF 3), 100 rows/s.
 */
export const sensorBaseline: ScenarioConfig = {
  name: 'Sensor readings (baseline)',
  schema: sensorSchema,
  compressionRatio: 0.5,
  replicationFactor: 3,
  writeRatePerSec: 100,
  tickMs: DAY_MS,
  days: 365,
  memtableFlushMiB: 64,
  ttlDays: 0,
  deleteRatePerSec: 0,
  seed: 42,
};

/**
 * The M2 classic mistake: a 7-day TTL "keeps the table small" — but without
 * compaction nothing is ever dropped. Live bytes plateau after a week while
 * the disk line keeps climbing. Expired ≠ deleted.
 */
export const ttlNoCompaction: ScenarioConfig = {
  name: 'TTL 7d, no compaction (expired ≠ deleted)',
  schema: sensorSchema,
  compressionRatio: 0.5,
  replicationFactor: 3,
  writeRatePerSec: 500,
  tickMs: HOUR_MS,
  days: 90,
  memtableFlushMiB: 64,
  ttlDays: 7,
  deleteRatePerSec: 25,
  seed: 42,
};

export const presets: ScenarioConfig[] = [sensorBaseline, ttlNoCompaction];
