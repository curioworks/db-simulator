import { useEffect, useRef, useState } from 'react';
import type { MetricsSnapshot, SimConfig, SkewModel, Verdict } from '../engine/types.ts';
import type { SimRequest, SimResponse } from '../worker/protocol.ts';

export interface SimulationState {
  snapshots: MetricsSnapshot[];
  /** Zipf weights + replica placement behind the per-node view (M6). */
  skew?: SkewModel;
  /** Failure verdicts for the simulated config (M7). */
  verdicts: Verdict[];
  /** True while a newer config is being simulated; keep the previous frame. */
  running: boolean;
  elapsedMs: number | null;
}

const DEBOUNCE_MS = 120;

/**
 * Runs the engine in a Web Worker. Slider changes re-simulate live: requests
 * are debounced, tagged with an id, and stale responses are dropped.
 */
export function useSimulation(config: SimConfig): SimulationState {
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const [state, setState] = useState<SimulationState>({
    snapshots: [],
    verdicts: [],
    running: true,
    elapsedMs: null,
  });

  useEffect(() => {
    const worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<SimResponse>) => {
      if (e.data.id !== requestId.current) return; // stale
      setState({
        snapshots: e.data.snapshots,
        skew: e.data.skew,
        verdicts: e.data.verdicts,
        running: false,
        elapsedMs: e.data.elapsedMs,
      });
    };
    workerRef.current = worker;
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    setState((s) => ({ ...s, running: true }));
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      const request: SimRequest = { id, config };
      workerRef.current?.postMessage(request);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [config]);

  return state;
}
