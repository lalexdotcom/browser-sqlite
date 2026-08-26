# Follow-ups — the open backlog

One short entry each. Anything closed is deleted from here — `CHANGELOG.md` and `git log`
record what was fixed. Evidence and numbers live in `mem:measurements`; VFS behaviour in
`mem:vfs`.

> **Triage proposed 2026-08-26, awaiting the user's decision.** The "verdict" column is a
> recommendation, not a decision. Nothing has been deleted on the strength of it. What *has*
> been done is verification: four items were found already fixed and unmarked, and are
> annotated as such.
>
> Since then `feat/tx-query-surface` shipped and moved two entries on its own account —
> `W-types` is nearly closed, `ABORT-1` is narrowed. Both are marked below.

## Designs owed — each needs its own brainstorming, none started

### ABORT-1 — `bulkWrite` and `output` take no `signal`

`signal` is on `SQLiteQueryOptions` and honoured by `read`/`write`/`first`/`stream`/
`chunk`. **`src/bulk.ts` contains no `AbortSignal` at all.** So the two long-running
methods in the public surface, the ones most likely to need cancelling, are the two that
cannot be. That it stops at `bulkWrite` is undocumented.

Cheaper than it looks for `bulkWrite`: it already calls the **public** `write` once per
batch and releases the worker between batches, so threading a `signal` down gives an abort
that lands *between* batches — the natural granularity, and the only point where stopping
is meaningful, since a multi-row INSERT is statement-atomic.

**`output()`'s semantics are decided (user, 2026-08-24): an abort drops the staging table
and touches nothing else.** No rename, no partial publication, previous target untouched —
which the wave-3 change already gives for free. An aborted `output()` is observationally a
no-op. Two mechanical consequences: the eager `DROP` is a write and needs a worker *after*
the abort freed one, so it is **best-effort** and must not hang or throw on failure (the
fallback is an orphan staging table, which `staleStagingTables` already sweeps); and
releasing the staging lock is what arms that sweep, so it must happen **after** the `DROP`
attempt.

First observed consumer of the gap: the benchmark page's containment design. Because
`bulkWrite` cannot be aborted, its only bound is a `Promise.race` against a timer, which
abandons the *wait* without stopping the *work* — so the page has to abandon a whole column
on that one row. When ABORT-1 lands, that special case disappears.

**Narrowed 2026-08-26 by `feat/tx-query-surface`.** A caller who needs a bulk load to stop
cleanly now has one answer that did not exist before: run it inside `transaction()`, where
abandoning means rolling back. That does not close ABORT-1 — there is still no `signal` on
either method, and the non-transactional path still has no bound — but it removes the case
where the *only* remedy was to chunk your own batches by hand.

Not blocking: no consumer on rc.3. **Verdict: keep.**

### DELETE-1 — there is no way to delete a database

No `deleteDatabase`, and a consumer has no supported way to remove one. Every persistent
VFS wa-sqlite ships implements `jDelete`, and for `AccessHandlePoolVFS` it is the **only**
correct removal — `#deletePath` un-associates the SQLite path and returns the slot to the
pool, deliberately leaving the OPFS file in place because that file *is* a reusable slot.
The library never exposes it: the worker holds the VFS instance and nothing routes to it.

The JSDoc half is **done** — `client.ts`'s `close()` no longer tells consumers to use
`navigator.storage.getDirectory()` directly, advice that was correct only for the plain
OPFS VFS on an already-closed database, left `-journal`/`-wal` behind even there, silently
cost `AccessHandlePoolVFS` its capacity, and was a no-op for the two IndexedDB VFS.

What a `deleteDatabase(file)` owes: route to the open VFS's `jDelete`, so it needs a worker
with that VFS loaded; decide what happens when the database is open in another tab, where
nothing here can revoke a handle; decide what it returns when the database does not exist
(SQLite's `xDelete` is content with that); and decide whether it removes auxiliary files,
which differ per VFS.

**It must delete IndexedDB databases too, not only OPFS entries (user, 2026-08-25).**
`IDBBatchAtomicVFS` and `IDBMirrorVFS` keep their data in an IndexedDB database named after
the VFS class, holding **every** database opened with that VFS on the origin — so `jDelete`
alone frees the SQLite file inside the store while the store itself stays, and
`indexedDB.deleteDatabase(<VFS name>)` would destroy every other consumer's data on the
same origin. Neither is the answer on its own. **That asymmetry between the OPFS and
IndexedDB families is the part that actually needs thought.** **Verdict: keep, and merge
RESIDUE-1 into it.**

### RESIDUE-1 — two VFS store under their class name, and cleanup never sees it

Same root fact as DELETE-1, from the cleanup side: a VFS stores where it likes, and only
the VFS knows where. `AccessHandlePoolVFS` keeps one OPFS directory named after the class
holding six pre-allocated files with random names; `IDBMirrorVFS` keeps one IndexedDB
database named `IDBMirrorVFS`, and **there is no equivalent of the OPFS root diff on the
IndexedDB side at all**.

**What it cost:** after several interrupted local runs, five of six `AccessHandlePoolVFS`
slots held orphaned databases. A database in `journal_mode=DELETE` needs two slots, so the
VFS failed at `opens` with a bare `sqlite3_open_v2` and no message, on both `sync` and
`async`. It read as a regression from a wa-sqlite patch committed minutes earlier; it was
residue. Deleting the directory by hand restored it with no code change. Corroborated on an
iOS device where `/sync` went 5/7 → 0/7 between two runs while `/async` was already at 0/7:
**the failure migrates from build to build as the pool fills**, which is the signature
six-slot exhaustion predicts and no engine defect does.

Two earlier isolated `opens` failures — `AccessHandlePoolVFS/async` on iOS 26 and
`/jspi` on macOS Chromium 150 — are **very likely the same exhaustion**, not engine
defects. Re-run on a swept root before recording either as real.

Fixes in rising order of cost: run `cleanupOpfsResidue` per *column* rather than once per
run; give IndexedDB the same before/after diff the OPFS root gets; or have each VFS declare
the storage names it owns — the only version that does not rely on diffing. **Verdict: keep,
fold into DELETE-1's design.**

### D6 — the `browser-sqlite/vite` plugin subpath

Designed 2026-08-18, approved, never built. Ship a `browser-sqlite/vite` export returning a
Vite plugin that does both corrections itself: push `optimizeDeps.exclude`, and copy
`dist/worker/*` using the **resolved** `build.assetsDir` rather than a literal
`dist/assets`. Consumer config collapses to `plugins: [browserSqlite()]`.
Zero-runtime-dependency is preserved — a Vite plugin is a plain object, so `vite` stays a
devDependency for types only. Coverage is free: consumer smoke mode 2 already exercises the
path, the fixture just switches to the shipped plugin.

The documented snippet must die with it: it hard-codes `dist/assets` (wrong the moment a
consumer sets `build.assetsDir`) and `node_modules/browser-sqlite/dist/worker` (wrong in a
pnpm workspace). Resolve the package via `import.meta.resolve`. If the plugin slips, fix
the snippet in place — it is wrong as written either way.

Also approved and unbuilt: **`wasmUrl`, optional** — an explicit base URL for the three
`.wasm`. When omitted, behaviour is **exactly today's** resolution; this is an escape
hatch, not a new default, and the default config must not change by a single byte.

Rejected: inlining the `.wasm` as base64 (+33 % on 2.4 MB raw, gives up streaming
compilation — acceptable only as an opt-in subpath, never the default); and waiting for
Vite (the `import.meta.url` rewrite during esbuild pre-bundling is intended behaviour, not
a bug in flight). **Verdict: user to decide — in scope for 1.0 or dropped.**

## Limits to document rather than fix

### HANDLE-1 — a long statement serializes the pool off Chromium

Root cause established 2026-08-24; **no remedy exists at our layer**. Full account in
`mem:vfs`. The public consequence: *"does not block the pool"* is false off Chromium.
Concurrent reads hold on Firefox only while no worker is running a long uninterruptible
statement.

`tests/browser/long-query.test.ts :: does not terminate the worker it abandoned, and does
not block the pool` fails on Firefox at 28-29.5 s against a 3 s budget. The scheduler, the
lease and `quiesce()` were each checked and exonerated — statuses sampled without wrapping
`Worker`, so the race was not perturbed.

**Verdict: treat = write it into Known Limitations (today only `OPFSCoopSyncVFS` has an
entry covering this shape), then delete this item.**

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single
writer". Partly settled: `output()` **must** be multi-tab safe (user requirement) and its
staging sweep is `navigator.locks`-guarded. The rest of the client stays uncoordinated.
**Verdict: treat = one line in Known Limitations saying so, before 1.0.**

### `readwrite-unsafe` has no guard

`OPFSWriteAheadVFS` declares `requires: ['opfs', 'readwrite-unsafe']`, but that feature is
in `UNPROBEABLE` — detecting it needs a worker and two access handles, and the client guard
is synchronous. So the VFS keeps its obscure off-Chromium failure and the README entry is
the only defence. **Verdict: user to decide — accept and delete, or design an async probe.**

### VIT-1 — Vite requires consumer configuration

Two independent reasons, both documented in the README's Bundler Configuration: esbuild
pre-bundling rewrites `import.meta.url` in `node_modules` during dev (fix:
`optimizeDeps.exclude`), and Vite's prod build does not copy `node_modules` wasm beside the
emitted worker (fix: a ~10-line plugin). rsbuild and no-bundler modes need nothing. Not a
defect in the artefact. **Verdict: delete — it is D6's motivation, and D6 carries it.**

## Evidence owed

### FLAKE-ROW-1 — `no-read-inside-transaction` is a race, not a verdict

The bench row flips between `pass` and `blocked` on the same VFS, engine and build between
runs an hour apart — and **in both directions within a single pair of runs**. Four WebKit
runs, 2026-08-25.

**The honest reading is that `blocked` is the expected state and `pass` is the lucky one.**
In reduced mode a VFS rotates one exclusive handle; whether a read is admitted before the
write transaction takes it is timing, not a property. `OPFSAdaptiveVFS`'s read-burst of
0.94–1.00× on every engine without `readwrite-unsafe` says the same from the other side.

**Consequence: no single run may be cited for this row.** The `OPFSCoopSyncVFS` Known
Limitations entry rests on it and currently reads as a determinism. It happens to be right
(blocked on 8 of 8 earlier runs) but needs **n≥3 per engine** before that wording is
defensible — and the same row cannot then be read as a verdict for `OPFSAdaptiveVFS`.
**Verdict: keep.**

### Two Firefox failures block wiring Firefox into CI

A browser cannot be a blocking gate while it is red.

- `long-query :: does not terminate the worker it abandoned` — this is HANDLE-1. Not a test
  defect; it needs a per-browser expectation.
- `lifecycle :: rejects the in-flight query on a deserialization failure` — times out at
  30 s. **Nobody has traced it.** Leading explanation is calibration: the test sleeps 100 ms
  then synthetically dispatches `messageerror`, betting the query is already in flight, and
  Firefox is 5.5× slower on the same CPU-bound query. Unverified. **Verdict: keep.**

### COOP-1's adversarial test — if COOP-1 survives at all

The symptom (`database is locked` in ~100 ms on interleaved DDL with four concurrent
readers) never reproduced under the suite, which defaults to `poolSize: 2` and never plays
that shape — so **the suite is not the instrument**. Its subject is largely absorbed by
HANDLE-1, and the mechanism analysis reads CoopSync's `SQLITE_BUSY` as a transfer protocol
we fail to retry.

A distinct defect recorded here because nowhere else fits: forced onto CoopSync, Chromium
fails `lifecycle :: restarts the slot once and keeps serving` with `sqlite3_open_v2` — the
replacement worker cannot reopen the database after a crash, consistent with the dead
worker's exclusive handle not yet being released.

**Already done and unmarked:** the README half. `OPFSCoopSyncVFS` now has a Known
Limitations entry, and it is considerably harder than the one this item asked for.
**Verdict: delete unless the decision is to remove CoopSync from the public surface, which
the niche analysis in `mem:vfs` argues for.**

### BENCH-DRIFT — the page holds a second copy of the invariants

**Halved 2026-08-26.** The probe half is closed: the page imports `detectFeatures` and
`missingFeature` from the package instead of deriving them. `HAS_UNSAFE_HANDLES` stays,
because it needs a worker and two access handles and has no synchronous equivalent.

**Permanent by design:** the six conformance invariants, ~220 lines on each side.
`dist/index.js` is the page's only import channel, so sharing them would ship conformance
assertions to every consumer.

**The rule: changing either copy obliges a review of the other, both directions.** What
makes a divergence visible rather than silent is that the page's row ids are normalized
from the conformance `describe()` titles — a row whose id no longer maps to a `describe()`
is the signal. Two places where the copies legitimately differ and must **not** be aligned:
the page returns `'blocked'` where invariant 6 logs a `console.warn` and passes (a table has
somewhere to render a third state, a suite does not); and the page reopens the column's
client after `survives-reopen` and `close-settles`, because it runs every row against one
client where the suite gets a fresh one per `it()`.

**The real remaining risk is the export gap**, not the duplication — see `mem:state`.
**Verdict: treat the export gap; keep the invariant note as documentation.**

### BASELINE-1 — two residuals, both small

Locate `structuredClone`'s BCD entry and confirm it does not raise the floor; and check
`chrome_android` / `safari_ios` in `LIB_FLOOR` rather than inheriting their desktop engine
(the assumption is commented in `scripts/render-vfs-matrix.ts`). Everything else shipped in
`9af6b37`. **Verdict: treat — about fifteen minutes.**

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says supported
but gives no first version, the cell keeps `?` rather than adopting the library's number —
the true floor is at least that and may be higher.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome 86+, so a
pre-86 engine cannot run the six OPFS VFS at all. What was built instead is a classic ES5
script ahead of the module in the bench page that watches for the module having started and,
after 8 s, replaces the banner with what is missing. It tests for the module *running*, not
for syntax, so it also covers a failed `dist/` fetch. Falsified by blocking that fetch, not
reasoned about.

## Small and cheap

### W-types — nearly closed

**Closed 2026-08-26 by `feat/tx-query-surface`:** the two named instances of "the shipped
`.d.ts` leaks unnameable internal types" are gone — `SQLiteQueryOptions` and
`TransactionDB` (now `SQLiteTransactionDB`) both appeared in public signatures without
being exported, and both are exported now. `SQLiteVFS` was already exported.

`SQLiteDB` is still hand-written rather than derived from the implementation, but it is no
longer a *duplicate* of anything: it and `SQLiteTransactionDB` share `SQLiteQueryAPI`, and
a bidirectional compile-time pin fails the build if they drift. **Verdict: keep, but it is
now one small item rather than three.**

### Cleanups — pruned 2026-08-26 against the source

Six of the nine originally listed were **already done and unmarked**: `status: 'HAHA'`, the
`'Cannot werite…'` typo, the `SQLiteCLientCallParams` protocol duplicate,
`SQLiteStreamOptions`, the unbounded `worker.requests`, and the stale `types.ts` protocol
block.

**Four more were done on 2026-08-26 (`c64b8c9`)**, each verified live first:

- the release action's mutable `@v1` pin — **this was never a cleanup**, it was a mutable
  reference in the job holding `NPM_TOKEN`; now pinned to a SHA;
- `sideEffects` and `engines`. Note the item as written was **wrong**: `sideEffects: false`
  would invite a bundler to drop `worker.ts`, which assigns `self.onmessage` at module
  scope. The declaration names the worker entry instead — true, and still tree-shakeable.
  Falsifiable by the consumer smoke, which passed 11/11;
- `acquireInstrumented`'s "seven acquisition sites" — there are six;
- the unstated phantom row type on `read`/`first`/`chunk`/`stream`. The JSDoc now says the
  type parameter is a cast, and why validating instead would be worse.

**What survives:**

- **No exhaustiveness (`default: const _x: never`) on either message-union dispatch.** A
  real change, worth its own pass: an unhandled message type would stop compiling.
- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via three `declare module` deep
  imports. **Not a one-liner** — it touches how the worker compiles. A project.
- 29 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. **Also a project, not a cleanup.**

**Kept deliberately, do not "clean up":** the no-op degradation branch in `locks.ts`, which
is unreachable in Node ≥ 21 and every current browser. The final review recommended keeping
it — spec-mandated, correct, zero maintenance.

### Deferred minors from wave 3 — test-naming nits

Test names that overclaim what they pin (`quoteIdent`'s "preserves case", `renderPragmas`'s
"re-escapes a quoted string literal", the scheduler's second designation assertion); vacuous
assertions sitting beside falsifiable ones; one comment naming the wrong assertion as the
one that turns red; a `deps as any` cast in the third `output()` unit test; a `String(value)`
no-op in `renderPragmas`; an orphaned "Routing predicate" JSDoc in `utils.ts`; and quoting
pinned by unit tests only at the INSERT site. **Verdict: one cleanup pass, or delete.**

## Performance backlog — after correctness, none blocking

- **No prepared-statement cache** (`worker.ts`) — typically the largest single win (2-10×);
  worst for `bulkWrite`'s ~32k-placeholder template.
- **No default PRAGMAs** → consumers silently run `journal_mode=DELETE` + `synchronous=FULL`.
  Shipping WAL + NORMAL + `busy_timeout` is on the list for its own reasons — note that
  `busy_timeout` is also option A for CoopSync, with a risk to **measure, not deduce**:
  SQLite's busy handler sleeps, and in a synchronous VFS in a worker that may block the very
  thread that owes the handle release, converting a failure into a deadlock.
- `bulkWrite` flushes are separate transactions (~300 commits for 1M rows).
- **Every worker compiles its own WASM copy** (1.23 MB × `poolSize`).
  `WebAssembly.Module` is structured-cloneable — compile once, `postMessage` it.
- Per-row `Object.fromEntries(cols.map(...))` in the hottest loop.
- **The one read-side idea worth measuring (user, 2026-08-21): prefer the LAST WRITER for
  reads, then lowest index.** A `lastWriterIndex` used purely as a freshness hint — no
  exclusivity, no effect on who may write, correctness carried by the barrier alone.
  Distinct from the shape the user rejected in wave 3 (reads preferring the *designated*
  writer), which was a correctness crutch. The prelude census in `mem:measurements` says
  there is room to recover something on mixed loads.

## A cross-tab lead, recorded unverified

**Web Locks as a registry, not as mutual exclusion.** Preferred over `BroadcastChannel`,
which loses the race on a message still in flight. Shape: a tab holds
`bsq:epoch:<file>:<n>`, takes `n+1` and releases `n` at commit, and other tabs read the
epoch as the max of the held names via `navigator.locks.query()` — the same "lock as
liveness marker" pattern `stagingLockName` already uses. It is *state*, not *delivery*, so
there is no in-flight window.

**The measurement that settles it:** the cost of `navigator.locks.query()` per acquisition
against the one worker round-trip it avoids. `query()` returns every lock held in the origin
and is specified as a diagnostic snapshot. If it is not clearly cheaper, the cross-tab
answer is the unconditional prelude, probably opt-in, not this. **Do not treat this as
promising until that number exists** — that is exactly how `PRAGMA data_version` and the
WAL VFS each cost a session.
