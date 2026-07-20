import type { MetricsSnapshot, SimConfig, SkewModel, Verdict } from '../engine/types.ts';

export interface SimRequest {
  /** Monotonic request id — the UI drops stale responses. */
  id: number;
  config: SimConfig;
}

export interface SimResponse {
  id: number;
  snapshots: MetricsSnapshot[];
  /** Resolved skew model (M6) — the per-node view needs the weights, not just the totals. */
  skew?: SkewModel;
  /** Failure verdicts (M7) — thresholds and the date each was crossed. */
  verdicts: Verdict[];
  /** Wall-clock ms the simulation took inside the worker. */
  elapsedMs: number;
}
