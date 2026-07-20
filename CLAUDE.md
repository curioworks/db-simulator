# db-simulator — Cassandra Growth & Failure Simulator

Interactive, fully client-side simulator that shows how a Cassandra table grows on disk
over time — and when a cluster is mathematically bound to fail — given a schema, write
rate, TTL, compaction strategy, and skew profile. Static hosting only (GitHub Pages).

## Core design decision

**Simulate metadata, not rows.** An SSTable is a struct:
`{ createdAt, minTs, maxTs, liveBytes, expiredBytes, tombstoneBytes }`
Never materialize data. Simulating 5 years of a 10TB table must take milliseconds.

## Architecture (3 layers, strictly separated)

1. **Size profiler** (`src/engine/profiler/`) — sample rows (CSV/JSON via File API,
   data never leaves the browser) or manual schema → per-row byte cost.
   `rowBytes = Σ(cellValue + cellOverhead[8–25B]) + clusteringKey + ~10B rowOverhead`,
   then `× (1 - compressionRatio)` (LZ4 ≈ 0.3–0.5) `× RF`.
2. **Engine** (`src/engine/`) — pure TypeScript, zero DOM deps, deterministic (seeded RNG).
   Tick loop (1h or 1d ticks): accumulate memtable → flush → age data across TTL →
   run compaction policy → emit metrics snapshot.
   Compaction is a strategy interface; STCS/TWCS/LCS are plugins.
   Tombstones drop only if gc_grace has passed AND all shadowed data is in the same SSTable.
3. **Presentation** (`src/ui/`) — React consumes plain time-series from the engine.
   Engine runs in a **Web Worker**; sliders re-simulate live.

## Stack

- Vite + React + TypeScript, recharts for charts, vitest for tests
- Config serialized to base64 URL param → every scenario is a shareable link
- Deploy: GitHub Actions → GitHub Pages
- Preset scenarios live in `src/presets/`

## Key outputs

- Stacked area chart over time: live / expired-not-yet-dropped / tombstone bytes
- SSTable count, read-amplification estimate per tick
- Flagship demo: TTL 7d + TWCS window 30d → disk line goes flat (data expires, disk never shrinks)

## Milestones

- **M1** — size model + write-only growth line. Validate math by hand first.
- **M2** — TTL expiry + tombstone accounting (expired ≠ deleted; gc_grace gate). Stacked area chart.
- **M3** — STCS (simplest policy; proves the strategy interface).
- **M4** — TWCS + preset "classic mistakes" scenarios (incl. flagship demo above).
- **M5** — read-amplification overlay (SSTables touched per query window).
- **M6** — skew model: top-K hot partitions simulated individually (Zipfian, slider for
  skew factor) + one aggregate tail bucket; partitions → token ranges → replica sets
  (N nodes, RF) so hot partitions concentrate on specific nodes.
- **M7** — failure verdicts, each a threshold with a date:
  1. Wide partition cliff — max partition size vs 100MB (warn) / multi-GB (fatal)
  2. Compaction saturation — per node, `ingestRate × writeAmp > compactionCap` ⇒ unbounded backlog (queue with ρ > 1); report the crossing day
  3. Disk asymmetry — hottest replica fills while cluster average looks healthy
- **M8** — mitigation toggle: sub-sharding with step-up promotion; slider 1→8 sub-shards,
  watch failure horizon recede or flip to stable.

## Testing

Golden-file tests: fixed seed + config → exact expected time series committed to repo.
Compaction bugs must show up as diffs. Engine tests run in Node via vitest, no DOM.

## Conventions

- Engine must stay importable without a browser (no `window`, no React imports)
- All randomness through one seeded PRNG passed into the engine
- Time is `number` (epoch ms) internally; formatting only in UI
- Sim currently in-progress: **M1–M7 done** (size model, growth line, TTL expiry + tombstone accounting, stacked chart, STCS + TWCS via the strategy interface — gc_grace-gated purging at merge, whole-window expiry drops — classic-mistake presets incl. the flagship TTL 7d + TWCS 30d window demo, golden tests, UI + worker, read-amplification overlay: per-tick `readSstables` = SSTables overlapping the trailing query window, query-window slider + synced step chart; skew model: Zipf write shares over `partitionCount` keys with the top 8 tracked individually + one aggregate tail, each hot partition's token pinning it to RF ring-consecutive nodes, per-tick `maxPartitionBytes`/`hotNodeBytes`, partitions/skew/nodes sliders + per-node bar chart, "Hot partitions" preset; failure verdicts in `src/engine/verdicts.ts` — wide-partition cliff, compaction saturation, disk asymmetry — each a threshold with a date, a verdict panel above the tiles, disk-per-node + compaction-throughput sliders, "Compaction throttled" preset; sub-sharding with step-up promotion in `src/engine/subshard.ts` — a hot partition doubles its shard count onto fresh tokens whenever one shard passes 50 MB, up to a 1→8 slider cap, with per-tick `hotNode`/`hotPartitionShards`, a promotion report on the wide-partition verdict, and the "Sub-sharding" preset). **All milestones M1–M8 are done.** Live demo: https://curioworks.github.io/db-simulator/

- Skew math note: shares are constant and TTL is uniform, so every partition holds exactly its share of the cluster totals at all times — the per-tick skew figures are two fixed fractions of `diskBytes`, no per-partition state in the tick loop. The Zipf normalizer sums 10K terms exactly then closes the tail with Euler–Maclaurin, so 10^8 partitions costs O(1), not O(n).
- Verdict notes (M7): verdicts run **after** the loop over the finished series, because two of the three need hindsight — the first crossing of a metric a sawtooth crosses repeatedly, and a backlog that only counts as unbounded if it never drains again. **Decide on the peak, not the horizon value**: STCS's lumpy reclaim can leave a node reading 42% full at the horizon while it hit 83% every cycle, so every byte-valued verdict carries `peak` alongside `value`. Write amplification is measured, not estimated — strategies report each merge through `CompactionContext.onWrite`, because diffing a tick's input and output sets would miss the intermediate tables an STCS cascade really wrote. The compaction backlog is a *shadow* queue: the engine still compacts unthrottled (the disk line shows a cluster that kept up) while the queue measures whether it could have. Verdicts carry numbers only — all wording and date formatting live in `VerdictPanel.tsx`.
- Sub-sharding notes (M8): the mitigation is modelled as **generations**, and the single rule everything follows from is that **re-keying is not retroactive** — a promotion redirects new writes onto fresh tokens and leaves every row already written exactly where it is. So the widest partition goes *flat* at a promotion, never smaller, and only shrinks as TTL and compaction reach the old generation; a model that divided the current size by the new shard count would show a comforting instant cliff that no real cluster has ever produced. A partition's bytes are therefore its write share **averaged over the history the disk still holds**, and that window is measured from the disk line itself (`diskBytes ÷ ingest`) rather than assumed equal to the TTL — which is what makes a table whose compaction strands weeks of expired data correctly keep its old wide partition for weeks. With no TTL the window is the whole run and the arithmetic lands where it should: the old generation's bytes stay constant forever, so sub-sharding stops the partition growing and never shrinks it. Promotion triggers at **half** the 100 MB warn line, deliberately: a mitigation that waits for the warn line guarantees the warn line is crossed, and the verdict could then never reach ok. Shares still sum to 1 because a partition's generations tile the window exactly. Cost is ~13% on the worst case (5 y hourly × 48 nodes: 590 → 665 ms), and zero when off — `maxSubShards ≤ 1` takes a static path that keeps every pre-M8 run bit-identical.
- The M8 result worth remembering: **8 sub-shards is exactly 8×, and nothing more.** No scenario goes fatal → ok on the 1→8 slider; the reachable moves are warn → ok and fatal → warn. On a key that is ~100× too coarse all it buys is precisely proportional time — while disk still grows linearly, each doubling of the shard count doubles the days to the cliff (fatal day 2 → 4 → 8 → 16). It also moves no bytes: the disk line is identical at every setting, because this is a schema change, not a capacity one. The read cost (a sub-sharded key scatters every read across all its shards) is stated in the verdict copy rather than folded into the read-amp metric, which counts SSTables cluster-wide and would be conflating two different things.
- Model limit worth knowing: hot partitions are the model's **only** source of node-level disk asymmetry, so a scenario with skewed nodes always also has wide partitions. Real clusters also skew from uneven vnode token ranges, which this model does not have.
- Perf note: simulation cost tracks the **flush count** (≈ total ingest ÷ `memtableFlushBytes`), not the byte count or the horizon. Day-length ticks at high write rates are pathological — thousands of SSTables accumulate inside one tick and STCS re-sorts the whole list per cascade step (measured 170 s vs 5.9 s for the same total work on hour ticks). High-volume presets need a large memtable to stay inside the milliseconds budget.