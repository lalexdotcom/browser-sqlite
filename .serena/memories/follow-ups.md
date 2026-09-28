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

## `open-retry` "succeeds once the holder lets go" times out on Firefox — to fix, not to log (user, 2026-09-28)

**The user's priority: reproduce it on demand, then remove the cause, so that CI never fails on valid code.** It has already refused a merge (`test/needs-skip-in-matrix`, first attempt), and five sightings put it past noise. Done means a reproduction that fails on demand — under load, with a squeezed timing, or with an instrumented holder — the cause named, and the fix verified against that reproduction. A raised timeout or a retry of the test is not a fix.

**Sightings, all Firefox, all 30 s with no assertion reached, all an open against a held file:**
- 2026-09-26, the repin's matrix, twice on unrelated cells (`OPFSCoopSyncVFS/async`, `IDBBatchAtomicVFS/jspi`) — never before in seven full matrices. Alone on the same tree: 20 of 20. The repin touches no code the test runs (VFS files byte-identical; only text encoding changed).
- 2026-09-26, the same shape in another test, in the pre-merge hook's `pnpm test` with nothing else running: `pool-cap.test.ts :: … reports the storage error behind a failed open`, `OPFSAdaptiveVFS/jspi`. **A/B of the pins, `pnpm test:firefox` interleaved, 5 runs each: 10 of 10 green**, old and new alike — not attributable to the repin.
- 2026-09-27, once in ten whole-config Firefox passes under sixteen busy loops (REUSE-LOAD).
- 2026-09-28, the pre-merge hook of `test/needs-skip-in-matrix` with nothing else running, `OPFSWriteAheadVFS/sync`. The branch touches no open path and the test declares no `needs`; the same cell had passed in the branch's `pnpm test` and full matrix hours before. Alone on that cell right after: 5 of 5 green; the merge passed on its second attempt.

- 2026-09-28, in the reproduction campaign below: the real test once, `OPFSWriteAheadVFS/sync`, whole Firefox config with nothing else loaded.

**Never on CI.** Green in every CI log since the test landed (2026-09-18); CI has not run since the last push (2026-09-22), and every sighting is later.

**The hang is BEFORE the open under test (2026-09-28).** Both kept logs say `no expect assertions completed`, and the first `expect` is on `holder.take` — so what hangs is `creator.write`, `creator.close` or `holder.take`, never `db.read`/`openWithRetry` (whose 2.5 s budget would throw, not hang). The earlier lead — how long the open retries while the holder is armed — is refuted.

**Not reproducible on demand by volume** (`.scratchpad/open-retry-probe-2026-09-28/`): the test's body looped in one page, ~7 000 bounded cycles alone and beside the suite, 0 stalls; instrumented copies of the test (one run per page, its real place) beside the whole Firefox config, 240 runs, 0; the same under sixteen busy loops, 280 runs (copies and the real test), 0. One stall in ~590 real-shaped runs, and load did not raise it. Under load every step stays far inside its budget (`holder.take` p99 463 ms, max 1 005 ms; `creator.write` max 4.2 s).

**The test now names its stall** (on `main` since 2026-09-28): every await raced against one deadline at 25 s, the failure reading `stalled in <step> … done: <steps before> … holder: <steps reached> … creator: … db: <pool debug state>`. Checked by sabotage — a `getDirectory` that never settles in the holder reports `stalled in holder.take … holder: booted > getDirectory`. **At the next sighting, read the step:**
- `holder.take`, holder last at `getDirectory` — the Firefox engine hang (`getDirectory()` never settles in a worker, the rstest/Firefox silent hang entry). Test-side: the holder must bound its worker and replace it, as the conformance probe does (`6560c9e`).
- `holder.take`, holder last at `createSyncAccessHandle` — Firefox neither grants nor rejects a handle the just-closed client still holds. Test-side: the holder bounds that wait itself.
- `holder.take`, `no step` — the blob worker never booted.
- `creator.write`, a worker `never initialized` — a fresh worker's open never finishes, and nothing in the client bounds a worker's startup (not verified beyond a grep): a consumer would hang the same way. Product-side — instrument the worker's boot next.
- `creator.close` — the drain never ends; the close path.
- `db.read` — the open under test after all; `openWithRetry` and `OPFSCoopSyncVFS`'s lock.

## `vfs-folders` "opens and persists a path exactly at the bound" failed once on Firefox IDBBatchAtomicVFS/jspi (2026-09-27)

In the full matrix run to verify the #365 carry: `firefox · IDBBatchAtomicVFS/jspi` 371/1/2, the one failure `tests/browser/vfs-folders.test.ts :: … opens and persists a path exactly at the bound`, `expected +0 to be 1` — a client created a table and closed, a second client on the same name counted **0** tables. First failure since the test was added (2026-09-23); every earlier matrix had it green, including the morning's on the same pin without #365. Report kept: `.matrix/2026-09-27T20-34-42-649Z/firefox-IDBBatchAtomicVFS-jspi.txt`. **Not reproduced:** the test alone on that pair 10/10, the whole cell three times through `pnpm test:matrix --engine firefox --pair IDBBatchAtomicVFS/jspi`, 372/0/2 each. Unrelated to #365 as far as the code goes — `IDBBatchAtomicVFS` does not use `WriteAhead.js`. If it recurs: it would be a persistence loss between two clients of that VFS on Firefox, the name at the 52-character bound; keep the report and check whether the first client's close had finished its IndexedDB transaction before the second opened.

## Repin wa-sqlite: #350, #357 and #361 are merged upstream (user, 2026-09-27) — later

The user reported all three merged on 2026-09-27, and deferred the repin and the patch update.
When it is done: repin on the upstream commit that has them, then regenerate
`patches/wa-sqlite@1.1.2.patch` WITHOUT their hunks — `OPFSCoopSyncVFS.js` (#350) and
`WriteAhead.js` (#361) leave it; #357 was never carried, so it only arrives with the pin. Follow
`mem:stack-and-build` ("When one merges"): `pnpm patch`, re-apply the old patch by hand first,
check `node_modules` and the lockfile after `patch-commit`. Check what upstream merged against
what we carry before dropping a hunk — #361 changed on review. Then the matrix, per
`mem:conventions`, and the upstream reports in `docs/upstream/` for their merge.

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

## The `.mjs` scripts are not type-checked (2026-09-24)

`tsc` covers `scripts/*.ts` since 2026-09-24, but no `allowJs`/`checkJs` is set, so the `.mjs` files are only linted and formatted by biome. Measured with `checkJs` and `@types/node` on 2026-09-24: **84 errors** — `consumer-smoke.mjs` 44, `bench/check.mjs` 19, `bench/dev.mjs` 12, `matrix-triage.mjs` 5, `static-server.mjs` 2, `bench/assemble.mjs` 1, `bounded.mjs` 1. Not triaged: how many are JSDoc-less inference noise and how many real is unknown.

## `db.debug` — for the documentation review session (user, 2026-09-24)

`API.md` has no `## *client*.debug` section: the property appears only in the options table (`debug` row: "the `db.debug` introspection tree"), which advertises it without saying what it holds or when it is `undefined`. Meanwhile `SQLiteDB.debug` is tagged `@internal` in `src/api.ts` ("Not part of the stable public API. Shape is subject to change without notice."), yet no `stripInternal` is set, so it ships in `dist/api.d.ts` with `ClientDebugState`. The docs and the tag disagree on whether it is public; the review settles which, and documents it or stops advertising it. Its type is also only partly readonly (`workers`, `requests`, `queries`, `currentRequest` and every `QueryDebugState` field are mutable).

## The bench's `pool N → M` header has not been seen on Safari (2026-09-23)

`feat/db-ready` made each column header show the pool it ran on once `db.ready` resolves. `check.mjs` verified it on Chromium and Firefox (Firefox exports `poolSize` 1 for the `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` pairs). On Safari the `OPFSAdaptiveVFS` columns should read `pool 4 → 1`; the user has not run it yet (serve from the container, `mem:conventions`).

## `db.debug`: a worker's `currentRequest` is never cleared (2026-09-28)

`createClientDebug`'s `assign` sets `worker.currentRequest` when a request gets its worker (`src/debug.ts`), and nothing unsets it — the release only stamps `releaseTime` (`src/client.ts`). So an idle worker, and every worker of a closed client, reports its LAST request as current. Found building `open-retry`'s stall report, which read `a request in flight` on a client already closed; the test now counts a request as running only while `releaseTime` is unset. `db.debug` is public (`API.md`), so a consumer reading `currentRequest` gets the same wrong answer.

## Firefox page crash on `lifecycle.test.ts` under a full run (2026-09-23)

**First sighting (2026-09-23).** The pre-merge `pnpm test` of `feat/db-ready` stopped with `Browser page crashed while running tests/browser/lifecycle.test.ts` on the Firefox config — no test failed, the file did not finish. Not reproduced: 10 of 10 runs of the file alone on Firefox clean, then the full `pnpm test` that concluded the merge green, and every earlier run that day (full suite, 22 Firefox matrix cells) clean. Unknown whether the new silent blob workers play a part — since 2026-09-25 the all-workers-gone test uses them too (`silentWorkersFromIndex`), so a second test of the file now spawns them; the next sighting should keep its `pnpm test` log.

**Second sighting, same day, on `feat/vfs-folders`** — the same message on the same file in the Firefox leg of a full `pnpm test`, run by a subagent after the dot-folder change; the file alone 34/34, the full rerun green. **The log was not kept this time either.** Two sightings in one day, both under a full parallel run, both clean in isolation: the next one must be captured — keep `.scratchpad/` logs of every full run until it is.

**Three more on 2026-09-28, logs kept** (`.scratchpad/open-retry-probe-2026-09-28/`: `suite-pass-1.log`, `suite2-pass-20.log`, `copies-pass-9.log`). The whole Firefox config (its two default targets) with the `open-retry` probe files beside it, no busy loops: **3 crashes in 42 launches**, every one on `lifecycle.test.ts`, and each ends the whole run 20-50 s in, the remaining files never run. Where it can be told, the crashed page was `OPFSAdaptiveVFS/jspi` — the other target's `lifecycle` finished 17/17 in two of the three — and with the 2026-09-26 matrix cell on `IDBMirrorVFS/async` it is not tied to one VFS. In all three the file's last lines are in the "startup readiness gate" group, but both projects' lines interleave in one log, so which test was running when the page died is not established.


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
  (`src/const/vfs.ts`), so `pairFor()` needs the answer in every browser test — on demand or at load,
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

## wa-sqlite's `autoCheckpoint` never reads the value it is given — upstream candidate (2026-09-22)

`#autoCheckpoint()` (`WriteAhead.js`) tests `this.options.autoCheckpoint > 0` and nothing else, so 1, 100 and 1000 all mean "after every transaction" — the option is a boolean wearing a number. The pragma parses a real integer (`OPFSWriteAheadVFS.js`, `case 'wal_autocheckpoint'`) and then nobody compares against it. Upstream's own comment says as much: *"A setting greater than zero enables automatic checkpoints"*. That case ends on `break` rather than `return SQLITE_OK`, so it falls through to `SQLITE_NOTFOUND` and SQLite processes the pragma too — inert, this VFS implementing its write-ahead below SQLite.

**A cheap correctness point, and it is NOT a performance fix** — the threshold was measured and refuted as one (AUTOCHECKPOINT-THRESHOLD, `mem:measurements`): the response is a step, not a curve, and the knee belongs to the workload. Worth asking for on its own; **the checkpoint cost is already addressed** by #361 (`docs/upstream/2026-09-23-…`), submitted and carried in `patches/`.

**Three things block a drive-by threshold**, kept because they are true of the code: `journalSizeLimit` already defaults to 1000 pages and is a *rotation* threshold evaluated in the same commit function, so equal values collide; `#backstop()` does not checkpoint, so nothing drains an idle connection once the threshold rises; and `=0` stops rotation for ever, since `#isInactiveFileEmpty()` short-circuits on a `#mapIdToTx` that only a checkpoint drains.

## `page_size` on `OPFSWriteAheadVFS` — a lever we hold, not yet advice (2026-09-22)

32 KiB instead of 4 KiB made the whole bulk insert 3.25× faster on Chromium, 1.18× on Firefox (PAGE-SIZE, `mem:measurements`). No upstream dependency at all. **Not a recommendation yet:** bulk insert is the friendliest case for large pages, and a scattered-update workload has never been measured. Measure that before it goes anywhere near the docs.

## Two worker fallback messages carry the path (2026-09-23)

`src/worker/worker.ts`'s open and delete fallbacks read `Failed to open ${file}` / `Failed to delete ${data.file}`, and since `feat/vfs-folders` the worker only knows the path (`.ad/name`). They fire only when something that is not an `Error` is thrown, and `startupError` forwards the text verbatim, so no client wrapping re-adds the logical name. Parked by the controller's ruling: the path is the only identifier the worker has. Reattaching the logical name would mean sending it to the worker or wrapping on the client side.

## Smaller things this branch left open (2026-09-15)

- **`handleDeath`'s guard for a slot-0 loss before the probe has no test** — no path was found that reaches
  it with the probe unanswered; it is defensive (`a0373c0`).


## Three browser tests guard less than their comments said (2026-09-14)

Found by `fix/pool-environment-cap`'s Task 10 and its reviews:

- **`barrier.test.ts` does not guard the barrier — because nothing observable does (spike, 2026-09-25).**
  Deleting the barrier statement leaves all six tests green on every declared pair, Chromium and
  Firefox (44 cells), with a positive control proving the path is reached. Bisected in a worktree
  holding today's `node_modules`: the two single-client tests went inert at `8bc0bf1` (last-writer
  routing sends the read to the fresh writer), the two-client ones at `aee3859` (statement cache).
  **`aee3859` is the real cause:** it moved `sqlite.column_names(stmt)` after the first `step()`.
  The old worker read the names BEFORE stepping, so a statement prepared on the old schema and
  re-prepared by SQLite at `step()` returned fresh rows under stale names — exactly the spec's
  `{"old_col": 42}`. Reverse-mutated on today's code (names read before the step): all seven
  schema scenarios go red without the barrier, and most stay red WITH it, since a cached statement
  keeps its old prepare. **So the staleness the barrier was built for was our worker, not SQLite;
  the tests are regression tests of the column-name capture, which is their real falsifier.**
  **Data staleness, probed the same day (BARRIER-DATA, `mem:measurements`): 3 stale reads in 1232
  without the barrier, 0 in 1232 with it, under incidental load; 0 / 480 in a focused loop, idle
  and loaded, in both arms.** So the barrier may guard something rare and nothing reproduces it on
  demand: it stays, and it still has no falsifier. Cross-tab needs no probe of its own — without
  the barrier there is no shared state left, and two tabs are two clients' workers to SQLite. The
  next step, if anyone chases it, is a reproduction of the three sightings' conditions (a loaded
  full run of the data probe), not a longer loop. Probes kept in `.scratchpad/barrier-spike-2026-09-25/`.
  **That reproduction was run on 2026-09-27 and it reproduces** (BARRIER-DATA, `mem:measurements`):
  under sixteen busy loops, 37 of 616 tests stale without the barrier, 0 of 616 with it, on the same
  cells — all on Chromium, every scenario, growth included. The barrier guards data freshness for
  real. **Cause found the same day (BARRIER-DATA): `OPFSWriteAheadVFS`'s read isolation.** A read
  transaction freezes the connection's view as the `BroadcastChannel` has left it, without reading
  the write-ahead to current as a write does; under load the writer's `tx` message is processed
  after the next read starts. 28/100 stale as shipped, 0/100 with `isolateForRead()` reading to
  current, 9/100 on the pre-#355 code. The barrier only buys time. **The race is traced** (BARRIER-DATA):
  the `tx` broadcast and the read's `query` take two channels with no ordering between them, and
  the stale reads are the ones where the query arrives first — present before #355, which only
  widens it. **Submitted upstream as rhashimoto/wa-sqlite#365 on 2026-09-27** (report
  `docs/upstream/2026-09-27-wa-sqlite-365-writeahead-read-freshness.md`); branch
  `fix/writeahead-read-catches-up` on the fork (`.work/wa-sqlite-readfresh`, `1273bb48` on upstream
  `e6e01ae1`): `isolateForRead()` reads the WAL to its end. Its test, in wa-sqlite's own suite,
  is deterministic — a reader worker blocks its event loop while a writer worker commits, then
  reads before its context delivers the broadcast: `1` for `2` on master, 8/8 runs, both builds.
  Two connections in ONE context share a `WriteAhead` view and cannot reproduce it. Cost ≈ 5 µs
  per read transaction on asyncify. Body in
  `.scratchpad/writeahead-read-freshness/pr-365-writeahead-read-freshness.md`. **Carried in
  `patches/` since 2026-09-27.** **2026-09-28: answered "by design", now opt-in, and the library
  sets it in the barrier.** rhashimoto keeps reads eventually consistent on purpose: reading to
  the end scans the uncommitted frames of a large open write on every read (~2 ms per MB,
  365-WORST, `mem:measurements`). The PR's second commit `ac817fd6` makes it
  `PRAGMA read_to_current`, off by default; the patch carries that revision. Our barrier on
  `OPFSWriteAheadVFS` runs its read between `read_to_current=1` and `=0` (`catchUpPragma`,
  `barrierSqlFor`), so the reads after a commit are current by construction and reads during a
  large open write scan nothing (365-LIB). **What is still open:** the barrier has no falsifier
  that fails under load — the old timing-only barrier read 0/100 even under 48 busy loops, so
  the pragma's gain is shown by wa-sqlite's deterministic test, not by ours. When #365 merges
  (or is closed), repin or regenerate the patch per `mem:stack-and-build`; if upstream names the
  pragma differently, `catchUpPragma` is the one place to change.
- **rstest's pages are off-the-record: OPFS sync-access-handle calls cost 160-290 µs there against
  0.6-2.6 µs on a persistent profile (RSTEST-OTR, `mem:measurements`, 2026-09-28).** rstest opens
  pages with Playwright's `browser.newContext()`. Every absolute OPFS timing taken under rstest —
  the checkpoint and page-size campaigns included — carries that per-call cost; ratios between
  arms of one run still compare. Not acted on: whether to measure OPFS in a persistent context
  (wa-sqlite's runner, or a Playwright `launchPersistentContext` harness) is the user's call.
- **`OPFSAnyContextVFS` releases its lock with a truncation still invisible — `disk I/O error` on
  Firefox (2026-09-25). FIXED in our build by a `patches/` hunk, submitted upstream as
  rhashimoto/wa-sqlite#363** (report `docs/upstream/2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md`).
  When it merges: repin and drop the hunk, per `mem:stack-and-build`. Guarded here by `tests/browser/vacuum.test.ts` (need
  `in-place-file`, added for it); upstream by `test/vfs_xUnlock.js` (8192 for 4096 on master). Full
  matrix with the patch, 2026-09-25: 66/66 cells green (`.matrix/2026-09-25T15-18-33-368Z`). Seen as `VACUUM` + two concurrent reads failing
  in one client with two workers; on Firefox `needs: ['two-workers']` resolves to
  `OPFSAnyContextVFS` whatever the target, 8-12 of 20 per run, never on Chromium (20/20 on the same
  pair). The failing statement is the READ on the other worker, `SQLITE_IOERR_READ` (266).
  **A `BroadcastChannel` trace of the VFS shows the mechanism:** `jTruncate` opens a writable and
  leaves it open; SQLite calls no `xSync` after the post-commit truncation, so the writer unlocks
  with the truncation unpublished. The reader takes `SHARED`, `getFile()` returns the OLD file
  (2 232 320 bytes against 8192), the writer then closes its writable for its own next read, and
  the reader's `File` snapshot dies with `AbortError`. **Hypothesis tested:** closing a pending
  writable in a `jUnlock` override, before `super.jUnlock`, gives 60/60 on Firefox (jspi and async)
  and 20/20 on Chromium. Upstream master (`e98c65d`, our pin) has no such close; upstream issues not
  searched yet (`gh` is available since 2026-09-28). Same shape as #361: an upstream PR plus a `patches/` carry. Probes and the
  instrumented VFS in `.scratchpad/vacuum-ioerr-2026-09-25/`. Also worth knowing: in that window a
  reader could read the pre-truncation file rather than fail, if its read wins the race.
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
  Since 2026-09-24 an omitted `build` loads `jspi` wherever the engine has it, so Safari 27+ escapes
  it by default; `VFS.md`'s `async` note says so. Still open: an upstream report (wa-sqlite or WebKit).
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

### `pool-cap`'s surplus-slot flake — margin widened, never reproduced; closed by the user on 2026-09-27

**The test.** `tests/browser/pool-cap.test.ts :: a pool capped by its environment > a surplus slot that times out, then declines in the retry round, is not announced lost` — Firefox only (`CAPPED`, no `readwrite-unsafe`). It holds slot 1's round-1 `open` back so round 1 gives up on it, then lets the retry decline, and asserts no `onWorkerLost`, a pool of 1, no warning.

**The flake and its mechanism.** Seen under load as `Worker 1 did not become ready within 600 ms`: `openTimeout` is client-wide, so it also governs slot 0's HEALTHY worker, and it was that one that missed. Squeezed on an idle machine, slot 0 needs some tens of ms (10, 25, 50 ms fail; 100 ms passes). `2be2ae6` (2026-09-21) moved `openTimeout` 600 → 3000 (~10× → ~50×) and the held-back `open` 3000 → 15000.

**Why it is closed although the cure is not demonstrated.** The flake was never reproduced, before or after — 64 busy loops left both budgets green — and on 2026-09-27 it ran in all ten whole-config Firefox passes under sixteen busy loops without failing (REUSE-LOAD, `mem:measurements`).

**If it is seen again:**
- Keep the whole run log and note the engine and the message — `did not become ready` means slot 0 missed the shared budget again.
- **Do not scale the numbers a third time.** The next move is a budget of slot 0's own, which is a product change: `openTimeout` is one option for the whole client.

### `WORKER_BUSY` seen once on 2026-09-14, never reproduced — closed by the user on 2026-09-27

**The sighting.** `query-timeout.test.ts :: rejects with OPERATION_TIMEOUT and leaves the client usable` failed once in a pre-push `pnpm test` on a loaded machine, with "Worker 1 already has a query in flight" — the reuse guard, now `WORKER_BUSY` (`src/pool.ts`). The log was not kept. That test then ran on `MemoryVFS`'s default `sync` build, which cannot cut a statement without isolation, so the timed-out query kept its worker for its whole natural length (22 s on Firefox, 60 s loaded) while the follow-up read raced it; it has run on `async` with that read bounded since 2026-09-15 (CI-QUERY-TIMEOUT).

**Chased twice, in both contexts, 0 each** — one file under sixteen busy loops, 0 of 40, with a positive control proving the detection path (LEASE-QUIESCE, 2026-09-21); the whole Firefox config ten times under sixteen busy loops, 0 in 7 453 tests (REUSE-LOAD, 2026-09-27). Both in `mem:measurements`.

**If it is seen again:**
- **Keep the whole `pnpm test` log** and note the engine, the target project and the test.
- It was at the CLIENT level (`db.read` through the scheduler), so the transaction queue does not explain it. With transactions serialised the guard means one thing only: **the scheduler handed a lease for a worker that was not idle** — that is the sentence to test, starting from where the lease is returned (`quiesce()` in `onReadLease` and `streamWithRetry`, `src/client.ts`).
- Before trusting a reproduction, check it aborts the statement it names: a wait on "a worker is running" once let aborts land on the freshness barrier (`mem:lessons`, 2026-09-27).

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

## #361: one allocation per checkpoint — waiting on rhashimoto (2026-09-26)

Suggested in the reply to his review, not implemented: the plan executor allocates one `bufferSize` region per checkpoint instead of a buffer per read and per write. Holds for both planners (every write retires every read before it). Should bring the executor below `master` in memory, not only in time (CHECKPOINT-PLAN, `mem:measurements`). **His choice: this PR or a follow-up.** Until then the patch carries the per-call executor.

## `aWorkerIsRunning` also matches the barrier, so an abort can land before the query is sent (2026-09-27)

**Diagnosed by a trace of the whole abort path** (`.scratchpad/interrupt-drain-2026-09-27/`, instrumented copies of `pool.ts`, `queries.ts`, `client.ts`, reverted). On a fresh client the first statement a worker runs is the freshness barrier (`SELECT count(*) FROM sqlite_master`), and `aWorkerIsRunning` (`tests/browser/helpers.ts`) is true for ANY running statement. A test that waits for it and then aborts can therefore abort during the barrier: the rejection comes from the acquisition race, the barrier ends in milliseconds, and **the query under test is never sent**. The list of statements sent says so: at the abort, Chromium had sent only the barrier 6 times in 6; Firefox had usually sent the long query too, but not always (2 in 6).

That is the whole "Firefox waits, Chromium does not" difference seen on `interrupt.test.ts`'s sync test: on Chromium the 20 M-row read never ran, so `close()` had nothing to wait for; on Firefox it usually ran, and `close()` waited it out (`ABORTING`, then the lease back at `done`, 22 s later — the correct behaviour). **No product defect; the earlier reading here, a worker lent back mid-statement, was wrong and is refuted by the same trace.**

**Fixed on `fix/abort-waits-for-its-query`:** `aWorkerIsRunning` is gone; `theQueryIsRunning(db, sql)` waits for a worker `RUNNING` on that very SQL (the debug state's current query). Every call site names its own query. Proved on the one test that started on a fresh client with a named falsifier — `abort-slot`'s "does not carry a dead worker's abort into its replacement": with the slot zeroing removed it stayed GREEN under the old helper and goes red under the new one. The sync test in `interrupt.test.ts` now also asserts the statement runs on (`ABORTING` 300 ms after the rejection); falsified by pinning `build: 'async'`, which is back to `READY` by then, on both engines.

## `test-matrix` shows a crashed cell as green-looking — seen 2026-09-26

In the repin's matrix, Firefox `IDBMirrorVFS/async` reported **204/0/2**: "Browser page crashed while running `tests/browser/lifecycle.test.ts`", 38 of 57 test files run, `failedTests: 0`. The table prints pass/fail/skip only, so the cell reads as green; only the script's exit code (1) and the raw report's `"status": "fail"` said otherwise — and the exit code was blamed on the two `open-retry` timeouts. Caught by the whole-branch review, not by the monitor. Rerun alone three times: 370/0/2, 57 files, no crash. **Two things open:** the crash itself (once in every `.matrix/` run so far), and `test-matrix.mjs` should mark a cell whose report status is `fail` or whose file count falls short, whatever its failed-test count. Until then, a monitor must match the report status, not the counts.

