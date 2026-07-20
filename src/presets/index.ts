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
  partitionCount: 100_000,
  skewExponent: 0.3,
  nodes: 6,
  diskPerNodeGiB: 1024,
  compactionMiBPerSec: 64,
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
  partitionCount: 100_000,
  skewExponent: 0.3,
  nodes: 6,
  diskPerNodeGiB: 1024,
  compactionMiBPerSec: 64,
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

/**
 * The M6 mistake: a partition key too coarse for the data volume. Same tuned
 * TWCS workload — disk is flat and healthy at the cluster level — but the
 * writes land on only 500 partitions with a Zipf 1.4 head, so the hottest
 * partition alone carries a multi-GB slab (Cassandra warns past 100 MB), and
 * the 8 tracked partitions pin two thirds of the bytes onto whichever nodes
 * own their token ranges. Cluster average looks fine; the fullest node
 * doesn't.
 */
export const hotPartitions: ScenarioConfig = {
  ...ttlTwcsTuned,
  name: 'Hot partitions (key too coarse)',
  partitionCount: 500,
  skewExponent: 1.4,
  nodes: 6,
};

/**
 * The M7 mistake: compaction_throughput throttled to protect read latency,
 * on a workload big enough that it can never catch up. 2 KB events at 3,500
 * rows/s put 1.8 MB/s of new data on each node; STCS rewrites every byte ~5
 * times over its life, so each node owes ~9.7 MB/s of compaction against an
 * 8 MiB/s cap. ρ = 1.15, and a queue with ρ > 1 has no steady state — the
 * backlog passes 8 TB by the horizon and would keep going.
 *
 * The disk line is the trap. It reads as a healthy 1.25 TB per node at the
 * horizon, but STCS's lumpy reclaim swings it to 2.5 TB — 83% of the disk —
 * every cycle, while the cluster average sits at 42%. Alert on the horizon
 * value and you never see it; alert on the peak and you do.
 *
 * No single slider fixes both, which is the lesson. TWCS windows sized to the
 * TTL drop whole windows instead of rewriting them and cut the compaction
 * bill from 9.2 to 6.4 MiB/s — but that is still ρ 0.80, a warning, even
 * though it halves the disk to 3.48 TB and clears the disk verdict. Raising
 * the cap to Cassandra's stock 64 MiB/s takes ρ to 0.14 and leaves the disk
 * peak exactly where it was. Doubling the ring to 12 nodes is the only single
 * move that clears both (ρ 0.57, peak 42%), because it is the only one that
 * divides the per-node load rather than the per-node work.
 */
export const compactionThrottled: ScenarioConfig = {
  name: 'Compaction throttled (backlog never drains)',
  schema: {
    columns: [
      { name: 'event_id', valueBytes: 16, cellOverheadBytes: 12 },
      { name: 'payload', valueBytes: 2048, cellOverheadBytes: 12 },
    ],
    clusteringKeyBytes: 8,
    rowOverheadBytes: 10,
  },
  compressionRatio: 0.5,
  replicationFactor: 3,
  writeRatePerSec: 3500,
  tickMs: HOUR_MS,
  days: 90,
  // A big memtable is what keeps a 28 TB-per-month workload inside the
  // milliseconds budget: sim cost tracks the flush count, not the byte count.
  memtableFlushMiB: 512,
  ttlDays: 3,
  deleteRatePerSec: 0,
  compaction: 'stcs',
  twcsWindowDays: 1,
  gcGraceDays: 1,
  queryWindowHours: 24,
  // Enough keys that the partition verdict stays quiet — this preset is about
  // compaction, not the schema.
  partitionCount: 10_000_000,
  skewExponent: 0.3,
  nodes: 6,
  diskPerNodeGiB: 3072,
  compactionMiBPerSec: 8,
  seed: 42,
};

export const presets: ScenarioConfig[] = [
  sensorBaseline,
  ttlNoCompaction,
  ttlStcs,
  ttlTwcsWide,
  ttlTwcsTuned,
  hotPartitions,
  compactionThrottled,
];
