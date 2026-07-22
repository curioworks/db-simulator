import type { ColumnSpec } from '../engine/profiler/types.ts';
import { DAY_MS, HOUR_MS, type ScenarioConfig } from '../presets/scenario.ts';
import { formatBytes } from './format.ts';

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
        <SliderField
          label="Query window"
          value={scenario.queryWindowHours}
          min={1}
          max={168}
          step={1}
          display={`reads last ${formatQueryWindow(scenario.queryWindowHours)}`}
          onChange={(queryWindowHours) => set({ queryWindowHours })}
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
        <h2>Partitions</h2>
        <SliderField
          label="Partitions"
          value={Math.log10(scenario.partitionCount)}
          min={1}
          max={8}
          step={0.05}
          display={formatPartitionCount(scenario.partitionCount)}
          onChange={(log) => set({ partitionCount: roundPartitionCount(10 ** log) })}
        />
        <SliderField
          label="Write skew"
          value={scenario.skewExponent}
          min={0}
          max={2}
          step={0.05}
          display={formatSkew(scenario.skewExponent)}
          onChange={(skewExponent) => set({ skewExponent })}
        />
        <SliderField
          label="Nodes"
          value={scenario.nodes}
          min={scenario.replicationFactor}
          max={48}
          step={1}
          display={`${scenario.nodes} nodes`}
          onChange={(nodes) => set({ nodes })}
        />
        <SliderField
          label="Sub-sharding"
          value={Math.log2(scenario.maxSubShards)}
          min={0}
          max={3}
          step={1}
          display={formatSubShards(scenario.maxSubShards)}
          onChange={(log) => set({ maxSubShards: 2 ** log })}
        />
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
          label="Disk per node"
          value={Math.log2(scenario.diskPerNodeGiB)}
          min={6}
          max={14}
          step={0.25}
          display={formatDiskPerNode(scenario.diskPerNodeGiB)}
          onChange={(log) => set({ diskPerNodeGiB: roundDiskGiB(2 ** log) })}
        />
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
            <option value="twcs">TWCS (time-window)</option>
          </select>
        </label>
        {scenario.compaction === 'twcs' && (
          <SliderField
            label="TWCS window"
            value={scenario.twcsWindowDays}
            min={1}
            max={60}
            step={1}
            display={scenario.twcsWindowDays === 1 ? '1 day' : `${scenario.twcsWindowDays} days`}
            onChange={(twcsWindowDays) => set({ twcsWindowDays })}
          />
        )}
        {scenario.compaction !== 'none' && (
          <SliderField
            label="Compaction throughput"
            value={scenario.compactionMiBPerSec}
            min={1}
            max={256}
            step={1}
            display={`${scenario.compactionMiBPerSec} MiB/s per node`}
            onChange={(compactionMiBPerSec) => set({ compactionMiBPerSec })}
          />
        )}
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
          <span>Key</span>
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
              value={col.key ? '' : col.cellOverheadBytes ?? 12}
              disabled={!!col.key}
              aria-label={`Column ${i + 1} cell overhead bytes`}
              title={col.key ? 'Clustering-key columns have no per-cell overhead' : undefined}
              onChange={(e) => setColumn(i, { cellOverheadBytes: Number(e.target.value) })}
            />
            <input
              type="checkbox"
              className="schema-key"
              checked={!!col.key}
              aria-label={`Column ${i + 1} is part of the clustering key`}
              title="Part of the clustering key: stored as the row's clustering prefix — no per-cell overhead, and the only field a row tombstone carries"
              onChange={(e) =>
                setColumn(i, { key: e.target.checked || undefined, cellOverheadBytes: undefined })
              }
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
        <p className="schema-note">
          Tick <strong>Key</strong> to make a column part of the clustering key: it is stored
          as the row's clustering prefix — no per-cell overhead — and is the only field a
          row-deletion tombstone still has to carry.
        </p>
        <label className="field">
          <span className="field-label">
            Partition key
            <span className="field-value">{scenario.schema.partitionKeyBytes ?? 0} B</span>
          </span>
          <input
            type="number"
            min={0}
            value={scenario.schema.partitionKeyBytes ?? 0}
            aria-label="Partition key bytes"
            onChange={(e) => setSchema({ partitionKeyBytes: Number(e.target.value) || undefined })}
          />
        </label>
        <p className="schema-note">
          Charged <strong>once per partition</strong> — {formatPartitionCount(scenario.partitionCount)}{' '}
          × this, a flat term on the disk line — not per row. Static partition count means it
          doesn't grow with writes, so at any real row count it's below the noise floor.
        </p>
      </section>
    </div>
  );
}

export function formatQueryWindow(hours: number): string {
  if (hours === 24) return '1 day';
  if (hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} h`;
}

/**
 * The partition slider is logarithmic — the interesting range spans 10 to
 * 100M — so snap to one or two significant digits and keep the label short.
 */
function roundPartitionCount(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = magnitude >= 100 ? magnitude / 10 : 1;
  return Math.max(1, Math.round(raw / step) * step);
}

export function formatPartitionCount(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M keys`;
  if (n >= 1_000) return `${parseFloat((n / 1_000).toFixed(1))}K keys`;
  return `${n} keys`;
}

/**
 * The disk slider is logarithmic (64 GiB → 16 TiB), so snap to the round
 * capacities people actually buy rather than to 2^13.25 = 9,742 GiB.
 */
function roundDiskGiB(raw: number): number {
  const magnitude = 2 ** Math.floor(Math.log2(raw));
  return Math.round(Math.round(raw / (magnitude / 4)) * (magnitude / 4));
}

/**
 * Formatted through formatBytes so the slider and the disk verdict name the
 * same capacity the same way — "3 TB per node" in both places, not "3 TiB"
 * here and "3 TB" there.
 */
export function formatDiskPerNode(giB: number): string {
  return `${formatBytes(giB * 1024 * 1024 * 1024)} per node`;
}

/**
 * The mitigation's cap, not a fixed shard count: a partition is only promoted
 * to it a doubling at a time, and only if it outgrows the trigger. Powers of
 * two because the bucket column is `hash(x) % S`.
 */
export function formatSubShards(max: number): string {
  return max <= 1 ? 'off' : `up to ${max} per hot key`;
}

/** Zipf exponent → what it means for the hot end of the key distribution. */
export function formatSkew(exponent: number): string {
  const label =
    exponent < 0.05
      ? 'uniform'
      : exponent < 0.5
        ? 'mild'
        : exponent < 0.9
          ? 'moderate'
          : exponent < 1.3
            ? 'hot keys'
            : 'severe';
  return `${exponent.toFixed(2)} · ${label}`;
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
