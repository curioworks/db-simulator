---
name: verify
description: Build, launch and drive the db-simulator app in headless Edge to verify changes at the GUI surface.
---

# Verifying db-simulator

Engine changes still need GUI verification — the engine runs in a Web Worker and
the tiles/chart are the observable surface. Unit/golden tests are CI's job.

## Build & serve

```powershell
npm run build          # tsc -b && vite build → dist/
npm run preview        # serves dist/ at http://localhost:4173/ (run in background)
```

Dev server (`npm run dev`, port 5173) also works but verify against the build.

## Drive (headless Edge, no browser download)

`npm install --no-save puppeteer-core`, then launch with
`executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'`.
If the driver script lives outside the repo, resolve the package via
`createRequire('file:///C:/projects/db-simulator/')`.

Useful hooks:
- Ready condition: `.recharts-area-area` exists and no `.tile-value` reads `—`.
- Stat tiles: `.tile` → `.tile-label` / `.tile-value` / `.tile-sub`. Default
  preset expects: 105 B row, 865 MB/day, 308 GB horizon, 4,934 SSTables.
- Sim latency: `.chart-meta` text ("simulated in N ms") — regression-watch this;
  the budget is milliseconds, not seconds.
- Sliders are React-controlled: focus the `input[type=range]`, then real key
  presses (`End`, arrows). Synthetic `.value=` writes won't fire onChange.
- Dark mode: `page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])`.

## Gotchas

- **Any change re-simulates after a 120 ms debounce** (`useSimulation`). Wait
  ≥ 300 ms after an input (or poll the tile text) before reading results.
- **Hash navigation is same-document**: `page.goto('…/#c=…')` from a loaded page
  fires `hashchange`, not a reload — state updates via the listener in App.tsx,
  after the same debounce. Removing the hash entirely does a full reload.
- Scenario URLs: base64url of the `ScenarioConfig` JSON in `#c=` (see
  `src/ui/urlConfig.ts`); build test hashes with
  `Buffer.from(JSON.stringify(s)).toString('base64url')`.

## Flows worth driving

1. Default load → tiles match the hand-validated numbers above.
2. Move a slider (keyboard `End`) → all four tiles + hash update.
3. Navigate to a crafted `#c=` link → tiles reflect the decoded scenario.
4. Garbage `#c=` → no crash; state kept (same-doc) or default (fresh load).
5. Hover the chart → crosshair + tooltip (date, bytes, SSTables, memtable).
6. `page.on('pageerror'|'console')` stays empty throughout.
