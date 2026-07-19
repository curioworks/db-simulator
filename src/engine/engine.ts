import { mulberry32 } from './prng.ts';
import { noCompaction, type CompactionStrategy } from './compaction/strategy.ts';
import { createStcs } from './compaction/stcs.ts';
import { createTwcs } from './compaction/twcs.ts';
import { buildSkewModel } from './skew.ts';
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
  const queryWindowMs = config.queryWindowMs ?? 86_400_000;
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
  if (queryWindowMs <= 0) throw new RangeError(`queryWindowMs must be > 0, got ${queryWindowMs}`);

  const rng = mulberry32(config.seed);
  // Skew (M6): with constant write shares and one uniform TTL, every
  // partition holds exactly its share of the totals at all times, so the
  // per-tick figures are two fixed fractions of diskBytes (see SkewModel).
  const skew = config.skew ? buildSkewModel(config.skew, config.seed) : undefined;
  const maxPartitionFrac = skew && config.skew ? skew.hotWeights[0] / config.skew.replicationFactor : 0;
  const hotNodeFrac = skew ? Math.max(...skew.nodeShare) : 0;
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
  // Read amp (M5): a table is touched by a query over [now − window, now] iff
  // its maxTs ≥ the cutoff (minTs ≤ now always holds). The list is minTs-
  // sorted, and STCS can leave maxTs non-monotone in it (a merged table can
  // hold newer data than an unmerged neighbour after it), so the count runs
  // over a sorted mirror of maxTs values instead: flushes append in maxTs
  // order (flush moments only move forward, and no compacted table can exceed
  // a past `now`), the cutoff only advances, so a pointer sweeps the mirror
  // once — amortized O(1) per tick. Compaction-change ticks rebuild the
  // mirror; those ticks are already O(n) by the strategy contract.
  let maxTsSorted: number[] = [];
  let queryPtr = 0;
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
      maxTsSorted.push(flushAt);
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
      maxTsSorted = sstables.map((s) => s.maxTs).sort((a, b) => a - b);
      queryPtr = 0;
    }

    const queryCutoff = tickEnd - queryWindowMs;
    while (queryPtr < maxTsSorted.length && maxTsSorted[queryPtr] < queryCutoff) queryPtr++;

    const diskBytes = liveBytes + expiredBytes + tombstoneBytes;
    snapshots.push({
      t: tickEnd,
      liveBytes,
      expiredBytes,
      tombstoneBytes,
      diskBytes,
      memtableBytes,
      sstableCount: sstables.length,
      readSstables: maxTsSorted.length - queryPtr,
      maxPartitionBytes: maxPartitionFrac * diskBytes,
      hotNodeBytes: hotNodeFrac * diskBytes,
    });
  }

  return { snapshots, sstables, skew };
}
