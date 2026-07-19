import type { SSTable, StcsTuning } from '../types.ts';
import type { CompactionContext, CompactionStrategy } from './strategy.ts';

/**
 * Size-tiered compaction, Cassandra-style: sort SSTables by size, walk them
 * smallest-first greedily growing a bucket while each table stays within
 * [avg × bucketLow, avg × bucketHigh] of the bucket's running average
 * (tables under minSstableSizeBytes all share one bucket), then merge any
 * bucket holding ≥ minThreshold tables, at most maxThreshold at a time.
 *
 * The sim models unthrottled background compaction: buckets keep merging
 * within one tick until none is eligible. (M7 adds the throughput cap that
 * turns this into a queue that can saturate.)
 *
 * Purging at merge time — the gc_grace gate:
 *  - TTL-expired data is self-tombstoning: a cell written at t is purgeable
 *    once now ≥ t + ttl + gc_grace, i.e. data older than
 *    `now − ttl − gc_grace` drops.
 *  - Explicit tombstones purge on the gc clock alone: written at t, droppable
 *    once now ≥ t + gc_grace.
 *  - CLAUDE.md's second condition — all shadowed data lives in the merge set —
 *    is assumed to hold: with size-tiered merging of a time-ordered flush
 *    stream, older (shadowed) data has almost always been folded into the
 *    same tiers. The sim takes purge-at-merge as exact rather than tracking
 *    per-cell overlap.
 *
 * Bytes inside an SSTable are uniform over [minTs, maxTs] (true by
 * construction from the engine's constant-rate flushes), so "data older than
 * cutoff" is a linear fraction of the span. Merged non-adjacent tables make
 * this an approximation — acceptable at sim granularity.
 *
 * Deterministic: no rng use; ties broken by list order (minTs-sorted).
 */
export type StcsOptions = Required<StcsTuning>;

export const STCS_DEFAULTS: StcsOptions = {
  minThreshold: 4,
  maxThreshold: 32,
  bucketLow: 0.5,
  bucketHigh: 1.5,
  minSstableSizeBytes: 50 * 1024 * 1024,
};

const sizeOf = (s: SSTable) => s.liveBytes + s.expiredBytes + s.tombstoneBytes;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Fraction of a [minTs, maxTs] span that lies before `cutoff`, assuming uniformity. */
function fracBefore(s: SSTable, cutoff: number): number {
  const span = s.maxTs - s.minTs;
  if (span <= 0) return s.maxTs <= cutoff ? 1 : 0;
  return clamp01((cutoff - s.minTs) / span);
}

/**
 * Merge a set of SSTables into (at most) one, purging what gc_grace allows.
 * Returns null when everything in the merge set is purgeable.
 */
export function mergeSSTables(
  tables: readonly SSTable[],
  ctx: CompactionContext,
): SSTable | null {
  // With no TTL nothing self-expires, so no data purge cutoff exists.
  const dataPurgeCutoff = ctx.ttlMs > 0 ? ctx.now - ctx.ttlMs - ctx.gcGraceMs : -Infinity;
  const tombPurgeCutoff = ctx.now - ctx.gcGraceMs;

  let live = 0;
  let expired = 0;
  let tomb = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const s of tables) {
    const dataTotal = s.liveBytes + s.expiredBytes;
    // Aging ran before compaction with cutoff now − ttl ≥ dataPurgeCutoff, so
    // every purgeable byte is already accounted expired; min() is float safety.
    const purgedData = Math.min(dataTotal * fracBefore(s, dataPurgeCutoff), s.expiredBytes);
    const purgedTomb = s.tombstoneBytes * fracBefore(s, tombPurgeCutoff);

    live += s.liveBytes;
    expired += s.expiredBytes - purgedData;
    tomb += s.tombstoneBytes - purgedTomb;

    // Surviving bytes start where their purge cutoff left off; track the span
    // per byte kind so the output minTs stays consistent with future aging.
    if (dataTotal - purgedData > 0) {
      minTs = Math.min(minTs, Math.max(s.minTs, dataPurgeCutoff));
      maxTs = Math.max(maxTs, s.maxTs);
    }
    if (s.tombstoneBytes - purgedTomb > 0) {
      minTs = Math.min(minTs, Math.max(s.minTs, tombPurgeCutoff));
      maxTs = Math.max(maxTs, s.maxTs);
    }
  }

  if (live + expired + tomb <= 0) return null;
  return {
    createdAt: ctx.now,
    minTs,
    maxTs,
    liveBytes: live,
    expiredBytes: expired,
    tombstoneBytes: tomb,
  };
}

/**
 * One STCS pass: bucket by size, find eligible buckets. Returns the merge set
 * (the bucket's oldest-by-minTs tables up to maxThreshold) or null if no
 * bucket is eligible. Preferring the smallest-average bucket gives the
 * natural small-to-large cascade.
 */
function pickMergeSet(sstables: readonly SSTable[], opts: StcsOptions): SSTable[] | null {
  const bySize = [...sstables].sort((a, b) => sizeOf(a) - sizeOf(b));

  // Greedy bucketing over the ascending size order: a table joins the open
  // bucket while it stays within the ratio band of the running average (the
  // ascending order makes bucketLow trivially satisfied; bucketHigh binds).
  const buckets: SSTable[][] = [];
  let bucket: SSTable[] = [];
  let bucketBytes = 0;
  for (const s of bySize) {
    const size = sizeOf(s);
    const avg = bucket.length > 0 ? bucketBytes / bucket.length : 0;
    const fitsSmall = size < opts.minSstableSizeBytes && avg < opts.minSstableSizeBytes;
    const fitsRatio = size >= avg * opts.bucketLow && size <= avg * opts.bucketHigh;
    if (bucket.length > 0 && (fitsSmall || fitsRatio)) {
      bucket.push(s);
      bucketBytes += size;
    } else {
      if (bucket.length > 0) buckets.push(bucket);
      bucket = [s];
      bucketBytes = size;
    }
  }
  if (bucket.length > 0) buckets.push(bucket);

  let best: SSTable[] | null = null;
  let bestAvg = Infinity;
  for (const b of buckets) {
    if (b.length < opts.minThreshold) continue;
    const avg = b.reduce((total, s) => total + sizeOf(s), 0) / b.length;
    if (avg < bestAvg) {
      best = b;
      bestAvg = avg;
    }
  }

  if (best === null) return null;
  return best
    .sort((a, b) => a.minTs - b.minTs || a.createdAt - b.createdAt)
    .slice(0, opts.maxThreshold);
}

export function createStcs(tuning: StcsTuning = {}): CompactionStrategy {
  const opts: StcsOptions = { ...STCS_DEFAULTS, ...tuning };
  if (opts.minThreshold < 2) throw new RangeError(`minThreshold must be ≥ 2, got ${opts.minThreshold}`);
  if (opts.maxThreshold < opts.minThreshold) {
    throw new RangeError(`maxThreshold must be ≥ minThreshold, got ${opts.maxThreshold}`);
  }
  if (opts.bucketLow <= 0 || opts.bucketHigh < opts.bucketLow) {
    throw new RangeError(`need 0 < bucketLow ≤ bucketHigh, got ${opts.bucketLow}/${opts.bucketHigh}`);
  }
  if (opts.minSstableSizeBytes < 0) {
    throw new RangeError(`minSstableSizeBytes must be ≥ 0, got ${opts.minSstableSizeBytes}`);
  }

  return {
    name: 'stcs',
    compact(sstables, ctx) {
      let current = sstables;
      // Loop until stable: each merge changes sizes, which can make the next
      // tier eligible in the same tick (unthrottled background compaction).
      for (;;) {
        const mergeSet = pickMergeSet(current, opts);
        if (mergeSet === null) return current;
        const picked = new Set(mergeSet);
        const next = current.filter((s) => !picked.has(s));
        const merged = mergeSSTables(mergeSet, ctx);
        if (merged !== null) next.push(merged);
        next.sort((a, b) => a.minTs - b.minTs || a.createdAt - b.createdAt);
        current = next;
      }
    },
  };
}
