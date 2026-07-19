import { DAY_MS, type ScenarioConfig } from './scenario.ts';

/**
 * Baseline preset — the same numbers as the hand-validated tests:
 * 70 B raw → 35 B compressed → 105 B on disk (RF 3), 100 rows/s.
 */
export const sensorBaseline: ScenarioConfig = {
  name: 'Sensor readings (baseline)',
  schema: {
    columns: [
      { name: 'sensor_value', valueBytes: 8, cellOverheadBytes: 12 },
      { name: 'status', valueBytes: 20, cellOverheadBytes: 12 },
    ],
    clusteringKeyBytes: 8,
    rowOverheadBytes: 10,
  },
  compressionRatio: 0.5,
  replicationFactor: 3,
  writeRatePerSec: 100,
  tickMs: DAY_MS,
  days: 365,
  memtableFlushMiB: 64,
  seed: 42,
};

export const presets: ScenarioConfig[] = [sensorBaseline];
