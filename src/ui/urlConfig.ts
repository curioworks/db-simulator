import type { ScenarioConfig } from '../presets/scenario.ts';

/**
 * Scenario ⇄ base64url in the URL hash (#c=…) — every scenario is a shareable
 * link. Hash, not query, so GitHub Pages never sees or logs the payload.
 */
export function encodeScenario(s: ScenarioConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeScenario(encoded: string): ScenarioConfig | null {
  try {
    const b64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isScenario(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isScenario(x: unknown): x is ScenarioConfig {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.name === 'string' &&
    typeof s.compressionRatio === 'number' &&
    typeof s.replicationFactor === 'number' &&
    typeof s.writeRatePerSec === 'number' &&
    typeof s.tickMs === 'number' &&
    typeof s.days === 'number' &&
    typeof s.memtableFlushMiB === 'number' &&
    typeof s.seed === 'number' &&
    typeof s.schema === 'object' &&
    s.schema !== null &&
    Array.isArray((s.schema as Record<string, unknown>).columns)
  );
}

export function readScenarioFromUrl(): ScenarioConfig | null {
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m ? decodeScenario(m[1]) : null;
}

export function writeScenarioToUrl(s: ScenarioConfig): void {
  history.replaceState(null, '', `#c=${encodeScenario(s)}`);
}
