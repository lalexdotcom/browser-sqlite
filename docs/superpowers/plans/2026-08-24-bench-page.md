# Benchmark and Conformance Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single self-contained `bench/index.html`, published to GitHub Pages, that runs the library's conformance invariants and eight measurements against every declared `(vfs, build)` pair on whatever device opens it, and hands the visitor a JSON download.

**Architecture:** One HTML file with one inline ES module, served beside a verbatim copy of `dist/`. The page imports `VFS_CAPABILITIES` from the built library, so the pair list, the pool caps and the skip rules come from the library rather than from a second copy. A sequential runner walks the selected pairs one at a time, appending a table column per pair and filling one cell per row as it lands, under two distinct timeout regimes. A GitHub Actions workflow builds, assembles and deploys.

**Tech Stack:** Plain HTML/CSS/ES modules — no TypeScript, no bundler, no framework, no runtime dependency. Node scripts in `scripts/` (ESM, `node:` builtins only). Playwright 1.62.1 (already a devDependency) for the hand-run driver. GitHub Actions with `actions/upload-pages-artifact` and `actions/deploy-pages`.

**Spec:** `docs/superpowers/specs/2026-08-24-bench-page-design.md` — read it alongside this plan.

## Global Constraints

- **Branch: `feat/vfs-capabilities`.** Do not branch off `main`, do not merge to `main`. (`mem:resume-plan` §0.3)
- **No file under `src/` is modified by this plan.** Not one. If a task seems to need it, stop and report.
- **`dist/` is copied verbatim, never re-bundled.** `dist/index.js` must keep its literal `new URL('./worker/worker.js', import.meta.url)`. Introducing any bundler over `dist/` reopens the two wave-P traps in `mem:project-state`.
- **`bench/index.html` is exactly one file.** HTML, CSS and one inline `<script type="module">`. No second script tag, no external `.js`, no external `.css`, no CDN, no font.
- **The exported JSON is never committed and never read by `scripts/render-vfs-matrix.ts`.**
- **Row ids are the conformance `describe()` titles verbatim.** See Task 4.
- **The origin is shared.** `lalexdotcom.github.io` serves every one of the user's Pages projects. OPFS cleanup targets only our exact generated names, never the root. IndexedDB cleanup deletes only stores that did not exist before the run. See spec §5.4 — the naive `indexedDB.deleteDatabase()` is destructive and must not be written.
- **Language:** all code, comments, commit messages and file content in **English**.
- **After every modification, run `pnpm check`** (biome, `--write`). It covers `scripts/` and `bench/`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **The pre-commit hook runs the full suite.** `MIRROR-1` is a known ≤1-in-15 flake in `tests/browser/vfs.test.ts :: IDBMirrorVFS opens and serves a round trip` (`no such table: wired`). If it fires on a commit that touches no `src/` file, re-run the commit. **Do not weaken, retry-wrap or skip that test.**

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `bench/index.html` | create | The whole page: markup, styles, probes, selection UI, runner, rows, rendering, export. One inline module. |
| `scripts/bench-assemble.mjs` | create | Copy `bench/index.html` (substituting `__LIB_VERSION__`) and `dist/` into an output directory. ~40 lines. |
| `scripts/bench-check.mjs` | create | Hand-run Playwright driver: serve, open, select, run, assert the table filled. Documented as a developer tool; nothing runs it automatically. |
| `.github/workflows/pages.yaml` | create | Build → assemble → deploy to Pages, on push to `main` and on `workflow_dispatch`. |
| `.gitignore` | modify | Add `_site/`. |
| `package.json` | modify | Add `bench:build` and `bench:serve` scripts. |
| `.serena/memories/follow-ups.md` | modify | The `BENCH-DRIFT` entry (Task 4). |

`bench/index.html` is one file by decision, not by accident (spec §2). It will land around 900 lines. The tasks below grow it in the order the sections are declared, so each task appends to a file whose earlier sections are already working.

---

### Task 1: Assembly, serving, and the page shell

**Files:**
- Create: `scripts/bench-assemble.mjs`
- Create: `scripts/bench-check.mjs`
- Create: `bench/index.html`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `_site/` layout (`index.html` + `dist/`); the global constants `LIB_VERSION`, `HAS_OPFS`, `HAS_JSPI`, `HAS_UNSAFE_HANDLES`, `AGENT` inside the page module; the DOM ids `#banner`, `#status`.

- [ ] **Step 1: Add the ignore entry and the package scripts**

In `.gitignore`, under the `# Dist` block that already holds `dist/`:

```
_site/
```

In `package.json`, in `scripts`, after `"docs:vfs"`:

```json
"bench:build": "pnpm build && node scripts/bench-assemble.mjs _site",
"bench:serve": "node scripts/static-server.mjs _site 8099"
```

- [ ] **Step 2: Write the assembler**

Create `scripts/bench-assemble.mjs`:

```js
#!/usr/bin/env node
/**
 * Assembles the servable benchmark page: bench/index.html beside a verbatim
 * copy of dist/.
 *
 * The copy is verbatim on purpose. dist/index.js carries a literal
 * `new URL('./worker/worker.js', import.meta.url)` and the three .wasm sit
 * beside worker.js under plain names; anything that rewrites those paths
 * breaks the page in exactly the way documented in mem:project-state.
 *
 * The only transformation is substituting __LIB_VERSION__, because the package
 * does not export its own version and the page has no build step to ask.
 *
 * Usage: node scripts/bench-assemble.mjs <outDir>
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const outDir = process.argv[2];
if (!outDir) {
  process.stderr.write('usage: bench-assemble.mjs <outDir>\n');
  process.exit(2);
}

const target = resolve(root, outDir);
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;

const page = readFileSync(join(root, 'bench/index.html'), 'utf8').replaceAll(
  '__LIB_VERSION__',
  version,
);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'index.html'), page);
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });

process.stdout.write(`assembled ${target} (browser-sqlite ${version})\n`);
```

- [ ] **Step 3: Write the page shell**

Create `bench/index.html`. This is the whole file for now; later tasks append inside the marked sections.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>browser-sqlite — conformance and benchmarks</title>
    <style>
      :root {
        color-scheme: light dark;
        --gap: 0.75rem;
        --border: color-mix(in srgb, currentColor 20%, transparent);
      }
      body {
        margin: 0 auto;
        padding: var(--gap);
        max-width: 70rem;
        font: 15px/1.5 system-ui, sans-serif;
      }
      h1 { font-size: 1.2rem; margin: 0 0 var(--gap); }
      #banner {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gap);
        padding: var(--gap);
        border: 1px solid var(--border);
        border-radius: 6px;
        font-size: 0.85rem;
      }
      #banner b { font-weight: 600; }
      .no { opacity: 0.55; }
      #status { margin: var(--gap) 0; font-size: 0.85rem; min-height: 1.5em; }
    </style>
  </head>
  <body>
    <h1>browser-sqlite — conformance and benchmarks</h1>

    <div id="banner">detecting…</div>

    <!-- SELECTION UI — Task 2 -->

    <p id="status"></p>

    <!-- RESULTS TABLE — Task 3 -->

    <script type="module">
      import { VFS_CAPABILITIES } from './dist/index.js';

      // ── Identity ────────────────────────────────────────────────────────
      // Substituted by scripts/bench-assemble.mjs. Opening bench/index.html
      // straight from the repo leaves the placeholder, which is why the guard
      // tests for it rather than trusting the value.
      const RAW_VERSION = '__LIB_VERSION__';
      const LIB_VERSION = RAW_VERSION.startsWith('__') ? 'unknown' : RAW_VERSION;

      /**
       * User-agent parsing, used for the banner and the export filename only.
       * Nothing on this page branches on it — feature decisions go through the
       * probes below. That is what makes a crude parser acceptable here.
       */
      const detectAgent = () => {
        const ua = navigator.userAgent;
        const match = (re) => ua.match(re)?.[1] ?? null;
        let engine = 'unknown';
        let version = null;
        if (/Firefox\//.test(ua)) {
          engine = 'firefox';
          version = match(/Firefox\/([\d.]+)/);
        } else if (/Edg\//.test(ua)) {
          engine = 'edge';
          version = match(/Edg\/([\d.]+)/);
        } else if (/Chrome\//.test(ua)) {
          engine = 'chrome';
          version = match(/Chrome\/([\d.]+)/);
        } else if (/Safari\//.test(ua)) {
          engine = 'safari';
          version = match(/Version\/([\d.]+)/);
        }
        return { engine, version, platform: navigator.platform ?? '', ua };
      };

      const AGENT = detectAgent();

      // ── Platform probes ─────────────────────────────────────────────────
      const HAS_OPFS =
        typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle !== 'undefined';

      /** JSPI. Feature-detected, never sniffed from the user agent. */
      const HAS_JSPI = typeof WebAssembly.Suspending === 'function';

      /**
       * `mode: 'readwrite-unsafe'` on OPFS sync access handles, probed by
       * BEHAVIOUR: open two handles on one file and see whether the second
       * succeeds. Firefox accepts the option and ignores it, so asking whether
       * the property is supported would answer yes and be wrong.
       *
       * createSyncAccessHandle only exists in a dedicated worker, hence the
       * inline blob worker. Ported from tests/conformance/helpers.ts — see
       * BENCH-DRIFT in mem:follow-ups before changing either copy.
       */
      const probeUnsafeHandles = () =>
        new Promise((resolve) => {
          if (!HAS_OPFS) return resolve(false);
          const src = `
            self.onmessage = async () => {
              let h1;
              try {
                const root = await navigator.storage.getDirectory();
                const fh = await root.getFileHandle('__probe_unsafe_handles', { create: true });
                h1 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
                const h2 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
                h2.close();
                self.postMessage(true);
              } catch {
                self.postMessage(false);
              } finally {
                try { h1?.close(); } catch {}
                try {
                  const root = await navigator.storage.getDirectory();
                  await root.removeEntry('__probe_unsafe_handles');
                } catch {}
              }
            };
          `;
          const url = URL.createObjectURL(
            new Blob([src], { type: 'application/javascript' }),
          );
          const worker = new Worker(url);
          const done = (value) => {
            resolve(value);
            worker.terminate();
            URL.revokeObjectURL(url);
          };
          worker.onmessage = (e) => done(e.data);
          worker.onerror = () => done(false);
          worker.postMessage(null);
        });

      const HAS_UNSAFE_HANDLES = await probeUnsafeHandles();

      /**
       * Whether we may delete IndexedDB stores after the run. Without this API
       * we cannot tell a store we created from one that was already there, and
       * this origin is shared with the user's other Pages projects — so the
       * only safe answer is to clean nothing. See spec §5.4.
       */
      const CAN_LIST_IDB = typeof indexedDB.databases === 'function';

      // ── Banner ──────────────────────────────────────────────────────────
      const flag = (label, ok) =>
        `<span class="${ok ? '' : 'no'}"><b>${label}</b> ${ok ? 'yes' : 'no'}</span>`;

      document.getElementById('banner').innerHTML = [
        `<span><b>${AGENT.engine}</b> ${AGENT.version ?? '?'}</span>`,
        `<span><b>browser-sqlite</b> ${LIB_VERSION}</span>`,
        flag('OPFS', HAS_OPFS),
        flag('readwrite-unsafe', HAS_UNSAFE_HANDLES),
        flag('JSPI', HAS_JSPI),
        CAN_LIST_IDB
          ? ''
          : `<span class="no"><b>IndexedDB cleanup</b> unavailable — stores created by this run are left in place</span>`,
      ]
        .filter(Boolean)
        .join('');

      // ── Pairs ───────────────────────────────────────────────────────────
      /** Every declared (vfs, build) pair, derived from the library's table. */
      const PAIRS = Object.entries(VFS_CAPABILITIES).flatMap(([vfs, cap]) =>
        cap.builds.map((build) => ({ id: `${vfs}/${build}`, vfs, build, cap })),
      );

      /**
       * The platform feature this pair needs and this engine lacks, or null.
       * Read from `requires` — never from a hardcoded VFS name. A VFS that only
       * `degradesWithout` a feature stays runnable: OPFSAdaptiveVFS without
       * readwrite-unsafe passes 102 of 104 browser tests, and marking it
       * unavailable would be false.
       */
      const missingFeature = (pair) => {
        if (pair.build === 'jspi' && !HAS_JSPI) return 'jspi';
        if (pair.cap.requires.includes('opfs') && !HAS_OPFS) return 'opfs';
        if (
          pair.cap.requires.includes('readwrite-unsafe') &&
          !HAS_UNSAFE_HANDLES
        )
          return 'readwrite-unsafe';
        return null;
      };

      /** Effective pool size: the declared cap, or 4 where unbounded. */
      const poolFor = (cap) => Math.min(4, cap.maxPoolSize ?? 4);

      // ── SELECTION UI — Task 2 ───────────────────────────────────────────

      // ── RUNNER — Task 3 ─────────────────────────────────────────────────

      document.getElementById('status').textContent =
        `${PAIRS.length} declared pairs, ` +
        `${PAIRS.filter((p) => !missingFeature(p)).length} runnable here`;

      // Read by scripts/bench-check.mjs.
      window.__BENCH__ = { LIB_VERSION, AGENT, PAIRS: PAIRS.map((p) => p.id) };
    </script>
  </body>
</html>
```

- [ ] **Step 4: Write the hand-run driver**

Create `scripts/bench-check.mjs`:

```js
#!/usr/bin/env node
/**
 * Hand-run driver for bench/index.html. NOTHING RUNS THIS AUTOMATICALLY — it
 * is not wired into CI and must not be. It exists so a developer can prove the
 * page still works on both engines without clicking through it.
 *
 * It asserts that the PAGE works, never that a VFS passes: a red cell can be a
 * correct report about this engine.
 *
 * Usage:
 *   pnpm bench:build
 *   node scripts/bench-check.mjs [chromium|firefox] [--all]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.argv[2] ?? 'chromium';
const all = process.argv.includes('--all');
const PORT = 8099;

const server = spawn(
  process.execPath,
  [resolve(root, 'scripts/static-server.mjs'), resolve(root, '_site'), String(PORT)],
  { stdio: 'inherit' },
);

const fail = (message) => {
  process.stderr.write(`FAIL — ${message}\n`);
  server.kill();
  process.exit(1);
};

try {
  const browser = await playwright[engine].launch();
  const page = await browser.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__BENCH__ !== undefined, {
    timeout: 30_000,
  });

  const info = await page.evaluate(() => window.__BENCH__);
  process.stdout.write(
    `${engine}: browser-sqlite ${info.LIB_VERSION}, ` +
      `${info.PAIRS.length} declared pairs\n`,
  );

  if (info.LIB_VERSION === 'unknown') {
    fail('__LIB_VERSION__ was not substituted — run pnpm bench:build first');
  }

  // Later tasks extend from here: select, start, wait for done, assert cells.

  if (problems.length) fail(problems.join('\n'));

  await browser.close();
  process.stdout.write('OK\n');
} finally {
  server.kill();
}
```

- [ ] **Step 5: Run the driver and verify it fails on an unassembled page**

Run:

```bash
node scripts/bench-check.mjs chromium
```

Expected: **FAIL** — either the server 404s (no `_site` yet) or `__LIB_VERSION__ was not substituted`. This proves the substitution guard is real before it is trusted.

- [ ] **Step 6: Assemble and run for real**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium && node scripts/bench-check.mjs firefox
```

Expected: both print `browser-sqlite 1.0.0-rc.3, 21 declared pairs` and `OK`.
On Chromium the banner reads OPFS yes / readwrite-unsafe yes / JSPI yes; on Firefox, readwrite-unsafe **no** — that difference is the probe proving it measures behaviour rather than the option's presence.

- [ ] **Step 7: Format and commit**

```bash
pnpm check
git add .gitignore package.json scripts/bench-assemble.mjs scripts/bench-check.mjs bench/index.html
git commit -m "feat(bench): the page shell, its assembler and a hand-run driver

bench/index.html loads the built library, probes the platform by behaviour
rather than by user agent, and derives its pair list from the exported
VFS_CAPABILITIES. bench-assemble.mjs copies dist/ verbatim — the literal
new URL() in dist/index.js is what makes the no-bundler mode work.

scripts/bench-check.mjs drives the page under Playwright by hand. It is
deliberately not wired into CI: it costs a file, not a gate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The selection UI

**Files:**
- Modify: `bench/index.html` (the `SELECTION UI` markers)
- Modify: `scripts/bench-check.mjs`

**Interfaces:**
- Consumes: `PAIRS`, `missingFeature`, `poolFor` (Task 1).
- Produces: `selectedPairs(): Pair[]`; DOM ids `#picker`, `#picker-summary`, `#select-all`, `#select-none`, `#start`; checkbox inputs carrying `data-pair="<vfs>/<build>"`.

- [ ] **Step 1: Add the markup**

Replace the `<!-- SELECTION UI — Task 2 -->` comment in `bench/index.html` with:

```html
    <details id="picker" open>
      <summary id="picker-summary">All</summary>
      <div class="picker-actions">
        <button type="button" id="select-all">All</button>
        <button type="button" id="select-none">None</button>
      </div>
      <div id="picker-list"></div>
    </details>

    <p><button type="button" id="start">Start</button></p>
```

- [ ] **Step 2: Add the styles**

Append inside the existing `<style>`:

```css
      #picker { border: 1px solid var(--border); border-radius: 6px; padding: var(--gap); }
      #picker summary { cursor: pointer; font-weight: 600; }
      .picker-actions { margin: var(--gap) 0; display: flex; gap: 0.5rem; }
      #picker-list { display: grid; gap: 0.15rem 1rem;
        grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); }
      #picker-list label { display: flex; gap: 0.4rem; align-items: baseline; }
      #picker-list label.unavailable { opacity: 0.45; }
      #picker-list .why { font-size: 0.8rem; opacity: 0.75; }
      button { font: inherit; padding: 0.3rem 0.8rem; }
```

- [ ] **Step 3: Build the list from the capability table**

Replace the `// ── SELECTION UI — Task 2 ───` marker with:

```js
      const list = document.getElementById('picker-list');
      const summary = document.getElementById('picker-summary');

      for (const pair of PAIRS) {
        const missing = missingFeature(pair);
        const label = document.createElement('label');
        label.className = missing ? 'unavailable' : '';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.pair = pair.id;
        box.checked = !missing;
        box.disabled = Boolean(missing);
        if (missing) label.title = `this browser has no ${missing}`;

        const text = document.createElement('span');
        text.textContent = `${pair.vfs} · ${pair.build}`;

        const why = document.createElement('span');
        why.className = 'why';
        why.textContent = missing
          ? `no ${missing}`
          : `pool ${poolFor(pair.cap)}`;

        label.append(box, text, why);
        list.append(label);
      }

      const boxes = () => [...list.querySelectorAll('input[data-pair]')];
      const byId = new Map(PAIRS.map((p) => [p.id, p]));

      const selectedPairs = () =>
        boxes()
          .filter((b) => b.checked)
          .map((b) => byId.get(b.dataset.pair));

      const refreshSummary = () => {
        const chosen = selectedPairs();
        const runnable = boxes().filter((b) => !b.disabled).length;
        summary.textContent =
          chosen.length === 0
            ? 'None selected'
            : chosen.length === runnable
              ? `All (${chosen.length})`
              : `${chosen.length} selected — ${chosen.map((p) => p.id).join(', ')}`;
        document.getElementById('start').disabled = chosen.length === 0;
      };

      list.addEventListener('change', refreshSummary);
      document.getElementById('select-all').addEventListener('click', () => {
        for (const b of boxes()) if (!b.disabled) b.checked = true;
        refreshSummary();
      });
      document.getElementById('select-none').addEventListener('click', () => {
        for (const b of boxes()) b.checked = false;
        refreshSummary();
      });
      refreshSummary();
```

- [ ] **Step 4: Extend the driver to assert the selection**

In `scripts/bench-check.mjs`, replace the `// Later tasks extend from here:` line with:

```js
  const runnable = await page.$$eval(
    '#picker-list input[data-pair]:not([disabled])',
    (els) => els.map((e) => e.dataset.pair),
  );
  if (runnable.length === 0) fail('no runnable pair on this engine');
  process.stdout.write(`runnable: ${runnable.join(', ')}\n`);

  if (all) {
    await page.click('#select-all');
  } else {
    await page.click('#select-none');
    await page.check(`#picker-list input[data-pair="${runnable[0]}"]`);
  }

  const summary = await page.textContent('#picker-summary');
  if (!summary || summary === 'None selected') fail(`bad summary: ${summary}`);
  process.stdout.write(`summary: ${summary}\n`);
```

- [ ] **Step 5: Run the driver on both engines**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all && node scripts/bench-check.mjs firefox --all
```

Expected: Chromium lists 21 runnable pairs. **Firefox lists fewer** — the three `OPFSWriteAheadVFS` pairs are disabled with `no readwrite-unsafe`, because that VFS declares it in `requires`. `OPFSAdaptiveVFS` stays enabled on Firefox: it only `degradesWithout` it. If Adaptive is disabled on Firefox, the `missingFeature` rule is reading the wrong field — fix it before continuing.

- [ ] **Step 6: Format and commit**

```bash
pnpm check
git add bench/index.html scripts/bench-check.mjs
git commit -m "feat(bench): capability-derived pair selection

One checkbox per declared (vfs, build) pair, built from VFS_CAPABILITIES so
a VFS added to the table appears here with no edit. Availability is read
from \`requires\`, never from a VFS name — which is what keeps
OPFSAdaptiveVFS enabled on Firefox, where it merely degrades.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The run engine, containment, cleanup, and the `opens` row

**Files:**
- Modify: `bench/index.html` (the `RESULTS TABLE` and `RUNNER` markers)
- Modify: `scripts/bench-check.mjs`

**Interfaces:**
- Consumes: `selectedPairs`, `PAIRS`, `poolFor` (Task 2).
- Produces:
  - `ROW_TIMEOUT_MS = 30_000`
  - `class ColumnAbandoned extends Error`
  - `abortableRow(fn)` / `unabortableRow(fn)` — the two timeout regimes
  - `CONFORMANCE_ROWS: Array<{ id, label, applies(cap), run(ctx) }>` where `ctx = { db, file, pair, pool }` and `run` resolves to `true`, throws, or returns the string `'blocked'`
  - `MEASUREMENT_ROWS` — declared empty here, filled in Tasks 5 and 6
  - `RESULTS` — `{ conformance: {}, measurements: {} }`, keyed by pair id then row id
  - DOM: `#results` table, `window.__BENCH__.done` flag

- [ ] **Step 1: Add the table markup and styles**

Replace `<!-- RESULTS TABLE — Task 3 -->` with:

```html
    <div id="results-wrap"><table id="results"><thead><tr id="head-row">
      <th>row</th></tr></thead><tbody id="body-rows"></tbody></table></div>
```

Append inside `<style>`:

```css
      #results-wrap { overflow-x: auto; }
      #results { border-collapse: collapse; font-size: 0.85rem; }
      #results th, #results td {
        border: 1px solid var(--border); padding: 0.25rem 0.5rem;
        text-align: left; white-space: nowrap;
      }
      #results thead th { position: sticky; top: 0; background: Canvas; }
      #results th small { display: block; font-weight: 400; opacity: 0.7; }
      #results tbody th { font-weight: 400; }
      .pending { opacity: 0.4; }
      .fail { color: #b00020; }
```

- [ ] **Step 2: Write the containment primitives**

Replace the `// ── RUNNER — Task 3 ───` marker with:

```js
      const ROW_TIMEOUT_MS = 30_000;

      /**
       * Thrown when a row could not be bounded without abandoning its column.
       * See spec §5.3: for a method that takes no AbortSignal the only bound
       * available is a race against a timer, which abandons the WAIT without
       * stopping the WORK. Continuing down the column would then time every
       * later row against a worker still executing the abandoned statement,
       * so the whole column is abandoned instead.
       */
      class ColumnAbandoned extends Error {}

      /**
       * A row whose work takes a `signal`: read / write / first / stream /
       * chunk. The abort reaches the drain, the worker is released, and the
       * run continues with the next row in the same column.
       */
      const abortableRow = async (fn) => {
        const signal = AbortSignal.timeout(ROW_TIMEOUT_MS);
        try {
          return await fn(signal);
        } catch (error) {
          if (signal.aborted) throw new RowTimeout();
          throw error;
        }
      };

      class RowTimeout extends Error {}

      /**
       * A row whose work takes no `signal` — bulkWrite and output today, see
       * ABORT-1 in mem:follow-ups. When ABORT-1 lands these rows move to
       * abortableRow and this function loses its last caller.
       */
      const unabortableRow = async (fn) => {
        let timer;
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ColumnAbandoned()), ROW_TIMEOUT_MS);
        });
        try {
          return await Promise.race([fn(), expired]);
        } finally {
          clearTimeout(timer);
        }
      };
```

- [ ] **Step 3: Write the storage cleanup**

Append:

```js
      /**
       * Surgical cleanup. This origin is shared with the user's other Pages
       * projects, so:
       *   - OPFS: remove only our exact generated name, never the root;
       *   - IndexedDB: wa-sqlite names the store after the VFS CLASS, not
       *     after our file, so every database this library ever created with
       *     IDBBatchAtomicVFS lives in one store called `IDBBatchAtomicVFS`.
       *     Deleting it by name would delete other applications' data. We
       *     therefore delete only stores that did not exist before this run.
       * See spec §5.4.
       */
      const idbBefore = CAN_LIST_IDB
        ? new Set((await indexedDB.databases()).map((d) => d.name))
        : null;

      const cleanupOpfs = async (file) => {
        if (!HAS_OPFS) return;
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(file, { recursive: true });
        } catch {
          // Never created, or this VFS does not use OPFS at all.
        }
      };

      const cleanupIdb = async () => {
        if (!idbBefore) return;
        const now = await indexedDB.databases();
        for (const { name } of now) {
          if (!name || idbBefore.has(name)) continue;
          await new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () =>
              resolve();
          });
        }
      };
```

- [ ] **Step 4: Write the row registry with `opens`, and the table renderer**

Append:

```js
      const RESULTS = { conformance: {}, measurements: {} };

      /**
       * Conformance rows. Ids are the describe() titles of
       * tests/conformance/invariants.test.ts, verbatim — see BENCH-DRIFT in
       * mem:follow-ups. `run` resolves true, resolves 'blocked', or throws.
       */
      const CONFORMANCE_ROWS = [
        {
          id: 'opens',
          label: 'opens and serves a query',
          applies: () => true,
          run: ({ db }) =>
            abortableRow(async (signal) => {
              await db.write('CREATE TABLE t (a INTEGER)', undefined, { signal });
              await db.write('INSERT INTO t VALUES (1)', undefined, { signal });
              const rows = await db.read('SELECT count(*) AS n FROM t', undefined, {
                signal,
              });
              if (rows[0].n !== 1) throw new Error(`expected 1, got ${rows[0].n}`);
              return true;
            }),
        },
      ];

      /** Measurement rows. Filled in Tasks 5 and 6. */
      const MEASUREMENT_ROWS = [];

      const headRow = document.getElementById('head-row');
      const bodyRows = document.getElementById('body-rows');
      const cells = new Map(); // `${pairId}|${rowId}` -> <td>

      const buildRows = () => {
        bodyRows.replaceChildren();
        for (const row of [...CONFORMANCE_ROWS, ...MEASUREMENT_ROWS]) {
          const tr = document.createElement('tr');
          tr.dataset.row = row.id;
          const th = document.createElement('th');
          th.textContent = row.label;
          th.title = row.id;
          tr.append(th);
          bodyRows.append(tr);
        }
      };

      const addColumn = (pair) => {
        const th = document.createElement('th');
        th.innerHTML = `${pair.vfs} · ${pair.build}<small>pool ${poolFor(pair.cap)}</small>`;
        headRow.append(th);
        for (const tr of bodyRows.querySelectorAll('tr')) {
          const td = document.createElement('td');
          td.className = 'pending';
          td.textContent = '…';
          tr.append(td);
          cells.set(`${pair.id}|${tr.dataset.row}`, td);
        }
      };

      const setCell = (pair, rowId, text, className = '') => {
        const td = cells.get(`${pair.id}|${rowId}`);
        if (!td) return;
        td.className = className;
        td.textContent = text;
      };
```

- [ ] **Step 5: Write the sequential runner**

Append:

```js
      const status = document.getElementById('status');
      const startButton = document.getElementById('start');
      let stopRequested = false;

      /**
       * One pair at a time, one row at a time. Two VFS running concurrently
       * would contend for OPFS and invalidate every number on this page, so
       * this sequencing is a correctness requirement, not a simplification.
       */
      const runPair = async (pair) => {
        addColumn(pair);
        const file = `bench-${crypto.randomUUID()}`;
        RESULTS.conformance[pair.id] = {};
        RESULTS.measurements[pair.id] = {};

        const db = createSQLiteClient(file, {
          vfs: pair.vfs,
          build: pair.build,
          poolSize: poolFor(pair.cap),
        });
        const ctx = { db, file, pair, pool: poolFor(pair.cap) };

        let abandoned = false;
        for (const row of [...CONFORMANCE_ROWS, ...MEASUREMENT_ROWS]) {
          const kind = CONFORMANCE_ROWS.includes(row)
            ? 'conformance'
            : 'measurements';

          if (abandoned) {
            RESULTS[kind][pair.id][row.id] = 'timeout';
            setCell(pair, row.id, '⏱');
            continue;
          }
          if (!row.applies(pair.cap)) {
            RESULTS[kind][pair.id][row.id] = 'skipped';
            setCell(pair, row.id, '⃠');
            continue;
          }

          status.textContent = `${pair.id} — ${row.id}`;
          try {
            const value = await row.run(ctx);
            if (value === 'blocked') {
              RESULTS[kind][pair.id][row.id] = 'blocked';
              setCell(pair, row.id, '⃠ blocked');
            } else if (kind === 'conformance') {
              RESULTS[kind][pair.id][row.id] = 'pass';
              setCell(pair, row.id, '✅');
            } else {
              RESULTS[kind][pair.id][row.id] = value;
              setCell(pair, row.id, formatMeasure(row, value));
            }
          } catch (error) {
            if (error instanceof ColumnAbandoned) {
              abandoned = true;
              RESULTS[kind][pair.id][row.id] = 'timeout';
              setCell(pair, row.id, '⏱ column abandoned', 'fail');
            } else if (error instanceof RowTimeout) {
              RESULTS[kind][pair.id][row.id] = 'timeout';
              setCell(pair, row.id, '⏱', 'fail');
            } else {
              RESULTS[kind][pair.id][row.id] =
                kind === 'conformance' ? 'fail' : null;
              const td = cells.get(`${pair.id}|${row.id}`);
              if (td) td.title = String(error?.message ?? error);
              setCell(pair, row.id, '❌', 'fail');
            }
            // Every later row would fail for the same reason and say nothing
            // new, so a failed `opens` ends this column.
            if (row.id === 'opens') abandoned = true;
          }
        }

        try {
          await Promise.race([
            db.close(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('close timed out')), ROW_TIMEOUT_MS),
            ),
          ]);
        } catch {
          // A close that never settles is HANDLE-1 holding the pool. Nothing
          // to do but move on; the worker dies with the page.
        }
        await cleanupOpfs(file);
      };

      /** Measurements render as text here; Task 7 adds the relative bars. */
      const formatMeasure = (row, value) =>
        value === null ? '—' : `${value.toFixed(row.decimals ?? 1)} ${row.unit}`;

      startButton.addEventListener('click', async () => {
        if (startButton.dataset.running) {
          stopRequested = true;
          return;
        }
        startButton.dataset.running = '1';
        startButton.textContent = 'Stop';
        document.getElementById('picker').open = false;
        window.__BENCH__.done = false;

        buildRows();
        for (const pair of selectedPairs()) {
          if (stopRequested) break;
          await runPair(pair);
        }
        await cleanupIdb();

        status.textContent = stopRequested ? 'stopped' : 'done';
        window.__BENCH__.done = true;
        window.__BENCH__.results = RESULTS;
        startButton.textContent = 'Start';
        delete startButton.dataset.running;
        stopRequested = false;
      });
```

- [ ] **Step 6: Import `createSQLiteClient`**

Change the first line of the module from:

```js
      import { VFS_CAPABILITIES } from './dist/index.js';
```

to:

```js
      import { createSQLiteClient, VFS_CAPABILITIES } from './dist/index.js';
```

- [ ] **Step 7: Extend the driver to run and assert no cell is stuck**

In `scripts/bench-check.mjs`, after the `summary:` line, append:

```js
  await page.click('#start');
  await page.waitForFunction(() => window.__BENCH__.done === true, {
    timeout: 10 * 60_000,
  });

  const stuck = await page.$$eval('#results td', (tds) =>
    tds.filter((td) => td.textContent === '…').length,
  );
  if (stuck > 0) fail(`${stuck} cells never resolved`);

  const columns = await page.$$eval('#head-row th', (th) => th.length - 1);
  if (columns === 0) fail('no column was rendered');

  process.stdout.write(
    `${columns} columns, results:\n` +
      JSON.stringify(await page.evaluate(() => window.__BENCH__.results), null, 2) +
      '\n',
  );
```

- [ ] **Step 8: Run on both engines**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all && node scripts/bench-check.mjs firefox --all
```

Expected: every selected pair gets a column; every `opens` cell is `✅`; OPFS is empty afterwards (check in devtools, `navigator.storage.getDirectory()`); no `pageerror`.
`MemoryVFS` and `MemoryAsyncVFS` pass too — they open, they just do not persist.

- [ ] **Step 9: Format and commit**

```bash
pnpm check
git add bench/index.html scripts/bench-check.mjs
git commit -m "feat(bench): the sequential runner, containment and cleanup

One pair at a time and one row at a time, because two VFS contending for
OPFS would invalidate every number on the page.

Two timeout regimes, and conflating them would corrupt the page's own
measurements: a row that takes a signal aborts and the column continues; a
row that does not can only abandon the wait, leaving the worker busy, so it
abandons the whole column instead (ABORT-1).

Cleanup is surgical because the origin is shared with the user's other
Pages projects: OPFS by exact name, IndexedDB only for stores that did not
exist before the run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The six remaining conformance rows, and the drift rule

**Files:**
- Modify: `bench/index.html` (`CONFORMANCE_ROWS`)
- Modify: `.serena/memories/follow-ups.md`

**Interfaces:**
- Consumes: `CONFORMANCE_ROWS`, `abortableRow`, `createSQLiteClient`, `cleanupOpfs` (Task 3).
- Produces: seven conformance rows total.

**Source of truth:** each `run` below mirrors the same-numbered `describe()` in `tests/conformance/invariants.test.ts`. Read that file before editing either copy.

- [ ] **Step 1: Add invariants 1 to 3**

In `bench/index.html`, append to the `CONFORMANCE_ROWS` array, after the `opens` entry:

```js
        {
          id: 'write-read-back',
          label: 'what is written is read back',
          applies: () => true,
          run: ({ db }) =>
            abortableRow(async (signal) => {
              await db.write('CREATE TABLE inv1 (a INTEGER)', undefined, { signal });
              await db.write('INSERT INTO inv1 VALUES (42)', undefined, { signal });
              const rows = await db.read('SELECT a FROM inv1', undefined, { signal });
              if (rows.length !== 1 || rows[0].a !== 42) {
                throw new Error(`expected [{a:42}], got ${JSON.stringify(rows)}`);
              }
              return true;
            }),
        },
        {
          id: 'survives-reopen',
          label: 'data survives close and reopen',
          // Read from the table, never hardcoded: the memory VFS declare
          // persistent: false and this row is meaningless for them.
          applies: (cap) => cap.persistent,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ctx.db.write('CREATE TABLE inv2 (a INTEGER)', undefined, {
                signal,
              });
              await ctx.db.write('INSERT INTO inv2 VALUES (7)', undefined, {
                signal,
              });
              await ctx.db.close();

              // This row closed the column's client, so it owes the column a
              // fresh one — the reopened client BECOMES the column's client.
              // Without this every later row fails with CLIENT_CLOSED. It is
              // also why rows read `ctx.db` and never destructure it: see
              // Step 2.
              ctx.db = createSQLiteClient(ctx.file, {
                vfs: ctx.pair.vfs,
                build: ctx.pair.build,
                poolSize: poolFor(ctx.pair.cap),
              });
              const rows = await ctx.db.read('SELECT a FROM inv2', undefined, {
                signal,
              });
              if (rows.length !== 1 || rows[0].a !== 7) {
                throw new Error(`expected [{a:7}], got ${JSON.stringify(rows)}`);
              }
              return true;
            }),
        },
        {
          id: 'concurrent-writes-lose-nothing',
          label: 'concurrent writes lose nothing',
          applies: (cap) => cap.maxPoolSize !== 1,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ctx.db.write('CREATE TABLE inv3 (a INTEGER)', undefined, {
                signal,
              });
              const N = 20;
              await Promise.all(
                Array.from({ length: N }, (_, i) =>
                  ctx.db.write('INSERT INTO inv3 VALUES (?)', [i], { signal }),
                ),
              );
              const rows = await ctx.db.read(
                'SELECT count(*) AS n FROM inv3',
                undefined,
                { signal },
              );
              if (rows[0].n !== N) throw new Error(`expected ${N}, got ${rows[0].n}`);
              return true;
            }),
        },
```

- [ ] **Step 2: Make the column's client replaceable**

Two rows close the column's client and hand it a replacement (`survives-reopen` above, `close-settles` in Step 4). That only works if every other row reads the *current* client. **Destructuring `({ db })` in a row signature captures the client that existed when the row was called — the stale one.**

So: in Task 3's `opens` row, change the signature from `run: ({ db }) =>` to `run: (ctx) =>` and replace each `db.` with `ctx.db.`.

And in `runPair` (Task 3), change the final close:

```js
        try {
          await Promise.race([
            ctx.db.close(),
```

`ctx` is already what `row.run(ctx)` passes, so nothing else changes. Every row added from here on reads `ctx.db`.

- [ ] **Step 3: Run and verify the column survives the reopen**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all
```

Expected: `survives-reopen` is `✅` for the seven persistent VFS and `⃠` for `MemoryVFS` / `MemoryAsyncVFS`; **`concurrent-writes-lose-nothing` on the row below it is still `✅`, not `❌`** — that is the assertion that Step 2 worked. If it is `❌` with `CLIENT_CLOSED`, a row is still destructuring `db` at call time.

- [ ] **Step 4: Add invariants 4 and 5**

Append to `CONFORMANCE_ROWS`:

```js
        {
          id: 'rollback-leaves-nothing',
          label: 'a rolled-back transaction leaves nothing',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ctx.db.write('CREATE TABLE inv4 (a INTEGER)', undefined, {
                signal,
              });
              let threw = false;
              try {
                await ctx.db.transaction(async (tx) => {
                  await tx.write('INSERT INTO inv4 VALUES (1)');
                  throw new Error('deliberate rollback');
                });
              } catch (error) {
                threw = /deliberate rollback/.test(String(error?.message ?? error));
              }
              if (!threw) throw new Error('transaction did not reject');
              const rows = await ctx.db.read(
                'SELECT count(*) AS n FROM inv4',
                undefined,
                { signal },
              );
              if (rows[0].n !== 0) throw new Error(`expected 0, got ${rows[0].n}`);
              return true;
            }),
        },
        {
          id: 'close-settles',
          label: 'close settles',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ctx.db.write('CREATE TABLE inv5 (a INTEGER)', undefined, {
                signal,
              });
              // No clock: a close that never settles is caught by the row
              // timeout. Asserting a duration here would be a benchmark, and
              // benchmarks are the other half of this page.
              await ctx.db.close();
              let rejected = false;
              try {
                await ctx.db.read('SELECT 1 AS n');
              } catch {
                rejected = true;
              }
              if (!rejected) throw new Error('read after close did not reject');

              // Same reason as survives-reopen: this row closed the column's
              // client, so it owes the column a fresh one.
              ctx.db = createSQLiteClient(ctx.file, {
                vfs: ctx.pair.vfs,
                build: ctx.pair.build,
                poolSize: poolFor(ctx.pair.cap),
              });
              return true;
            }),
        },
```

- [ ] **Step 5: Add invariant 6, with its blocked state**

Append to `CONFORMANCE_ROWS`:

```js
        {
          id: 'no-read-inside-transaction',
          label: 'no read runs inside an open transaction',
          applies: (cap) => cap.maxPoolSize !== 1,
          /**
           * B1 isolation. Exercising it needs a second worker served while the
           * transaction holds — which HANDLE-1 prevents on any VFS rotating a
           * single exclusive OPFS access handle. The pool-acquire blocks at the
           * scheduler, before the signal is ever checked, so the abort is how
           * we tell "isolated" from "never got the chance to look".
           *
           * That distinction is the reason this row can return 'blocked'
           * instead of pass or fail: reporting a pass there would claim we
           * proved something we did not.
           */
          run: async (ctx) => {
            await ctx.db.write('CREATE TABLE inv6 (a INTEGER)');

            let release;
            const held = new Promise((resolve) => {
              release = resolve;
            });
            const tx = ctx.db.transaction(async (inner) => {
              await inner.write('INSERT INTO inv6 VALUES (1)');
              await held;
            });

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2000);
            const readOutcome = ctx.db
              .read('SELECT count(*) AS n FROM inv6', undefined, {
                signal: controller.signal,
              })
              .then(
                (rows) => ({ ok: true, rows }),
                (error) => ({ ok: false, error }),
              );
            const aborted = new Promise((resolve) => {
              controller.signal.addEventListener('abort', () => resolve(null), {
                once: true,
              });
            });

            const winner = await Promise.race([readOutcome, aborted]);
            clearTimeout(timer);

            let verdict;
            if (winner === null) {
              verdict = 'blocked';
            } else if (!winner.ok) {
              release();
              await tx;
              throw winner.error;
            } else if (winner.rows[0].n !== 0) {
              release();
              await tx;
              throw new Error(
                `read saw ${winner.rows[0].n} uncommitted rows — B1 violated`,
              );
            } else {
              verdict = true;
            }

            release();
            await tx;
            return verdict;
          },
        },
```

- [ ] **Step 6: Run on both engines and read the difference**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all && node scripts/bench-check.mjs firefox --all
```

Expected:
- Chromium: all seven rows `✅` where they apply; `⃠` on the memory VFS for `survives-reopen`, and on the `maxPoolSize: 1` VFS (`AccessHandlePoolVFS`, `MemoryVFS`, `MemoryAsyncVFS`) for rows 3 and 6.
- **Firefox: `no-read-inside-transaction` reads `⃠ blocked` on the OPFS handle-rotating VFS.** That is HANDLE-1 observed, and it is the correct report — not a failure.

- [ ] **Step 7: Record the drift rule**

Add this section to `.serena/memories/follow-ups.md`, immediately before `## Performance — after correctness, with debug instrumentation live`:

```markdown
## BENCH-DRIFT — the page holds a second copy of the invariants and the probes

**Status: standing rule, not a bug. Opened 2026-08-24 with the benchmark page.**

`bench/index.html` re-implements, in plain JS, what `tests/conformance/invariants.test.ts` and
`tests/conformance/helpers.ts` hold in TypeScript: the six invariants, the `readwrite-unsafe`
behavioural probe, and the JSPI detection. The duplication is deliberate — a self-contained HTML
file cannot import `tests/**` , which import `src/` — and it is bounded: these describe properties
of SQLite and of the platform, not of our implementation, so they are expected to be static.

**The rule: changing either copy obliges a review of the other.** Both directions.

What makes a divergence visible rather than silent: **the page's row ids are the conformance
`describe()` titles verbatim** — `opens`, `write-read-back`, `survives-reopen`,
`concurrent-writes-lose-nothing`, `rollback-leaves-nothing`, `close-settles`,
`no-read-inside-transaction`. A row whose id no longer matches a `describe()` is the signal.

Two places where the copies legitimately differ, and must not be "aligned":

- The page returns `'blocked'` where invariant 6 logs a `console.warn` and passes. Same
  observation, different medium: a test suite has nowhere to render a third state, a table does.
- The page reopens the column's client after `survives-reopen` and `close-settles`, because it runs
  every row against one client where the suite gets a fresh one per `it()`.

This is the class of defect this repository already knows it has — *"here, comments drift faster
than code"* — applied to code rather than comments.
```

- [ ] **Step 8: Format and commit**

```bash
pnpm check
git add bench/index.html .serena/memories/follow-ups.md
git commit -m "feat(bench): the six conformance invariants, and BENCH-DRIFT

Row ids are the conformance describe() titles verbatim, which is what makes
a divergence between the two copies visible by name rather than silent.

Invariant 6 gets a third state the test suite has nowhere to render: on a
VFS rotating a single exclusive access handle the concurrent read is never
served, so B1 was not exercised. Reporting that as a pass would claim a
proof we do not have — it reads 'blocked'.

Two rows close the column's client and owe it a fresh one; without that
every later row in the column fails with CLIENT_CLOSED.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The dataset, the timing helpers, and four measurements

**Files:**
- Modify: `bench/index.html` (`MEASUREMENT_ROWS`)

**Interfaces:**
- Consumes: `MEASUREMENT_ROWS`, `abortableRow`, `unabortableRow`, `ROW_TIMEOUT_MS` (Task 3).
- Produces:
  - `DATASET_ROWS = 10_000`
  - `time(fn)` → `Promise<number>` (ms)
  - `quantile(samples, q)` → number
  - `ensureDataset(ctx)` → builds `bench` once per column
  - measurement row shape: `{ id, label, unit, decimals?, better: 'low' | 'high', applies(cap), run(ctx) }`
  - four rows: `bulk-insert-10k`, `write-latency-p50`, `write-latency-p95`, `point-read-p50`, `list-page-p50`

- [ ] **Step 1: Add the helpers**

In `bench/index.html`, immediately before `const MEASUREMENT_ROWS = []`, insert:

```js
      const DATASET_ROWS = 10_000;

      /** Wall time of one awaited call, in ms. */
      const time = async (fn) => {
        const start = performance.now();
        await fn();
        return performance.now() - start;
      };

      /**
       * Order statistic over raw samples — never a mean. These VFS differ in
       * their tail, which is exactly what a mean hides.
       */
      const quantile = (samples, q) => {
        const sorted = [...samples].sort((a, b) => a - b);
        const index = Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil(q * sorted.length) - 1),
        );
        return sorted[index];
      };

      /** A short read: primary-key lookup, so the cost is round-trip, not SQLite. */
      const shortRead = (db, id, signal) =>
        db.first('SELECT id, label FROM bench WHERE id = ?', [id], { signal });

      const randomId = () => 1 + Math.floor(Math.random() * DATASET_ROWS);

      /**
       * Builds the column's shared dataset exactly once. Rows that need it call
       * this; rows that do not (bulk-insert, which builds its own) do not pay
       * for it. Uses bulkWrite, so it inherits the unabortable regime.
       */
      const ensureDataset = async (ctx) => {
        if (ctx.datasetReady) return;
        await unabortableRow(async () => {
          await ctx.db.write(
            'CREATE TABLE bench (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)',
          );
          const bulk = ctx.db.bulkWrite('bench', ['id', 'label', 'n']);
          for (let i = 1; i <= DATASET_ROWS; i++) {
            bulk.enqueue({ id: i, label: `row-${i}`, n: i % 97 });
          }
          await bulk.close();
          await ctx.db.write('CREATE INDEX bench_n ON bench (n)');
        });
        ctx.datasetReady = true;
      };
```

- [ ] **Step 2: Add the four measurement rows**

Replace `const MEASUREMENT_ROWS = [];` with:

```js
      const MEASUREMENT_ROWS = [
        {
          id: 'bulk-insert-10k',
          label: `bulk insert ${DATASET_ROWS.toLocaleString('en')} rows`,
          unit: 'ms',
          decimals: 0,
          better: 'low',
          applies: () => true,
          // bulkWrite takes no signal (ABORT-1), so this row can only abandon
          // the column. It is deliberately first: paying that risk before the
          // dataset exists costs less than paying it halfway down the column.
          run: async (ctx) => {
            const ms = await time(() => ensureDataset(ctx));
            return ms;
          },
        },
        {
          id: 'write-latency-p50',
          label: 'single INSERT — p50',
          unit: 'ms',
          decimals: 2,
          better: 'low',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              await ctx.db.write('CREATE TABLE lat (a INTEGER)', undefined, { signal });
              await ctx.db.write('INSERT INTO lat VALUES (0)', undefined, { signal }); // warmup
              const samples = [];
              for (let i = 1; i <= 100; i++) {
                samples.push(
                  await time(() =>
                    ctx.db.write('INSERT INTO lat VALUES (?)', [i], { signal }),
                  ),
                );
              }
              ctx.writeLatency = samples;
              return quantile(samples, 0.5);
            }),
        },
        {
          id: 'write-latency-p95',
          label: 'single INSERT — p95',
          unit: 'ms',
          decimals: 2,
          better: 'low',
          applies: () => true,
          // Reuses the samples the p50 row collected rather than running 100
          // more inserts: two runs would measure two different database sizes.
          run: (ctx) =>
            ctx.writeLatency ? quantile(ctx.writeLatency, 0.95) : null,
        },
        {
          id: 'point-read-p50',
          label: 'point read by primary key — p50',
          unit: 'ms',
          decimals: 2,
          better: 'low',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              await shortRead(ctx.db, randomId(), signal); // warmup
              const samples = [];
              for (let i = 0; i < 200; i++) {
                samples.push(
                  await time(() => shortRead(ctx.db, randomId(), signal)),
                );
              }
              return quantile(samples, 0.5);
            }),
        },
        {
          id: 'list-page-p50',
          label: 'one page of a list (LIMIT 50) — p50',
          unit: 'ms',
          decimals: 2,
          better: 'low',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              const page = (offset) =>
                ctx.db.read(
                  'SELECT id, label FROM bench ORDER BY n, id LIMIT 50 OFFSET ?',
                  [offset],
                  { signal },
                );
              await page(0); // warmup
              const samples = [];
              for (let i = 0; i < 100; i++) {
                samples.push(
                  await time(() => page(Math.floor(Math.random() * (DATASET_ROWS - 50)))),
                );
              }
              return quantile(samples, 0.5);
            }),
        },
      ];
```

- [ ] **Step 3: Run on Chromium and sanity-check the numbers**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all
```

Expected shape, not exact values:
- `bulk-insert-10k` in the hundreds of ms to a few seconds per VFS.
- `write-latency-p50` well under `list-page-p50`? **No — expect the opposite** on OPFS VFS: a single INSERT commits, a LIMIT 50 read does not. If `write-latency-p50` comes out below `point-read-p50`, something is not committing and the numbers are meaningless — investigate before continuing.
- `write-latency-p95` ≥ `write-latency-p50` always. If it is `—`, the p50 row failed and the reuse guard did its job.
- No `⏱ column abandoned`. If `bulk-insert-10k` abandons a column, `DATASET_ROWS` is too large for that VFS on this machine — report it rather than silently lowering it.

- [ ] **Step 4: Run on Firefox**

```bash
node scripts/bench-check.mjs firefox --all
```

Expected: same shape, everything slower. The repository already knows Firefox is ~5.5× slower than Chromium on CPU-bound SQLite work, so a broad slowdown is not a defect.

- [ ] **Step 5: Format and commit**

```bash
pnpm check
git add bench/index.html
git commit -m "feat(bench): the dataset and four application-shaped measurements

Bulk insert, single-INSERT latency, point read, and one page of a list —
the shapes a real client actually issues, rather than microbenchmarks.

Every quantile is an order statistic over raw samples, never a mean: these
VFS differ in their tail, which is exactly what a mean hides. p95 reuses
the p50 row's samples rather than running 100 more inserts, which would
measure a different database size.

bulk-insert-10k runs first on purpose: bulkWrite takes no signal (ABORT-1),
so it is the one row that can abandon a column, and paying that risk before
the dataset exists costs less than paying it halfway down.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Concurrency, scan, transaction throughput, and pool blocking

**Files:**
- Modify: `bench/index.html` (`MEASUREMENT_ROWS`)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `longQuery(iterations)`, `calibrateLongQuery(ctx)`, and four rows — `read-burst-concurrency`, `full-scan`, `transaction-throughput`, `pool-blocking`.

- [ ] **Step 1: Add the long-query helpers**

Insert before `const MEASUREMENT_ROWS`:

```js
      /**
       * A single very long sqlite3_step() with no table to populate: SQLite
       * must run the whole recursion before the first row of count(*) exists.
       * Copied from tests/browser/helpers.ts.
       *
       * That property is what makes it the right instrument for pool-blocking:
       * a worker inside it never returns to its event loop, which is precisely
       * HANDLE-1's mechanism.
       */
      const longQuery = (iterations) =>
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${iterations}) SELECT count(*) AS n FROM c`;

      /**
       * Finds an iteration count that costs 1.5–3 s ON THIS DEVICE, then reuses
       * it for every column. A constant would be meaningless across a laptop
       * and a phone — this repository already measured Firefox at ~5.5× a
       * Chromium of the same CPU on this exact query.
       */
      const calibrateLongQuery = async (ctx) => {
        if (ctx.longIterations) return ctx.longIterations;
        let iterations = 1_000_000;
        for (let attempt = 0; attempt < 6; attempt++) {
          const ms = await time(() => ctx.db.read(longQuery(iterations)));
          if (ms >= 1500 && ms <= 3000) break;
          if (ms > 3000) {
            iterations = Math.max(100_000, Math.round(iterations / 2));
            break;
          }
          iterations = Math.round(iterations * Math.max(2, 2000 / Math.max(ms, 1)));
        }
        ctx.longIterations = iterations;
        return iterations;
      };
```

Calibration runs per column rather than once for the page: `ctx` is per-pair, and a VFS that is 10× slower deserves its own count. Recording it in the export (Task 8) is what keeps the number interpretable.

- [ ] **Step 2: Add the four rows**

Append to `MEASUREMENT_ROWS`:

```js
        {
          id: 'read-burst-concurrency',
          label: '24 short reads — parallel vs serial (gain)',
          unit: '×',
          decimals: 2,
          better: 'high',
          applies: () => true,
          /**
           * The row that shows the library's reason to exist. On a poolSize-1
           * VFS it lands near 1.00, which is the declared behaviour and not a
           * failure — see the note rendered under the table.
           */
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              const ids = Array.from({ length: 24 }, randomId);

              await shortRead(ctx.db, ids[0], signal); // warmup

              const serial = await time(async () => {
                for (const id of ids) await shortRead(ctx.db, id, signal);
              });
              const parallel = await time(() =>
                Promise.all(ids.map((id) => shortRead(ctx.db, id, signal))),
              );
              return serial / parallel;
            }),
        },
        {
          id: 'full-scan',
          label: `full scan over ${DATASET_ROWS.toLocaleString('en')} rows`,
          unit: 'ms',
          decimals: 1,
          better: 'low',
          applies: () => true,
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              const scan = () =>
                ctx.db.read(
                  'SELECT count(*) AS n, sum(n) AS total, max(label) AS last FROM bench',
                  undefined,
                  { signal },
                );
              await scan(); // warmup
              const samples = [];
              for (let i = 0; i < 5; i++) samples.push(await time(scan));
              return quantile(samples, 0.5);
            }),
        },
        {
          id: 'transaction-throughput',
          label: '500 inserts inside one transaction',
          unit: 'ms',
          decimals: 0,
          better: 'low',
          applies: () => true,
          // The gap against write-latency-p50 × 500 is the most useful thing a
          // developer learns from this page.
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ctx.db.write('CREATE TABLE txput (a INTEGER)', undefined, {
                signal,
              });
              return time(() =>
                ctx.db.transaction(async (tx) => {
                  for (let i = 0; i < 500; i++) {
                    await tx.write('INSERT INTO txput VALUES (?)', [i]);
                  }
                }),
              );
            }),
        },
        {
          id: 'pool-blocking',
          label: 'short read during a long query (× idle)',
          unit: '×',
          decimals: 2,
          better: 'low',
          applies: (cap) => cap.maxPoolSize !== 1,
          /**
           * HANDLE-1, measured. ≈1 means the pool served the short read while
           * the long query ran; ≫1 means one worker inside an uninterruptible
           * statement stranded the whole pool.
           *
           * This is the ONE claim in the README's reduced-mode section that
           * the test suite does not prove, because proving it means timing
           * something and CI runs tests rather than benchmarks.
           */
          run: (ctx) =>
            abortableRow(async (signal) => {
              await ensureDataset(ctx);
              const iterations = await calibrateLongQuery(ctx);

              const idle = [];
              for (let i = 0; i < 5; i++) {
                idle.push(await time(() => shortRead(ctx.db, randomId(), signal)));
              }
              const baseline = Math.max(quantile(idle, 0.5), 0.01);

              // Deliberately not awaited: the long query must still be running
              // while the short reads are timed. Its rejection is swallowed —
              // the row timeout is what bounds this, not the long query.
              const long = ctx.db.read(longQuery(iterations), undefined, { signal });
              long.catch(() => {});

              await new Promise((resolve) => setTimeout(resolve, 50));

              const during = [];
              for (let i = 0; i < 5; i++) {
                during.push(await time(() => shortRead(ctx.db, randomId(), signal)));
              }

              await long.catch(() => {});
              return quantile(during, 0.5) / baseline;
            }),
        },
```

- [ ] **Step 3: Add the note that keeps a 1.00 readable**

After the `</table>` in the results markup, add:

```html
    <p class="note">
      On a VFS capped at one worker, <code>read-burst-concurrency</code> lands
      near 1.00× and <code>pool-blocking</code> well above it. That is the
      declared behaviour, not a failure.
    </p>
```

and in `<style>`:

```css
      .note { font-size: 0.8rem; opacity: 0.75; max-width: 46rem; }
```

- [ ] **Step 4: Run on Chromium and read the two ratios**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all
```

Expected:
- `read-burst-concurrency` **above 1** on multi-connection VFS at pool 4, and **≈1.00** on `AccessHandlePoolVFS`, `MemoryVFS`, `MemoryAsyncVFS`.
- `pool-blocking` **≈1** on Chromium for `OPFSAdaptiveVFS` (it holds one `readwrite-unsafe` handle per connection there), and `⃠` on the pool-1 VFS.
- `transaction-throughput` far below `500 × write-latency-p50`.

- [ ] **Step 5: Run on Firefox — this is the observation the README owes**

```bash
node scripts/bench-check.mjs firefox --all
```

Expected: **`pool-blocking` well above 1 for `OPFSAdaptiveVFS` and `OPFSCoopSyncVFS`**, and near 1 for `IDBBatchAtomicVFS`, `IDBMirrorVFS` and `OPFSAnyContextVFS`. That split is HANDLE-1 measured, and it is the first time this project has a number for it. **Record the numbers in the task report** — they are the input to `mem:resume-plan` §0.2 items 1 and 4.

If `pool-blocking` comes out ≈1 everywhere on Firefox, the long query is finishing before the short reads run: raise the calibration window and re-run before concluding anything.

- [ ] **Step 6: Format and commit**

```bash
pnpm check
git add bench/index.html
git commit -m "feat(bench): concurrency, scan, transaction throughput, pool blocking

pool-blocking is the point of this task: it times a short read against a
worker stuck inside a single uninterruptible step(), which is HANDLE-1's
mechanism, and it is the one claim in the README's reduced-mode section
that the test suite does not prove.

The long query's iteration count is calibrated per column to cost 1.5-3 s
on the device in hand. A constant would be meaningless between a laptop and
a phone — Firefox is already known to be ~5.5x a Chromium of the same CPU
on this exact query.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Relative bars and final display states

**Files:**
- Modify: `bench/index.html` (`formatMeasure`, styles)

**Interfaces:**
- Consumes: `RESULTS`, `MEASUREMENT_ROWS`, `setCell` (Tasks 3, 5, 6).
- Produces: `renderMeasureRow(row)` — repaints one measurement row's cells with a bar scaled to the best column so far.

- [ ] **Step 1: Add the bar styles**

Append to `<style>`:

```css
      td.measure { position: relative; text-align: right; font-variant-numeric: tabular-nums; }
      td.measure .bar {
        position: absolute; inset: 0 auto 0 0; z-index: -1;
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      td.measure .value { position: relative; }
      td.measure.best { font-weight: 600; }
```

- [ ] **Step 2: Repaint a row whenever one of its cells lands**

Replace the `formatMeasure` function from Task 3 with:

```js
      /**
       * Repaints every cell of one measurement row, scaled to the best value
       * present so far. Called each time a cell lands, because "best" changes
       * as columns arrive — a bar drawn once against the first column would
       * be a lie by the third.
       */
      const renderMeasureRow = (row) => {
        const entries = Object.entries(RESULTS.measurements)
          .map(([pairId, rows]) => [pairId, rows[row.id]])
          .filter(([, value]) => typeof value === 'number');
        if (entries.length === 0) return;

        const values = entries.map(([, value]) => value);
        const best = row.better === 'high' ? Math.max(...values) : Math.min(...values);
        const worst = row.better === 'high' ? Math.min(...values) : Math.max(...values);

        for (const [pairId, value] of entries) {
          const td = cells.get(`${pairId}|${row.id}`);
          if (!td) continue;
          // Ratio to best, always in [0,1], whichever direction is better.
          const ratio =
            row.better === 'high' ? value / best : best / value;
          td.className = `measure${value === best && worst !== best ? ' best' : ''}`;
          td.title = '';
          td.replaceChildren();
          const bar = document.createElement('span');
          bar.className = 'bar';
          bar.style.width = `${Math.max(2, ratio * 100)}%`;
          const text = document.createElement('span');
          text.className = 'value';
          text.textContent = `${value.toFixed(row.decimals ?? 1)} ${row.unit}`;
          td.append(bar, text);
        }
      };
```

- [ ] **Step 3: Call it from the runner**

In `runPair`, replace the measurement branch:

```js
            } else {
              RESULTS[kind][pair.id][row.id] = value;
              setCell(pair, row.id, formatMeasure(row, value));
            }
```

with:

```js
            } else {
              RESULTS[kind][pair.id][row.id] = value;
              if (typeof value === 'number') {
                renderMeasureRow(row);
              } else {
                setCell(pair, row.id, '—');
              }
            }
```

- [ ] **Step 4: Run and look at it**

```bash
pnpm bench:build && pnpm bench:serve
```

Open `http://127.0.0.1:8099/` in a real browser, select All, Start. Check by eye:
- bars grow left-to-right and the widest cell is the best one on **both** directions (`ms` low-is-better, `×` high-is-better on `read-burst-concurrency`, low-is-better on `pool-blocking`);
- bars re-scale as later columns land;
- a row where every column is equal shows no bold cell (`worst !== best` guard);
- the table scrolls horizontally at 21 columns without the page scrolling.

- [ ] **Step 5: Format and commit**

```bash
pnpm check
git add bench/index.html
git commit -m "feat(bench): relative bars, rescaled as columns arrive

Each measurement row is repainted whenever one of its cells lands, because
the best value changes as columns arrive — a bar drawn once against the
first column would be a lie by the third.

The ratio is computed against the row's own direction, so the widest bar is
the best cell whether lower or higher wins.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The JSON export

**Files:**
- Modify: `bench/index.html`
- Modify: `scripts/bench-check.mjs`

**Interfaces:**
- Consumes: `RESULTS`, `AGENT`, `LIB_VERSION`, `HAS_OPFS`, `HAS_JSPI`, `HAS_UNSAFE_HANDLES`.
- Produces: `#download` button; `buildExport()` → the object in spec §8; `exportFilename()`.

- [ ] **Step 1: Add the button**

After the `<p><button type="button" id="start">Start</button></p>` line:

```html
    <p><button type="button" id="download" disabled>Download JSON</button></p>
```

- [ ] **Step 2: Build the payload**

Append to the module, after `renderMeasureRow`:

```js
      /**
       * The page's output, in one file. Both halves are here and clearly
       * separated, but only `conformance` is worth citing anywhere: the
       * measurements describe one device on one day.
       *
       * Nothing consumes this automatically. It is not committed and
       * scripts/render-vfs-matrix.ts never reads it — see spec §1.
       */
      const buildExport = () => ({
        generatedAt: new Date().toISOString(),
        lib: LIB_VERSION,
        agent: AGENT,
        features: {
          opfs: HAS_OPFS,
          readwriteUnsafe: HAS_UNSAFE_HANDLES,
          jspi: HAS_JSPI,
        },
        // Iteration counts differ per column by design (calibrateLongQuery), so
        // pool-blocking is uninterpretable without them.
        longQueryIterations: Object.fromEntries(
          Object.entries(RESULTS.measurements).map(([pairId, rows]) => [
            pairId,
            rows.__iterations ?? null,
          ]),
        ),
        conformance: RESULTS.conformance,
        measurements: RESULTS.measurements,
      });

      const pad = (n) => String(n).padStart(2, '0');

      const exportFilename = () => {
        const d = new Date();
        const stamp =
          `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
          `-${pad(d.getHours())}${pad(d.getMinutes())}`;
        const slug = (s) => String(s ?? 'unknown').replace(/[^\w.-]+/g, '-');
        return `browser-sqlite-${slug(AGENT.engine)}-${slug(AGENT.version)}-${slug(LIB_VERSION)}-${stamp}.json`;
      };

      document.getElementById('download').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(buildExport(), null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFilename();
        a.click();
        URL.revokeObjectURL(url);
      });
```

- [ ] **Step 3: Record the calibrated iteration count, and enable the button**

In `calibrateLongQuery` (Task 6), before `return iterations;`, add:

```js
        RESULTS.measurements[ctx.pair.id].__iterations = iterations;
```

In `runPair` (Task 3), immediately after the row loop and before the close, add:

```js
        document.getElementById('download').disabled = false;
```

The button is enabled after the **first** column completes, per spec §8 — a visitor who stops a long run still leaves with what ran.

`__iterations` lives on the same map as the measurement values but is not a row id, and `renderMeasureRow` only ever reads `rows[row.id]` — so it cannot leak into a cell. Confirm that by eye in Step 5: the table must show no extra row, and the export must show the count under `longQueryIterations`.

- [ ] **Step 4: Assert the export in the driver**

In `scripts/bench-check.mjs`, before `if (problems.length)`, add:

```js
  const enabled = await page.$eval('#download', (b) => !b.disabled);
  if (!enabled) fail('download button never enabled');

  const payload = await page.evaluate(() => {
    const parsed = JSON.parse(
      JSON.stringify({
        keys: Object.keys(window.__BENCH__.results),
      }),
    );
    return parsed;
  });
  if (!payload.keys.includes('conformance')) fail('export shape wrong');
```

- [ ] **Step 5: Run, and download by hand once**

```bash
pnpm bench:build && node scripts/bench-check.mjs chromium --all
```

Then open the page manually (`pnpm bench:serve`), run one pair, click **Download JSON**, and check the downloaded file:
- the filename matches `browser-sqlite-chrome-<version>-1.0.0-rc.3-<stamp>.json`;
- it parses;
- `lib` is not `"unknown"`;
- `conformance` and `measurements` are keyed by `"<vfs>/<build>"`;
- `longQueryIterations` carries a number for any pair where `pool-blocking` ran.

- [ ] **Step 6: Format and commit**

```bash
pnpm check
git add bench/index.html scripts/bench-check.mjs
git commit -m "feat(bench): the JSON export

One file, both halves clearly separated, enabled as soon as the first
column completes so a visitor who stops a long run still leaves with what
ran.

It carries the per-column calibrated iteration count, without which
pool-blocking is uninterpretable — the counts differ per column by design.

Nothing consumes this automatically: it is not committed and
render-vfs-matrix.ts never reads it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The Pages workflow

**Files:**
- Create: `.github/workflows/pages.yaml`

**Interfaces:**
- Consumes: `pnpm build`, `scripts/bench-assemble.mjs`.
- Produces: a deployed page at `https://lalexdotcom.github.io/browser-sqlite/`.

**Precondition, already satisfied:** Settings → Pages → Source = **GitHub Actions**, done by the user on 2026-08-24.

- [ ] **Step 1: Read the existing workflow for the setup steps**

Read `.github/workflows/ci.yaml` and copy its checkout / pnpm / Node / install steps verbatim — same action versions, same cache configuration. Do not invent a different setup; drift between two workflows in one repo is a maintenance cost for nothing.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/pages.yaml`:

```yaml
name: pages

# workflow_dispatch is not a convenience here: it is what lets the benchmark
# page be published from a feature branch and opened on a real Safari or iPhone
# before that branch merges. No machine in this project is either of those.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Never two deploys at once; a superseded run is cancelled rather than raced.
concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      # <-- the checkout / pnpm / node / install steps copied from ci.yaml -->

      - name: Build the library
        run: pnpm build

      - name: Assemble the page
        run: node scripts/bench-assemble.mjs _site

      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site

      - id: deployment
        uses: actions/deploy-pages@v4
```

Replace the comment line with the real steps from Step 1.

- [ ] **Step 3: Verify the workflow parses and the artifact is right, locally**

```bash
rm -rf _site && pnpm build && node scripts/bench-assemble.mjs _site
test -f _site/index.html && test -f _site/dist/index.js && test -f _site/dist/worker/worker.js
ls _site/dist/worker/*.wasm
grep -c "__LIB_VERSION__" _site/index.html || echo "substituted (0 occurrences)"
grep -o "new URL(\"./worker/worker.js\", *import.meta.url)" _site/dist/index.js | head -1
```

Expected: all files present, three `.wasm`, **zero** occurrences of `__LIB_VERSION__`, and the literal `new URL` still in `dist/index.js`. That last grep is the guard against anything ever bundling `dist/` — if it comes back empty, stop.

- [ ] **Step 4: Commit and dispatch**

```bash
pnpm check
git add .github/workflows/pages.yaml
git commit -m "ci(pages): publish the benchmark page

on: push to main, and workflow_dispatch — the manual trigger is the point.
It publishes from a feature branch so the page can be opened on a real
Safari or a real iPhone before the branch merges, which is the only
instrument this project has for those engines.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Then **report to the user** that the branch must be pushed and the workflow dispatched manually against `feat/vfs-capabilities`. Do not push without being asked — nothing on this branch has been pushed, by decision (`mem:resume-plan` §0.3).

- [ ] **Step 5: Final whole-page verification**

```bash
pnpm bench:build
node scripts/bench-check.mjs chromium --all
node scripts/bench-check.mjs firefox --all
pnpm check && pnpm exec tsc --noEmit && pnpm test && pnpm test:consumer
```

Expected: both drivers `OK`; `tsc` unchanged (this plan added no TypeScript); `pnpm test` 323/0 (re-run once on a `MIRROR-1` flake); consumer smoke 11/11. Confirm `git status` is clean and `_site/` is untracked.

---

## Self-Review

**Spec coverage.** §2 shape → Task 1. §2.1 one import path → Task 1 Step 2. §2.2 no re-bundling → Task 1 and the grep in Task 9 Step 3. §3 matrix from the library → Task 1 Step 3 and Task 2 Step 3. §4 probes → Task 1 Step 3 (plus a third trivial `HAS_OPFS` probe the spec's banner implies but its §4 does not name). §5.1 UI → Task 2. §5.2 sequential → Task 3 Step 5. §5.3 containment and the two regimes → Task 3 Steps 2 and 5. §5.4 cleanup and shared origin → Task 3 Step 3. §6.1 seven conformance rows → Tasks 3 and 4. §6.2 eight measurements → Tasks 5 and 6. §6.3 shared shapes → Task 5 Step 1 and Task 6 Step 1. §6.4 agent detection → Task 1 Step 3. §7 display → Tasks 3 and 7. §8 export → Task 8. §9 deployment → Task 9. §10 drift → Task 4 Step 7. §11 verification → each task's run steps plus Task 9 Step 5. No gap found.

**Deviation recorded:** the spec says two probes; the plan adds `HAS_OPFS` because `requires: ['opfs']` must be checkable and the banner already promises the flag. It is a detection, not a behaviour change.

**Type consistency.** `poolFor(cap)` takes a capability, not a VFS name — differing deliberately from the conformance helper's `poolFor(vfs)`, and used consistently as `poolFor(pair.cap)`. Row `run` receives `ctx` everywhere after Task 4 Step 2, never a destructured `{ db }` — that migration is an explicit step because it is the one signature change mid-plan. `RESULTS.measurements[pairId]` holds numbers keyed by row id plus the non-row `__iterations`. `better` is `'low' | 'high'` on every measurement row.
