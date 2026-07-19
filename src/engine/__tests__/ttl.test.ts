import { describe, expect, it } from 'vitest';
import { simulate } from '../engine.ts';
import type { SimConfig } from '../types.ts';

/**
 * Hand-validated TTL expiry + tombstone accounting.
 *
 * Rates are picked so every number is float-exact:
 *   data:       1,000 rows/s × 96 B  =  96 B/ms
 *   tombstones: 1,000 dels/s × 32 B  =  32 B/ms   (dataFrac = 96/128 = 0.75)
 *   per 1h tick: 128 × 3,600,000     = 460,800,000 B
 *   flush threshold = 460,800,000    → exactly one flush per tick, at tick end
 *     each SSTable: 345,600,000 data + 115,200,000 tombstone bytes,
 *     spanning exactly [tickStart, tickEnd]
 *
 * TTL = 1.5h. At the end of tick n the expiry cutoff is (n − 1.5)h:
 *   tick 1: cutoff −0.5h → nothing expired
 *   tick 2: cutoff  0.5h → SSTable1 [0,1h] half-expired: 172,800,000
 *   tick 3: cutoff  1.5h → SSTable1 fully (345,600,000) + SSTable2 half
 *           (172,800,000) = 518,400,000 = 96 B/ms × 5,400,000 ms exactly
 */
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const DATA_PER_TICK = 345_600_000;
const TOMB_PER_TICK = 115_200_000;

const config: SimConfig = {
  seed: 1,
  startTime: START,
  tickMs: HOUR,
  ticks: 240, // 10 days
  writeRatePerSec: 1000,
  onDiskRowBytes: 96,
  memtableFlushBytes: 460_800_000,
  ttlMs: 1.5 * HOUR,
  deleteRatePerSec: 1000,
  tombstoneRowBytes: 32,
};

describe('simulate — TTL expiry + tombstones', () => {
  const { snapshots, sstables } = simulate(config);

  it('matches the hand-computed first three ticks exactly', () => {
    expect(snapshots[0]).toEqual({
      t: START + HOUR,
      liveBytes: DATA_PER_TICK,
      expiredBytes: 0,
      tombstoneBytes: TOMB_PER_TICK,
      diskBytes: DATA_PER_TICK + TOMB_PER_TICK,
      memtableBytes: 0,
      sstableCount: 1,
    });

    expect(snapshots[1].expiredBytes).toBe(172_800_000);
    expect(snapshots[1].liveBytes).toBe(2 * DATA_PER_TICK - 172_800_000);

    expect(snapshots[2].expiredBytes).toBe(518_400_000);
    expect(snapshots[2].liveBytes).toBe(3 * DATA_PER_TICK - 518_400_000);
    expect(snapshots[2].tombstoneBytes).toBe(3 * TOMB_PER_TICK);
  });

  it('splits each flushed SSTable by the two ingest rates', () => {
    expect(sstables[0].minTs).toBe(START);
    expect(sstables[0].maxTs).toBe(START + HOUR);
    expect(sstables[0].liveBytes + sstables[0].expiredBytes).toBe(DATA_PER_TICK);
    expect(sstables[0].tombstoneBytes).toBe(TOMB_PER_TICK);
  });

  it('tracks the analytic expiry line: expired = dataRate × (now − ttl − start)', () => {
    const dataPerMs = 96;
    snapshots.forEach((s) => {
      const cutoffMs = s.t - config.ttlMs! - START;
      const exact = Math.max(0, dataPerMs * cutoffMs);
      expect(Math.abs(s.expiredBytes - exact)).toBeLessThanOrEqual(exact * 1e-9);
    });
  });

  it('never drops a byte: expired ≠ deleted, disk only grows without compaction', () => {
    snapshots.forEach((s, i) => {
      const written = (i + 1) * (DATA_PER_TICK + TOMB_PER_TICK);
      expect(s.diskBytes + s.memtableBytes).toBe(written);
      if (i > 0) expect(s.diskBytes).toBeGreaterThanOrEqual(snapshots[i - 1].diskBytes);
    });
  });

  it('fully-expired SSTables end with zero live bytes', () => {
    // After 240 ticks the cutoff is at 238.5h: SSTables 1–238 fully expired.
    expect(sstables[0].liveBytes).toBe(0);
    expect(sstables[237].liveBytes).toBe(0);
    expect(sstables[238].liveBytes).toBeGreaterThan(0); // the half-expired one
    expect(sstables[239].liveBytes).toBe(DATA_PER_TICK); // still fully live
  });

  it('keeps everything live when TTL is disabled', () => {
    const noTtl = simulate({ ...config, ttlMs: 0, ticks: 10 });
    noTtl.snapshots.forEach((s) => expect(s.expiredBytes).toBe(0));
  });

  it('is deterministic for the same seed and config', () => {
    expect(simulate(config)).toEqual(simulate(config));
  });
});
