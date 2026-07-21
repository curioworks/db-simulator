# Parameters, outputs and scenarios

A reference for every knob in the simulator: what it means, how it enters the
math, and how to read what comes back out.

Live demo: <https://curioworks.github.io/db-simulator/>

---

## 1. What is actually being simulated

**Metadata, not rows.** Nothing in this simulator ever materializes a row, a
value, or a key. The entire state of the modelled table is a list of structs:

```ts
{ createdAt, minTs, maxTs, liveBytes, expiredBytes, tombstoneBytes }
```

One struct per SSTable. Everything you see — the growth curve, the SSTable
count, the read amplification, the widest partition, the per-node disk bars —
is arithmetic over that list. That is why five simulated years of a 10 TB table
finish in milliseconds.

Two consequences worth internalising before reading anything else:

1. **There is no sample data.** See [§2](#2-there-is-no-sample-data).
2. **Every byte figure is on-disk, post-compression, and cluster-wide unless
   labelled otherwise** — replication factor is folded into the per-row cost
   once, at the top, so it does not have to be re-applied anywhere else. The two
   exceptions are labelled where they appear: *widest partition* is per replica,
   and *fullest node* is per node.

---

## 2. There is no sample data

This is worth stating plainly because the question comes up immediately, and
because `CLAUDE.md` describes a CSV/JSON sampling profiler that **has not been
built**. `src/engine/profiler/rowSize.ts` says so in its own doc comment:

> *(A sampling-based profiler over CSV/JSON rows lands later; it must produce
> the same SizeModel shape.)*

There is no file upload, no parser, and no row generator anywhere in the
codebase. Nothing is sampled, nothing is synthesised, and no data — yours or
otherwise — is read. What stands in for data is two independent abstractions:

### 2.1 The schema is a size, not a shape

You describe columns by their **average encoded byte cost**, not by type or
content. Each column is one of two kinds. A regular column is a *cell*: a value
plus per-cell metadata overhead (timestamp, flags, cell path — ~8 B bare, up to
~25 B with TTL). A column ticked **Key** is part of the **clustering key**
instead — stored once as the row's clustering prefix, so it carries value bytes
only and no per-cell overhead. (This is why the two are modelled separately:
they are stored differently, and only the clustering key survives into a row
tombstone.)

```
keyBytes       = Σ_key(valueBytes)                      ← clustering prefix, no cell overhead
cellBytes      = Σ_regular(valueBytes + cellOverheadBytes)
rawRowBytes    = cellBytes + keyBytes + rowOverheadBytes
compressedRow  = rawRowBytes × (1 − compressionRatio)
onDiskRowBytes = compressedRow × replicationFactor
```

The baseline preset works out to `(8+12) + (20+12) + 8 + 10 = 70 B` raw — two
data cells, one 8 B clustering-key column (value only), 10 B row overhead
→ 35 B compressed → **105 B on disk** at RF 3. Every single row in the
simulation costs exactly that. There is no size distribution, no variance, no
outlier row, no null handling and no wide-vs-narrow row mix. If your real rows
vary a lot in size, feed in the mean and know that the model will not show you
the tail.

Row-deletion tombstones get their own cost, which is deliberately *not* the row
cost — a tombstone is a marker, not data, so it carries the clustering key and
overhead but no cell values:

```
tombstoneRowBytes = (keyBytes + rowOverheadBytes + 12) × (1 − compressionRatio) × RF
```

### 2.2 Partitions are a count and a curve, not keys

There is no set of keys. The partition model is exactly two numbers —
`partitionCount` (N) and `skewExponent` (s) — from which every partition's share
of the write stream is derived analytically:

```
weight(i) = i^(−s) / H(N, s)        for rank i = 1 … N
H(N, s)   = Σ i^(−s)                (the generalized harmonic number)
```

The eight hottest partitions are tracked individually; everything past rank 8
is pooled into one aggregate tail bucket that spreads evenly. That is the whole
representation. (`H(N, s)` is summed exactly for the first 10,000 terms and
closed with Euler–Maclaurin after that, so N = 10⁸ costs the same as N = 100.)

### 2.3 What randomness exists

Almost none — and this surprises people. **Both compaction strategies are fully
deterministic and draw nothing from the PRNG.** Ingest is a constant continuous
rate with no bursts, no diurnal cycle and no jitter.

The seed feeds exactly one thing: **token placement** — which nodes each hot
partition's replicas land on. Verified by running the `Hot partitions` preset
across four seeds:

| Metric | Across seeds 42 / 7 / 1234 / 999 |
|---|---|
| disk, SSTable count, read amp, widest partition | **byte-identical** |
| replica placement | differs |
| fullest node at horizon | 17.0 / 16.1 / 14.4 / 20.9 GB |

So if you re-seed and the disk line moves, that is a bug. If the *fullest node*
moves, that is the model working: it is telling you your node asymmetry is a
function of where the ring happened to put your hot keys, and is worth
re-rolling a few times before you trust a single number.

The seed has no UI control. Presets all use 42; a custom seed can only arrive
through a shared URL.

---

## 3. Parameter reference

Everything below is clamped on input (`clampScenario`), including values arriving
from a hand-edited share link, so no setting can make the engine throw.

### 3.1 Workload

| Parameter | Range | Meaning |
|---|---|---|
| **Write rate** | 10 – 10,000 rows/s (clamp allows 0 – 10M) | Cluster-wide row inserts per second. Constant; no bursts. |
| **Horizon** | 30 – 1,825 days | How long to simulate. Verdict dates are only findable inside it — `ok` means "never crossed *within the horizon*". |
| **Row TTL** | 0 – 90 days (clamp 0 – 3,650) | 0 = off. Data older than `now − ttl` becomes **expired**, which is not deleted: it stays on disk until a compaction is allowed to drop it. |
| **Delete rate** | 0 – 1,000 rows/s | Explicit row deletions. Each writes one tombstone, which is itself data on disk. |
| **Query window** | 1 – 168 h | The trailing time range a typical read scans. Drives read amplification only — it changes no bytes. |
| **Tick resolution** | 1 hour / 1 day | Simulation granularity. **See the warning below.** |

> ⚠️ **Day ticks at high write rates are pathological.** Simulation cost tracks
> the *flush count* (total ingest ÷ memtable threshold), not bytes or horizon.
> With day-length ticks, thousands of SSTables can accumulate inside one tick and
> STCS re-sorts the whole list per cascade step — measured at **170 s vs 5.9 s**
> for the same total work on hour ticks. High-volume scenarios need hour ticks
> and a large memtable. This is a known sharp edge, not a protected one: the
> dropdown will let you hang the worker.

### 3.2 Partitions

| Parameter | Range | Meaning |
|---|---|---|
| **Partitions** | 10 – 100M (log slider) | **Distinct** partition keys the workload writes to. This is a cardinality assertion — see [§6](#6-partition-distribution-uniqueness-and-concentration). |
| **Write skew** | 0 – 2 (Zipf exponent) | 0 = perfectly uniform · ~0.3 mild · ~0.7 moderate · ~1.1 hot keys · ~1.4+ severe. |
| **Nodes** | RF – 48 | Nodes on the token ring. Floored at RF (a ring smaller than RF cannot place a replica set). |
| **Sub-sharding** | off, 2, 4, 8 | The M8 mitigation cap. See [§3.5](#35-sub-sharding-the-mitigation). |

### 3.3 Cluster

| Parameter | Range | Meaning |
|---|---|---|
| **Replication factor** | 1, 2, 3, 5 | Folded into `onDiskRowBytes`, so every byte figure already counts every replica. |
| **Disk per node** | 64 GiB – 16 TiB (log) | **Only feeds the disk verdict.** It does not cap anything — the disk line will happily run past 100%. |
| **Compression savings** | 0 – 90% | LZ4 on time-series data realistically saves 30–50%. |
| **Memtable flush threshold** | 16 – 512 MiB | See the unit note below. |
| **Compaction** | none / STCS / TWCS | LCS is *not* implemented despite being named in `CLAUDE.md`. |
| **TWCS window** | 1 – 60 days | Only shown for TWCS. The single most consequential knob in the tool. |
| **Compaction throughput** | 1 – 256 MiB/s per node | **Does not throttle the simulation.** See below. |
| **gc_grace** | 0 – 30 days | Only shown when compaction is on. Gates purging of expired data and tombstones. |

> **Memtable units are on-disk-equivalent, not heap.** A real Cassandra memtable
> holds uncompressed, per-replica data. This simulator folds compression and RF
> into every byte figure so units line up everywhere, which means a "64 MiB"
> memtable here corresponds to a considerably smaller real one. Treat it as a
> flush-frequency dial rather than a heap setting.

> **The throughput cap is a shadow queue.** The engine always compacts
> instantly and unthrottled — the disk line shows what a cluster that *kept up*
> would look like. The cap runs a parallel queue alongside it that measures
> whether that cluster could have kept up, and that queue is the only thing the
> saturation verdict reads. So lowering the cap will turn the verdict red
> without bending the disk curve. That is intentional, and it is the honest way
> to show "your disk graph looks fine and your cluster is still doomed".

### 3.4 Schema

Up to 32 columns, each with a name and an average `valueBytes` (0 – 1M). A
regular column also has a `cellOverheadBytes` (0 – 100, default 12) — Cassandra
3.x+ per-cell metadata runs about 8 B for a bare cell to ~25 B with TTL and a
complex path. Tick **Key** to make a column part of the clustering key instead:
it then contributes value bytes only (no per-cell overhead), and it is the only
part of a row a deletion tombstone still names. One optional `rowOverheadBytes`
(default 10) applies to the whole row.

Note the partition key's own bytes are **not** an input. Cassandra stores the
partition key once per partition, not per row, so at any realistic row count it
is noise against the row body.

### 3.5 Sub-sharding (the mitigation)

Models the standard fix for a wide partition — adding a bucket to the key:

```sql
PRIMARY KEY ((sensor_id, shard), ts)   -- shard = hash(x) % S
```

The slider is a **cap, not a fixed count**. A tracked partition doubles its
shard count only when one of its shards passes **50 MB per replica**, so only
the keys that need splitting pay the read fan-out. 50 MB is deliberately half
the 100 MB warn line: a mitigation that waits for the warn line guarantees the
warn line gets crossed, which would make `ok` structurally unreachable.

**The one rule everything follows from: re-keying is not retroactive.** A
promotion redirects new writes onto fresh tokens and moves *no row already
written*. So the widest partition goes **flat** at a promotion — never
smaller — and shrinks only as TTL and compaction reach the old generation. A
model that divided the current size by the new shard count would show a
comforting instant cliff that no real cluster has ever produced.

With no TTL at all, the old generation's bytes stay constant forever: sub-sharding
stops the partition growing and never shrinks it. That is the correct answer.

---

## 4. Reading the output

### 4.1 Tiles

| Tile | Unit | Notes |
|---|---|---|
| Row on disk | bytes/row | Post-compression, × RF. The whole size model in one number. |
| Ingest per day | bytes/day | Cluster-wide. |
| Disk at horizon | bytes | Includes the memtable. |
| Dead at horizon | bytes | expired + tombstones — bytes you are paying for and cannot read. |
| SSTables | count **across the cluster** | A fleet total — every node compacts its own share, so this is the per-node structure × node count, and never less than the node count. See [§8](#8-model-limits). |
| Read amplification | count **per replica** | SSTables a single read of the trailing window touches on **one replica** (a read hits one replica's local store, not the ring), so it is computed per node — the count that drives read latency. Under TWCS/STCS it is structural (windows/tiers) and barely moves with the ring; without compaction it is volume-driven and *falls* as you add nodes, since each node then holds fewer SSTables. See [§8](#8-model-limits). |
| **Widest partition** | bytes **per replica** | The widest single *sub-shard* when sub-sharding is on — which is what Cassandra actually materializes. |
| **Fullest node** | bytes **per node** | With its ratio to the cluster average. |

### 4.2 The stacked area chart

Three bands: **live** / **expired-not-yet-dropped** / **tombstone**. The gap
between the top of the stack and the live band is the entire point of the tool —
it is disk you are paying for that holds nothing you can read.

### 4.3 The ratio to watch

`disk ÷ live` is the single most diagnostic number, and it is why the four TTL
presets exist as a sequence: 13.15× → 3.13× → 2.85× → 2.48×, same workload,
compaction settings only.

---

## 5. Verdicts

Three ways a cluster is mathematically bound to fail, each a threshold with a
date. They run **after** the simulation, over the finished series, because two
of them need hindsight.

| Verdict | warn | fatal | Decided on |
|---|---|---|---|
| **Wide partition** | 100 MB per replica | 1 GB per replica | peak |
| **Disk asymmetry** | 70% of node disk | 90% | peak, vs the cluster average *at the same tick* |
| **Compaction saturation** | ρ ≥ 0.8 | ρ > 1 and backlog never drains | tail-quarter average |

**`ok` is a real answer.** It means the metric never reached its warn line
inside the simulated horizon — not that the check was skipped.

**Everything byte-valued is decided on the peak, not the horizon value.** STCS's
lumpy reclaim can leave a node reading 42% full at the horizon while it hit 83%
every single cycle. Alert on the horizon value and you never see it. This is
exactly what the `Compaction throttled` preset demonstrates.

**ρ = arrival ÷ drain.** Above 1 the queue is unbounded — no amount of time lets
it catch up, so the crossing date is a hard date rather than a projection. The
date itself comes from the queue (the last tick the node was ever caught up),
not from ρ. Write amplification is *measured* from the strategies' actual merges
via `onWrite`, never estimated.

Disk asymmetry compares the peak against the cluster average **at the tick of
that peak**. Comparing a peak-over-time against a horizon value would read as
asymmetry even on a perfectly even ring, where the whole gap is really the
compaction sawtooth moving every node up and down together.

---

## 6. Partition distribution: uniqueness and concentration

> *"In the sample data, are you considering whether the partition keys will be
> unique — and if not, what might happen?"*

This section answers two related questions: whether the keys are unique
([§6.1](#61-uniqueness-is-asserted-never-checked)–[§6.5](#65-sub-shard-placement-collides-too)),
and — given a fixed number of keys — how the *shape* of the write distribution
across them drives the cluster from healthy to fatal
([§6.6](#66-perfectly-uniform-the-safe-baseline)–[§6.7](#67-concentration-how-it-degrades-1-at-a-time)).

### 6.1 Uniqueness is asserted, never checked

Since no keys exist ([§2](#2-there-is-no-sample-data)), there is nothing to
check for collisions. `partitionCount` is a claim *you* make about your data:
**the number of distinct partition keys**, i.e. cardinality. Within the model
they are unique by construction — partition ranked `i` for `i = 1…N`, each with
its own Zipf weight.

### 6.2 If your keys are less unique than you assumed

This is the important case, and the answer is clean: **fewer distinct keys is
exactly, and only, a smaller `partitionCount`.** The model has no separate
"collision" mode because it does not need one — colliding keys and a coarser key
are the same thing. So dial the slider down to your *actual* cardinality and the
model is already correct.

Measured on the sub-sharding preset's workload (Zipf 0.7, TTL 7 d + TWCS 1 d)
with the mitigation switched **off**, sliding only the key count:

| Distinct keys | Widest partition (peak) | Verdict | Warn crossed |
|---|---|---|---|
| 5,000 | 659 MB | warn | day 2 |
| 2,500 | 825 MB | warn | day 2 |
| 500 | 1.38 GB | **fatal** | day 1 |
| 100 | 2.46 GB | **fatal** | day 0 |

Note what that column does *not* do: halving the key count from 5,000 to 2,500
does **not** double the widest partition — it moves it 1.25×. With skew present,
the hot partition's share is set mostly by the *exponent*, not the count: the
Zipf normalizer `H(N, s)` grows very slowly in N. Only at `skewExponent = 0`
(uniform) does halving N exactly double every partition.

The practical read: **if you are already skewed, adding keys buys you much less
than you think.** Fixing the exponent — or sub-sharding the head — moves the
number; fixing the count barely does.

### 6.3 Which direction the error hurts

Over-counting is the dangerous direction. Entering more keys than really exist
makes the simulator under-report partition width *and* node asymmetry, and hand
back a false green. The classic sources:

- Partitioning by something whose real cardinality is far below the mental model
  — `device_type` (12 values) where you pictured `device_id` (millions);
  `day` where you meant `hour`.
- Entering **row count** instead of **distinct-key count**. Easy to do and
  wrong by orders of magnitude.
- A key with a natural hot skew — a tenant id where one tenant is 90% of
  traffic — where the *count* is genuinely high but the effective count is not.
  Raise `skewExponent`; do not lower the count.

This is precisely the `Hot partitions` preset: cluster-level disk is flat and
healthy, and the hottest single key is carrying 8.92 GB.

### 6.4 What is *not* modelled: overwrites

The sharpest limitation in this area. **The model has no upsert semantics.**
Every write is treated as a new distinct row. In real Cassandra, writing the
same partition key *and* clustering key twice is an overwrite — both copies sit
on disk, shadowing each other, until compaction merges them.

So if your workload overwrites rows, this simulator will:

- **overstate live bytes** (it counts every write as new data),
- **understate what compaction reclaims** (merging duplicates is a real win it
  never models), and
- **understate transient read amplification** from the same row living in
  several SSTables at once.

The one deletion path that *is* modelled is explicit row deletion, via the
delete-rate slider → tombstones. If you need to approximate an overwrite-heavy
workload today, the least-bad proxy is to raise the delete rate: it at least
prices the shadowing marker, though not the duplicate row body.

### 6.5 Sub-shard placement collides too

Sub-shard tokens are drawn independently, so two shards of the same partition
can land on the same node — and on a small ring they certainly will. The
`Sub-sharding` preset splits the hottest key 8 ways at RF 3 on a 6-node ring:
that is 24 replica placements onto 6 nodes, so by pigeonhole the key ends up on
**all six** nodes with several doubling up. That is faithful to how random token
assignment behaves, and it is why splitting 8 ways relieves the hottest node by
less than 8×.

### 6.6 Perfectly uniform: the safe baseline

First, the case where nothing is wrong. Set skew to 0 and every one of the N
partitions carries an identical `1/N` share of the writes. Because shares are
constant and the TTL is uniform, each partition holds exactly its share of the
cluster's on-disk bytes at all times, so:

```
widest partition (per replica, uniform) = clusterDisk / (N × RF)
```

Measured on the tuned TWCS workload — 5,000 keys, RF 3, cluster flat at
73.4 GB:

| | Uniform (skew 0) |
|---|---|
| hottest key's share | 1/5000 = **0.02%** |
| widest partition | **5.3 MB** |
| fullest node vs 6-node average | **1.06×** (essentially even) |
| wide-partition / disk-asymmetry verdicts | both **ok** |

A uniform workload's failure mode is **never partition width at any sane scale**
— it is total disk and compaction. To push a uniform workload to even a 100 MB
partition you would need `clusterDisk = 100 MB × RF × N` ≈ 1.6 TB here (about
260 GB per node), and long before that the story is "buy disk", not "fix the
key". So
if your keys really are evenly hit, the partition and node-asymmetry verdicts are
not the ones to watch — the growth curve is.

### 6.7 Concentration: how it degrades, 1% at a time

Now move the other way. Your scenario — one partition key `b` accumulating many
rows under *different* clustering keys — is a single partition taking a growing
share `f` of the write stream. (Different clustering keys means distinct rows,
so this is the clean case, **not** the overwrite gap of [§6.4](#64-what-is-not-modelled-overwrites);
that only bites when the *full* primary key repeats.)

The same share-of-totals identity gives a strikingly simple law — **the widest
partition is exactly linear in that key's share, and independent of N and of the
key count entirely:**

```
widest partition (per replica) = f × clusterDisk / RF
```

Sweeping `f` on the same 73.4 GB workload, everything else held fixed:

| Hot key's share of writes | Widest partition (peak) | Verdict | Warn crossed |
|---|---|---|---|
| 0.02% (uniform) | 5.3 MB | ok | — |
| **1%** | 265 MB | warn | day 6 |
| **2%** | 529 MB | warn | day 3 |
| **3%** | 794 MB | warn | day 2 |
| **4%** | 1.03 GB | **fatal** | day 1 |
| **5%** | 1.29 GB | **fatal** | day 1 |

Read three things off that table:

1. **Each extra 1% of concentration adds a fixed step** — here almost exactly
   265 MB every time (264, 265, 265…), because the law is linear in `f`. That is
   the literal answer to "increase it by 1% more": the widest partition grows by
   `1% × clusterDisk / RF`, a constant, so the walk to the cliff is a straight
   line, not a curve.

2. **The cluster disk is 73.4 GB at every row of that table.** Changing the
   distribution moves *zero* bytes off the cluster — total disk, compaction and
   read amplification are byte-identical across all six runs. Skew only decides
   *where* the same bytes pile up. (This is the mirror image of the sub-sharding
   result: both are schema changes, not capacity changes.)

3. **Node asymmetry barely moves** — the fullest node goes 1.06× → 1.08× the
   average while the partition goes from safe to multi-GB fatal. The fullest
   node's total is dominated by the evenly-spread tail; one hot key adds its
   share to a couple of nodes, but that is small against the bulk. So on a
   big-disk cluster, **concentration on a single key degrades you through the
   wide-partition verdict first, and often only** — the disk-asymmetry verdict
   can sit green right next to a fatal partition. Node asymmetry becomes the
   binding verdict instead only when much of the *head* concentrates (many hot
   keys at once, which is the `Hot partitions` preset), or the ring is small and
   the node disk tight.

The threshold ladder for this workload:

- the hottest key crosses the **100 MB warn** line once it exceeds **0.40%** of
  all writes;
- it crosses the **1 GB fatal** line at **4.09%**.

Both scale with cluster disk: at twice the retained data those percentages halve.
And the fix for the whole family is sub-sharding ([§3.5](#35-sub-sharding-the-mitigation)),
which splits key `b` across more tokens so its per-shard width comes back down —
moving, once again, no bytes.

---

## 7. The preset scenarios

Eight scenarios, ordered as a narrative. Numbers below are measured from the
shipped presets and formatted as the UI formats them.

### 1. Sensor readings (baseline)
*100 rows/s · 365 d · no TTL · no compaction*

The hand-validated case: 70 B raw → 35 B compressed → 105 B on disk at RF 3.
Pure linear growth to **308 GB**, all of it live. Everything else is a departure
from this line. Validates the size model by hand before any policy runs.

### 2. TTL 7d, no compaction (expired ≠ deleted)
*500 rows/s · 90 d · TTL 7 d · 25 deletes/s*

**The M2 lesson.** A 7-day TTL "keeps the table small" — live bytes plateau at
29.5 GB after a week, exactly as promised. Disk climbs to **388 GB** anyway.
Ratio **13.15×**. Nothing is ever dropped because nothing ever compacts, and
reads pay too: a day-long query touches ~11 SSTables on the replica that serves
it (~69 across the 6-node fleet).

### 3. TTL 7d + STCS (late, lumpy reclaim)
*same workload, STCS on*

Disk finally comes down — but late and in lumps: horizon **92.4 GB**, peak
**310 GB**. Small tiers reclaim a slice every few days while the big tier holds
weeks of expired data hostage until its 4-table merge fires. Read amp (per
replica) 11 → 5. The horizon value is 3.3× better than the peak, which is the
whole argument for deciding verdicts on peaks.

### 4. TTL 7d + TWCS 30d window (window ≫ TTL)
*TWCS, 30-day windows*

**The flagship mistake.** A window that dwarfs the TTL: each 30 d window
compacts once when it closes, then sits there — expired bytes and all — until
the entire window ages past TTL + gc_grace. The disk line goes *flat*, which
looks like success, but flat as a **sawtooth between 84 and 146 GB**, shedding a
whole window at a time and never coming down to the 29.5 GB live line.

### 5. TTL 7d + TWCS 1d window (the fix)
*TWCS, 1-day windows*

Same everything, window sized to the workload. Whole windows expire and drop
daily. Disk goes genuinely flat at **73.4 GB** — TTL + gc_grace + 1 = 18 days of
data, ratio **2.48×**, read amp 1. The remaining gap above live is gc_grace:
slide it to 0 and disk hugs live at 1.07×.

### 6. Hot partitions (key too coarse)
*same tuned TWCS · 500 keys · Zipf 1.4*

**The M6 lesson, and the counterexample for M8.** Cluster-level disk is
identical to preset 5 and looks perfectly healthy — 73.4 GB, flat, read amp 1.
But writes land on only 500 partitions with a severe head, so the hottest single
partition carries **8.92 GB** (Cassandra warns past 100 MB, dies in the GBs) and
the 8 tracked partitions pin two-thirds of the bytes onto whichever nodes own
their token ranges. The cluster average looks fine. The fullest node does not.

### 7. Sub-sharding (mitigating a wide partition)
*tuned TWCS · 5,000 keys · Zipf 0.7 · sub-sharding up to 8*

**The M8 mitigation and its ceiling.** The hottest key alone reaches 659 MB and
passes 100 MB on day 2. Slide sub-sharding up and the verdict walks down one
doubling at a time — **659 → 330 → 165 → 82.4 MB** — with the crossing receding
day 2 → day 6 → day 12 → **never**. At 8 shards it reads `ok`.

Then load preset 6 and try the same fix on a key 100× too coarse: 8.92 → 4.46 →
2.23 → 1.11 GB, **fatal at every step**. All it buys is time, and exactly
proportional time — while disk grows linearly, each doubling doubles the days to
the cliff, so the fatal date walks 2 → 4 → 8 → 16 and stops.

Watch the disk line while you drag the slider: **73.4 GB at every setting.**
This is a schema change, not a capacity one — the same bytes, differently
addressed.

### 8. Compaction throttled (backlog never drains)
*2 KB events · 3,500 rows/s · 890 GB/day · STCS · 7 MiB/s cap*

**The M7 lesson.** `compaction_throughput` throttled to protect read latency, on
a workload that can never catch up. Each node takes 1.8 MB/s of new data; STCS
rewrites every byte ~4.5× over its life, so each node owes ~7.9 MiB/s against a
7 MiB/s cap. **ρ = 1.13**, and a queue with ρ > 1 has no steady state — the
backlog passes 6.2 TB and would keep going. (The bill is measured *per node* —
each node compacts its own share — not on the whole cluster's data at once: a
store six times larger carries an extra STCS tier and would overstate it. See
[§8](#8-model-limits).)

The disk line is the trap. Per node it reads as a comfortable **1.25 TB at the
horizon — 42% of the 3 TB disk** — while the STCS sawtooth swings it to
**2.5 TB, 83%**, every single cycle. Note this verdict is *not* firing on
node-to-node asymmetry: with 10M keys at Zipf 0.3 the ring is essentially even.
It fires purely on the sawtooth over time, which is exactly why the verdict is
decided on the peak. Alert on the horizon value and you never see it.

No single slider fixes both, which is the lesson:

| Move | Effect |
|---|---|
| TWCS windows sized to the TTL | drops whole expired windows, clears the disk verdict (peak → 34%) — but the current window still runs STCS, so the compaction bill does not fall and ρ stays **1.21, fatal** |
| Cap → 64 MiB/s (stock) | ρ → 0.12, disk peak **unchanged** |
| Ring 6 → 12 nodes | ρ 0.56, peak 42% — **clears both** |

Only the last one divides the per-node *load* rather than the per-node *work*.

---

## 8. Model limits

What this tool does not know, so you do not read a verdict it cannot support.

**Partition and data model**
- No upsert/overwrite semantics ([§6.4](#64-what-is-not-modelled-overwrites)) — the largest single gap.
- No row-size distribution: every row is the mean, exactly.
- No range or partition tombstones; only row-level deletes.
- No secondary indexes, materialized views, collections or static columns.

**Cluster**
- **Hot partitions are the model's only source of node-level disk asymmetry.**
  A scenario with skewed nodes therefore always also has wide partitions. Real
  clusters also skew from uneven vnode token ranges, which this model has no
  concept of.
- SimpleStrategy placement only — no racks, no datacenters, no NetworkTopologyStrategy.
- No repair, streaming, bootstrap or decommission traffic.
- No node failure, no hinted handoff, no read repair.
- Compaction is instantaneous and infinitely parallel; the throughput cap only
  feeds the shadow queue.

**Compaction domains: byte totals vs. structural counts**
- The **byte engine is one aggregate compaction domain**: it accumulates the
  whole cluster's ingest (RF folded in) into one memtable, flushes and compacts
  it once, and the byte *totals* — disk, live, expired, tombstones — come from
  that single stream. It does *not* run a separate memtable and compactor per
  node. This is a deliberate simplification: total disk is additive across nodes
  regardless of how the ring is sliced, and the disk growth story is what the
  tool is about.
- The three **structural** figures — SSTable count, read amplification and
  compaction (write-amp) bytes — describe the *shape* of a store, not a byte
  total, and a real cluster has one store *per node*. Each is reconstructed by
  running one average node's 1/N share through the same mechanics: the **SSTable
  count** is a fleet total (per-node × N, so never below the node count once all
  have flushed); **read amplification** is the per-node figure itself (a read
  hits one replica's store); **compaction bytes** are a fleet total (per-node ×
  N — each node compacts its share with its *own* write amplification, which
  drives the saturation backlog).
- This is not a flat × N. Without compaction the structure is **volume-driven**,
  so a single store's figure is node-independent: the reconstruction collapses
  back to the aggregate, the fleet count grows with N, and read amp *falls* with
  N (each node holds fewer SSTables). Under **TWCS** it is **time-structural** —
  every node keeps the same windows — so it is exact. Under **STCS** it is a
  close approximation: a node with 1/N the data has slightly fewer tiers, which
  is precisely why the count *and* the compaction bill must not be read off the
  aggregate stream — a store N× larger carries an extra tier and would overstate
  both (and, before this was fixed, inflated the saturation verdict from a true
  ρ ≈ 0.99 to a false ρ ≈ 1.15).
- Residual approximations: the per-node share is taken as uniform (the average
  node), so skew moves a node's *bytes* (tracked by the fullest-node metric) but
  not its *table count* or *write-amp*; the hot node's backlog scales the fleet
  compaction by that node's disk share rather than re-deriving its slightly
  higher tier count individually.

**Reads**
- Read amplification is a **per-replica** count: the SSTables one replica must
  touch for a read over the trailing window — a read hits one replica's local
  store, not the ring, so it is computed per node (see above). Under TWCS/STCS it
  is structural (live windows / tiers) and barely moves with the ring; without
  compaction it is volume-driven and *falls* as nodes are added. It does not
  model bloom filters, key/row cache, partition index granularity, or latency of
  any kind.
- The **read fan-out cost of sub-sharding is stated in the verdict copy, not
  folded into the read-amp metric** — a sub-sharded key scatters every read
  across all its shards, but that is a different quantity from "SSTables one
  replica touches", and conflating them would make both numbers meaningless.

**Not built**
- The CSV/JSON sampling profiler described in `CLAUDE.md` ([§2](#2-there-is-no-sample-data)).
- LCS, despite being named as a strategy plugin in `CLAUDE.md`. Only STCS and
  TWCS exist.

---

## 9. Sharing a scenario

Every control is serialized to a base64 URL parameter, so any scenario — including
one that is not a preset — is a shareable link. Hand-edited links are safe:
every field is clamped into an engine-legal range on the way in, and links
predating a milestone get sensible defaults for fields they lack (a pre-M8 link
comes back with sub-sharding off; a pre-M6 link with a mildly skewed
100K-partition workload on a 6-node ring).

`maxSubShards` is snapped to a power of two, so a hand-edited `5` becomes `4`
rather than a shard count no `hash(x) % S` bucket scheme would ever produce.
