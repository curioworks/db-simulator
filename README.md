# db-simulator

Interactive, fully client-side simulator that shows how a Cassandra table grows
on disk over time — and when a cluster is mathematically bound to fail — given a
schema, write rate, TTL, compaction strategy and skew profile.

**Live demo: <https://curioworks.github.io/db-simulator/>**

It simulates *metadata, not rows*: an SSTable is a six-field struct, never a row
store, so five simulated years of a 10 TB table finish in milliseconds. Nothing
is uploaded and nothing leaves the browser — there is no data to send.

## Documentation

- **[Parameters, outputs and scenarios](docs/PARAMETERS.md)** — every knob, how
  it enters the math, how to read the verdicts, what each preset demonstrates,
  and the model's limits.

## Development

```sh
npm install
npm run dev      # Vite dev server
npm test         # vitest, engine only — no DOM
npm run build    # production bundle
```

The engine (`src/engine/`) is pure TypeScript with zero DOM dependencies and is
importable from Node. It runs in a Web Worker in the app.
