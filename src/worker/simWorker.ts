import { simulate } from '../engine/engine.ts';
import type { SimRequest, SimResponse } from './protocol.ts';

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const { id, config } = e.data;
  const t0 = performance.now();
  const { snapshots, skew } = simulate(config);
  const response: SimResponse = { id, snapshots, skew, elapsedMs: performance.now() - t0 };
  self.postMessage(response);
};
