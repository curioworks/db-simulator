import { useMemo } from 'react';
import type { MetricsSnapshot } from '../engine/types.ts';

const MAX_POINTS = 800;

/**
 * Shared by the growth and read-amp charts so both render the exact same
 * x-points — recharts syncs their hover crosshairs by index, so the two
 * downsamples must stay identical.
 *
 * Hourly ticks over years produce tens of thousands of points; the series are
 * smooth enough that a stride-downsample (always keeping the endpoint) is
 * lossless at screen resolution.
 */
export function useChartPoints(snapshots: MetricsSnapshot[]): MetricsSnapshot[] {
  return useMemo(() => {
    const stride = Math.max(1, Math.ceil(snapshots.length / MAX_POINTS));
    const out = snapshots.filter((_, i) => i % stride === 0);
    const last = snapshots.at(-1);
    if (last && out.at(-1) !== last) out.push(last);
    return out;
  }, [snapshots]);
}

/** Six evenly spaced time ticks across the simulated span. */
export function useXTicks(data: MetricsSnapshot[]): number[] | undefined {
  return useMemo(() => {
    if (data.length < 2) return undefined;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    return Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5);
  }, [data]);
}

/** Long horizons label ticks with the year, short ones with month + day. */
export function spansYears(data: MetricsSnapshot[]): boolean {
  return data.length > 1 && data[data.length - 1].t - data[0].t > 200 * 86_400_000;
}
