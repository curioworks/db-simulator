import type { Verdict, VerdictCrossing, VerdictLevel } from '../engine/types.ts';
import { formatBytes, formatDate } from './format.ts';

interface Props {
  verdicts: Verdict[];
  running: boolean;
}

/**
 * The three ways this cluster is bound to fail, each as a threshold and the
 * date it was crossed (M7).
 *
 * Status colour never carries the meaning on its own: every card pairs its
 * hue with a glyph and the level spelled out, and all the text sits in ink
 * tokens rather than the status hue — the reference status palette puts
 * warning at 1.79:1 on the light surface, which is a fine mark and an
 * unreadable label. The glyph gets its contrast from the filled badge behind
 * it instead (ink on good/warn, white on fatal: 5.9, 10.7 and 4.8:1).
 */
export function VerdictPanel({ verdicts, running }: Props) {
  if (verdicts.length === 0) {
    return <div className="chart-empty chart-empty-short">Checking for failure modes…</div>;
  }
  return (
    <div className="verdicts" style={{ opacity: running ? 0.55 : 1 }}>
      {verdicts.map((v) => (
        <VerdictCard key={v.id} verdict={v} />
      ))}
    </div>
  );
}

const LEVEL_LABEL: Record<VerdictLevel, string> = {
  ok: 'Holds',
  warn: 'Warning',
  fatal: 'Fatal',
};

const LEVEL_GLYPH: Record<VerdictLevel, string> = { ok: '✓', warn: '!', fatal: '✕' };

function VerdictCard({ verdict }: { verdict: Verdict }) {
  const { title, headline, detail, fix } = describe(verdict);
  return (
    <div className={`verdict verdict-${verdict.level}`}>
      <div className="verdict-head">
        <span className="verdict-badge" aria-hidden="true">
          {LEVEL_GLYPH[verdict.level]}
        </span>
        <span className="verdict-level">{LEVEL_LABEL[verdict.level]}</span>
        <span className="verdict-title">{title}</span>
      </div>
      <div className="verdict-headline">{headline}</div>
      <div className="verdict-detail">{detail}</div>
      {fix ? <div className="verdict-fix">{fix}</div> : null}
    </div>
  );
}

/** "day 22 · Jan 23, 2026" — the date a threshold was first reached. */
const when = (c: VerdictCrossing) => `day ${c.day} · ${formatDate(c.at)}`;

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** MiB/s, the unit Cassandra's compaction_throughput is set in. */
const mibs = (bytesPerSec: number) => `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MiB/s`;

interface Copy {
  title: string;
  headline: string;
  detail: string;
  fix?: string;
}

/**
 * Verdicts carry numbers only — wording and date formatting belong to the UI
 * (CLAUDE.md conventions), so every sentence is composed here.
 */
function describe(v: Verdict): Copy {
  switch (v.id) {
    case 'wide-partition': {
      const title = 'Wide partition cliff';
      const headline = `${formatBytes(v.peak)} in the widest partition`;
      const sharded = v.maxSubShards > 1;
      // Sub-sharding is a schema change with a running cost, so the copy names
      // the cost wherever it takes credit: every read of a sub-sharded key has
      // to scatter across all of its shards.
      const fix = sharded
        ? `Sub-sharding split it ${v.subShards} ways — every read of that key now scatters across all ${v.subShards}. Past that, only a finer partition key helps.`
        : 'Add to the partition key so writes spread over more of them — or turn on sub-sharding to split the hot keys automatically.';

      if (v.fatal) {
        const capped = sharded && v.subShards >= v.maxSubShards;
        return {
          title,
          headline,
          detail:
            `Past 100 MB on ${when(v.warn ?? v.fatal)}, past 1 GB on ${when(v.fatal)}. Repair, compaction and reads all materialise a partition at a time.` +
            (capped
              ? ` ${v.subShards} sub-shards only bought time: splitting ${v.subShards} ways divides the partition ${v.subShards} ways, and this key is further over than that.`
              : ''),
          fix,
        };
      }
      if (v.warn) {
        // Careful here: this branch is the partition going *over* the line, so
        // the promotion did not hold it. Saying it did — next to a headline
        // several times the guidance — is the kind of reassurance that gets a
        // cluster paged at 3am.
        const late = v.promoted
          ? v.subShards >= v.maxSubShards
            ? ` Sub-sharding split it ${v.subShards} ways and then ran out of shards on ${when(v.promoted)}; it kept growing from there.`
            : ` Sub-sharding split it ${v.subShards} ways on ${when(v.promoted)}, which was not enough.`
          : '';
        return {
          title,
          headline,
          detail:
            `Past Cassandra's 100 MB guidance on ${when(v.warn)}. Still short of the multi-GB range that takes a node down.` +
            late,
          fix,
        };
      }
      if (v.promoted) {
        return {
          title,
          headline,
          detail: `Held under the 100 MB guidance for the whole run. It was heading past it: sub-sharding promoted the hottest key to ${v.subShards} shards by ${when(v.promoted)}. The rows already written stayed exactly where they were — a split only redirects new ones.`,
          fix,
        };
      }
      return {
        title,
        headline,
        detail: `Under the 100 MB guidance for the whole run, spread over ${v.partitionCount.toLocaleString('en-US')} partitions.`,
      };
    }

    case 'compaction-saturation': {
      const title = 'Compaction saturation';
      const headline = `ρ ${v.value.toFixed(2)}`;
      const rates = `n${v.node} owes ${mibs(v.writeRateBytesPerSec)} of compaction against a ${mibs(v.capBytesPerSec)} cap`;
      const fix =
        'Raise compaction throughput, add nodes, or switch to TWCS so whole windows drop instead of being rewritten.';
      if (!v.compacting) {
        return {
          title,
          headline: 'no compaction',
          detail:
            'Nothing is merging, so there is no compaction queue to saturate. That cluster fails on read amplification instead — see the panel below.',
        };
      }
      if (v.capBytesPerSec <= 0) {
        return { title, headline: 'uncapped', detail: 'No compaction throughput limit set.' };
      }
      if (v.fatal) {
        return {
          title,
          headline,
          detail: `${rates}. Above 1 the queue has no steady state: it last drained on ${when(v.fatal)} and is ${formatBytes(v.backlogBytes)} behind by the horizon. More time does not help.`,
          fix,
        };
      }
      if (v.warn) {
        return {
          title,
          headline,
          detail: `${rates}, so it only just keeps up — first fell a full tick behind on ${when(v.warn)}. Nothing spare for a repair, a bootstrap or a node down.`,
          fix,
        };
      }
      return {
        title,
        headline,
        detail: `${rates}, leaving ${pct(1 - v.value, 1)} headroom.`,
      };
    }

    case 'disk-asymmetry': {
      const title = 'Disk asymmetry';
      const headline = `${formatBytes(v.peak)} on n${v.node}`;
      const share = v.capacityBytes > 0 ? pct(v.peak, v.capacityBytes) : '—';
      // Peak and average are both taken at the peak tick, so their ratio is
      // genuine node asymmetry. On an even ring it is ~1 and saying "while the
      // cluster averages half that" would be a lie told by the sawtooth.
      const ratio = v.averageBytes > 0 ? v.peak / v.averageBytes : 1;
      const contrast =
        ratio >= 1.05
          ? `n${v.node} peaks at ${share} of its ${formatBytes(v.capacityBytes)} disk — ${ratio.toFixed(2)}× what the average node holds at that moment`
          : `n${v.node} peaks at ${share} of its ${formatBytes(v.capacityBytes)} disk, with the rest of the ring right behind it`;
      const fix =
        ratio >= 1.05
          ? 'Skew puts the hot partitions on one replica set — spread the key, or give the ring more nodes.'
          : 'The ring is even, so this is volume, not skew: add nodes, shorten the TTL, or cut what compaction strands on disk.';
      if (v.capacityBytes <= 0) {
        return { title, headline, detail: 'No node disk size set.' };
      }
      if (v.fatal) {
        return {
          title,
          headline,
          detail: `${contrast}. Past 90% on ${when(v.fatal)}, with no room left for compaction to write a merge before it can free the inputs.`,
          fix,
        };
      }
      if (v.warn) {
        return {
          title,
          headline,
          detail: `${contrast}. Past 70% on ${when(v.warn)} — compaction needs headroom to write a merge's output before freeing its inputs.`,
          fix,
        };
      }
      return { title, headline, detail: `${contrast}. Comfortable for the whole run.` };
    }
  }
}
