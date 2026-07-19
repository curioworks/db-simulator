import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsSnapshot } from '../engine/types.ts';
import { formatBytes, formatCount, formatDate, formatShortDate } from './format.ts';
import type { Theme } from './theme.ts';

const MAX_POINTS = 800;

interface Props {
  snapshots: MetricsSnapshot[];
  theme: Theme;
  /** Previous frame is held at reduced opacity while a re-sim is in flight. */
  running: boolean;
}

export function GrowthChart({ snapshots, theme, running }: Props) {
  // Hourly ticks over years produce tens of thousands of points; the line is
  // monotone so a stride-downsample (always keeping the endpoint) is lossless
  // at screen resolution.
  const data = useMemo(() => {
    const stride = Math.max(1, Math.ceil(snapshots.length / MAX_POINTS));
    const out = snapshots.filter((_, i) => i % stride === 0);
    const last = snapshots.at(-1);
    if (last && out.at(-1) !== last) out.push(last);
    return out;
  }, [snapshots]);

  const xTicks = useMemo(() => {
    if (data.length < 2) return undefined;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    return Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5);
  }, [data]);

  // Clean Y ticks: round steps in binary byte units (…, 32, 64, 128 GiB) so
  // labels come out as "64 GB", never "79.2 GB".
  const yTicks = useMemo(() => {
    const max = data.reduce((m, s) => Math.max(m, s.diskBytes), 0);
    if (max <= 0) return undefined;
    const step = niceByteStep(max / 5);
    const count = Math.ceil(max / step);
    return Array.from({ length: count + 1 }, (_, i) => i * step);
  }, [data]);

  const spansYears = data.length > 1 && data[data.length - 1].t - data[0].t > 200 * 86_400_000;

  if (data.length === 0) return <div className="chart-empty">Simulating…</div>;

  return (
    <div className="chart-body" style={{ opacity: running ? 0.55 : 1 }}>
      <ResponsiveContainer width="100%" height={360}>
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke={theme.grid} strokeWidth={1} />
          <XAxis
            dataKey="t"
            type="number"
            scale="linear"
            domain={['dataMin', 'dataMax']}
            ticks={xTicks}
            tickFormatter={(t: number) => (spansYears ? formatDate(t) : formatShortDate(t))}
            tick={{ fill: theme.muted, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: theme.axis, strokeWidth: 1 }}
          />
          <YAxis
            tickFormatter={formatBytes}
            ticks={yTicks}
            domain={yTicks ? [0, yTicks[yTicks.length - 1]] : [0, 'auto']}
            tick={{ fill: theme.muted, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={78}
          />
          <Tooltip
            cursor={{ stroke: theme.axis, strokeWidth: 1 }}
            content={<GrowthTooltip theme={theme} />}
          />
          <Area
            dataKey="diskBytes"
            name="On-disk size"
            type="linear"
            stroke={theme.series1}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={theme.series1}
            fillOpacity={0.1}
            isAnimationActive={false}
            activeDot={{ r: 4.5, fill: theme.series1, stroke: theme.surface, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const BIN_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Smallest "round" byte step (1/2/4/…/512 × 1024ᵏ) that is ≥ rough. */
function niceByteStep(rough: number): number {
  let base = 1;
  while (rough >= base * 1024) base *= 1024;
  for (const s of BIN_STEPS) {
    if (s * base >= rough) return s * base;
  }
  return base * 1024;
}

interface TooltipProps {
  theme: Theme;
  active?: boolean;
  payload?: Array<{ payload: MetricsSnapshot }>;
}

function GrowthTooltip({ theme, active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="tooltip-date">{formatDate(s.t)}</div>
      <div className="tooltip-row">
        <span className="tooltip-key" style={{ background: theme.series1 }} />
        <span className="tooltip-value">{formatBytes(s.diskBytes)}</span>
        <span className="tooltip-label">on disk</span>
      </div>
      <div className="tooltip-row tooltip-secondary">
        {formatCount(s.sstableCount)} SSTables · memtable {formatBytes(s.memtableBytes)}
      </div>
    </div>
  );
}
