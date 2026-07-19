import { mulberry32 } from './prng.ts';
import { noCompaction, type CompactionStrategy } from './compaction/strategy.ts';
import type { MetricsSnapshot, SimConfig, SimResult, SSTable } from './types.ts';

/**
 * Tick loop: accumulate memtable → flush at the threshold → run the compaction
 * strategy → emit a metrics snapshot. Writes arrive at a continuous constant
 * rate within a tick, so flush moments are interpolated to the exact ms; this
 * keeps minTs/maxTs honest for the time-windowed strategies later (TWCS).
 */
export function simulate(config: SimConfig, strategy: CompactionStrategy = noCompaction): SimResult {
  const { startTime, tickMs, ticks, writeRatePerSec, onDiskRowBytes, memtableFlushBytes } = config;

  if (tickMs <= 0) throw new RangeError(`tickMs must be > 0, got ${tickMs}`);
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative integer, got ${ticks}`);
  }
  if (writeRatePerSec < 0) throw new RangeError(`writeRatePerSec must be ≥ 0, got ${writeRatePerSec}`);
  if (onDiskRowBytes < 0) throw new RangeError(`onDiskRowBytes must be ≥ 0, got ${onDiskRowBytes}`);
  if (memtableFlushBytes <= 0) {
    throw new RangeError(`memtableFlushBytes must be > 0, got ${memtableFlushBytes}`);
  }

  const rng = mulberry32(config.seed);
  const bytesPerMs = (writeRatePerSec * onDiskRowBytes) / 1000;

  let sstables: SSTable[] = [];
  let memtableBytes = 0;
  /** Timestamp of the oldest data sitting in the memtable; null when empty. */
  let memtableMinTs: number | null = null;
  // Running totals over `sstables`, maintained incrementally: flushes add to
  // them, and a full re-sum happens only on ticks where the strategy actually
  // changed the set (signalled by returning a new array — see the
  // CompactionStrategy contract). Re-summing every tick is O(ticks × SSTables)
  // and blows the milliseconds budget at high write rates.
  let liveBytes = 0;
  let expiredBytes = 0;
  let tombstoneBytes = 0;
  const snapshots: MetricsSnapshot[] = [];

  for (let i = 0; i < ticks; i++) {
    const tickStart = startTime + i * tickMs;
    const tickEnd = tickStart + tickMs;

    // Pour this tick's writes into the memtable, flushing every time the
    // threshold is crossed. cursor tracks the in-tick write clock.
    let remaining = bytesPerMs * tickMs;
    let cursor = tickStart;
    while (bytesPerMs > 0 && memtableBytes + remaining >= memtableFlushBytes) {
      const needed = memtableFlushBytes - memtableBytes;
      const flushAt = cursor + needed / bytesPerMs;
      sstables.push({
        createdAt: flushAt,
        minTs: memtableMinTs ?? cursor,
        maxTs: flushAt,
        liveBytes: memtableFlushBytes,
        expiredBytes: 0,
        tombstoneBytes: 0,
      });
      liveBytes += memtableFlushBytes;
      remaining -= needed;
      cursor = flushAt;
      memtableBytes = 0;
      memtableMinTs = null;
    }
    if (remaining > 0) {
      memtableMinTs ??= cursor;
      memtableBytes += remaining;
    }

    const compacted = strategy.compact(sstables, { now: tickEnd, rng });
    if (compacted !== sstables) {
      sstables = [...compacted];
      liveBytes = 0;
      expiredBytes = 0;
      tombstoneBytes = 0;
      for (const s of sstables) {
        liveBytes += s.liveBytes;
        expiredBytes += s.expiredBytes;
        tombstoneBytes += s.tombstoneBytes;
      }
    }

    snapshots.push({
      t: tickEnd,
      liveBytes,
      expiredBytes,
      tombstoneBytes,
      diskBytes: liveBytes + expiredBytes + tombstoneBytes,
      memtableBytes,
      sstableCount: sstables.length,
    });
  }

  return { snapshots, sstables };
}
