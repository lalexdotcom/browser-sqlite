# Follow-ups — the open backlog

One short entry each, and every entry OPEN. Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## Designs owed — ideas, not scheduled work (user, 2026-09-03)

**The user has said explicitly that the three below are not planned for the short or medium
term — they are ideas.** Keep them, do not present them as pending rc.5 scope, and do not
propose them as "the next thing" the way this file's older framing invited.


### A real watcher on a database's clients — deferred by the user, 2026-09-03

Database inspection ships as a one-shot snapshot the consumer polls. The user asked for a
watcher during the brainstorm, then withdrew the word deliberately: *"ce sera une autre
fonctionnalité"*. **The measurement that makes it cheap is already banked** —
`navigator.locks.query()` is `≈ 0.032 ms + 0.00038 ms × n` on Chromium, so polling at
300-500 ms costs 0.14-0.23 ms of main thread per second and takes no lock, no worker round
trip and no queue.

**What it cannot be built on, and this is the whole design constraint:** Web Locks has NO
change notification. An emitter fed from the registry can only poll internally — which
moves the polling under the hood and makes it permanent, charging every client for an
observability most never read. That is why the shipped API is on-demand. A genuine push
mechanism needs a second channel (a `BroadcastChannel` hello/bye reconciled against
`query()` for tabs that were killed without saying goodbye), and that channel is the cost
to weigh, not the query.

**Two smaller emitters may be the better shape than "watch the count"** — the question a
consumer actually has is usually "a tab left" or "the database is free now", and the second
is nearly free already: waiting on `bsq:conn` exclusively IS the event "nobody left".

### One compiled `WebAssembly.Module` for the pool — the premise it waited on is dead

Every worker compiles its own copy of the 1.23 MB binary. Sharing one is verified and
priced in `mem:measurements`: the clone is free and arrives usable, but it buys ~2 ms on
Chromium, which overlaps those compiles anyway, and ~8 ms at the default `poolSize` on
Firefox, which does not.

It was carried on the premise that whatever solved multi-tab would improve those numbers —
a coordinator compiles once per **origin** rather than once per client. **That premise is
gone:** rc.5's cross-tab design has no coordinator and cannot have one, because a
SharedWorker cannot open a connection on the four VFS that matter (`mem:state`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

### A timed flush — out of rc.4 (user, 2026-08-27)

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost the argument turns on is measured**: ~3.4 ms on Chromium/sync and ~5.3 ms on
Chromium/async (`mem:measurements`). That price is what a timer would pay per flush on a
trickle, and it is no longer a deduction.

## `tx.savepoint()` returning a rollback callback — for rc.6 (user, 2026-09-11)

A feature, so rc.6 by the triage rule. Raised while settling rc.5's savepoint rule: three writes
in one `try`, the third times out — rc.5 keeps the first two, as SQLite does for any statement
error. A consumer who wants the three all-or-nothing without abandoning the whole transaction
needs a nested block; the user's shape is a `tx.savepoint()` that returns a callback rolling
back to it. Not designed. It will sit on the savepoint machinery merged on 2026-09-12 (`via`, `__bsq_sp`,
`mem:architecture`): a new entry point must go through the facade, which concludes the library's
savepoint before opening its own.

## `BUILD_CAPABILITIES` — one registry per axis, for rc.6 (user, 2026-09-16)

A comfort refactor, so rc.6 by the triage rule — raised by the user while the matrix ran.
Aggregate `BUILD_REQUIREMENTS` and `BUILD_DEGRADES_WITHOUT` into one
`BUILD_CAPABILITIES` table and derive `type SQLiteBuild = keyof typeof BUILD_CAPABILITIES`,
exactly as `SQLiteVFS` already derives from `VFS_CAPABILITIES` (`src/types.ts`). **Keep
`WA_SQLITE_BUILDS` in the worker and `BUILD_NOTE` in the VFS.md generator** — the dynamic
`wa-sqlite` imports and the documentation data must not ship to every consumer, which is the
reason `types.ts` already gives for keeping browser versions out.

**The objection written in `src/types.ts` against `keyof` is measurably false — delete it, do
not move it.** It claims `keyof` "would let a forgotten entry mean silently that the build does
not exist". Measured 2026-09-16 on a scratch file: under `keyof`, a build added to a dependent
table but missing from the registry fails with TS2561 (excess key) — on a `satisfies` table AND
on a type-annotated one — and a build in the registry missing from a dependent table fails with
TS2741. The `keyof` shape is STRICTER, because every other build-keyed table is then checked
against the registry in both directions.

**The one detail that makes it compile:** `satisfies Record<string, BuildCapability>`, with
`string` and not `SQLiteBuild` — otherwise the derivation is circular. `VFS_CAPABILITIES` does
exactly that.

**Scope:** `BUILD_REQUIREMENTS[build]` becomes `BUILD_CAPABILITIES[build].requires` at 11 sites
in 7 files — `src/capabilities.ts` (3), `scripts/render-vfs-matrix.ts` (4, including
`Object.keys(BUILD_REQUIREMENTS)` which becomes the build list and reads better for it), and
four test files. src + scripts + tests, so it needs the user's go-ahead before it starts.

**`interruptible` must be RE-DERIVED as part of this, not carried over (user, 2026-09-16).**
The property belongs to the build, and today it is stated twice: `BUILD_DEGRADES_WITHOUT.sync
= ['cross-origin-isolated']` declares it, and `holds('interruptible')` in
`tests/browser/target.ts` restates it as `build !== 'sync' || here.crossOriginIsolated`. The
duplication of the FACT is removed before rc.6 (§ below, done in the test chantier); what waits
for `BUILD_CAPABILITIES` is naming the PROPERTY. **Do not derive it from `degradesWithout` taken
as a whole**: that list means "degrades on any axis", and it is only by coincidence that the
`sync` build's single declared degradation IS the interrupt. The clean shape is a field that
names it — `interruptibleWithout: ['cross-origin-isolated']` for `sync`, empty elsewhere — from
which `degradesWithout` can be derived, not the reverse. Same relation as `layout` → `storage`:
the fine datum carries the logic, the aggregate is derived.

**THE BOUNDARY, and it is the user's, 2026-09-16: build PREFERENCE ORDER does not move here.**
It stays in each VFS's `builds` array in `VFS_CAPABILITIES` — per-VFS granularity, and far more
readable than a global ranking. The library's rule, in the user's words: *if you specified no
build, I take the first of this VFS that your environment supports; if you specified one it does
not support, I raise.* That is the entry "Default to the first build the environment supports"
below, and `BUILD_CAPABILITIES` only supplies the `requires` that rule tests against. Raised as a
possible home for the ordering and refused on the spot.

## Split `src/types.ts` into `const/` and `types/`, for rc.6 (user, 2026-09-16)

The user's design, decided in chat after being confronted with a smaller counter-proposal and
holding. **The stated goal is the one that decides the open cases: the root of `src/` is too
full, and the benefit is the user reading the code.** Do it AFTER `BUILD_CAPABILITIES` (§ above)
— `const/builds.ts` is that table's home, so the other order writes the file twice.

**The rule that places everything: a type derived from a const lives in the same file as the
const.** No import, no drift. It is why `SQLiteVFS` does not move away from `VFS_CAPABILITIES`.

`const/` — platform.ts (`PlatformFeature`; no const, but the base of the DAG) · builds.ts
(`BUILD_CAPABILITIES` + `SQLiteBuild`) · vfs.ts (`VFS_CAPABILITIES` + `SQLiteVFS`,
`VFSCapability`, `VFSStorage`, `VFSLayout`, `VFSMemoryModel`, `defaultBuildFor`) · sqlite.ts
(today's `src/sqlite-codes.ts`, moved — the move IS the point, not a side effect).

`types/` — protocol.ts (`ClientMessageData`, `WorkerMessageData`, `SQLiteWorkerMessageData`,
`SQLWorkerResultData`, `SavepointOp`, `WasmLocation`, `SQLOptions`, `SharedArrayTypes`) ·
errors.ts (today's `src/errors.ts` whole, `SQLiteErrorCode` AND the two classes — user,
2026-09-16). Note in passing: `types/` therefore emits JS, it is not erasable-only; the
directory name groups declarations, it is not a contract.

**`src/types.ts` may survive, and the distinction is exact (user, 2026-09-16): it keeps whatever
isolated types belong nowhere else, but it NEVER re-exports what moved.** A residual module
holding its own orphan declarations is fine; a barrel forwarding `const/` and `types/` is not,
because it would keep alive the public/internal mixing the split exists to end. On today's
content the leftover set looks empty — `WasmLocation` is the likeliest orphan, since it travels
in the worker message (`pool.ts`) but is also a plain option shape used by `utils`, `delete` and
`client` — so decide it when the move is made, not now.

DAG: platform ← builds ← vfs ← protocol, no cycle.

**The strongest reason is already written in the code**, at `src/index.ts`: "Named rather than
`export *`: the wire-protocol types in types.ts are internal and must not reach the public
surface." One file mixes public API with internal protocol, and only a hand-maintained export
list separates them. Extracting `protocol.ts` makes that boundary structural.

**No re-export barrel at `src/types.ts`.** 28 files import it; a barrel would make the change
invisible to all of them and keep alive exactly the public/internal mixing the split exists to
end. **The user does not consider the import churn a cost** — one LSP rename — and that
judgement is theirs, taken on being told the number.

## `db.ready` — a promise for the pool's startup, for rc.6 (user, 2026-09-13)

A feature, so rc.6 by the triage rule. Raised while designing the environment pool cap:
`db.poolSize` is exact once every worker has opened or declined, and nothing public signals that
moment — only a query that went through the scheduler's startup gate. Shape agreed in chat, not
designed further: a property `db.ready: Promise<void>`, not an `onReady` option — it resolves
when the gate opens, rejects with `failClient`'s error on a total startup failure and with
`CLIENT_CLOSED` on a `close()` before it, and carries an internal `.catch` so a consumer who never
reads it sees no unhandled rejection. It derives from the scheduler's `gateDeferred.promise`.
Once it exists, `db.poolSize`'s contract becomes "exact once `db.ready` resolves".

**The bench's column header waits for it too (user, 2026-09-14).** It shows the declared
`poolFor` today, and the burst row divides its ideal gain by it — 4 for `OPFSAdaptiveVFS` on
Firefox and Safari, which run 1. Once `db.ready` exists the header shows the requested `poolSize`
→ the effective `db.poolSize`, when they differ. The export already records `db.poolSize`.

## Default to the first build the environment supports — `jspi` before `async`, for rc.6 (user, 2026-09-14)

A behaviour change, so rc.6. `defaultBuildFor` returns `builds[0]` whatever the engine, and the
client then refuses a build the engine lacks (`missingFeature`, `src/client.ts`) — so merely
listing `jspi` first would break every engine without JSPI, Safari 26 included. The agreed shape:
list `jspi` before `async` for the five `async`-first VFS (`OPFSAdaptiveVFS`,
`IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS`, `MemoryAsyncVFS`) and resolve the default
as the first declared build whose `BUILD_REQUIREMENTS` `detectFeatures()` meets; `async` stays the
fallback. The `sync`-first VFS do not move.

**Why:** Safari's Asyncify slowdown (IDB-SIGNAL, `mem:measurements`), which `jspi` escapes on
Safari 27. On Chromium and Firefox the bench corpus says `jspi` is equal or faster — full scan
×0.41-0.66, list page ×0.40-0.86, bulk insert ×0.72-1.04 — except two Chromium IDBBatchAtomicVFS
rows: single write ×1.18 (3.0 → 3.55 ms) and 500 UPDATEs ×1.13 (median of 10 exports each).

**To do:** the resolution everywhere `defaultBuildFor` is called (client, worker, `deleteDatabase`);
a test of the no-JSPI fallback; the stale JSDoc at `src/client.ts` ("JSPI is Chromium-only" — VFS.md
says Firefox 153+, Safari 27+); `VFS.md`; a CHANGELOG entry, the default changing. **Check first:** a
consumer who passes one `.wasm` URL without `build`. **Measure first:** `OPFSAdaptiveVFS` on `jspi`
on Safari 27, the pair whose default would change for the most consumers.

## The rstest/Firefox silent hang — CAUSE FOUND 2026-09-16, fix not taken

**`navigator.storage.getDirectory()` inside a dedicated worker sometimes never settles on Firefox
— no resolve, no reject — under concurrent OPFS access from many pages.** That call sits at
module scope behind a TOP-LEVEL AWAIT: `probeUnsafeHandles()` in `tests/conformance/helpers.ts`,
reached by every browser test file through `tests/browser/helpers.ts` → `AVAILABLE_FEATURES`.
rstest runs test files in parallel pages, so ~43 of these probe workers start per run, ten of them
inside one five-second window. When one never answers, that file's module never finishes
evaluating: **no test starts, so neither `testTimeout` (30 s) nor `hookTimeout` can fire**, rstest
reports the file as "running" for ever, and `pnpm test` never ends.

Established 2026-09-16, by instrumenting the probe worker step by step and catching a wedge:
the wedged page prints `worker constructed` then `step:start` and nothing more, where a healthy
page goes `step:start → got-root → got-file-handle → h1 → caught(NoModificationAllowedError) →
ANSWERED false`. It stops at `await navigator.storage.getDirectory()`.

Arms, all on Firefox `OPFSWriteAheadVFS/sync`, one project, no load: real probe **4 hangs / 24
runs** (~17 %); probe stubbed to `return false` (behaviour-neutral on Firefox) **0 / 9**; probe
bounded at 8 s **0 / 6**. The hang lands on whichever file loses: `inspect-marker` ×3,
`inspect-client` ×1, `pool-savepoint` ×1.

REFUTED on the way, keep refuted: it is NOT contention on the probe's fixed file name. Measured
directly — a second `createSyncAccessHandle` on a held file REJECTS at once on Firefox
(`NoModificationAllowedError`) and is granted on Chromium (that is what the probe reads).

**Guarded 2026-09-16 (`6560c9e`), not cured.** Each probe attempt is bounded at 10 s, a wedged
worker is terminated and replaced, three times, and the third failure THROWS rather than answering
— a silent `false` would flip `readwrite-unsafe` on Chromium and make tests pass for the wrong
reason. `scripts/bounded.mjs` now gives every browser script a deadline (exit 124), because the
next hang of this shape will not be this one.

WHAT REMAINS OPEN:
- **`HAS_UNSAFE_HANDLES` is still awaited at module scope** (`tests/conformance/helpers.ts`, the
  top-level await; `AVAILABLE_FEATURES` is only derived from it — this entry used to name the wrong
  one). **Making it lazy is NOT the structural answer this entry once claimed, and the correction
  is measured (2026-09-21):** it would not reduce the number of probes, which is what wakes the
  engine bug. `readwrite-unsafe` feeds `singleConnectionWithout` and `exclusiveConnectionWithout`
  (`src/types.ts`), so `pairFor()` needs the answer in every browser test — on demand or at load,
  every page still probes once. And the run no longer hangs either way, since `6560c9e` bounds it.
  What laziness would still buy is only that a module-scope throw becomes a named test failure.
- **The lever that WOULD attack the trigger is one probe per run instead of one per page**, and it
  is now designed rather than speculated. Measured 2026-09-21, all three in `.scratchpad/probe-2026-09-21/`:
  rstest 0.11.8 has **no per-run hook with browser access** (`setupFiles` runs before each FILE;
  `globalSetup` runs in Node, and beside `projects` at root level it is silently IGNORED — declared
  per project it runs once per project); the **injection channel works** — a value set in
  `globalSetup`'s `process.env` reaches the page as `import.meta.env.X`, synchronously at module
  scope, so declaration-time skips survive; and **no storage is shared** to cache an answer in —
  not across runs, not across files of one run (same origin, isolated: `a` reads back its own
  write, `b` reads `<empty>` 4 s later), not across projects (the origin's port differs). So the
  shape is: `globalSetup` launches its own Playwright browser against a `127.0.0.1` page, probes
  once, injects. Cost measured at **813 ms per project** (launch 183, page 404, probe 45, teardown
  175) — ≈ +3.3 s on `pnpm test`, ≈ +2 % on the matrix, against 45 ms per page removed in parallel.
  Roughly neutral in wall clock: the cost is not the argument either way.
- **The engine bug is unreported, and Bugzilla was searched on 2026-09-21: nothing matches.** The
  component is **Core › Storage: Bucket File System** (where the OPFS meta 1748667 lives); its 33
  open bugs are almost all the `readwrite-unsafe` series and PBM, and a summary search for
  `getDirectory` and `hang` there returns nothing of this shape. `Storage: Quota Manager`'s hangs
  are all shutdownhangs.
  **Two things block the report, and neither is the writing.** (1) The repro is not portable: the
  console probe in `.scratchpad/firefox-hang-2026-09-16/` does NOT reproduce it (0 of 144), only
  the suite's shape does — ~50 pages each asking a worker for the OPFS root within a few seconds.
  (2) Every sighting is on **Playwright's Firefox 153.0** (BuildID 20260722045007), a patched
  build; Mozilla will ask first, so confirm on a stock Firefox before opening, or the bug is
  Playwright's, not theirs. Then: `enter_bug.cgi?product=Core&component=Storage%3A%20Bucket%20File%20System`,
  blocks 1748667, keyword `hang`, and a `mozregression` range if it reproduces on stock.

## `pool-cap`'s surplus-slot flake — margin widened, cure NOT demonstrated (2026-09-21)

`tests/browser/pool-cap.test.ts :: a pool capped by its environment > a surplus slot that times
out, then declines in the retry round, is not announced lost`. The coupling is fixed — `openTimeout`
600 → 3000 with the delayed open 3000 → 15000 (`2be2ae6`) — and the mechanism is established:
`openTimeout` is client-wide, so it governs slot 0's HEALTHY worker as well as the surplus slot,
and under load it was the healthy one that missed. Squeezed on an idle machine, slot 0 needs some
tens of ms: 10, 25 and 50 ms all fail with `Worker 1 did not become ready within N ms`, 100 ms
passes. So 600 was ~10×, and 3000 is ~50×.

**What stays open is the verdict.** The flake itself was NEVER reproduced: 64 busy loops leave the
old and new budgets both green, and a full matrix is green exactly as it was on the days the flake
did not show. If it returns, fiftyfold is still short and the next move is to stop scaling and give
slot 0 a budget of its own — which needs a product change, since `openTimeout` is one knob for the
whole client.

## The consumer docs are hard-wrapped at 80 columns (2026-09-18)

`VFS.md` ~23 wrapped prose paragraphs, `README.md` ~9, `API.md` ~3; `CHANGELOG.md` is clean. The
user's rule is long lines in markdown (`mem:conventions`, writing for the consumer) — hard wrapping
makes a reworded sentence reflow a whole block and hurts reading in rendered form. **`VFS.md` cannot
be fixed in the file alone**: 14 of its spans are generated, and the wrapped strings live in
`scripts/render-vfs-matrix.ts`; the `pre-push` hook runs `pnpm docs:vfs && git diff --exit-code
VFS.md` and would reject a divergence. Pure formatting, no behaviour, but it touches three consumer
files plus a script.

## What the matrix showed, and what it shows now (2026-09-16, resolved 2026-09-18)

**The three product defects are gone.** Full matrix on 2026-09-18 after the fixes: 65 of 66 cells
green, 1 failing test, 1 distinct group — against 62 cell-failures and 20 groups on 2026-09-16.
**Re-measured 2026-09-21 once that one was fixed (`2be2ae6`): 66 of 66 cells green, 0 failing
tests, 2650 s.** Every one of the three traced to a
wa-sqlite defect rather than to this library, and each is upstream with a falsifying test in
wa-sqlite's own suite: `OPFSCoopSyncVFS` → #350 plus our own `deleteDatabase` probe (a file's
existence, not an open), `IDBBatchAtomicVFS` → #351, `IDBMirrorVFS` → #352 and #353. Reports in
`docs/upstream/`, patch inventory in `mem:stack-and-build`.

Kept for its method rather than its content — the original entry, now closed:

Numbers in `mem:measurements`. `scripts/matrix-triage.mjs` regenerates the grouping from any
`.matrix/<run>/`.

**Everything the triage called test work is done.** 989 cell-failures → 500 (the dead cleanup)
→ 79 (the `Need` vocabulary and the pinned pool sizes) → pending, after the dying-worker handle
fix cleared the last 18. `MemoryVFS` and `MemoryAsyncVFS` are entirely green; 49 of 66 cells were
green before the last fix. **The lesson the sequence taught, and it was the triage's own
prediction: clearing the first pile is what made the second readable** — the second GREW when the
first went, because tests finally reached their real cause.

What is left is product, on three VFS, none of them recommended. Each needs a diagnosis before a
fix, as `output()` did.

- **`IDBMirrorVFS` — 46.** All one defect, and the abandonment was never the cause: `pData` is a
  `Uint8ArrayProxy`, so `block.set(pData, …)` stored zeroes — including over SQLite's rollback
  journal header, after which a rollback undid nothing.
- **`IDBBatchAtomicVFS` — 8.** One defect too, with two faces by build: `jWrite` wrote through a
  block it assumed started at the offset.
- **`OPFSCoopSyncVFS` — 7.** Two unrelated causes, which nothing suggested: the six
  `DATABASE_NOT_FOUND` were `deleteDatabase` reading `SQLITE_CANTOPEN` as absence on a database
  that existed but was empty; the `sqlite3_open_v2` ones were handles leaked by a partial
  acquisition.

**The lesson the three shared, and it is in `mem:lessons`: a pile's twelve subjects can be one
defect, and the scenario a defect is found through is often not the one that demonstrates it.**

## wa-sqlite's `jOpen` swallows the cause of a failed open — upstream candidate (2026-09-21)

`OPFSCoopSyncVFS.jOpen`'s asynchronous phase catches its error, stores an invalid `PersistentFile` as the only signal and calls `console.error(e)` — it never sets `this.lastError` (the catch inside the `retryOps` push, `node_modules/wa-sqlite/src/examples/OPFSCoopSyncVFS.js`). The retried open then reads `!persistentFile.fileHandle` and returns `SQLITE_CANTOPEN`, so a caller cannot tell a file held by a dead context from one that does not exist. That is what made the two matrix cells report a bare `WORKER_CRASHED: sqlite3_open_v2`, and instrumenting that catch by hand is what produced the `NoModificationAllowedError` the #350 diagnosis rests on. The #350 report already names it a separate subject.

**The fix is one line — `this.lastError = e` in that catch — and both consumers are already in place.** `src/worker/worker.ts` already reads `vfsInstanceSeen.lastError` and formats it as `name: message` into the open failure's `detail`. **What it does NOT buy, measured 2026-09-21 and refuting what this entry first claimed: SQLite's own message does not carry it.** Since wa-sqlite #330 a failed `open_v2` reports the connection's message rather than the function name — but that message is `unable to open database file`, identical with and without the fix, because SQLite does not fold `xGetLastError` into it here. Reading the VFS instance is not a shortcut, it is the only route. Nothing on our side changes, which is why this buys diagnosability and nothing else — the failure it used to hide is fixed.

**Posted as rhashimoto/wa-sqlite#357 on 2026-09-21**, from `lalexdotcom:fix/coopsync-open-last-error`, rebased onto `master` at `93b92308` before opening. Two commits, four files. `test/vfs_open_last_error.js` fails on that master on the `default` and `asyncify` builds and passes with the fix; the whole upstream suite is 2905/14/0. Report and evidence: `docs/upstream/2026-09-21-wa-sqlite-357-coopsync-open-last-error.md`. Prepared in a worktree at `.work/wa-sqlite-lasterror`, kept in case review asks for an iteration.

**The second finding, and it is the one a reviewer will weigh:** the upstream test harness cannot observe VFS state at all. `test/test-worker.js` proxies the VFS behind a getter that returns only functions, so `await vfs.lastError` answers `undefined` even after a path that DOES set it (probed directly). The test therefore carries a one-line harness change. Nothing depended on the old behaviour — every non-function property answered `undefined`.

**Not carried in `patches/`** — deliberately: it fixes no failure, it makes one legible. Carrying it would put `NoModificationAllowedError` into our open failures' `detail`; that is the user's call and it is not taken.

## Mixing VFS of the `opfs-path` family on one database (2026-09-15)

Measured while the second-client guard was built: on Chromium an `OPFSAdaptiveVFS` client beside a LIVE
`OPFSWriteAheadVFS` client opens and reads an **empty** database (`no such table`) — WriteAhead's writes
live in its own `-wa0`/`-wa1` files; on Firefox it waits while WriteAhead holds `bsq:conn` exclusively,
then gets `WORKER_CRASHED` once that client closes. **Not measured:** the successive shape (WriteAhead
writes, closes, another VFS reopens), where the same write-ahead files are the reason to fear a stale
read. CROSS-VFS (2026-09-02) already showed deletion through any member destroys the others' data.

**The user's idea, on the table:** a short per-VFS prefix in the file name, which would make "one database,
one VFS" true by construction, as it already is for the `idb-store` and `opfs-pool` families. Its own
branch: the migration of existing databases is the design's core (rc.4 is published under `latest`), and
the prefix spends part of wa-sqlite's 56-character path budget.

## Smaller things this branch left open (2026-09-15)

- A **refused client still appears in `inspectDatabase().clients`** until it is closed —
  `AccessHandlePoolVFS` behaved that way before the branch too.
- **Interrupt latency differs per pair:** `OPFSWriteAheadVFS/async` cuts an abandoned write at ≈0.6 of its
  natural length on Chromium where `OPFSAdaptiveVFS/async` cuts below 0.5. `tx-savepoint` T3/T4's bound was
  widened to `natural * 0.8` for it; nobody has measured the others.
- **`handleDeath`'s guard for a slot-0 loss before the probe has no test** — no path was found that reaches
  it with the probe unanswered; it is defensive (`a0373c0`).
- **Three tests of `multi-client.test.ts` carry no falsifier** (their claims were run and refuted): "never
  refuses a read-only transaction opened under a writer", "gives back a usable client after a transaction
  is aborted mid-contention", "commits at most one more batch after a bulkWrite is aborted". Their comments
  now say what was tried. Whether to find a real falsifier or delete them is the user's call.


## Three browser tests guard less than their comments said (2026-09-14)

Found by `fix/pool-environment-cap`'s Task 10 and its reviews:

- **`barrier.test.ts` does not guard the barrier.** Deleting `BARRIER_SQL` in `applyBarrier` leaves
  it green on `OPFSAdaptiveVFS` (Chromium, real multi-connection) and on `OPFSAnyContextVFS` alike —
  pre-existing, not caused by the migration (checked by the task reviewer).
- **`long-query.test.ts`'s `interrupt()` falsifier was already inert at 14be4ee**, on Adaptive.
- **Concurrency D-09 has no falsifier by construction.** Every VFS with an exclusive handle now runs
  one worker per client where that matters, so a second worker never reaches the init lock, and
  `OPFSAnyContextVFS` opens two connections at once without harm. The lock still serialises opens
  across clients and tabs; a two-client test is what would guard it. Its comment says so.

## What the `IDBBatchAtomicVFS` long-statement fix left open (2026-09-14)

- **On Safari, wa-sqlite's `async` (Asyncify) build slows down after a few long statements, and
  stays slow.** Measured 2026-09-14 on Safari 26.6.2 (IDB-SIGNAL, `mem:measurements`): after four
  ~1.5 s reads, `IDBBatchAtomicVFS` and `OPFSAnyContextVFS` ran their fourth at 11-30 s, and every
  `async` column's cached full scan ran 8-17× slower afterwards; `MemoryVFS` on the `sync` build did
  not move. Not IndexedDB (a 32 MB cache changes nothing), not the library's yield (no signal in the
  probe, and rc.4 shows it). Pre-existing; Chromium and Firefox never showed it. **The `jspi`
  build escapes it** (Safari 27.0, flat long reads and a cached scan back at baseline), and on
  that Safari the bench's two `jspi` columns answer `true` where both `async` ones stay `null`.
  The library defaults to a VFS's first declared build (`defaultBuildFor`), which is `async` for
  `OPFSAdaptiveVFS` — a recommended VFS — `IDBBatchAtomicVFS`, `IDBMirrorVFS`,
  `OPFSAnyContextVFS` and `MemoryAsyncVFS`; `OPFSAdaptiveVFS` itself was not probed.
  The default build is decided for rc.6 (the entry "Default to the first build the environment
  supports"). Still open: saying it in `VFS.md`, and an upstream report (wa-sqlite or WebKit).
- **Whether a yielding statement lets a rotated OPFS handle move between clients.** HANDLE-1 says a
  long statement never returns to its event loop; an abortable one on `async`/`jspi` now does,
  every 100 000 VM ops. Unmeasured.

## wa-sqlite's `OPFSAdaptiveVFS.js` reads `FileSystemSyncAccessHandle.prototype` at module load (2026-09-14)

Line 9, unguarded, and it is bundled into the one worker file, so where the interface is missing no
VFS loads at all, memory VFS included: Playwright's Linux WebKit 26.5 failed every column's `opens`
with `TypeError: undefined is not an object (evaluating
'globalThis.FileSystemSyncAccessHandle.prototype')`. Safari on macOS has the interface, and
Playwright's Linux WebKit was set aside earlier for limits of this kind (user). Unmeasured whether
a consumer environment lacks it; an insecure context is the candidate. Pre-existing, not scheduled.

## A timed-out read on Firefox can leave the next query meeting `GENERATOR_ABANDONED`, under load (2026-09-14)

`query-timeout.test.ts :: rejects with OPERATION_TIMEOUT and leaves the client usable` failed once
in a pre-push `pnpm test` on a loaded machine, with "Worker 1 already has a query in flight".
**What 2026-09-15 established about that test** (CI-QUERY-TIMEOUT, `mem:measurements`): it ran on
`MemoryVFS`'s default `sync` build, which cannot cut a running statement without isolation, so the
query it timed out kept its worker for its whole natural length — 22 s on Firefox, 60 s loaded.
The follow-up read was racing a worker that was still busy. The test now runs on `async` and
bounds that read.

**Chased on 2026-09-21 with the busy-loop method, and the lease holds: 0 of 40** (LEASE-QUIESCE,
`mem:measurements`). The shape was recreated deliberately — `firefox · MemoryVFS/sync`, no
isolation, so the worker stays busy 22 s — and every run's follow-up read came back, which on that
build is only possible by waiting the statement out. The detection path was proved with a positive
control rather than assumed, so the zero is a statement and not a blind spot.

**What keeps this entry open is narrow and stated: the sighting's context was a whole `pnpm test`,
tens of pages in parallel, while the campaign ran one file under CPU load.** ABANDON-WEDGE's own
lesson was that the reproducing context can be the full chain. The next arm is the whole Firefox
config under load; nobody has run it. Reliability by the triage rule, still not scheduled — and now
with one measured arm against it rather than nothing.

Carry this whichever way it goes: **`GENERATOR_ABANDONED` is wider than its name.** Two overlapping
`tx.read()`s reach the same guard with no generator anywhere, and so does an in-flight `bulkWrite`
batch (`src/pool.ts`, and the comment there says so).

## The pre-commit hook — three hooks since 2026-09-11 (user)

Decided and installed on 2026-09-11, in `package.json` under `simple-git-hooks`:

- `pre-commit` — `tsc`, then `lint-staged`, then the unit project: ~1.5 s. **While concluding a
  merge that stopped on a conflict** (`MERGE_HEAD` exists) it runs `pnpm test` instead of the
  unit project, because the commit that concludes such a merge fires `pre-commit` and never
  `pre-merge-commit`.
- `pre-merge-commit` — `tsc`, `biome ci .`, `pnpm test`. Every merge here is `--no-ff`, so
  every merge into `main` pays the full suite.
- `pre-push` — the same, as the backstop for commits made directly on `main` before anything
  reaches CI. Since 2026-09-15 it also runs CI's VFS table check, `pnpm docs:vfs && git diff
  --exit-code VFS.md` (user), after a hand edit inside a generated span of `VFS.md` failed the
  first CI run of rc.5 before it reached a single test.

Verified in a scratch repository: an ordinary commit, a clean `--no-ff` merge, a conflicted
merge concluded by `git commit` and by `git merge --continue`, and a push each fire the
expected hook and only it.

**The user's principle: the agent runs the full verification when it delivers; the hooks are
braces on the belt, not the gate** (`mem:conventions`). The full suite cost ~80 s per commit —
chromium+unit 19 s, firefox 49 s, isolated 12.5 s, measured 2026-09-11 — against under 2 s for
`tsc`, biome and the unit project together.

What the change gives up, knowingly: a browser-only regression on a feature branch surfaces
at the merge, not at the commit that caused it; a flake is sampled once per merge rather than
once per commit; a direct commit on `main` can sit red locally until the next push. And every
hook still checks the working tree, not the staged tree.

What the entry established before the decision, kept for its evidence:

- **What it has caught.** A one-in-eighteen Firefox flake at a closure, after every task
  review had passed (`mem:lessons`, "A pre-merge verification is not ceremony"); and a
  Firefox-only flake that CI alone had shown as noise for weeks, once the per-engine split put
  Firefox in the hook (`mem:lessons`, "A test that waits for a TRANSIENT state").
- **What it does not guarantee.** On 2026-09-10 commit `c2ef918` landed with a failing
  `tsc`, although the hook ends with `tsc`. Traced on 2026-09-11 from the implementer's
  transcript — full evidence in `.scratchpad/hook-forensics/c2ef918-timeline.md`:
  - **Nobody bypassed it.** No `--no-verify`, no `SKIP_SIMPLE_GIT_HOOKS` anywhere in the
    agent's commands. Its attempt at 15:11:52 was REFUSED by the hook's `tsc`.
  - **Its next attempt, started 15:13:40, was already a commit in `git log` at 15:14:05** —
    25 s in, when that hook's suite alone takes ~100 s; the captured output stops at the start
    of the suite. The hook cannot have reached `tsc`.
  - **Hypothesis, not proven:** the agent's tool cut or backgrounded the command mid-hook,
    and the hook exited without failing. The timeline file says how to test it in a scratch
    clone. If it holds, "the hook passed" is not evidence whenever the committer's shell can
    drop a long command.
  - Separately, the hook runs `tsc` against the WORKING TREE, not the tree being committed,
    and honours `SKIP_SIMPLE_GIT_HOOKS=1` and `$SIMPLE_GIT_HOOKS_RC` — two more ways a green
    hook can differ from a green commit. Only a per-commit check in a clean worktree proved the
    rest of that branch.
- **The hook file is rewritten by design, and that is harmless.** `"prepare":
  "simple-git-hooks"` reinstalls `.git/hooks/pre-commit` — same content — on every
  `pnpm install` and every `pnpm pack`, so `pnpm test:consumer` rewrites it (its first stage
  packs). A changed mtime on that file is not evidence of tampering: on 2026-09-10 at 15:02:52
  it was a subagent's unasked `pnpm store prune && pnpm install`; on 2026-09-11 it was the
  consumer smoke.

## Notes, with nothing to fix

### An abort through the shared slot reports `done`, not `error` — and that is right

The worker breaks out of its row loop rather than throwing, so the query ends with `done` and
the pool's `onServed` fires exactly as for a completed query. That looks like a
misclassification and is not one: `onServed`'s only effect is `slot.restarts = 0` in
`src/supervisor.ts`, and it means "this worker executed SQL and came back", which an
interrupted worker has just demonstrated. Withholding it would make the supervisor readier to
condemn a healthy worker. Raised by the final review of the query-interruption lot,
2026-09-05, and deliberately not changed.

### Twelve `any` remain in `src/`, and they are structural

The return type of the dynamic VFS and WASM imports inside their `satisfies`
constraints; the VFS instance, which upstream does not type (it declares only
`examples/tag.js`); `bulk.ts`'s `{ [K in KEYS]: any }` row shape, where `unknown`
breaks the `keys.map((k) => data[k])` indexing; and one overload dispatch in
`locks.ts`. Thirty-seven became twelve on 2026-08-31 and the remainder is not
worth chasing. **Re-count before citing this.**

**Kept deliberately, do not "clean up":** the no-op degradation branch in
`locks.ts`, unreachable in Node ≥ 21 and every current browser. Spec-mandated,
correct, zero maintenance.


### The library's floor is computed, not transcribed (2026-08-28)

`LIB_FLOOR` in `scripts/render-vfs-matrix.ts` is read from
`@mdn/browser-compat-data` (a devDependency) over a named list of the APIs the
published bundle uses, mobile columns from `chrome_android` / `safari_ios`
rather than inherited from desktop. The computed floors reproduced the
transcribed ones byte for byte, so the old numbers were right — they simply
could not stay right on their own. `bcdVersion` throws rather than guessing when
BCD gives `true` or `false` instead of a version.

**`FEATURE_SUPPORT`, right above it, is still transcribed by hand and cannot be
fully mechanised**: JSPI's `Safari: '27'` comes from a WebKit blog post, not from
BCD. Its "checked 2026-08-24" comment is load-bearing; do not delete it under the
impression that the file now reads everything from BCD.

**`structuredClone` was the trap.** It would have raised the floor from Chrome 92
to 98 — for an error *cause*. `cloneable()` now probes with `MessageChannel`
(Chrome 2, Firefox 41, Safari 5), which runs the same algorithm and throws the
same `DataCloneError`. The probe exists because a cause that cannot be cloned
makes `postMessage` throw *inside a catch block*, so the client receives no reply
at all and waits for ever. It lives in `src/worker/cloneable.ts` — pure, and
tested in Node, for the reason `statement-cache.ts` is.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome
86+, so a pre-86 engine cannot run the six OPFS VFS at all. What was built
instead is a classic ES5 script ahead of the module in the bench page that
watches for the module having started and, after 8 s, replaces the banner with
what is missing. It tests for the module *running*, not for syntax, so it also
covers a failed `dist/` fetch. Falsified by blocking that fetch, not reasoned
about.

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says
supported but gives no first version, the cell keeps `?` rather than adopting the
library's number — the true floor is at least that and may be higher.

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer.
`HAS_UNSAFE_HANDLES` stays on the page because it needs a worker and two access handles.

**The live rule: changing either copy obliges a review of the other, both directions.** The
page's row ids are normalized from the conformance `describe()` titles, so a row whose id
no longer maps to a `describe()` is the signal. Two places where the copies legitimately
differ and must **not** be aligned: the page returns `'blocked'` where invariant 6 logs a
`console.warn` and passes (a table has somewhere to render a third state, a suite does
not); and the page reopens the column's client after `survives-reopen` and `close-settles`,
because it runs every row against one client where the suite gets a fresh one per `it()`.

## Three things about the statement cache that no test can see

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".

**An abandoned statement's read transaction is unobservable.** `settle` resets the statement
on every non-error exit, and the reset is what ends its implicit read transaction. That an
aborted query leaves its statement cached and reusable **is** tested, with a verified
falsifier. That it leaves no read transaction open is not. With the reset removed, a second
client writing the same file still succeeds and a later read still observes it — in
`journal_mode=DELETE` and in WAL. Either the statement had already reached `SQLITE_DONE`
before the abort landed, or the lock goes back on some other path; nobody has established
which. **The prior question, if this is ever chased:** can the abort be made to land strictly
inside a `step()` that has not yet returned `DONE`? Until that is answerable, no assertion
here can discriminate.

**The one-query-per-worker invariant became load-bearing.** The cache needs no lock because a
worker holds one lease at a time. Before the cache, breaking that would have produced
confusing behaviour; now it is a `reset` on a statement another query is stepping. Nothing at
the place where someone would break it says so.
