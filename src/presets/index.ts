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
  compaction: 'none',
  twcsWindowDays: 1,
  gcGraceDays: 10,
  queryWindowHours: 24,
  seed: 42,
};

/**
 * The M2 classic mistake: a 7-day TTL "keeps the table small" — but without
 * compaction nothing is ever dropped. Live bytes plateau after a week while
 * the disk line keeps climbing. Expired ≠ deleted. Reads hurt too (M5): at
 * ~69 flushes/day, a day-long query has to touch ~70 SSTables — the same
 * read touches at most 9 once any compaction strategy is on.
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
  compaction: 'none',
  twcsWindowDays: 1,
  gcGraceDays: 10,
  queryWindowHours: 24,
  seed: 42,
};

/**
 * Same workload with STCS turned on (M3): the disk line finally comes back
 * down — but late and in lumps. Small tiers merge and reclaim a slice every
 * few days; the big tier holds weeks of expired data hostage until its
 * 4-table merge finally fires. Sets up TWCS (M4) as the fix.
 */
export const ttlStcs: ScenarioConfig = {
  ...ttlNoCompaction,
  name: 'TTL 7d + STCS (late, lumpy reclaim)',
  compaction: 'stcs',
};

/**
 * The M4 flagship mistake: TWCS with a window that dwarfs the TTL. Each 30d
 * window compacts once when it closes and then sits there, expired bytes and
 * all, until the whole window ages past TTL + gc_grace. The disk line goes
 * flat — but as a sawtooth between ~73 and ~146 GiB (avg 3.5× the 29.5 GiB
 * live), shedding a whole ~72 GiB window at a time, and it never comes down
 * to the live line.
 */
export const ttlTwcsWide: ScenarioConfig = {
  ...ttlNoCompaction,
  name: 'TTL 7d + TWCS 30d window (window ≫ TTL)',
  compaction: 'twcs',
  twcsWindowDays: 30,
};

/**
 * The fix: 1-day windows, so whole windows expire and drop daily. Disk goes
 * genuinely flat at TTL + gc_grace + 1 = 18 days of data (~75 GiB, 2.6×
 * live). The remaining gap above the live line is gc_grace: slide it to 0
 * and disk hugs live at 1.07×.
 */
export const ttlTwcsTuned: ScenarioConfig = {
  ...ttlTwcsWide,
  name: 'TTL 7d + TWCS 1d window (the fix)',
  twcsWindowDays: 1,
};

export const presets: ScenarioConfig[] = [
  sensorBaseline,
  ttlNoCompaction,
  ttlStcs,
  ttlTwcsWide,
  ttlTwcsTuned,
];
