import type { MetricsSnapshot, SimConfig } from '../engine/types.ts';

export interface SimRequest {
  /** Monotonic request id — the UI drops stale responses. */
  id: number;
  config: SimConfig;
}

export interface SimResponse {
  id: number;
  snapshots: MetricsSnapshot[];
  /** Wall-clock ms the simulation took inside the worker. */
  elapsedMs: number;
}
