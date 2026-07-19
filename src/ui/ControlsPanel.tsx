import type { ColumnSpec } from '../engine/profiler/types.ts';
import { DAY_MS, HOUR_MS, type ScenarioConfig } from '../presets/scenario.ts';

interface Props {
  scenario: ScenarioConfig;
  onChange: (next: ScenarioConfig) => void;
}

export function ControlsPanel({ scenario, onChange }: Props) {
  const set = (patch: Partial<ScenarioConfig>) => onChange({ ...scenario, ...patch });
  const setSchema = (patch: Partial<ScenarioConfig['schema']>) =>
    set({ schema: { ...scenario.schema, ...patch } });
  const setColumn = (i: number, patch: Partial<ColumnSpec>) => {
    const columns = scenario.schema.columns.map((c, j) => (j === i ? { ...c, ...patch } : c));
    setSchema({ columns });
  };

  return (
    <div className="controls">
      <section>
        <h2>Workload</h2>
        <SliderField
          label="Write rate"
          value={scenario.writeRatePerSec}
          min={10}
          max={10000}
          step={10}
          display={`${scenario.writeRatePerSec.toLocaleString('en-US')} rows/s`}
          onChange={(writeRatePerSec) => set({ writeRatePerSec })}
        />
        <SliderField
          label="Horizon"
          value={scenario.days}
          min={30}
          max={1825}
          step={5}
          display={scenario.days >= 365 ? `${(scenario.days / 365).toFixed(1)} years` : `${scenario.days} days`}
          onChange={(days) => set({ days })}
        />
        <SliderField
          label="Row TTL"
          value={scenario.ttlDays}
          min={0}
          max={90}
          step={1}
          display={scenario.ttlDays === 0 ? 'off' : `${scenario.ttlDays} days`}
          onChange={(ttlDays) => set({ ttlDays })}
        />
        <SliderField
          label="Delete rate"
          value={scenario.deleteRatePerSec}
          min={0}
          max={1000}
          step={5}
          display={
            scenario.deleteRatePerSec === 0
              ? 'none'
              : `${scenario.deleteRatePerSec.toLocaleString('en-US')} rows/s`
          }
          onChange={(deleteRatePerSec) => set({ deleteRatePerSec })}
        />
        <label className="field">
          <span className="field-label">Tick resolution</span>
          <select
            value={scenario.tickMs}
            onChange={(e) => set({ tickMs: Number(e.target.value) })}
          >
            <option value={HOUR_MS}>1 hour</option>
            <option value={DAY_MS}>1 day</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Cluster</h2>
        <label className="field">
          <span className="field-label">Replication factor</span>
          <select
            value={scenario.replicationFactor}
            onChange={(e) => set({ replicationFactor: Number(e.target.value) })}
          >
            {[1, 2, 3, 5].map((rf) => (
              <option key={rf} value={rf}>
                RF {rf}
              </option>
            ))}
          </select>
        </label>
        <SliderField
          label="Compression savings"
          value={scenario.compressionRatio}
          min={0}
          max={0.9}
          step={0.05}
          display={`${Math.round(scenario.compressionRatio * 100)}%`}
          onChange={(compressionRatio) => set({ compressionRatio })}
        />
        <SliderField
          label="Memtable flush threshold"
          value={scenario.memtableFlushMiB}
          min={16}
          max={512}
          step={16}
          display={`${scenario.memtableFlushMiB} MiB`}
          onChange={(memtableFlushMiB) => set({ memtableFlushMiB })}
        />
        <label className="field">
          <span className="field-label">Compaction</span>
          <select
            value={scenario.compaction}
            onChange={(e) => set({ compaction: e.target.value as ScenarioConfig['compaction'] })}
          >
            <option value="none">None</option>
            <option value="stcs">STCS (size-tiered)</option>
          </select>
        </label>
        {scenario.compaction !== 'none' && (
          <SliderField
            label="gc_grace"
            value={scenario.gcGraceDays}
            min={0}
            max={30}
            step={1}
            display={scenario.gcGraceDays === 0 ? 'purge immediately' : `${scenario.gcGraceDays} days`}
            onChange={(gcGraceDays) => set({ gcGraceDays })}
          />
        )}
      </section>

      <section>
        <h2>Schema</h2>
        <div className="schema-head">
          <span>Column</span>
          <span>Value B</span>
          <span>Cell ovh</span>
          <span />
        </div>
        {scenario.schema.columns.map((col, i) => (
          <div className="schema-row" key={i}>
            <input
              type="text"
              value={col.name}
              aria-label={`Column ${i + 1} name`}
              onChange={(e) => setColumn(i, { name: e.target.value })}
            />
            <input
              type="number"
              min={0}
              value={col.valueBytes}
              aria-label={`Column ${i + 1} value bytes`}
              onChange={(e) => setColumn(i, { valueBytes: Number(e.target.value) })}
            />
            <input
              type="number"
              min={0}
              max={100}
              value={col.cellOverheadBytes ?? 12}
              aria-label={`Column ${i + 1} cell overhead bytes`}
              onChange={(e) => setColumn(i, { cellOverheadBytes: Number(e.target.value) })}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove column ${col.name}`}
              disabled={scenario.schema.columns.length === 1}
              onClick={() =>
                setSchema({ columns: scenario.schema.columns.filter((_, j) => j !== i) })
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ghost-btn"
          onClick={() =>
            setSchema({
              columns: [
                ...scenario.schema.columns,
                { name: `col_${scenario.schema.columns.length + 1}`, valueBytes: 8, cellOverheadBytes: 12 },
              ],
            })
          }
        >
          + Add column
        </button>
        <label className="field">
          <span className="field-label">Clustering key bytes</span>
          <input
            type="number"
            min={0}
            value={scenario.schema.clusteringKeyBytes}
            onChange={(e) => setSchema({ clusteringKeyBytes: Number(e.target.value) })}
          />
        </label>
      </section>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}

function SliderField({ label, value, min, max, step, display, onChange }: SliderFieldProps) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        <span className="field-value">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
