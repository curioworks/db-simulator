import type { ColumnSpec, SchemaProfile } from '../engine/profiler/types.ts';
import type { SimConfig } from '../engine/types.ts';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MiB = 1_048_576;

/**
 * Everything a shareable scenario link carries. UI state ⇄ base64 URL param.
 * Pure data — no DOM, importable from engine tests and presets alike.
 */
export interface ScenarioConfig {
  name: string;
  schema: SchemaProfile;
  /** Fraction of bytes removed by compression, [0, 1). */
  compressionRatio: number;
  replicationFactor: number;
  writeRatePerSec: number;
  /** Tick resolution: HOUR_MS or DAY_MS. */
  tickMs: number;
  /** Simulated horizon in days. */
  days: number;
  memtableFlushMiB: number;
  /** Row TTL in days; 0 = no TTL. */
  ttlDays: number;
  /** Row deletions per second, cluster-wide (each writes a tombstone). */
  deleteRatePerSec: number;
  /** Compaction strategy; STCS/TWCS run with Cassandra-default size tuning (M3/M4). */
  compaction: 'none' | 'stcs' | 'twcs';
  /** TWCS window size in days; only used when compaction is 'twcs'. */
  twcsWindowDays: number;
  /** gc_grace in days; gates purging of expired data and tombstones. */
  gcGraceDays: number;
  /** How far back a typical read scans, in hours; drives the read-amp metric (M5). */
  queryWindowHours: number;
  /** Distinct partitions the workload writes to (M6). */
  partitionCount: number;
  /** Zipf exponent for write skew (M6): 0 = uniform, ~1 = classic hot-key. */
  skewExponent: number;
  /** Nodes on the token ring (M6); always ≥ replicationFactor. */
  nodes: number;
  /**
   * Mitigation (M8): most sub-shards a hot partition may be promoted to.
   * 1 = off. Powers of two, since the bucket column is `hash(x) % S`.
   */
  maxSubShards: number;
  /** Usable disk per node in GiB (M7) — the disk-exhaustion verdict's limit. */
  diskPerNodeGiB: number;
  /** Per-node compaction throughput cap in MiB/s (M7); Cassandra 4.x default 64. */
  compactionMiBPerSec: number;
  seed: number;
}

/**
 * Hot partitions tracked individually (M6); everything past them is one
 * aggregate tail bucket. Fixed rather than exposed — 8 is enough to show the
 * head of any Zipf curve, and the tail carries the rest exactly.
 */
export const TOP_K_PARTITIONS = 8;

/**
 * Clamp every field into engine-legal ranges. URL-decoded scenarios are
 * untrusted (hand-editable), and clamped UI inputs mean buildSizeModel /
 * simulate can never throw on user input.
 */
export function clampScenario(s: ScenarioConfig): ScenarioConfig {
  const num = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  const replicationFactor = Math.round(num(s.replicationFactor, 1, 10, 3));

  // Schema is one unified column list; clustering-key columns (`key`) carry
  // value bytes only, regular columns keep their per-cell overhead.
  const columns: ColumnSpec[] = s.schema.columns.map((c, i) => {
    const col: ColumnSpec = { name: c.name || `col_${i + 1}`, valueBytes: num(c.valueBytes, 0, 1_000_000, 8) };
    if (c.key) col.key = true;
    else if (c.cellOverheadBytes !== undefined) col.cellOverheadBytes = num(c.cellOverheadBytes, 0, 100, 12);
    return col;
  });
  // Pre-unification links carried the clustering key as a scalar; fold it into
  // the column list as a key column so old #c=… links still resolve.
  const legacyClustering = (s.schema as { clusteringKeyBytes?: unknown }).clusteringKeyBytes;
  if (!columns.some((c) => c.key) && typeof legacyClustering === 'number' && legacyClustering > 0) {
    columns.push({ name: 'clustering_key', valueBytes: num(legacyClustering, 0, 100_000, 8), key: true });
  }

  return {
    ...s,
    name: s.name || 'Custom scenario',
    compressionRatio: num(s.compressionRatio, 0, 0.95, 0.5),
    replicationFactor,
    writeRatePerSec: num(s.writeRatePerSec, 0, 10_000_000, 100),
    tickMs: s.tickMs === HOUR_MS ? HOUR_MS : DAY_MS,
    days: Math.round(num(s.days, 1, 3650, 365)),
    memtableFlushMiB: num(s.memtableFlushMiB, 1, 4096, 64),
    // M1-era shared links lack these fields; default them to "off".
    ttlDays: num(s.ttlDays, 0, 3650, 0),
    deleteRatePerSec: num(s.deleteRatePerSec, 0, 1_000_000, 0),
    // Pre-M3/M4 links lack these; gc_grace defaults to Cassandra's 10 days,
    // the TWCS window to Cassandra's 1 day.
    compaction: s.compaction === 'stcs' || s.compaction === 'twcs' ? s.compaction : 'none',
    twcsWindowDays: Math.round(num(s.twcsWindowDays, 1, 365, 1)),
    gcGraceDays: num(s.gcGraceDays, 0, 365, 10),
    // Pre-M5 links lack this; default to a day-long query.
    queryWindowHours: Math.round(num(s.queryWindowHours, 1, 168, 24)),
    // Pre-M6 links lack these; default to a mildly skewed 100K-partition
    // workload on a 6-node ring. A ring smaller than RF cannot place a
    // replica set, so nodes is floored at RF rather than rejected.
    partitionCount: Math.round(num(s.partitionCount, 1, 100_000_000, 100_000)),
    skewExponent: num(s.skewExponent, 0, 2, 0.3),
    nodes: Math.max(replicationFactor, Math.round(num(s.nodes, 1, 64, 6))),
    // Pre-M8 links lack this; default to the mitigation off. Snapped to a
    // power of two so a hand-edited 5 becomes 4 rather than a shard count no
    // modulo bucket scheme would produce.
    maxSubShards: 2 ** Math.round(Math.log2(num(s.maxSubShards, 1, 8, 1))),
    // Pre-M7 links lack these; default to a 1 TiB node running Cassandra
    // 4.x's stock compaction_throughput.
    diskPerNodeGiB: Math.round(num(s.diskPerNodeGiB, 16, 65_536, 1024)),
    compactionMiBPerSec: Math.round(num(s.compactionMiBPerSec, 1, 1024, 64)),
    seed: Math.round(num(s.seed, 0, 2 ** 31, 42)),
    schema: {
      columns: columns.slice(0, 32),
      rowOverheadBytes:
        s.schema.rowOverheadBytes === undefined
          ? undefined
          : num(s.schema.rowOverheadBytes, 0, 1000, 10),
      // Partition key charged once per partition, so no per-row scale — a wide
      // ceiling is fine. Absent stays absent (feature off).
      partitionKeyBytes:
        s.schema.partitionKeyBytes === undefined
          ? undefined
          : num(s.schema.partitionKeyBytes, 0, 100_000, 0),
    },
  };
}

export function toSimConfig(
  s: ScenarioConfig,
  sizeModel: { onDiskRowBytes: number; tombstoneRowBytes: number; partitionKeyOnDiskBytes?: number },
): SimConfig {
  return {
    seed: s.seed,
    startTime: Date.UTC(2026, 0, 1),
    tickMs: s.tickMs,
    ticks: Math.max(1, Math.ceil((s.days * DAY_MS) / s.tickMs)),
    writeRatePerSec: s.writeRatePerSec,
    onDiskRowBytes: sizeModel.onDiskRowBytes,
    memtableFlushBytes: s.memtableFlushMiB * MiB,
    ttlMs: s.ttlDays * DAY_MS,
    deleteRatePerSec: s.deleteRatePerSec,
    tombstoneRowBytes: sizeModel.tombstoneRowBytes,
    gcGraceMs: s.gcGraceDays * DAY_MS,
    queryWindowMs: s.queryWindowHours * HOUR_MS,
    skew: {
      partitionCount: s.partitionCount,
      zipfExponent: s.skewExponent,
      topK: TOP_K_PARTITIONS,
      nodes: s.nodes,
      replicationFactor: Math.min(s.replicationFactor, s.nodes),
      maxSubShards: s.maxSubShards,
    },
    diskPerNodeBytes: s.diskPerNodeGiB * 1024 * MiB,
    compactionThroughputBytesPerSec: s.compactionMiBPerSec * MiB,
    // Partition key stored once per partition → a flat term, count × per-key
    // on-disk cost. Zero unless the schema sets partitionKeyBytes.
    partitionOverheadBytes: (sizeModel.partitionKeyOnDiskBytes ?? 0) * s.partitionCount,
    compaction:
      s.compaction === 'twcs'
        ? { strategy: 'twcs', windowMs: s.twcsWindowDays * DAY_MS }
        : { strategy: s.compaction },
  };
}
