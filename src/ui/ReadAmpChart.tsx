import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsSnapshot } from '../engine/types.ts';
import { spansYears, useChartPoints, useXTicks } from './chartData.ts';
import { formatCount, formatDate, formatShortDate } from './format.ts';
import type { Theme } from './theme.ts';

interface Props {
  snapshots: MetricsSnapshot[];
  theme: Theme;
  /** Previous frame is held at reduced opacity while a re-sim is in flight. */
  running: boolean;
}

/**
 * SSTables a time-bounded read must touch, per tick. Shares syncId="sim" and
 * the exact x-points with the growth chart so both crosshairs move together.
 * The count is piecewise-constant between ticks, hence the step line.
 */
export function ReadAmpChart({ snapshots, theme, running }: Props) {
  const data = useChartPoints(snapshots);
  const xTicks = useXTicks(data);
  const yearly = spansYears(data);

  if (data.length === 0) return <div className="chart-empty chart-empty-short">Simulating…</div>;

  return (
    <div className="chart-body" style={{ opacity: running ? 0.55 : 1 }}>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} syncId="sim" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
            tickFormatter={formatCount}
            allowDecimals={false}
            domain={[0, 'auto']}
            tick={{ fill: theme.muted, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={78}
          />
          <Tooltip
            cursor={{ stroke: theme.axis, strokeWidth: 1 }}
            content={<ReadAmpTooltip color={theme.series4} />}
          />
          <Line
            dataKey="readSstables"
            name="SSTables touched"
            type="stepAfter"
            stroke={theme.series4}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 4.5, fill: theme.series4, stroke: theme.surface, strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipProps {
  color: string;
  active?: boolean;
  payload?: Array<{ payload: MetricsSnapshot }>;
}

function ReadAmpTooltip({ color, active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="tooltip-date">{formatDate(s.t)}</div>
      <div className="tooltip-row">
        <span className="tooltip-key" style={{ background: color }} />
        <span className="tooltip-value">{formatCount(s.readSstables)}</span>
        <span className="tooltip-label">
          of {formatCount(s.sstableCount)} SSTables touched
        </span>
      </div>
    </div>
  );
}
