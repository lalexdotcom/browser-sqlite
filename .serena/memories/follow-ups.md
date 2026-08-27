# Follow-ups — the open backlog

One short entry each. Anything closed is deleted from here — `CHANGELOG.md` and `git log`
record what was fixed. Evidence and numbers live in `mem:measurements`; VFS behaviour in
`mem:vfs`.

**Triaged 2026-08-27 (user).** The 2026-08-26 proposal was applied: `COOP-1` and the wave-3
deferred minors deleted, `RESIDUE-1` folded into `DELETE-1`, `BENCH-DRIFT` reduced to its
live rule, `D6` and `VIT-1` closed on measurement. Verdict annotations are gone with it —
what is written here is the backlog, not a proposal about it.

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
and touches nothing else.** No rename, no partial publication, previous target untouched.
An aborted `output()` is observationally a no-op. Two mechanical consequences: the eager
`DROP` is a write and needs a worker *after* the abort freed one, so it is **best-effort**
and must not hang or throw on failure (the fallback is an orphan staging table, which
`staleStagingTables` already sweeps); and releasing the staging lock is what arms that
sweep, so it must happen **after** the `DROP` attempt.

First observed consumer of the gap: the benchmark page's containment design. Because
`bulkWrite` cannot be aborted, its only bound is a `Promise.race` against a timer, which
abandons the *wait* without stopping the *work* — so the page abandons a whole column on
that row. When ABORT-1 lands, that special case disappears.

**Narrowed 2026-08-26 by `feat/tx-query-surface`:** a caller who needs a bulk load to stop
cleanly can run it inside `transaction()`, where abandoning means rolling back. The
non-transactional path still has no bound.

### DELETE-1 — there is no way to delete a database, and cleanup cannot see the residue

No `deleteDatabase`, and a consumer has no supported way to remove one. Every persistent
VFS wa-sqlite ships implements `jDelete`, and for `AccessHandlePoolVFS` it is the **only**
correct removal — `#deletePath` un-associates the SQLite path and returns the slot to the
pool, deliberately leaving the OPFS file in place because that file *is* a reusable slot.
The library never exposes it: the worker holds the VFS instance and nothing routes to it.
The JSDoc half is done.

What a `deleteDatabase(file)` owes: route to the open VFS's `jDelete`, so it needs a worker
with that VFS loaded; decide what happens when the database is open in another tab, where
nothing here can revoke a handle; decide what it returns when the database does not exist
(SQLite's `xDelete` is content with that); and decide whether it removes auxiliary files,
which differ per VFS.

**It must delete IndexedDB databases too (user, 2026-08-25).** `IDBBatchAtomicVFS` and
`IDBMirrorVFS` keep their data in an IndexedDB database named after the VFS class, holding
**every** database opened with that VFS on the origin — so `jDelete` alone frees the SQLite
file inside the store while the store stays, and `indexedDB.deleteDatabase(<VFS name>)`
would destroy every other consumer's data on the same origin. Neither is the answer alone.
**That asymmetry between the OPFS and IndexedDB families is the part that needs thought.**

**RESIDUE-1, folded in 2026-08-27** — the same root fact from the cleanup side. A VFS
stores where it likes and only the VFS knows where, so a design that answers deletion
answers residue too.

*What residue cost:* after several interrupted local runs, five of six
`AccessHandlePoolVFS` slots held orphaned databases. A database in `journal_mode=DELETE`
needs two slots, so the VFS failed at `opens` with a bare `sqlite3_open_v2` and no message,
on both `sync` and `async`. It read as a regression from a wa-sqlite patch committed
minutes earlier; it was residue, and deleting the directory by hand restored it with no
code change. Corroborated on an iOS device where `/sync` went 5/7 → 0/7 between two runs
while `/async` was already at 0/7: **the failure migrates from build to build as the pool
fills**, the signature six-slot exhaustion predicts and no engine defect does. **The iOS attribution is refuted, 2026-08-27.** This entry said the isolated
`AccessHandlePoolVFS` `opens` failures on iOS were "very likely the same exhaustion", and
prescribed re-running on a swept root before recording either as real. That was done: site
data cleared on the device, page reloaded, and **`sync` and `async` both still fail with
the same bare `sqlite3_open_v2`**. Two arguments say it is not residue — it survives a
cleared root, and it is the iPhone alone, while macOS 26.5.2, macOS 27.0 and iPadOS 27.0
all pass with the same residue history. See IOS-AHP-1 below. The `/jspi` failure on macOS
Chromium 150 is untouched by this and still owes its re-run.

*Corrected twice on 2026-08-27, and the second correction is the true one.* The durable
mechanism already exists and shipped in `76141b3`: `sweepBeforeRun` runs before every bench
and removes anything prefixed `bench-` plus every name a previous run recorded as its own
in `localStorage`, and `remember('opfs', name)` is written **before** the removal attempt,
so a directory that resists removal is retried on the next run. Its own comment names this
exact failure. `cleanupOpfsResidue`'s run-start diff is only the second half of the pair —
reading it alone led to the wrong conclusion that per-column cleanup or per-VFS declaration
were the only options.

**The real gap was narrow: the mechanism cannot reach residue older than itself.** A
directory created before `76141b3` was never recorded as ours and does not start with
`bench-`, so both passes skip it for ever. That is why iOS 26.6 fails identically on
2026-08-25 and 2026-08-27 rather than drifting.

**Closed 2026-08-27** by having `sweepBeforeRun` also reclaim names taken from
`VFS_CAPABILITIES` itself — the OPFS directory or IndexedDB database a VFS keeps under its
own class name, derived from the `storage` field so a new VFS needs no edit. Legacy residue
and any future gap are both covered, with no device-side intervention.

*What stays open here is the library-side question, not the bench one:* a VFS should
**declare the storage names it owns** so `deleteDatabase` can delete by declaration rather
than by difference. IndexedDB needs it most — it has no equivalent diff at all, and
`indexedDB.deleteDatabase(<VFS name>)` would take every other consumer's data on the
origin with it.

### `wasmUrl`, optional — approved 2026-08-18, never built

An explicit base URL for the three `.wasm`. When omitted, behaviour is **exactly today's**
resolution: this is an escape hatch, not a new default, and the default config must not
change by a single byte.

Rejected then and still rejected: inlining the `.wasm` as base64 (+33 % on 2.4 MB raw, and
it gives up streaming compilation — acceptable only as an opt-in subpath, never the
default).

*It used to be listed beside D6, the `browser-sqlite/vite` plugin. D6 died on 2026-08-27
when its premise was measured false — Vite does emit the worker's `.wasm`, from 6.1 through
8.2.2, and the consumer smoke passes with no plugin. `wasmUrl` never depended on it.*

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

**To treat:** write it into Known Limitations (today only `OPFSCoopSyncVFS` has an entry
covering this shape), then delete this item.

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single
writer". Partly settled: `output()` **must** be multi-tab safe (user requirement) and its
staging sweep is `navigator.locks`-guarded. The rest of the client stays uncoordinated.

**To treat:** one line in Known Limitations saying so, before 1.0.

### `OPFSWriteAheadVFS`'s `requires` is wrong — measured 2026-08-27

It declares `requires: ['opfs', 'readwrite-unsafe']`, and `mem:vfs` said that off Chromium
"the second connection cannot take the handle, and the pool breaks with no error naming the
cause". **Both are false.** Forced onto Firefox with `HAS_UNSAFE_HANDLES=false`, the VFS
passes all three build pairs and all six invariants — including invariant 3, concurrent
writes — at `poolSize` 1, 2 and 4. The mechanism was inferred and never executed.

**Why nobody saw it: the declaration and the skip confirmed each other.** `requires` caused
the conformance skip, and the skip prevented `requires` from ever being falsified. Nine
pairs skipped themselves on the strength of their own declaration.

**There was never a guard to design.** `missingFeature` skips `UNPROBEABLE` features, so
`requires: ['readwrite-unsafe']` has never blocked anything at construction on any engine.
The long-running "accept it, or design an async probe?" question was about a defence that
did not exist.

**The fix is `requires: ['opfs']` with `degradesWithout: ['readwrite-unsafe']`** — the
shape `OPFSAdaptiveVFS` already uses. It changes no runtime behaviour, un-skips nine
conformance entries, and changes the generated README row.

**Do not simply delete the README warning.** Firefox is one engine; WebKit is where OPFS
diverges (ANYCONTEXT-1 was a WebKit-only bug in this exact area) and cannot be tested here,
Linux WebKit having no OPFS at all. Narrow the entry from "does not work off Chromium" to
"not measured on Safari", and add this VFS to the owed Safari 27 / iOS 26 / iPadOS 27
campaign. The degradation itself is also unmeasured — the read-burst ratio would say
whether it degrades like `OPFSAdaptiveVFS` or not at all.

### IOS-AHP-1 — `AccessHandlePoolVFS` cannot open on iOS 26.6, and it is not residue

`sync` and `async` both fail at `opens` with a bare `sqlite3_open_v2`, on 2026-08-25 and
twice on 2026-08-27 — including **after the device's site data was cleared**, which is the
test RESIDUE-1 prescribed for exactly this. macOS 26.5.2, macOS 27.0 and iPadOS 27.0 all
pass, so it is the iPhone specifically rather than the engine version or accumulated
residue.

Reproducible, unlike everything else that came out of this campaign. Nothing is known about
the mechanism: `sqlite3_open_v2` with no message is what the VFS returns when it cannot
take two of its six slots, but that is the same symptom exhaustion produces, and exhaustion
has been ruled out. **Do not reuse RESIDUE-1's explanation for it.**

The VFS is `poolSize: 1` and niche; this blocks nothing. But it is the one solid,
repeatable device finding available, which makes it the cheapest place to learn something
real about OPFS on iOS.

### REOPEN-1 — `OPFSWriteAheadVFS/sync :: survives-reopen` is a flake on Safari 27

Seen as `timeout` on macOS 27.0 and iPadOS 27.0 on 2026-08-27, and **`pass` on the very
next run of each, twenty minutes later**. One occurrence in two runs on each device. Clean
on Safari 26.5.2 and 26.6, and clean on the other two builds throughout.

**Opened as a defect on the strength of "reproduced on two devices" — which was two devices
at one run each, and that distinguishes nothing.** It is the same shape as FLAKE-ROW-1: a
race whose verdict depends on timing. Do not write a mechanism for it before n≥3 per
device, and note the honest question may not be "why can one build not reopen" at all:
`OPFSWriteAheadVFS` gives no concurrency on Safari (`mem:measurements`), so whether it
should be recommended there is the prior question.

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

### Two Firefox failures block wiring Firefox into CI

A browser cannot be a blocking gate while it is red.

- `long-query :: does not terminate the worker it abandoned` — this is HANDLE-1. Not a test
  defect; it needs a per-browser expectation.
- `lifecycle :: rejects the in-flight query on a deserialization failure` — times out at
  30 s. **Nobody has traced it.** Leading explanation is calibration: the test sleeps 100 ms
  then synthetically dispatches `messageerror`, betting the query is already in flight, and
  Firefox is 5.5× slower on the same CPU-bound query. Unverified.

Note the conformance suite already runs on both engines and is green on both; this is about
`pnpm test`'s browser project.

### BASELINE-1 — two residuals, both small

Locate `structuredClone`'s BCD entry and confirm it does not raise the floor; and check
`chrome_android` / `safari_ios` in `LIB_FLOOR` rather than inheriting their desktop engine
(the assumption is commented in `scripts/render-vfs-matrix.ts`). Everything else shipped in
`9af6b37`. **About fifteen minutes.**

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says supported
but gives no first version, the cell keeps `?` rather than adopting the library's number —
the true floor is at least that and may be higher.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome 86+, so a
pre-86 engine cannot run the six OPFS VFS at all. What was built instead is a classic ES5
script ahead of the module in the bench page that watches for the module having started
and, after 8 s, replaces the banner with what is missing. It tests for the module
*running*, not for syntax, so it also covers a failed `dist/` fetch. Falsified by blocking
that fetch, not reasoned about.

## Notes, with nothing to fix

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer. The export
half is closed (`de3abdf`); the probe half is closed; `HAS_UNSAFE_HANDLES` stays on the
page because it needs a worker and two access handles.

**The live rule: changing either copy obliges a review of the other, both directions.** The
page's row ids are normalized from the conformance `describe()` titles, so a row whose id
no longer maps to a `describe()` is the signal. Two places where the copies legitimately
differ and must **not** be aligned: the page returns `'blocked'` where invariant 6 logs a
`console.warn` and passes (a table has somewhere to render a third state, a suite does
not); and the page reopens the column's client after `survives-reopen` and `close-settles`,
because it runs every row against one client where the suite gets a fresh one per `it()`.

## Small and cheap

### W-types — one item, not three

`SQLiteDB` is hand-written rather than derived from the implementation. It is no longer a
*duplicate* of anything: it and `SQLiteTransactionDB` share `SQLiteQueryAPI`, and a
bidirectional compile-time pin fails the build if they drift.

### Two things called cleanups that are projects

- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via three `declare module` deep
  imports. Not a one-liner — it touches how the worker compiles.
- 29 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.

**Kept deliberately, do not "clean up":** the no-op degradation branch in `locks.ts`,
unreachable in Node ≥ 21 and every current browser. Spec-mandated, correct, zero
maintenance.

**The hygiene note this list earned.** Five entries were found already done and unmarked in
one session — VFS-COV, COOP-1's README half, `SQLiteVFS`'s export, six of nine cleanups,
and message-union exhaustiveness. The backlog was appended to and never retired, so its
length stopped meaning anything. **Verify an item against the source before scheduling work
on it**, and delete it the moment it is done rather than leaving it to be rediscovered.

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
against the one worker round-trip it avoids. `query()` returns every lock held in the
origin and is specified as a diagnostic snapshot. If it is not clearly cheaper, the
cross-tab answer is the unconditional prelude, probably opt-in, not this. **Do not treat
this as promising until that number exists** — that is exactly how `PRAGMA data_version`
and the WAL VFS each cost a session.
