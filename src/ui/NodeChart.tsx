import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SkewModel } from '../engine/types.ts';
import { byteTicks } from './chartData.ts';
import { formatBytes } from './format.ts';
import type { Theme } from './theme.ts';

interface Props {
  /** Cluster-wide on-disk bytes at the horizon — every replica counted once. */
  diskBytes: number;
  skew: SkewModel | undefined;
  theme: Theme;
  running: boolean;
}

interface NodeRow {
  node: string;
  bytes: number;
  share: number;
  /** Ranks (1-based) of the tracked hot partitions this node replicates. */
  hosts: number[];
}

/**
 * Where the bytes actually land. One bar per node, in ring order — sorting by
 * size would hide which node is which, and node identity is the point: the
 * cluster average can look healthy while one node fills up.
 *
 * Bars carry direct value labels: slot 5 sits below 3:1 on the light surface,
 * so the numbers, not the fill, do the reading.
 */
export function NodeChart({ diskBytes, skew, theme, running }: Props) {
  const data = useMemo<NodeRow[]>(() => {
    if (!skew) return [];
    return skew.nodeShare.map((share, i) => ({
      node: `n${i}`,
      bytes: share * diskBytes,
      share,
      hosts: skew.hotReplicas.flatMap((replicas, rank) => (replicas.includes(i) ? [rank + 1] : [])),
    }));
  }, [skew, diskBytes]);

  if (data.length === 0) {
    return <div className="chart-empty chart-empty-short">Simulating…</div>;
  }

  const average = diskBytes / data.length;
  const hottest = data.reduce((m, d) => Math.max(m, d.bytes), 0);
  // Round tick labels, but the axis still ends at the data: rounding the
  // domain up to the next binary step would strand a third of the plot width.
  const xTicks = byteTicks(hottest, 4)?.filter((t) => t <= hottest);
  const axisMax = hottest * 1.02;

  return (
    <div className="chart-body" style={{ opacity: running ? 0.55 : 1 }}>
      <ResponsiveContainer width="100%" height={Math.max(160, 44 + data.length * 26)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 20, right: 78, bottom: 0, left: 8 }}
          barCategoryGap={2}
        >
          <CartesianGrid horizontal={false} stroke={theme.grid} strokeWidth={1} />
          <XAxis
            type="number"
            domain={[0, axisMax]}
            ticks={xTicks}
            tickFormatter={formatBytes}
            tick={{ fill: theme.muted, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: theme.axis, strokeWidth: 1 }}
          />
          <YAxis
            type="category"
            dataKey="node"
            tick={{ fill: theme.muted, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            cursor={{ fill: theme.grid, fillOpacity: 0.4 }}
            content={<NodeTooltip color={theme.series5} average={average} />}
          />
          <Bar dataKey="bytes" fill={theme.series5} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.node} stroke={theme.surface} strokeWidth={2} />
            ))}
            <LabelList
              dataKey="bytes"
              position="right"
              offset={8}
              formatter={(v) => formatBytes(Number(v))}
              style={{ fill: theme.ink2, fontSize: 12 }}
            />
          </Bar>
          <ReferenceLine
            x={average}
            stroke={theme.ink2}
            strokeDasharray="3 3"
            strokeWidth={1}
            label={{
              value: `average ${formatBytes(average)}`,
              position: 'top',
              offset: 8,
              fill: theme.muted,
              fontSize: 11,
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipProps {
  color: string;
  average: number;
  active?: boolean;
  payload?: Array<{ payload: NodeRow }>;
}

function NodeTooltip({ color, average, active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="tooltip-date">Node {d.node}</div>
      <div className="tooltip-row">
        <span className="tooltip-key" style={{ background: color }} />
        <span className="tooltip-value">{formatBytes(d.bytes)}</span>
        <span className="tooltip-label">on disk · {(d.share * 100).toFixed(1)}% of cluster</span>
      </div>
      <div className="tooltip-row tooltip-secondary">
        {average > 0 ? `${(d.bytes / average).toFixed(2)}× the cluster average` : 'no data yet'}
        {d.hosts.length > 0
          ? ` · replicates hot partition${d.hosts.length > 1 ? 's' : ''} #${d.hosts.join(', #')}`
          : ' · no tracked hot partition'}
      </div>
    </div>
  );
}
