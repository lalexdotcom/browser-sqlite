# Design — wiring the remaining VFS, and a conformance suite

Date: 2026-08-24
Status: approved in chat, not yet planned
Supersedes nothing. Prerequisite for the benchmark page, which is a separate project.

## 1. Purpose

Wire the four VFS the library ships in `node_modules` but does not expose, declare what every
VFS can and cannot do in one compiler-checked table, prove those declarations with a conformance
suite, and generate the README's VFS table from the same table so it cannot drift.

**Memory footprint is one axis of the choice, not the choice.** The library was started to stop
loading large data structures into RAM, and consumers plausibly arrive for that reason, so
footprint has to be visible per VFS where today it is invisible. But it vetoes nothing on its own:
a VFS that is frugal and slow is as useless as one that is fast and enormous. The design goal is a
balance across several axes — footprint, throughput and latency, whether the pool actually runs
concurrently, durability, browser compatibility — and **the table's job is to expose every cursor
so a consumer can weigh them, not to rank VFS for them.** See §3.1.

### Out of scope

- **The benchmark page.** It is a separate project with its own spec. This one only makes the page
  possible, by exporting the capability table (§6) so the page reads the VFS list at runtime
  instead of holding a copy.
- **The README's recommendation prose.** It rests on measurements the page produces and the user
  runs; it cannot be written before the page exists. See §5.3.
- **Choosing a new default VFS.** The user has stated the goal — the default must be usable
  concurrently on every browser, even at a performance cost — but the decision waits for the
  measurement campaign.
- **The two Firefox test failures** (HANDLE-1 and the `messageerror` timing) and COOP-1.

## 2. What gets wired

Four entries in `VFSConfigs` (`src/worker/worker.ts`), same shape as the five existing ones — a
dynamic `import()` with its own `webpackChunkName` — and four entries in the capability table
(`src/types.ts`). The public `SQLiteVFS` type derives from the table's keys, so it gains its four
members with no further edit, and a VFS without a loader or a build without a module fails to
compile.

### 2.1 Declared builds — executed, never trusted

| VFS | declared builds | source of the claim |
|---|---|---|
| `IDBMirrorVFS` | `async`, `jspi` | **inferred from the source** — `jOpen` / `jLock` / `jClose` are async while `jRead` / `jWrite` are not. Absent from upstream's comparison table. |
| `OPFSAnyContextVFS` | `async`, `jspi` | upstream table |
| `MemoryVFS` | `sync`, `async`, `jspi` | upstream table |
| `MemoryAsyncVFS` | `async`, `jspi` | upstream table |

Nine new combinations, on top of the thirteen already verified. The convention established on
`feat/vfs-default` holds: every declared combination is run against the pinned wa-sqlite v1.1.2
rather than copied from a table. **`IDBMirrorVFS` is the row to watch** — it is the only one whose
builds come from reading the code rather than from upstream.

### 2.2 Why these four

- **`IDBMirrorVFS`** and **`OPFSAnyContextVFS`** are the only VFS that escape HANDLE-1
  structurally, because neither holds a synchronous OPFS access handle. They are therefore the only
  candidates for a browser without `readwrite-unsafe`. See `mem:follow-ups`.
- **`MemoryVFS`** and **`MemoryAsyncVFS`** are not product options — memory is *per worker*, so a
  pool would hold independent, silently diverging databases. They are wired for measurement: the
  first is the storage floor that makes every other number interpretable, and the pair
  `MemoryVFS` (sync) / `MemoryAsyncVFS` (async) prices the Asyncify bridge in isolation at
  identical storage, which is the missing piece for explaining Firefox's measured 5.5× penalty.

`OPFSPermutedVFS` is not wired and must not be: removed deliberately on `feat/vfs-default`, both
deprecated upstream and measured at 24 % stale cross-connection reads.

### 2.3 Cost, measured

Wiring costs bytes for every consumer: the shipped worker is monolithic (W-chunks, `wontfix` —
Rollup refuses code-splitting for the IIFE worker output Vite produces), so every wired VFS is
downloaded whether or not it is selected. Source sizes gzipped: `IDBMirrorVFS` 6808,
`OPFSAnyContextVFS` 1899, `MemoryVFS` 1321, `MemoryAsyncVFS` 639 — 10 667 total against a
123 652-byte worker, roughly **+9 %**.

The corollary decided the public surface: **exposing an already-wired VFS costs nothing extra.**
There is no "wire it but keep it private" middle ground that saves bytes, so the choice is purely
one of support commitment. All eight are public.

## 3. The capability table

`VFS_BUILDS` is renamed **`VFS_CAPABILITIES`** and its entries become objects. The rename happens
because the table stops being about builds alone, and it happens *before* the table is exported
(§6) so the first published shape is the final one.

```ts
export const VFS_CAPABILITIES = {
  IDBMirrorVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,        // null = unbounded
    multiConnection: true,
    persistent: true,
    memoryModel: 'whole-database',
  },
  MemoryVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
  },
  // …
} as const satisfies Record<string, VFSCapability>;
```

`SQLiteVFS` still derives from the keys. `defaultBuildFor` reads `.builds[0]`.

**One table, no second source.** The conformance suite reads it to decide which scenarios apply,
the README generator renders it, the guards enforce it, and the benchmark page enumerates it at
runtime. Nothing may hold a copy.

### 3.1 `memoryModel` is one cursor among several, and every VFS must show it

Footprint is a field rather than prose because it is currently the one axis a consumer cannot see
at all: builds, concurrency and persistence are at least discoverable, memory behaviour is not. It
takes its place beside the other axes, with no more weight than they have. Two values:

- `page-cache` — only SQLite's page cache lives in RAM, bounded and tunable via
  `PRAGMA cache_size`. All OPFS VFS, and `IDBBatchAtomicVFS` with the caveat that upstream requires
  its cache be large enough to hold the journal.
- `whole-database` — the entire database is resident. `IDBMirrorVFS`, `MemoryVFS`,
  `MemoryAsyncVFS`.

**`IDBMirrorVFS` is the case this field exists for, and it is a trade rather than a verdict.** It
is upstream's fastest option with and without contention, and it escapes HANDLE-1 — two axes where
it wins outright — against a footprint proportional to database size × `poolSize`, on an axis
where it loses outright. Which way that balance falls is exactly what the measurement campaign has
to settle, and **this spec does not pre-empt it.** Whatever the outcome, the field must exist, so
that the trade is visible instead of implicit.

Cross-cutting and equally undocumented today: **`poolSize` multiplies the footprint whatever the
VFS**, since every worker holds its own page cache. Default is 2.

### 3.2 Guards read the table

The current guard is a hardcoded special case:

```ts
if (vfs === 'AccessHandlePoolVFS' && poolSize > 1) throw new Error(…)
```

It becomes a table lookup on `maxPoolSize`, which removes the special case and covers the two
memory VFS at the same time.

**The error type is unified.** That guard throws a bare `Error` today while the build guard
immediately above it throws `SQLiteError('INVALID_OPTION')`, so a caller discriminating on `code`
cannot catch the first. Adding a second `poolSize` guard while keeping two error types would make
the surface worse. All option guards throw `SQLiteError('INVALID_OPTION')`. This is a breaking
change to an error type, free at rc.

The memory VFS message states the real reason, which is not volatility: memory is per worker, so a
pool holds independent databases that diverge silently. That is corruption, not data loss on close.

## 4. The conformance suite

A **separate rstest project**, `conformance`, excluded from `pnpm test`. Run by
`pnpm test:conformance`, and in CI as a step distinct from `verify`, on Chromium and Firefox.

It is separate because eight VFS through a scenario list each start workers and open real storage.
`pnpm test` must stay at its current ~8 s; the estimated 20-40 s of conformance does not belong
in the loop a developer runs on every change.

### 4.1 One tier here, because of where the line falls

The line is **property of the code** versus **property of the machine**. Properties of the code
are tested; properties of the machine are measured by whoever owns the machine.

**The conformance suite therefore holds invariants only.** An earlier draft gave it a second,
measuring tier. That tier does not belong here: CI runs tests and not benchmarks, and nothing
numeric is published, so a measurement tier in this suite would run nowhere and rot. Every
measurement moved to the benchmark page's project, where it runs on demand for the person who
opened it.

**The invariants fail the build.** Every VFS, every browser, no per-browser exemptions. Six:

1. What is written is read back on the same client.
2. Data survives `close()` and reopening. *Skipped for `persistent: false`.*
3. Concurrent writes lose nothing: exact count, no corruption. *Requires `maxPoolSize > 1`.*
4. A rolled-back transaction leaves nothing behind.
5. `close()` settles in bounded time.
6. No read executes inside an open transaction — B1, the founding invariant. A VFS whose locking
   were broken would show here. *Requires `maxPoolSize > 1`.*

A scenario skipped by capability is **recorded as skipped with its reason**, never silently
absent.

### 4.2 The one claim tests cannot prove

"The pool blocks under a long uninterruptible statement on a browser without `readwrite-unsafe`"
is a consequence of the VFS model — one exclusive handle, rotated — and blocking is inherently
temporal, so verifying it means timing something. Since CI does not time anything, this claim is
**written by hand and marked as the single assertion in the VFS section that the suite does not
prove**, so it is re-read when the model changes. Its evidence is HANDLE-1 in `mem:follow-ups`.

## 5. The README's VFS table

### 5.1 Generated from the capability table, by a pure script

`scripts/render-vfs-matrix.mjs` reads `VFS_CAPABILITIES` and rewrites a delimited block in
`README.md`. **No browser runs.** CI regenerates and `git diff --exit-code`: the table cannot drift
from the declarations.

It carries capabilities, builds, memory model, and `poolSize` limits. **It carries no timings**, by
the user's decision: benchmarks measured on one machine promise a performance the library does not
control, and readers are reliably disappointed by libraries that publish them.

### 5.2 Declarations are proven by the suite, not by an artifact

A VFS declared `multiConnection: true` that fails invariant 3 or 6 turns CI red. A false
declaration does not survive. This is the same anti-drift guarantee an earlier draft sought through
a committed results artifact with provenance and dates, obtained instead through tests — which is
both simpler and stronger, and removes the artifact entirely.

**Browser compatibility is proven the same way**, since the suite runs per browser: a VFS that
cannot open on Firefox is red there. For browsers nobody runs — Safari, Android — the table says
**"not measured"**, never "presumed compatible". The user has no Android device, so that row stays
unmeasured until someone with one opens the page.

### 5.3 The recommendation prose comes later, and states models rather than numbers

Deferred to after the benchmark page exists and the user has run a campaign. Two rules govern it:

**Measurements validate the model; the README states the model.** A performance number is true on
one machine on one day. A structural property is true as long as the code is what it is, and any
reader can re-check it by reading the VFS.

- Not: "`IDBMirrorVFS` is 3× faster."
- But: "`IDBMirrorVFS` keeps the whole database in RAM in every worker — the fastest option, at a
  footprint proportional to database size × `poolSize`."

**The campaign is dated.** A note records when the model was validated by measurement and on which
browsers, so a future reader knows when re-validation is due. The campaign being one-shot is
exactly why the prose must not rest on its numbers.

## 6. The capability table becomes public

`VFS_CAPABILITIES`, `SQLiteVFS`, `SQLiteBuild` and `defaultBuildFor` are exported from `index.ts`.

Today none of them is reachable: `index.ts` re-exports only `client` and `errors`, and
`dist/index.d.ts` does not mention them — so a consumer must pass a `vfs` value whose type it
cannot name. That is the open half of W-types.

Three consequences, all wanted:

- **The benchmark page enumerates VFS at runtime from the library**, instead of holding a list that
  would drift. Adding a VFS makes it appear in the page with no edit there.
- **The page becomes an ordinary consumer of the public API** — no deep imports, no private
  coupling — so it builds like the `consumer-smoke` apps in their no-bundler mode.
- **The README generator, the page and the runtime read the same table.**

Exporting a value makes its shape a compatibility commitment, which is why §3's rename and reshape
land first.

## 7. Verification

- **The nine new build combinations are executed.** `tests/browser/vfs.test.ts` already has a test
  that takes one declared combination and asserts it opens and serves a query; it is generalised
  into a loop over the whole table. Declaring a combination that does not work becomes red. rstest
  0.11.8 has no `it.each` — use a plain `for` loop calling `it()`, the pattern in
  `tests/unit/routing.test.ts`.
- **Falsifiability is declared per test and verified by hand** — delete the line, watch it go red,
  restore it. This project has paid twice for the difference between claiming falsifiability and
  executing it.
- **Guards**: one test per VFS with `maxPoolSize: 1` asserting `SQLiteError('INVALID_OPTION')`,
  including `AccessHandlePoolVFS`, which covers the error-type unification.
- **The README generator** is verified by the CI diff.
- **Time budget**: `pnpm test` must stay at ~8 s. Measured before and after, not assumed.
- **Before merge**, verified **on `main` after merging, not only on the branch**: `pnpm check`,
  `tsc --noEmit`, the full suite, conformance on Chromium and Firefox, and consumer smoke 11/11.

## 8. Sequencing

1. Reshape and rename the capability table; move the guards onto it; unify the error type.
2. Wire the four VFS; run all twenty-two build combinations; fix the declarations reality
   contradicts.
3. Export the table and its types.
4. Build the conformance project and its six invariants with capability gating.
5. Generate the README table; wire the CI diff.
6. Verify per §7.

The benchmark page follows as its own spec, then the user's measurement campaign, then the
recommendation prose.
