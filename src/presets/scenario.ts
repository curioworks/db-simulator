import type { SchemaProfile } from '../engine/profiler/types.ts';
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
  seed: number;
}

/**
 * Clamp every field into engine-legal ranges. URL-decoded scenarios are
 * untrusted (hand-editable), and clamped UI inputs mean buildSizeModel /
 * simulate can never throw on user input.
 */
export function clampScenario(s: ScenarioConfig): ScenarioConfig {
  const num = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    ...s,
    name: s.name || 'Custom scenario',
    compressionRatio: num(s.compressionRatio, 0, 0.95, 0.5),
    replicationFactor: Math.round(num(s.replicationFactor, 1, 10, 3)),
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
    seed: Math.round(num(s.seed, 0, 2 ** 31, 42)),
    schema: {
      columns: s.schema.columns.slice(0, 32).map((c, i) => ({
        name: c.name || `col_${i + 1}`,
        valueBytes: num(c.valueBytes, 0, 1_000_000, 8),
        cellOverheadBytes:
          c.cellOverheadBytes === undefined ? undefined : num(c.cellOverheadBytes, 0, 100, 12),
      })),
      clusteringKeyBytes: num(s.schema.clusteringKeyBytes, 0, 100_000, 8),
      rowOverheadBytes:
        s.schema.rowOverheadBytes === undefined
          ? undefined
          : num(s.schema.rowOverheadBytes, 0, 1000, 10),
    },
  };
}

export function toSimConfig(
  s: ScenarioConfig,
  sizeModel: { onDiskRowBytes: number; tombstoneRowBytes: number },
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
    compaction:
      s.compaction === 'twcs'
        ? { strategy: 'twcs', windowMs: s.twcsWindowDays * DAY_MS }
        : { strategy: s.compaction },
  };
}
