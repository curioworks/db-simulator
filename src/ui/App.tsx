import { useEffect, useMemo, useState } from 'react';
import { buildSizeModel } from '../engine/profiler/rowSize.ts';
import { presets, sensorBaseline } from '../presets/index.ts';
import { clampScenario, toSimConfig, type ScenarioConfig } from '../presets/scenario.ts';
import { ControlsPanel, formatPartitionCount, formatQueryWindow } from './ControlsPanel.tsx';
import { GrowthChart } from './GrowthChart.tsx';
import { NodeChart } from './NodeChart.tsx';
import { ReadAmpChart } from './ReadAmpChart.tsx';
import { VerdictPanel } from './VerdictPanel.tsx';
import { formatBytes, formatCount, formatDate } from './format.ts';
import { useSimulation } from './useSimulation.ts';
import { useTheme } from './theme.ts';
import { readScenarioFromUrl, writeScenarioToUrl } from './urlConfig.ts';

export function App() {
  const theme = useTheme();
  const [scenario, setScenarioRaw] = useState<ScenarioConfig>(
    () => clampScenario(readScenarioFromUrl() ?? sensorBaseline),
  );
  const setScenario = (next: ScenarioConfig) => setScenarioRaw(clampScenario(next));

  useEffect(() => writeScenarioToUrl(scenario), [scenario]);

  // Opening a shared #c=… link while the app is already loaded is a
  // same-document navigation — no reload, so re-read the hash ourselves.
  // (Our own writes use history.replaceState, which never fires hashchange.)
  useEffect(() => {
    const onHashChange = () => {
      const fromUrl = readScenarioFromUrl();
      if (fromUrl) setScenarioRaw(clampScenario(fromUrl));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const sizeModel = useMemo(
    () =>
      buildSizeModel({
        schema: scenario.schema,
        compressionRatio: scenario.compressionRatio,
        replicationFactor: scenario.replicationFactor,
      }),
    [scenario],
  );
  const simConfig = useMemo(() => toSimConfig(scenario, sizeModel), [scenario, sizeModel]);
  const { snapshots, skew, verdicts, running, elapsedMs } = useSimulation(simConfig);

  const last = snapshots.at(-1);
  // Both figures must come from the same simulation: while a re-sim is in
  // flight the worker's node count still trails the slider, and mixing the
  // two renders a "fullest node" below the average.
  const simNodes = skew?.nodeShare.length ?? 0;
  const avgNodeBytes = last && simNodes > 0 ? last.diskBytes / simNodes : 0;
  const ingestPerDay =
    scenario.writeRatePerSec * 86_400 * sizeModel.onDiskRowBytes +
    scenario.deleteRatePerSec * 86_400 * sizeModel.tombstoneRowBytes;
  const deadAtHorizon = last ? last.expiredBytes + last.tombstoneBytes : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>Cassandra growth simulator</h1>
          <p>
            How a table grows on disk given a schema, write rate, TTL and compaction strategy.
            Try TWCS on a TTL'd table: a window sized to the TTL drops whole expired windows
            daily, while a 30-day window strands weeks of expired data on disk. The read
            amplification panel counts the SSTables one time-bounded read has to touch. Turn
            up write skew and watch the hottest partition swell while the fullest node pulls
            away from a cluster average that still looks healthy. The verdicts up top turn all
            of that into three dates: when the hottest partition passes the cliff, when
            compaction stops being able to catch up, and when the fullest node runs out of
            disk.
          </p>
        </header>
        <label className="field preset-field">
          <span className="field-label">Preset</span>
          <select
            value={presets.some((p) => p.name === scenario.name) ? scenario.name : '__custom__'}
            onChange={(e) => {
              const preset = presets.find((p) => p.name === e.target.value);
              if (preset) setScenario(preset);
            }}
          >
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            {!presets.some((p) => p.name === scenario.name) && (
              <option value="__custom__">Custom scenario</option>
            )}
          </select>
        </label>
        <ControlsPanel
          scenario={scenario}
          onChange={(next) => setScenario({ ...next, name: 'Custom scenario' })}
        />
      </aside>

      <main className="main">
        <VerdictPanel verdicts={verdicts} running={running} />

        <div className="tiles">
          <StatTile
            label="Row on disk"
            value={formatBytes(sizeModel.onDiskRowBytes)}
            sub={`${sizeModel.rawRowBytes.toFixed(0)} B raw − ${Math.round(scenario.compressionRatio * 100)}% × RF ${scenario.replicationFactor}`}
          />
          <StatTile label="Ingest per day" value={formatBytes(ingestPerDay)} sub="cluster-wide, on disk" />
          <StatTile
            label="Disk at horizon"
            value={last ? formatBytes(last.diskBytes + last.memtableBytes) : '—'}
            sub={last ? formatDate(last.t) : ''}
          />
          <StatTile
            label="Dead at horizon"
            value={deadAtHorizon !== null ? formatBytes(deadAtHorizon) : '—'}
            sub="expired + tombstones"
          />
          <StatTile
            label="SSTables"
            value={last ? formatCount(last.sstableCount) : '—'}
            sub={
              scenario.compaction === 'stcs'
                ? 'STCS compaction'
                : scenario.compaction === 'twcs'
                  ? `TWCS ${scenario.twcsWindowDays}d windows`
                  : 'no compaction'
            }
          />
          <StatTile
            label="Read amplification"
            value={last ? formatCount(last.readSstables) : '—'}
            sub={`SSTables per read, last ${formatQueryWindow(scenario.queryWindowHours)}`}
          />
          <StatTile
            label="Hottest partition"
            value={last ? formatBytes(last.maxPartitionBytes) : '—'}
            sub={`per replica, of ${formatPartitionCount(scenario.partitionCount)}`}
          />
          <StatTile
            label="Fullest node"
            value={last ? formatBytes(last.hotNodeBytes) : '—'}
            sub={
              last && avgNodeBytes > 0
                ? `${(last.hotNodeBytes / avgNodeBytes).toFixed(2)}× the ${simNodes}-node average`
                : `${scenario.nodes}-node ring`
            }
          />
        </div>

        <div className="chart-card">
          <div className="chart-title">
            <h2>On-disk size over time</h2>
            {elapsedMs !== null && (
              <span className="chart-meta">simulated in {elapsedMs.toFixed(0)} ms</span>
            )}
          </div>
          <GrowthChart snapshots={snapshots} theme={theme} running={running} />
        </div>

        <div className="chart-card">
          <div className="chart-title">
            <h2>Read amplification</h2>
            <span className="chart-meta">
              SSTables a read of the last {formatQueryWindow(scenario.queryWindowHours)} must touch
            </span>
          </div>
          <ReadAmpChart snapshots={snapshots} theme={theme} running={running} />
        </div>

        <div className="chart-card">
          <div className="chart-title">
            <h2>Disk per node</h2>
            <span className="chart-meta">
              at the horizon · RF {scenario.replicationFactor} over {scenario.nodes} nodes
            </span>
          </div>
          <NodeChart
            diskBytes={last?.diskBytes ?? 0}
            skew={skew}
            theme={theme}
            running={running}
          />
        </div>

        <details className="table-view">
          <summary>Data table</summary>
          <SnapshotTable snapshots={snapshots} />
        </details>
      </main>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </div>
  );
}

const TABLE_ROWS = 24;

function SnapshotTable({ snapshots }: { snapshots: ReturnType<typeof useSimulation>['snapshots'] }) {
  const rows = useMemo(() => {
    const stride = Math.max(1, Math.ceil(snapshots.length / TABLE_ROWS));
    const out = snapshots.filter((_, i) => (i + 1) % stride === 0);
    const lastRow = snapshots.at(-1);
    if (lastRow && out.at(-1) !== lastRow) out.push(lastRow);
    return out;
  }, [snapshots]);

  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Live</th>
          <th>Expired</th>
          <th>Tombstones</th>
          <th>Total on disk</th>
          <th>SSTables</th>
          <th>Read amp</th>
          <th>Hot partition</th>
          <th>Fullest node</th>
          <th>Compacted</th>
          <th>Backlog</th>
          <th>Memtable</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.t}>
            <td>{formatDate(s.t)}</td>
            <td>{formatBytes(s.liveBytes)}</td>
            <td>{formatBytes(s.expiredBytes)}</td>
            <td>{formatBytes(s.tombstoneBytes)}</td>
            <td>{formatBytes(s.diskBytes)}</td>
            <td>{formatCount(s.sstableCount)}</td>
            <td>{formatCount(s.readSstables)}</td>
            <td>{formatBytes(s.maxPartitionBytes)}</td>
            <td>{formatBytes(s.hotNodeBytes)}</td>
            <td>{formatBytes(s.compactionBytes)}</td>
            <td>{formatBytes(s.compactionBacklogBytes)}</td>
            <td>{formatBytes(s.memtableBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
