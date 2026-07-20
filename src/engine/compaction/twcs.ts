import type { SSTable, TwcsTuning } from '../types.ts';
import type { CompactionContext, CompactionStrategy } from './strategy.ts';
import { createStcs, mergeSSTables, STCS_DEFAULTS } from './stcs.ts';

/**
 * Time-window compaction, Cassandra-style: SSTables bucket into fixed
 * windows by their newest data (maxTs). Three moves, in order:
 *
 *  1. **Whole-SSTable expiry drop** — a table whose entire span is past the
 *     gc_grace gate is unlinked, never rewritten. This is TWCS's signature:
 *     reclaim without compaction I/O. (As in stcs.ts, CLAUDE.md's
 *     shadowed-data-overlap condition is assumed to hold.)
 *  2. **Closed windows compact to one SSTable each** — the per-window major
 *     that runs once when a window stops being current. mergeSSTables purges
 *     whatever the gc_grace gate allows at that moment; after that the
 *     window's table sits untouched (expired bytes and all) until move 1
 *     finally drops it. Window size ≫ TTL therefore strands expired data —
 *     the classic misconfiguration the M4 presets demonstrate.
 *  3. **The current window runs STCS** with the inherited size-tier tuning.
 *
 * One pass reaches the fixed point: closed windows end at ≤ 1 table, the
 * inner STCS loops until stable, and merge survivors are never droppable
 * (mergeSSTables already purged what the gate allows).
 *
 * Deterministic: no rng use.
 */
export type TwcsOptions = Required<TwcsTuning>;

export const TWCS_DEFAULTS: TwcsOptions = {
  ...STCS_DEFAULTS,
  windowMs: 86_400_000,
};

/** True when every byte in the table is past its purge cutoff — droppable whole. */
function fullyPurgeable(s: SSTable, ctx: CompactionContext): boolean {
  const dataOk =
    s.liveBytes + s.expiredBytes <= 0 ||
    (ctx.ttlMs > 0 && s.maxTs <= ctx.now - ctx.ttlMs - ctx.gcGraceMs);
  const tombOk = s.tombstoneBytes <= 0 || s.maxTs <= ctx.now - ctx.gcGraceMs;
  return dataOk && tombOk;
}

export function createTwcs(tuning: TwcsTuning = {}): CompactionStrategy {
  const opts: TwcsOptions = { ...TWCS_DEFAULTS, ...tuning };
  if (!(opts.windowMs > 0)) throw new RangeError(`windowMs must be > 0, got ${opts.windowMs}`);
  // Validates the inherited STCS knobs and provides the current-window loop.
  const stcs = createStcs(opts);

  return {
    name: 'twcs',
    compact(sstables, ctx) {
      let changed = false;

      const kept = sstables.filter((s) => !fullyPurgeable(s, ctx));
      if (kept.length !== sstables.length) changed = true;

      // maxTs ≤ now by construction, so no window is ever newer than current.
      const currentWindow = Math.floor(ctx.now / opts.windowMs);
      const currentTables: SSTable[] = [];
      const closedByWindow = new Map<number, SSTable[]>();
      for (const s of kept) {
        const w = Math.floor(s.maxTs / opts.windowMs);
        if (w >= currentWindow) {
          currentTables.push(s);
        } else {
          const list = closedByWindow.get(w);
          if (list) list.push(s);
          else closedByWindow.set(w, [s]);
        }
      }

      const next: SSTable[] = [];
      for (const tables of closedByWindow.values()) {
        if (tables.length === 1) {
          next.push(tables[0]);
          continue;
        }
        changed = true;
        const merged = mergeSSTables(tables, ctx);
        if (merged !== null) {
          // The per-window major. Move 1's whole-table drops write nothing —
          // that is exactly why TWCS costs less compaction I/O than STCS.
          ctx.onWrite?.(merged.liveBytes + merged.expiredBytes + merged.tombstoneBytes);
          next.push(merged);
        }
      }

      const compactedCurrent = stcs.compact(currentTables, ctx);
      if (compactedCurrent !== currentTables) changed = true;
      next.push(...compactedCurrent);

      if (!changed) return sstables;
      next.sort((a, b) => a.minTs - b.minTs || a.createdAt - b.createdAt);
      return next;
    },
  };
}
