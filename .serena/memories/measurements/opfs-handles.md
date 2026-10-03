# Measurements — OPFS access handles, pool caps, leaks

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## LEAK-LIB — what #350's class of leak costs this library, per VFS, 2026-09-30, Chromium 151 / Firefox 153, this container

**Method.** rstest pages, each VFS on its builds. A blob worker holds one file with an exclusive `createSyncAccessHandle`. The red arm is the installed wa-sqlite with one PR's change reversed — `patch -R` of that file's part of `patches/wa-sqlite@1.1.2.patch`, and of upstream `5113ecb2` for #350 — then restored and compared byte for byte.

| scenario | with the fix | fix reversed |
|---|---|---|
| `AccessHandlePoolVFS` (#368): one pool file held at the first `create()`, released once another pool file is seen taken | the read resolves 168-701 ms after the client is created, 8 of 8; `vfs-create-retry.test.ts` alone 52 of 52 | `WORKER_CRASHED`, cause `NoModificationAllowedError`, after 10.1-10.4 s, 12 of 12, both engines |
| `OPFSCoopSyncVFS` (#350): `open-retry.test.ts`, "succeeds once the holder lets go" | green (the baseline) | red 8 of 8, both engines: `unable to open database file: NoModificationAllowedError` |
| `OPFSAdaptiveVFS` (#369), Firefox: the database file held, a client fails, the holder lets go, a new client opens | opens | opens, 7 of 7 (`jspi` 4, `async` 3), the failed client closed first or not |
| `OPFSWriteAheadVFS` (#367), Firefox: the database file, `-wa0` or `-wa1` held, a client fails and is closed, a new client opens | opens | opens, 30 of 30, the three builds |
| the same two VFS on Chromium | opens | opens, every case |
| wa-sqlite #362 simulated: a stale `.ahp-*` directory whose file is held 1.5 s while an `OPFSCoopSyncVFS` client opens | the read resolves 1554-1631 ms after the client is created, 8 of 8, both engines; the directory is gone afterwards | the same, 8 of 8 — the sweep involves none of these fixes |

**Why two VFS have no exposure.** A worker whose open fails posts `open-error`, and `handleDeath` terminates it: the Web Lock and the handle it kept go with it. Only `createVfsInstance` and `openWithRetry` try again inside one worker, which is `AccessHandlePoolVFS` and `OPFSCoopSyncVFS`. On `OPFSAdaptiveVFS` the kept lock `OPFS:/<path>` was listed by `navigator.locks.query()` right after the failure in one run of seven, and the reopen went through all the same.

**A failed client kept its connection lock until `close()` — fixed the same day (user's decision): `failClient` now releases it, guarded by `tests/browser/failed-client.test.ts`.** What follows is the behaviour before the fix. `failClient` released the client's roster marker and not `connRelease`. On Firefox, where `OPFSWriteAheadVFS` takes that lock exclusively, the client created after a failed one that was not closed gets `DATABASE_IN_USE`: 6 of 6 with the fixes in place (`sync` and `jspi`), 6 of 6 with them reversed; it opens once the failed one is closed. On Chromium, where the lock is shared, it opens, 6 of 6. `deleteDatabase` asks for the lock exclusively, so it is refused on both engines: `DATABASE_IN_USE` 12 of 12 after a failed client that was not closed (`OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi`, 3 each per engine), while `inspectDatabase()` answers `clients: []`, `tabs: 0`; it succeeds once the failed client is closed, 12 of 12.

**How a killed worker lets go of the pool, and whether the library meets it.** A client on `AccessHandlePoolVFS/sync`, its worker killed through a dispatched `error` (the library terminates it), idle or inside `longQuery(40_000_000)`; a blob worker then replays the pool's acquisition — every file at once — about every 3 ms until all six are granted. Ten runs per case.

| | released | an attempt granted only part of the pool |
|---|---|---|
| Chromium, idle | all six at the first attempt or by 3 ms | 0 of 10 |
| Chromium, inside the statement | none for 2.00 s, then all six at 2001-2006 ms | 0 of 10, ~680 attempts each |
| Firefox, idle or inside the statement | all six by 1-6 ms | 5 of 20, one or three files |
| Firefox, the same under sixteen busy loops | all six by 21 ms at most | 7 of 40, one to five files |

So Firefox releases them one by one and Chromium at once. Chromium's 2.00 s is Blink's `kForcibleTerminationDelay` (`base::Seconds(2)`, `third_party/blink/renderer/core/workers/worker_thread.cc`): the grace given to a worker still running script before it is terminated by force — the engine's, neither wa-sqlite's nor this library's. The library never met the partial hold: with a restart allowed, the read after the kill answered on the replacement worker 100 times of 100 **with #368's change reversed** — Chromium 43-55 ms idle and 2077-2098 ms inside the statement (10 each), Firefox 49-60 ms (40), Firefox under the busy loops 105-197 ms (40). The replacement's first `create()` comes long after the window. With the change, the same figures (Chromium 43-50 and 2076-2095 ms, Firefox 50-57 ms, 10 each).

**`OPFSCoopSyncVFS` `#initialize()` with a temporary file that fails.** Upstream `5be9cd14` alone, Playwright persistent profiles, a worker whose third `.tmp` `createSyncAccessHandle` rejects once with `QuotaExceededError`; 17 scenarios per engine. `create()` fails, its directory keeps the files created and its Web Lock stays held. Every later `create()` succeeded: in another worker, in the same worker, after a collection, after the worker terminates. On Chromium (`gc()` exposed) the collection releases the lock and the next `create()` sweeps the directory, so the handles went with the instance. On Firefox the collection could not be forced: the lock stays, the directory is skipped as in use, and it is swept once the worker is gone. The consequence read in the code — a lock released with its handles still open, and every later `create()` failing on the sweep — did not occur.

**`close()` then `deleteDatabase()` at once on `AccessHandlePoolVFS`**, the other caller of `createVfsInstance`, with #368's change reversed: the deletion succeeded 60 times of 60 — Chromium 35-48 ms, Firefox 50-85 ms, Firefox under sixteen busy loops 97-213 ms, 20 each.

**wa-sqlite #362 with the real navigation.** A page opens `OPFSCoopSyncVFS`, keeps it open and navigates to itself, ten runs, two passes; Playwright persistent profile. The back/forward cache needs the full Chromium build: `channel: 'chromium'` with `--disable-back-forward-cache` removed from the default arguments. The headless shell never caches (`BackForwardCacheDisabledForDelegate`), and every run then passes for the wrong reason. Each page left with `pagehide.persisted === true`.

| after a cached page | first open | |
|---|---|---|
| wa-sqlite alone (upstream `5be9cd14`), as in the issue | fails 18 of 18, `NoModificationAllowedError` on `removeEntry`, 21-35 ms in | a second worker then opens, 18 of 18 |
| this library's built `dist/` | succeeds 18 of 18, in 135-144 ms against 55-58 ms with no cached page | the rows written by the earlier pages are read back |

The ~85 ms added is one turn of `createVfsInstance`'s retry. On Firefox the condition does not arise: with its cache enabled (`fission.bfcacheInParent: true` and `browser.sessionhistory.max_total_viewers: 4` in `firefoxUserPrefs` — Playwright's build sets the first to `false` — after which a page with nothing in it leaves with `persisted === true`), a page holding the database open still leaves with `persisted === false`, and the next page's first open succeeds, 9 of 9 for wa-sqlite alone and 9 of 9 for the library (53-73 ms).

## COOPSYNC-OPEN-CLOSED — the two `sqlite3_open_v2` cells do not come back, 2026-09-21, this container

Method: the one cell that ever carried them, `BSQ_TEST_TARGETS=OPFSCoopSyncVFS/sync pnpm exec rstest
--config rstest.config.ts --project 'chromium*' run`, eight consecutive times on an otherwise idle
machine. **8 of 8 green** — 337 tests, 333 passed, 4 skipped, 0 failed on every run, ~32 s each, and
no `sqlite3_open_v2` anywhere in the output. The two files execute rather than skip on that target:
run alone they give 18 tests, 0 skipped.

With the two full matrices since the fix (2026-09-18 15:50 and 2026-09-21) that is **ten clean runs
of that cell**. It failed 5 times in 14 full-cell runs before (36 %, VFS-PILES above), which puts ten
consecutive greens at ~1 % by luck. Cause and fix: wa-sqlite #350, the partial-acquisition leak, with
`exclusiveFileHandle` and `openWithRetry` on our side. **What remained of the subject was
diagnosability alone** — `jOpen` swallowed the cause — and wa-sqlite #357 settled it (pinned 2026-09-28).

## SAFARI-CAP — the pool caps hold on Safari and Firefox, 2026-09-14, the user's Mac + this container

Safari 26.6.2 macOS, `readwriteUnsafe: false`: one run at preview
`5db2c8b` (`…20260914142953…`), three at preview `29fbc71` (`…150411…`, `…150425…`, `…150436…`).
Firefox 153 linux, this container: three at `main@29fbc71` (`…130632…`, `…130832…`, `…131030…`).
`poolSize` **1** on every column of `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS` and `OPFSCoopSyncVFS`,
every build, every run; `reasons` empty; conformance all pass. At `5db2c8b` the page still "passed"
the two two-worker rows on WriteAhead and Adaptive at one worker — the BENCH-DRIFT copy had not
followed conformance's `oneWorkerHere`; since `29fbc71` they report `skipped`, and so does
`reads-during-long-query`. The console at `5db2c8b` (the user's screenshot) showed only the cap
warnings — eight for WriteAhead, four for Adaptive, one per bench client since the page passes
`poolSize: 4`, none for CoopSync — and no `lost` line, no wa-sqlite error pair, no `jDelete` error.

**`OPFSWriteAheadVFS`'s lead over `OPFSAdaptiveVFS` holds at equal pool** — every column below
ran one worker. Medians of 3 runs, ms; Safari and Firefox are different machines, so compare
within an engine only.

| Safari | WA sync | WA async | Adaptive async | CoopSync sync | CoopSync async |
|---|---|---|---|---|---|
| write p50 | 0.4 | 0.4 | 1.2 | 0.6 | 0.6 |
| point read p50 | 0.25 | 0.25 | 0.55 | 0.25 | 0.3 |
| transaction | 25 | 29 | 34 | 26 | 33 |

| Firefox | WA sync | WA async | WA jspi | Adaptive async | Adaptive jspi | CoopSync sync | CoopSync async | CoopSync jspi |
|---|---|---|---|---|---|---|---|---|
| write p50 | 1.2 | 1.4 | 1.4 | 3.4 | 3.6 | 1.8 | 1.8 | 2.2 |
| point read p50 | 0.4 | 0.4 | 0.5 | 0.85 | 0.9 | 0.4 | 0.45 | 0.55 |
| transaction | 64 | 68 | 71 | 66 | 73 | 66 | 65 | 71 |

So the 2026-09-04 gap was not pool size: Adaptive writes and point reads cost 2-3× WriteAhead's on
both engines, build for build; transactions are close on Firefox.

## WORKER-LOST — why `OPFSWriteAheadVFS` lost workers off Chromium, 2026-09-13/14, this container + the user's devices

Method and full tables: spec `docs/superpowers/specs/2026-09-13-pool-environment-cap-design.md`
§6. Firefox 3 runs per probe, Chromium control.

- **Structural, not a race:** `OPFSWriteAheadVFS` at `poolSize` 1/2/4 lost 0/1/3 workers on Firefox,
  3/3 runs, on all three builds; 0 on Chromium; `OPFSAdaptiveVFS` at 4 lost none anywhere. Which
  slot survived varied — the race is for the VFS's `#open` lock.
- **Cause:** a second `createSyncAccessHandle({ mode: 'readwrite-unsafe' })` on a held file rejects
  — `NoModificationAllowedError` on Firefox, `InvalidStateError` on Safari (WebKit's exclusive
  `acquireLockForFile`); `h.mode` is undefined off Chromium, so the option is ignored.
- **The probe that fixes it:** `'mode' in FileSystemSyncAccessHandle.prototype` in a dedicated
  worker — Chromium true, Firefox false, Safari false (the user, in Safari's console);
  `typeof FileSystemSyncAccessHandle` is `"undefined"` in the page on both local engines.
- Each failed open printed two console lines — `jOpen`'s empty `e.stack`, then `jGetLastError`'s
  error: six pairs at `poolSize` 4 (the user's Safari and Firefox consoles, preview page).
- **Why nothing saw it:** rstest's markdown reporter omits a passing test's console; with
  `--reporter default` the Firefox suite printed 12 `lost` lines, every one intended.

## POOL-SIZE — a pool buys nothing on a rotated exclusive handle, 2026-09-14, this container

Method and table: spec §10.1. Fresh client per sample,
sizes 1/2/4 rotated per iteration, 2 warm-ups + 5 measured, 3 runs per engine, medians, 2 000 rows.

- **Firefox `OPFSAdaptiveVFS` (reduced):** startup 70-76 ms @1 against 129-136 @4; five bursts of
  eight reads 71-74 against 117-130; a read during an open write transaction ≈ 265 ms at every
  size; a table read during a long table query waits out the query at every size.
- **`OPFSCoopSyncVFS`:** bursts 44-47 @1 against 118-129 @4 on Firefox, 25-28 against 86-94 on
  Chromium; a read during a write transaction waits at every size, on both.
- **Control, Chromium `OPFSAdaptiveVFS`:** bursts 60-82 @1 against 44-53 @4; a read during a write
  transaction 263 ms @1, 3 ms @2 and @4 — the probe does discriminate.
- The one cost of a pool of one found: a query touching no table waits behind a long query instead
  of running beside it. Point reads, writes, transactions and scans: equal at every size.
- The first long-query arm touched no table and measured nothing (`mem:lessons`). Not measured:
  Safari; anything across tabs.

## HANDLE-1 measured per VFS — 2026-09-04, four platforms, `preview` on Pages

**Method.** The bench page's `reads-during-long-query` row, which races a short read against
a long statement holding one of the pool's workers: the read winning means it was served
without waiting. No clock, no threshold. Ten exports across four platforms, `poolFor` = 4 for
every VFS below, so "no other worker" is excluded.

| engine | served | waited |
|---|---|---|
| Chromium 150 (has `readwrite-unsafe`) | Adaptive, WriteAhead, AnyContext | CoopSync, IDBBatchAtomic |
| Safari 27 (no RWU, macOS + iPadOS) | AnyContext/jspi only | everything else |
| Firefox 154 (accepts RWU, ignores it) | AnyContext only | everything else |

**Corrected 2026-09-14 — two cells of this table are not what they say.** IDBBatchAtomic's
"waited" is the **unsignalled** path: the row passes a `signal`, which reached the worker only from
`f4b3fd7`, after these exports, and at `29fbc71` the same row reports it served (IDB-SIGNAL,
above). WriteAhead's "waited" off Chromium ran on **one live worker**, the other three lost
(WORKER-LOST, above). The one-handle OPFS columns were not re-measured under a yielding statement:
since `29fbc71` the row skips a column whose pool runs one worker.

**The partition follows `readwrite-unsafe` exactly** — the README's central limitation, until
now stated in prose and inferred from `read-burst` ratios. The read-burst gains agree
independently: 0.89-1.45 across twenty non-AnyContext columns on Safari and Firefox.

**`OPFSAnyContextVFS` is the only OPFS VFS serving concurrent reads without RWU**, which makes
it the one to suggest to a Safari or Firefox consumer who reads while working. It is also the
worst writer measured here — 13-18 ms for a single INSERT against 0.2-0.6 ms, and 695-821 ms
on the 500-UPDATE row against 32-125 — so it is a trade, never a winner.

### `OPFSWriteAheadVFS` beats the default on Safari on every axis but concurrency

macOS Safari 27, 2026-09-04, `sync` against the default `OPFSAdaptiveVFS/async`. **n=1.**

| | default | WriteAhead/sync |
|---|---|---|
| write p50 | 2.00 ms | 0.60 |
| write **p95** | 8.60 ms | **1.00** |
| point read | 1.90 ms | 0.20 |
| page of a list | 4.60 ms | 2.00 |
| full scan | 16 ms | 10 |
| transaction | 44 ms | 31 |

This is what refuted `mem:vfs`'s "outside Chromium it earns nothing over the default", which
had been generalised from a read-burst measurement about concurrency alone.

### What the grouping recovered

`point-read` was nulling 61 cells of 88 on iPadOS before being timed in groups of 20;
`write-latency` 14 of 22 on both Safaris and 18 of 22 on Firefox, `list-page` 10 of 22 on
Firefox, before groups of 5. The cause was always the clock — 0.1 ms on Chromium, 1 ms on
Safari and Firefox — never the dataset.

After, and it is not uniform:

- **Chromium and both Safaris: clean.** One null cell in a whole 22-column export, and it is
  `reads-during-long-query` failing its 1.5-3 s calibration — the row declining to answer
  rather than guessing. iPadOS shows one to three of those, `/async` builds only.
- **Firefox 154 still nulls 8 of 22 on `write-latency-p50`** and 3 on the p95, on the
  fastest columns: `AccessHandlePoolVFS` and the two memory VFS run at 0.1-0.4 ms per
  insert, so even ×5 stays under the 2 ms floor a 1 ms clock imposes. Predicted before the
  device run and confirmed by it. Raising the group would fix it and cost p95 sensitivity —
  the reason five was chosen — so it stands as a known gap, not an oversight.

### A tab on the origin blocks two columns, reproducibly

macOS Safari, 2026-09-04: `sweep.left: ["idb:IDBBatchAtomicVFS (blocked)"]` with
`idbAfter: ["IDBBatchAtomicVFS"]` — so not a slow delete, a live connection elsewhere. Both
`IDBBatchAtomicVFS` columns then failed `opens` at 20 s. The chain: another connection →
`deleteDatabase` fires `blocked` → **the delete request stays queued on that database** → the
run's own open queues behind it. **`/` and `/preview/` are the same origin**, so a tab on the
released page holds the same stores. Quitting Safari cleared it and the next run was clean,
22 columns, zero failures. Before 2026-09-04 `blocked` was counted as a successful deletion,
so this was silent rather than absent.

## Handle starvation reproduces deterministically — 2026-09-03

**Method.** Throwaway `tests/browser/starvation-probe.test.ts` (deleted). Client A on
`OPFSAdaptiveVFS`, `poolSize: 1`, holding an OPEN write transaction; client B created on the
same file with `openTimeout: 3000`; timing B's first query.

| engine | outcome |
|---|---|
| Chromium | **opened after 47 ms** |
| Firefox | **`TIMEOUT` after 3077 ms** |

**This is the phenomenon GATE-1 says no test exercises**, and it reproduces on the first
attempt with no timing tricks: the write transaction holds the one rotated exclusive OPFS
handle, and the second client's `open_v2` never gets it. Chromium is unaffected because
`readwrite-unsafe` gives each connection its own handle.

**Why it is not a permanent test yet, and this is a decision rather than a difficulty.** The
result is engine-conditional by nature, and `readwrite-unsafe` is in `UNPROBEABLE`
(`capabilities.ts:37`), so a test cannot branch on it — WebIDL ignores the unknown option and
answering yes is wrong. This repository has **no skip-by-engine idiom**: every browser test is
written to pass on both, and where reduced mode changes the outcome the tests accommodate it
(`long-query.test.ts:61`, `multi-client.test.ts:97`). Adding a Firefox-only test would
introduce a convention this project has never taken, which is the user's call, not a
reviewer's. The alternative is an assertion weak enough to hold on both — "opens, or reports
TIMEOUT; never hangs and never silently shrinks the pool" — which pins the gate's contract
rather than the starvation.

## HANDLE-ORPHAN — Firefox DOES release a terminated worker's sync handle, 2026-09-09

**This measurement contradicts the explanation HANDLE-2 carried until today**, which said
Firefox does not release the handle. At the ENGINE level it does. See `mem:vfs`, HANDLE-2,
which was corrected the same day.

Raw OPFS only — no wa-sqlite, no VFS, no client. A blob-URL worker creates a
`FileSystemSyncAccessHandle` on a fresh OPFS file, writes four bytes, flushes, reports, and is
then `terminate()`d by the page. A second worker polls `createSyncAccessHandle()` on the same
file every 100 ms for up to 10 s. Run twice: unloaded, and under the sixteen busy-loop workers
ABANDON-WEDGE validated as the load that makes the real defect reproducible. Firefox, this
container.

| probe | unloaded | under 16 busy loops |
|---|---|---|
| control — holder closed the handle, then killed | opens, 1 attempt, 1 ms | opens, 1 attempt, 6 ms |
| holder killed while **idle**, holding | opens, 1 attempt, 1 ms | opens, 1 attempt, **2 ms** |
| holder killed while **spinning**, holding | opens, 1 attempt, 1 ms | opens, 1 attempt, **5 ms** |
| `removeEntry()` issued immediately after the kill | `removed` | **`NoModificationAllowedError`** |
| `getFile()` read after the kill | — | 4 bytes, intact |

**A worker killed mid-synchronous-loop releases its handle exactly like an idle one** — which
is the case that mattered, since the real holder is inside `sqlite3_step()` and cannot answer
anything.

**The release is prompt but NOT instantaneous, and that is the whole nuance.** The
`removeEntry` row is the same operation as the others except that it runs microseconds after
`terminate()` rather than after a worker spawn: under load it still meets
`NoModificationAllowedError` — the very name ABANDON-WEDGE captured once. So that error names a
window of a few milliseconds, not a stable state.

**What it does not cover.** The probe's holder is a plain worker holding a raw handle. The real
holder also owns wa-sqlite's `ahp:<path>` Web Lock and a `retryOps` state machine, and its peers
carry their own. This measures the engine and nothing above it — which is what it was for: the
engine is exonerated, so HANDLE-2's permanence lives in the hand-over protocol or in our pool.

The probes, question by question:

| probe | question | answer |
|---|---|---|
| handle orphan | does Firefox release a terminated worker's sync access handle? | yes, 1-6 ms, idle or mid-spin, loaded or not |
| wedge 1 | kill the handle's holder behind the client's back | no wedge; lock and handle both come back |
| wedge 2 | kill it through `handleDeath`, with a peer contending | 0/10 wedges |
| wedge 3 | `onPoisoned` and `drainTimeout` paths | drain path clean; the "wedge" was the probe's own never-resolving callback |
| wedge 4 | six forms, discriminated | the stuck callback holds `bsq:write`; the crash is what makes `close()` lie |
| write-lock wedge | breadth and permanence | same on Chromium and Firefox, on the recommended VFS, still held past 70 s |
| after close | what a callback meets after `close()` | first statement HUNG, transaction never settled — both fixed since |
| tab off | does a destroyed agent release its lock? | yes; closing the tab repairs the origin |

Method note: the browser console is not forwarded by the rstest reporter, so the probe carried
its values out through deliberate assertion failures. Anything measured this way must collect
its results and emit them ONCE per test — the first failing `expect` ends the test, which cost
one run's worth of P4.

## HANDLE-2 does not reproduce — 2026-09-09, ~70 attempts on `main`, 40 at the pre-fix commit

Written because a negative that cost this much must not be re-paid. See `mem:vfs`, HANDLE-2.
The pre-fix runs used a git worktree at `94bfaac` with
`node_modules` symlinked from the main checkout, which is enough to run one browser config.

On `main`, six shapes, Firefox, `OPFSCoopSyncVFS`, under sixteen busy loops, all with the OPFS
resource and the lock table checked at the moment of interest: holder killed while idle; holder
killed mid-`step()`; crash through `handleDeath` with a second client contending for the handle
(10); crash inside an open transaction (16 across four forms); an abandoned generator with a
`next()` outstanding, `drainTimeout` lowered (10). **No wedge attributable to the handle in any
of them**, and every recovery path behaved: the `ahp:` lock is released on termination, a raw
third-party `createSyncAccessHandle()` succeeds, a replacement worker spawns and serves.

At the pre-fix commit `94bfaac`, where ABANDON-WEDGE recorded **9/40 (22 %)** on
`OPFSCoopSyncVFS`: `abandon-transaction.test.ts` forced onto that VFS and run 20 times under
sixteen SHELL busy loops, 12 times under sixteen IN-PAGE busy loops, plus 8 runs on the default
VFS — **0/40**. At 22 % a null of 0/20 alone has probability 0.6 %.

**What this does and does not license.** It does not prove the original observation was invented
— the load profile of a container hours apart is not controllable, and the recorded run had the
full `pnpm test` chain around it, which none of these did. It does mean **nobody has a
reproduction of HANDLE-2 today, on `main` or before the fix**, and that the only symptom anyone
has described — a permanent, silent, origin-wide wedge — is produced deterministically by
WRITELOCK-STUCK above, whose shape the pre-fix branch is independently recorded as having hit
(`mem:history`: "an `await gen.return()` parked behind an in-flight `next()` that held the
origin's write lock indefinitely").

## HANDLE-CORPSE — a worker killed INSIDE a statement holds its OPFS handles ~30× longer, 2026-09-16

Chromium, `AccessHandlePoolVFS`. Time from `worker.terminate()` until a fresh client on the same
database opens and answers `SELECT 1`, polled; the first client is closed first so the connection
lock is not what is being measured (the first attempt at this measured the lock instead and read
`-1` on every trial — the probe, not the engine, was wrong).

| the worker was… | handles released after |
| --- | ---: |
| idle, between statements | **65 ms** |
| inside `longQuery(20_000_000)`, a long synchronous `step()` | **2039 ms** |

Control: a client closed cleanly, no terminate — **67 ms**, i.e. indistinguishable from killing an
idle one. **It is not termination that is slow, it is termination while the thread is inside
synchronous WASM.**

**Why it bites only this VFS:** `#acquireAccessHandles()` opens a `FileSystemSyncAccessHandle` on
EVERY file of its directory, and such a handle is exclusive per file. Two instances of that VFS
therefore cannot coexist on one origin, even on different databases — so a new worker meets the
corpse and dies with `NoModificationAllowedError` before SQLite is involved (hence no
`sqliteCode`; `worker.ts` had already noted these DOMExceptions carry a misleading numeric `code`).

**The name is the discriminator and it is specified.** `NoModificationAllowedError`, identical on
both engines — `mem:follow-ups` had already recorded it for Firefox from an unrelated probe. The
MESSAGE is engine prose ("Access Handles cannot be created…" on Chromium); never match on it.

**How the causal chain was closed, after two refuted hypotheses.** Delaying the respawn by 250 ms
and by 1000 ms changed nothing — both are BELOW the 2 s threshold, which is why the first two
attempts read as "not a race". 3000 ms turned the isolated test green. On the suite side the same
threshold explains the cascade: a 3000 ms wait before the victim test clears it, while the same
wait placed AFTER the cleanup's `deleteDatabase` does not — because the delete itself runs inside
the window, fails, and leaks the pool slot. Moving the wait BEFORE the delete took the file from
6 failures to 1.

**Cost of the silence:** the cleanup's `deleteDatabase` ended in `.catch(() => {})`, so the leaked
slots were invisible and the later failures read as capacity exhaustion with no cause. A full day
(`mem:lessons`).

**Fixed 2026-09-16 (`3755805`)** in `createVfsInstance` (`src/worker/worker.ts`), shared by the
pool worker and the delete worker. `AccessHandlePoolVFS/sync` on chromium: **330/0/4**, from 7
failures at MATRIX-4. **Note a figure I got wrong when reporting it, and which is in that commit
message: I said "from 21". 21 was that cell two fixes earlier; 7 is what it was immediately
before.**

## ADAPTIVE-JSPI-SAFARI — `OPFSAdaptiveVFS` on `jspi` against `async`, Safari 27, read off banked exports 2026-09-24

The measurement the default-build change required before `OPFSAdaptiveVFS` moved to `jspi`. It was already banked: 38 bench exports (rc.3 and rc.4, 21 iPadOS and 17 macOS) carry both columns. Median of the per-run ratio `jspi / async`; below 1 favours `jspi`, except `read-burst-concurrency`, where higher is better.

| metric | macOS | iPadOS |
|---|---|---|
| full scan | 0.67 | 0.50 |
| list page p50 | 0.66 | 0.50 |
| point read p50 | 0.66 | 0.66 |
| bulk insert 10k | 0.78 | 0.91 |
| transaction throughput | 0.83 | 0.59 |
| write latency p50 | 1.00 | 1.00 |
| read-burst concurrency | 0.97 | 1.00 |

No median favours `async`. Single runs spread wider — bulk insert on iPadOS up to 1.73 — and Asyncify's Safari slowdown (IDB-SIGNAL) can weigh on the `async` columns depending on where they fall in a run: a cost a consumer pays too, not an artefact. n differs per metric (4 to 21) because the bench's row set grew across those releases.

## SAFARI-OPFS — what Safari 26 and 27 answer about OPFS access handles, 2026-09-16

Measured by the user in Safari 26's console on a `localhost` page (a secure context is required —
with no page open, `navigator.storage` is undefined and every worker throws `TypeError`), running
the Firefox hang's console probe: 144 workers across 12 iframes × 3
rounds, each asking the OPFS root for one shared file and then two sync access handles on it.

- **Safari does NOT honour `mode: 'readwrite-unsafe'`.** Every worker that got the file reported
  `unsafe: false` — its second handle was refused. Safari sits with Firefox, not Chromium. The
  library's consequence: `OPFSWriteAheadVFS` is single-client there, so a second client (a second
  tab) gets `DATABASE_IN_USE`, exactly as on Firefox.
- **Safari's error for a handle another context holds is `InvalidStateError: The object is in an
  invalid state.`** — not Chromium's and Firefox's `NoModificationAllowedError`. 132 of 144 workers
  got it. Any code that matches on the error NAME rather than on the failure will behave
  differently on Safari.
- **12 of 144 got through, and WHICH ones is the finding.** Per round: 6, 4, 2. They cluster by
  context — round 1 put all four workers of context 11 (the last iframe created) through, plus one
  each in contexts 0 and 9. The contention burst clears in ~60 ms, and whoever arrives after it is
  served normally. So Safari 26 refuses a SIMULTANEOUS contender outright; it does not refuse a
  later one. The 6 → 4 → 2 decline fits: later rounds start with warm iframes, so they are more
  tightly synchronized.
- **It is fast:** every worker settled in 45-68 ms, contention included.
- **No wedge** (0 of 144), but that proves nothing about the Firefox `getDirectory()` hang: this
  probe does not reproduce it on Firefox either (0 of 144 there, churn included). See
  `mem:follow-ups`.

**Safari 27, same probe, same day — the capability is unchanged, the CONTENTION is not.**

- `readwrite-unsafe` is still refused: every worker that got the file reports `unsafe: false`. So
  the second-client guard applies to Safari 26 and 27 alike.
- **Safari 26 put 12 of 144 through (8 %), never waiting — everything settled in 45-68 ms.
  Safari 27 put 113 of 144 through (78 %), in 53-172 ms.**
- **Safari 27 QUEUES, and round 1 shows it exactly: 48 of 48 through, served in the order the
  contexts were created** — context 0 at 59 ms, 1 at 70, 2 at 78, … 11 at 172, four workers per
  context, about ten milliseconds per step. That is FIFO on the file, not a race. Round 2: 44 of
  48. Round 3: 21 of 48 — so the queue is not unconditional; it degrades under pressure (or with a
  previous round's handles still settling), and the losers get `InvalidStateError`.
- So between 26 and 27 WebKit moved from REFUSING a contended `createSyncAccessHandle` to WAITING
  for its turn. On 27 a second context that asks for a handle gets it; on 26 it fails at once.
- Consequence to check before relying on it: handle starvation is asserted for Firefox only
  (`tests/browser/firefox/handle-starvation.test.ts`). If Safari 27 queues, its starvation shape
  is neither Firefox's nor Chromium's, and nothing measures it.

## HELD-LIVE — a file held by a live context, on the VFS that do not declare `exclusiveFileHandle`, 2026-09-28, this container

**Method.** A throwaway browser test (deleted after the run): a dedicated worker takes a plain
`createSyncAccessHandle()` on the database file and keeps it; a client with `poolSize: 1` then runs
`SELECT 1`. One run per engine, target `OPFSWriteAheadVFS/sync` (the test names its VFS), on branch
`chore/wa-sqlite-repin` after `91ea0a8`, Playwright's Chromium and Firefox.

| VFS | engine | outcome | cause name | time to fail |
|---|---|---|---|---:|
| `OPFSWriteAheadVFS` | Firefox | `WORKER_CRASHED` | `NoModificationAllowedError` | 71 ms |
| `OPFSAdaptiveVFS` | Firefox | `WORKER_CRASHED` | `NoModificationAllowedError` | 61 ms |
| `OPFSWriteAheadVFS` | Chromium | `WORKER_CRASHED` | `NoModificationAllowedError` | 43 ms |
| `OPFSAdaptiveVFS` | Chromium | `WORKER_CRASHED` | `NoModificationAllowedError` | 39 ms |

**Reading.** The cause is the held-file name `openWithRetry` retries on, on both engines — on
Chromium too, since a `readwrite-unsafe` request still conflicts with an exclusive holder. Only the
`exclusiveFileHandle` declaration keeps these opens from waiting out the 2.5 s budget against a
holder that is alive and will not let go (`mem:vfs`).
