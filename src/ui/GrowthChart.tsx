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
import { byteTicks, spansYears, useChartPoints, useXTicks } from './chartData.ts';
import { formatBytes, formatCount, formatDate, formatShortDate } from './format.ts';
import type { Theme } from './theme.ts';

interface Series {
  key: 'liveBytes' | 'expiredBytes' | 'tombstoneBytes';
  name: string;
  color: string;
}

/**
 * Colors follow the entity, never the series count: live/expired/tombstone
 * hold categorical slots 1/2/3 whether or not a band is currently visible.
 */
function allSeries(theme: Theme): Series[] {
  return [
    { key: 'liveBytes', name: 'Live', color: theme.series1 },
    { key: 'expiredBytes', name: 'Expired (not dropped)', color: theme.series2 },
    { key: 'tombstoneBytes', name: 'Tombstones', color: theme.series3 },
  ];
}

interface Props {
  snapshots: MetricsSnapshot[];
  theme: Theme;
  /** Previous frame is held at reduced opacity while a re-sim is in flight. */
  running: boolean;
}

export function GrowthChart({ snapshots, theme, running }: Props) {
  const data = useChartPoints(snapshots);

  // A band that is zero across the whole run is omitted (with its legend
  // entry); the survivors keep their colors.
  const series = useMemo(
    () => allSeries(theme).filter((s) => data.some((d) => d[s.key] > 0)),
    [theme, data],
  );

  const xTicks = useXTicks(data);

  // Clean Y ticks: round steps in binary byte units (…, 32, 64, 128 GiB) so
  // labels come out as "64 GB", never "79.2 GB".
  const yTicks = useMemo(
    () => byteTicks(data.reduce((m, s) => Math.max(m, s.diskBytes), 0)),
    [data],
  );

  const yearly = spansYears(data);

  if (data.length === 0) return <div className="chart-empty">Simulating…</div>;

  return (
    <div className="chart-body" style={{ opacity: running ? 0.55 : 1 }}>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span className="legend-item" key={s.key}>
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={360}>
        <AreaChart data={data} syncId="sim" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke={theme.grid} strokeWidth={1} />
          <XAxis
            dataKey="t"
            type="number"
            scale="linear"
            domain={['dataMin', 'dataMax']}
            ticks={xTicks}
            tickFormatter={(t: number) => (yearly ? formatDate(t) : formatShortDate(t))}
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
            content={<GrowthTooltip series={series} />}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              name={s.name}
              stackId="disk"
              type="linear"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={s.color}
              fillOpacity={0.1}
              isAnimationActive={false}
              activeDot={{ r: 4.5, fill: s.color, stroke: theme.surface, strokeWidth: 2 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipProps {
  series: Series[];
  active?: boolean;
  payload?: Array<{ payload: MetricsSnapshot }>;
}

function GrowthTooltip({ series, active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="tooltip-date">{formatDate(s.t)}</div>
      {series.map((sr) => (
        <div className="tooltip-row" key={sr.key}>
          <span className="tooltip-key" style={{ background: sr.color }} />
          <span className="tooltip-value">{formatBytes(s[sr.key])}</span>
          <span className="tooltip-label">{sr.name.toLowerCase()}</span>
        </div>
      ))}
      {series.length > 1 && (
        <div className="tooltip-row tooltip-total">
          <span className="tooltip-key" />
          <span className="tooltip-value">{formatBytes(s.diskBytes)}</span>
          <span className="tooltip-label">total on disk</span>
        </div>
      )}
      <div className="tooltip-row tooltip-secondary">
        {formatCount(s.sstableCount)} SSTables · memtable {formatBytes(s.memtableBytes)}
      </div>
    </div>
  );
}
