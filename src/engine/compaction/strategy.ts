import type { PRNG } from '../prng.ts';
import type { SSTable } from '../types.ts';

export interface CompactionContext {
  /** Epoch ms at the end of the current tick. */
  now: number;
  rng: PRNG;
}

/**
 * Compaction is a plugin. The engine calls the strategy once per tick with the
 * current SSTable set and replaces the set with whatever comes back. STCS,
 * TWCS and LCS implement this interface (M3+).
 *
 * Contract: return the input array **by identity** to signal "nothing to do" —
 * the engine then keeps its running byte totals instead of re-summing every
 * SSTable (that re-sum is O(ticks × SSTables) across a run, which blows the
 * milliseconds budget at high write rates). Return a fresh array when
 * compacting; never mutate the input or its structs.
 */
export interface CompactionStrategy {
  readonly name: string;
  compact(sstables: readonly SSTable[], ctx: CompactionContext): readonly SSTable[];
}

/** M1 baseline: flush-only, nothing ever merges. */
export const noCompaction: CompactionStrategy = {
  name: 'none',
  compact: (sstables) => sstables,
};
