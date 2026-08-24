# Design — the benchmark and conformance page

Date: 2026-08-24
Status: approved in chat, not yet planned
Branch: `feat/vfs-capabilities`, continued — **not** a new branch off `main`, per `mem:resume-plan` §0.3.
Prerequisite: `2026-08-24-vfs-wiring-conformance-design.md`, which exported the capability table
this page reads at runtime.

## 1. Purpose

A single static page, hosted on GitHub Pages, that anyone can open on their own device to answer
two questions this project's CI structurally cannot:

1. **Which VFS actually work here?** No machine in this project is a real Safari or a real iPhone.
   Playwright's WebKit is not Safari and licenses no conclusion about it; on Linux it has no
   `navigator.storage` at all. A human opening a page on a real device is the only instrument that
   exists.
2. **What do they cost here?** The README documents a per-VFS trade — write latency against pool
   non-blocking — whose numbers depend on the engine, and CI runs tests rather than benchmarks.

This is wave 4's dividend and it is why the page is cheap: **the library no longer needs
cross-origin isolation**, so plain GitHub Pages over HTTPS is a sufficient secure context with no
special headers.

### Out of scope

- **Feeding the README.** The exported JSON is downloadable and nothing more. It is not committed,
  not historised, and `scripts/render-vfs-matrix.ts` never reads it. The two-layer
  observed-vs-documented model with per-cell provenance was designed, rejected by the user on
  2026-08-24, and must not be rebuilt. The README's `Browser compatibility` column keeps coming
  from MDN BCD and caniuse alone.
- **Settling the pending VFS decision** (`mem:resume-plan` §0.2 item 1 — `IDBBatchAtomicVFS` vs
  `OPFSAnyContextVFS`). The user's decision on 2026-08-24 is *page first, item 1 later*: the page
  is designed to be readable and useful, not to be that measurement's instrument, and item 1 will
  reuse whatever it can. §6 does put the two rows that price the trade on the page, so in practice
  it should be reusable — but the page's scenarios are not to be bent to that question.
- **A new default VFS**, the two Firefox failures, COOP-1, D6.
- **A CI smoke test for the page itself.** Raised in chat, not requested. The page is a tool, not
  published code, and adding a Playwright job for it buys a guard against deploying a broken page
  at the price of a CI job. If a broken deploy actually happens, revisit; do not pre-empt it.

## 2. Shape — one file

`bench/index.html`. One file: HTML, CSS and a single inline `<script type="module">`. No
TypeScript, no bundler, no framework, no dependency.

That is the user's decision and the reason is portability: the deployed artifact is a file plus
`dist/`, servable by anything, openable from disk, diffable in one place. It is the only untyped
source in a repository that is otherwise strict TypeScript, which is an accepted cost for a tool
that ships to nobody. **Clean, not ornate** — no design system, no build-time templating.

### 2.1 One import path, in local and in production

The page imports the library as `./dist/index.js`. For that path to be true both locally and on
Pages, a small script assembles a serving directory:

```
scripts/bench-assemble.mjs <outDir>   # ~15 lines
  cp bench/index.html <outDir>/index.html   (with __LIB_VERSION__ substituted, §8)
  cp -r dist            <outDir>/dist
```

Local: `pnpm build && node scripts/bench-assemble.mjs _site && node scripts/static-server.mjs _site 8080`.
CI runs the same three commands. `_site/` is gitignored.

The alternative — serving the repo root and importing `../dist/index.js` — needs a different path
in the Pages layout or a redirect stub at the artifact root. The script is fewer moving parts and
makes local and CI byte-identical.

### 2.2 The worker is never re-bundled

`dist/index.js` keeps its literal `new URL('./worker/worker.js', import.meta.url)`, and the three
`.wasm` sit beside `worker.js` under plain names. Copying `dist/` verbatim is exactly the
"no bundler" consumer mode that `scripts/consumer-smoke.mjs` already drives green. **Nothing in
this design may introduce a bundler over `dist/`** — see the two wave-P traps in
`mem:project-state`.

## 3. The matrix comes from the library

The page does not hold a list of VFS. It imports `VFS_CAPABILITIES` from `./dist/index.js` — public
since `2478c81` — and derives from it:

- one checkbox per declared `(vfs, build)` pair;
- the column set;
- `poolSize` per column (§6);
- whether `survives-reopen` applies (`persistent`);
- whether the pair needs a platform feature (`requires`).

Consequence worth stating: **a VFS added to the table tomorrow appears in the page with no edit
here.** This is the one place duplication was avoidable, and it is avoided.

`DEFAULT_VFS` is not exported from the package entry; the page therefore marks no default. Do not
add an export just for this.

## 4. Two feature probes, at load

- **JSPI** — `typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function'`.
- **`readwrite-unsafe`** — open two `createSyncAccessHandle({ mode: 'readwrite-unsafe' })` on the
  same file inside an inline blob worker and report whether the second succeeds. Feature-detected
  by *behaviour*, because Firefox accepts the option and ignores it.

Both are ported from `tests/conformance/helpers.ts`. They gate checkboxes rather than producing
failures: a `jspi` pair on a browser without JSPI, or `OPFSWriteAheadVFS` without
`readwrite-unsafe`, is disabled with the reason in its `title`.

`requires` drives this, never a hardcoded VFS name: `OPFSWriteAheadVFS` is disabled because it
declares `requires: ['readwrite-unsafe']`, while `OPFSAdaptiveVFS` — which only
`degradesWithout` it — stays enabled and is expected to run in reduced mode. Marking Adaptive
broken on Firefox would be false: it passes 102 of 104 browser tests there.

## 5. Run model and containment

### 5.1 UI

A collapsed `<details>`; its `summary` reads `All` or `3 selected — OPFSAdaptiveVFS/async, …`.
Its body holds the checkboxes plus **All** / **None** buttons. Below it, **Start**, which becomes
**Stop** while a run is in flight.

Results are one table: rows fixed in their final order from the start, **columns appended as each
pair begins**, cells moving from `…` to their result as they land. Header banner: detected engine
and version, `opfs` / `readwrite-unsafe` / `jspi`, library version, date.

### 5.2 Strictly sequential

One pair at a time, and within a pair one row at a time. Two VFS running concurrently would
contend for OPFS and invalidate every number on the page. This is not a simplification, it is a
correctness requirement for the measurement half.

### 5.3 Containment — the part that is not optional

**HANDLE-1 can block a pool for the full duration of an uninterruptible statement, and there is no
remedy in our code.** On Firefox and Safari a badly chosen pair can therefore hang indefinitely. So:

- every row runs under a 30 s bound;
- the column's `close()` is bounded too;
- a row that expires renders `⏱`;
- `opens` failing short-circuits the rest of that column — every later row would fail for the same
  reason and would say nothing new.

**Two kinds of bound, and conflating them would corrupt the page's own numbers.**
`read` / `write` / `first` / `stream` / `chunk` take a `signal` (`SQLiteQueryOptions`), so
`AbortSignal.timeout(30_000)` genuinely reaches the drain: the work stops, the worker is released,
and the run continues with the **next row** in the same column.

**`bulkWrite` and `output` take no `signal`** — `src/bulk.ts` has no `AbortSignal` at all. For
those rows the only available bound is a `Promise.race` against a timer, which abandons the *wait*
without stopping the *work*: the worker stays busy, and every subsequent row in that column would
be timed against a machine still executing the abandoned insert. So a timeout on a non-abortable
row **abandons the whole column** — remaining rows render `⏱`, `close()` is attempted under its own
bound, storage is cleaned, and the run moves to the next pair.

Which rows are abortable is read from the method being called, not guessed per row. **This is
tracked as ABORT-1 in `mem:follow-ups`** — when `bulkWrite` and `output` gain a `signal`, that row
changes category and nothing else on the page does.

**Storage is cleaned per column.** Each pair opens a uniquely named database and removes it
afterwards: `navigator.storage.getDirectory().removeEntry(name, { recursive: true })` for OPFS,
`indexedDB.deleteDatabase(name)` for the IndexedDB VFS. Without this a phone fills up silently
across a few runs.

## 6. The rows

### 6.1 Conformance — seven, pass/fail

Row ids are **word for word** the `describe()` titles of `tests/conformance/invariants.test.ts`,
plus `opens` from `builds.test.ts`:

| id | property |
|---|---|
| `opens` | the pair opens and serves a query |
| `write-read-back` | what is written is read back |
| `survives-reopen` | data survives close and reopen |
| `concurrent-writes-lose-nothing` | concurrent writes lose nothing |
| `rollback-leaves-nothing` | a rolled-back transaction leaves nothing |
| `close-settles` | close settles |
| `no-read-inside-transaction` | no read runs inside an open transaction |

`survives-reopen` is skipped where `persistent: false` — read from the table, not hardcoded.

### 6.2 Measurements — eight

`poolSize = min(4, maxPoolSize ?? 4)`. A shared dataset of 10 000 indexed rows is built once per
column. Every measurement gets one uncounted warmup pass.

| id | what it shows |
|---|---|
| `bulk-insert-10k` | bulk write throughput (ms, rows/s) via `bulkWrite` |
| `write-latency-p50/p95` | 100 single `INSERT`s — the write latency the pending VFS decision must price |
| `point-read-p50` | 200 `first()` on the primary key — "render one record" |
| `list-page-p50` | 100 × `ORDER BY … LIMIT 50 OFFSET n` — "render one page of a list" |
| `read-burst-concurrency` | 24 short reads via `Promise.all` ÷ the same 24 in series — **ratio; this is the row that shows read concurrency** |
| `full-scan` | aggregate over the 10 000 rows |
| `transaction-throughput` | 500 inserts inside one `transaction()` — the gap against `write-latency` is the most useful thing a developer learns here |
| `pool-blocking` | a short read's latency during an unawaited long CPU-bound query ÷ its latency idle. ≈1 = the pool is free, ≫1 = HANDLE-1 |

`pool-blocking` matters beyond curiosity: **it is the one claim in the README's reduced-mode
section that the test suite does not prove**, because proving it means timing something.

### 6.3 The three shapes the rows share

Fixing these once removes the ambiguity from the table above and stops each row inventing its own.

- **A "short read"** — used by `point-read-p50`, `list-page-p50` and `read-burst-concurrency` — is
  `first('SELECT … FROM bench WHERE id = ?')` on the primary key. Small enough that its cost is
  round-trip and scheduling, not SQLite.
- **The long CPU-bound query** in `pool-blocking` is `longQuery(n)` from
  `tests/browser/helpers.ts` — `WITH RECURSIVE c(x) AS (…) SELECT count(*) FROM c` — which spends
  everything inside a single uninterruptible `step()` before any row exists. That property is what
  makes it the right instrument: a worker inside it never returns to its event loop, which is
  precisely HANDLE-1's mechanism. `n` is **calibrated at run time**, not fixed: the page steps `n`
  up from 1e6 until one run takes 1.5–3 s on this device, then reuses that `n` for every column.
  A constant would be meaningless across a laptop and a phone, and the repository already knows
  Firefox is ~5.5× slower than Chromium on this exact query.
- **Every timing is `performance.now()` around the awaited call**, and every `p50`/`p95` is an
  order statistic over the raw samples, never a mean. Means hide exactly the tail these VFS differ
  in.

### 6.4 Engine and version

Detected by user-agent string parsing, ~15 lines: Firefox, Edge, Chrome/Chromium, Safari, in that
order of testing, plus `navigator.platform`. It feeds the header banner and the export filename
only — **no behaviour anywhere on the page branches on it**, which is why a crude parser is
acceptable here and would not be anywhere else. Feature decisions go through §4's probes.

On a `poolSize: 1` VFS, `read-burst-concurrency` lands near 1 and `pool-blocking` well above it.
That is the declared behaviour, not a failure, and the display must say so rather than colour it
red.

## 7. Display

Conformance cells: `✅` / `❌` with the error message in `title` / `⏱` / `⃠` not applicable.

Measurement cells: value and unit, plus a bar relative to the best column on that row, so a reader
sees who wins without arithmetic. Column heading: `<vfs> · <build>`, with the effective `poolSize`
as a subtitle.

## 8. Export

A **Download JSON** button, enabled as soon as the first column completes.

Filename: `browser-sqlite-<engine>-<version>-<lib>-<YYYYMMDD-HHmm>.json`, e.g.
`browser-sqlite-safari-18.3-1.0.0-rc.3-20260824-1712.json`.

```jsonc
{
  "generatedAt": "2026-08-24T17:12:00.000Z",
  "lib": "1.0.0-rc.3",
  "agent": { "engine": "safari", "version": "18.3", "platform": "iPhone", "ua": "…" },
  "features": { "opfs": true, "readwriteUnsafe": false, "jspi": false },
  "conformance":  { "OPFSAdaptiveVFS/async": { "opens": "pass", "write-read-back": "pass" } },
  "measurements": { "OPFSAdaptiveVFS/async": { "bulk-insert-10k": 812.4 } }
}
```

Values are `"pass" | "fail" | "timeout" | "skipped"` and `number | null`. Both halves are in one
file, clearly separated; only the conformance half is ever worth citing.

**The library version is not exported by the package.** `bench-assemble.mjs` substitutes
`__LIB_VERSION__` in the HTML from `package.json`, and the page falls back to `"unknown"` when the
placeholder survives — which is what happens if someone opens `bench/index.html` straight from the
repo.

## 9. Deployment

`.github/workflows/pages.yaml`:

- `on: push: branches: [main]` **and** `workflow_dispatch`. The manual trigger is the point: it
  publishes from `feat/vfs-capabilities` without merging, which `mem:resume-plan` §0.3 forbids, and
  a real-Safari run is the whole reason the page exists.
- Job: checkout → pnpm + Node → `pnpm install` → `pnpm build` → `node scripts/bench-assemble.mjs _site`
  → `actions/upload-pages-artifact` → `actions/deploy-pages`.
- `permissions: { pages: write, id-token: write, contents: read }`, `concurrency: { group: pages }`.
- Independent of `ci.yaml`; it gates nothing and nothing gates it.

Settings → Pages → Source = GitHub Actions: **done by the user on 2026-08-24.**

## 10. Drift

The page re-implements the six invariants and the two probes. That duplication is deliberate
(§2 — a self-contained file cannot import `tests/conformance/*.ts`, which import `src/`), bounded,
and describes properties of SQLite rather than of our implementation, so it is expected to be
static.

It is still duplication, in a repository whose own lesson is that *"comments drift faster than
code"*. Mitigations, both required:

1. Row ids are the conformance `describe()` titles verbatim, so a divergence is visible by name.
2. **A `BENCH-DRIFT` entry in `mem:follow-ups`**: changing `tests/conformance/invariants.test.ts`
   or `tests/conformance/helpers.ts` obliges a review of `bench/index.html`, and the reverse.

## 11. Verification

There is no test suite for the page — see §1, out of scope. What is checked before it is called
done:

- `pnpm build && node scripts/bench-assemble.mjs _site && node scripts/static-server.mjs _site 8080`,
  then a full run in Chromium and in Firefox, both installed in the devcontainer.
- Chromium: every declared pair selected; every column completes or is contained; no unhandled
  rejection in the console; OPFS empty afterwards.
- Firefox: `OPFSAdaptiveVFS` runs in reduced mode and `pool-blocking` lands well above 1, which is
  the observation the README asserts and nothing yet demonstrates.
- The exported JSON parses and its keys match §8.
- `biome check --write` over `bench/` and `scripts/`; `tsc --noEmit` unaffected (no TypeScript
  added).
- `pnpm test` and `pnpm test:consumer` unchanged — this design touches no `src/` file.

## 12. Sequencing

1. `scripts/bench-assemble.mjs` and the `_site` gitignore entry.
2. `bench/index.html` — shell, capability-driven checkboxes, probes, empty table.
3. The seven conformance rows.
4. The eight measurement rows.
5. Display polish: relative bars, containment states, header banner.
6. Export.
7. `.github/workflows/pages.yaml`.
8. The `BENCH-DRIFT` memory entry.

Steps 3 and 4 are the substance; 1, 2, 7 and 8 are small and independent.
