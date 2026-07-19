import { mulberry32 } from './prng.ts';
import { noCompaction, type CompactionStrategy } from './compaction/strategy.ts';
import { createStcs } from './compaction/stcs.ts';
import { createTwcs } from './compaction/twcs.ts';
import type { MetricsSnapshot, SimConfig, SimResult, SSTable } from './types.ts';

/**
 * Tick loop: accumulate memtable → flush at the threshold → age data across
 * TTL → run the compaction strategy → emit a metrics snapshot.
 *
 * Writes arrive at a continuous constant rate within a tick, so flush moments
 * are interpolated to the exact ms; this keeps minTs/maxTs honest for the
 * time-windowed strategies later (TWCS). Data + tombstone ingest share the
 * memtable; each flushed SSTable splits its bytes by the two rates.
 *
 * TTL aging assumes data inside an SSTable is uniformly distributed over
 * [minTs, maxTs] (true by construction for flushes: constant rate, contiguous
 * spans; an approximation for compacted tables, whose spans may also overlap
 * neighbours). A pointer over the minTs-ordered list skips the fully-expired
 * prefix, keeping aging amortized O(1) per tick in the flush-only case and
 * proportional to the handful of cutoff-straddling tables otherwise.
 */
export function simulate(config: SimConfig, strategy?: CompactionStrategy): SimResult {
  const { startTime, tickMs, ticks, writeRatePerSec, onDiskRowBytes, memtableFlushBytes } = config;
  const ttlMs = config.ttlMs ?? 0;
  const deleteRatePerSec = config.deleteRatePerSec ?? 0;
  const tombstoneRowBytes = config.tombstoneRowBytes ?? 0;
  const gcGraceMs = config.gcGraceMs ?? 0;
  // An explicit strategy argument (tests, custom strategies) wins over the
  // serializable spec that arrives through the worker boundary.
  strategy ??=
    config.compaction?.strategy === 'stcs'
      ? createStcs(config.compaction)
      : config.compaction?.strategy === 'twcs'
        ? createTwcs(config.compaction)
        : noCompaction;

  if (tickMs <= 0) throw new RangeError(`tickMs must be > 0, got ${tickMs}`);
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative integer, got ${ticks}`);
  }
  if (writeRatePerSec < 0) throw new RangeError(`writeRatePerSec must be ≥ 0, got ${writeRatePerSec}`);
  if (onDiskRowBytes < 0) throw new RangeError(`onDiskRowBytes must be ≥ 0, got ${onDiskRowBytes}`);
  if (memtableFlushBytes <= 0) {
    throw new RangeError(`memtableFlushBytes must be > 0, got ${memtableFlushBytes}`);
  }
  if (ttlMs < 0) throw new RangeError(`ttlMs must be ≥ 0, got ${ttlMs}`);
  if (deleteRatePerSec < 0) throw new RangeError(`deleteRatePerSec must be ≥ 0, got ${deleteRatePerSec}`);
  if (tombstoneRowBytes < 0) throw new RangeError(`tombstoneRowBytes must be ≥ 0, got ${tombstoneRowBytes}`);
  if (gcGraceMs < 0) throw new RangeError(`gcGraceMs must be ≥ 0, got ${gcGraceMs}`);

  const rng = mulberry32(config.seed);
  const dataPerMs = (writeRatePerSec * onDiskRowBytes) / 1000;
  const tombPerMs = (deleteRatePerSec * tombstoneRowBytes) / 1000;
  const bytesPerMs = dataPerMs + tombPerMs;
  const dataFrac = bytesPerMs > 0 ? dataPerMs / bytesPerMs : 0;

  let sstables: SSTable[] = [];
  let memtableBytes = 0;
  /** Timestamp of the oldest data sitting in the memtable; null when empty. */
  let memtableMinTs: number | null = null;
  /** Index of the first SSTable that is not yet fully expired. */
  let agePtr = 0;
  // Running totals over `sstables`, maintained incrementally: flushes and
  // aging apply deltas, and a full re-sum happens only on ticks where the
  // strategy actually changed the set (signalled by returning a new array —
  // see the CompactionStrategy contract). Re-summing every tick is
  // O(ticks × SSTables) and blows the milliseconds budget at high write rates.
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
      const flushLive = memtableFlushBytes * dataFrac;
      const flushTomb = memtableFlushBytes - flushLive;
      sstables.push({
        createdAt: flushAt,
        minTs: memtableMinTs ?? cursor,
        maxTs: flushAt,
        liveBytes: flushLive,
        expiredBytes: 0,
        tombstoneBytes: flushTomb,
      });
      liveBytes += flushLive;
      tombstoneBytes += flushTomb;
      remaining -= needed;
      cursor = flushAt;
      memtableBytes = 0;
      memtableMinTs = null;
    }
    if (remaining > 0) {
      memtableMinTs ??= cursor;
      memtableBytes += remaining;
    }

    // Age flushed data across the TTL. The list is minTs-ordered, so
    // everything before agePtr is fully expired and each SSTable is fully
    // expired exactly once. Flush-only spans are contiguous (the cutoff
    // straddles at most one table); compacted spans can overlap, so all
    // straddling tables past the prefix get the partial treatment.
    if (ttlMs > 0) {
      const cutoff = tickEnd - ttlMs;
      while (agePtr < sstables.length && sstables[agePtr].maxTs <= cutoff) {
        const s = sstables[agePtr];
        expiredBytes += s.liveBytes;
        liveBytes -= s.liveBytes;
        s.expiredBytes += s.liveBytes;
        s.liveBytes = 0;
        agePtr++;
      }
      for (let j = agePtr; j < sstables.length && sstables[j].minTs < cutoff; j++) {
        const s = sstables[j];
        const dataTotal = s.liveBytes + s.expiredBytes;
        const target =
          s.maxTs <= cutoff
            ? dataTotal
            : dataTotal * ((cutoff - s.minTs) / (s.maxTs - s.minTs));
        const delta = target - s.expiredBytes;
        if (delta > 0) {
          s.expiredBytes = target;
          s.liveBytes = dataTotal - target;
          expiredBytes += delta;
          liveBytes -= delta;
        }
      }
    }

    const compacted = strategy.compact(sstables, { now: tickEnd, ttlMs, gcGraceMs, rng });
    if (compacted !== sstables) {
      sstables = [...compacted];
      liveBytes = 0;
      expiredBytes = 0;
      tombstoneBytes = 0;
      agePtr = sstables.length;
      for (let j = sstables.length - 1; j >= 0; j--) {
        const s = sstables[j];
        liveBytes += s.liveBytes;
        expiredBytes += s.expiredBytes;
        tombstoneBytes += s.tombstoneBytes;
        // agePtr's invariant is only that everything before it is fully
        // expired; the first live table bounds that from above. Strategies
        // must keep the list minTs-sorted.
        if (s.liveBytes > 0) agePtr = j;
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
