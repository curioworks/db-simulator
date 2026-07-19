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
- Sim currently in-progress: **M1–M5 done** (size model, growth line, TTL expiry + tombstone accounting, stacked chart, STCS + TWCS via the strategy interface — gc_grace-gated purging at merge, whole-window expiry drops — classic-mistake presets incl. the flagship TTL 7d + TWCS 30d window demo, golden tests, UI + worker, read-amplification overlay: per-tick `readSstables` = SSTables overlapping the trailing query window, query-window slider + synced step chart); next is **M6** (skew model: hot partitions → token ranges → replica sets). Live demo: https://curioworks.github.io/db-simulator/