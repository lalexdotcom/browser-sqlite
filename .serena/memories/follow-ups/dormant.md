# Follow-ups — entries waiting on an event

Part of `mem:follow-ups`. Each entry here needs no action until its event comes (a new sighting, a Playwright release); moved out of `mem:follow-ups` verbatim on 2026-10-05 to keep it under 40 000 characters.

## `open-retry` "succeeds once the holder lets go" times out on Firefox — DORMANT until the next sighting (user, 2026-10-03)

**DORMANT: no action until it happens again (user, 2026-10-03).** Reproduction attempts are over (below), and nothing since the test names its stall: 13 full matrices of 22 Firefox cells each and every hook's `pnpm test`, 2026-09-28 to 2026-10-03, all clean. The release will make test runs rarer; the capture and the tree below are what makes a late sighting usable. **Where a sighting lands:** every run through `scripts/bounded.ts` (`pnpm test`, the hooks, conformance) is kept in `.test-runs/` since 2026-10-03, the newest 30, so a failure is still readable after a green rerun; a matrix keeps its own in `.matrix/`. Read its `stalled in` line and follow the tree.

**When it returns, the user's priority stands: reproduce it on demand, then remove the cause, so that CI never fails on valid code.** It has already refused a merge (`test/needs-skip-in-matrix`, first attempt), and five sightings put it past noise. Done means a reproduction that fails on demand — under load, with a squeezed timing, or with an instrumented holder — the cause named, and the fix verified against that reproduction. A raised timeout or a retry of the test is not a fix.

**Sightings, all Firefox, all 30 s with no assertion reached, all an open against a held file:**
- 2026-09-26, the repin's matrix, twice on unrelated cells (`OPFSCoopSyncVFS/async`, `IDBBatchAtomicVFS/jspi`) — never before in seven full matrices. Alone on the same tree: 20 of 20. The repin touches no code the test runs (VFS files byte-identical; only text encoding changed).
- 2026-09-26, the same shape in another test, in the pre-merge hook's `pnpm test` with nothing else running: `pool-cap.test.ts :: … reports the storage error behind a failed open`, `OPFSAdaptiveVFS/jspi`. **A/B of the pins, `pnpm test:firefox` interleaved, 5 runs each: 10 of 10 green**, old and new alike — not attributable to the repin.
- 2026-09-27, once in ten whole-config Firefox passes under sixteen busy loops (REUSE-LOAD).
- 2026-09-28, the pre-merge hook of `test/needs-skip-in-matrix` with nothing else running, `OPFSWriteAheadVFS/sync`. The branch touches no open path and the test declares no `needs`; the same cell had passed in the branch's `pnpm test` and full matrix hours before. Alone on that cell right after: 5 of 5 green; the merge passed on its second attempt.

- 2026-09-28, in the reproduction campaign below: the real test once, `OPFSWriteAheadVFS/sync`, whole Firefox config with nothing else loaded.

- 2026-09-28 evening, not seen: 30 whole Firefox config passes in a row on `main`, nothing else loaded, the stall report in place — 30 of 30 clean (the test ran 60 times, both targets).

**Never on CI.** Green in every CI log since the test landed (2026-09-18); CI has not run since the last push (2026-09-22), and every sighting is later.

**The hang is BEFORE the open under test (2026-09-28).** Both kept logs say `no expect assertions completed`, and the first `expect` is on `holder.take` — so what hangs is `creator.write`, `creator.close` or `holder.take`, never `db.read`/`openWithRetry` (whose 2.5 s budget would throw, not hang). The earlier lead — how long the open retries while the holder is armed — is refuted.

**Not reproducible on demand by volume:** the test's body looped in one page, ~7 000 bounded cycles alone and beside the suite, 0 stalls; instrumented copies of the test (one run per page, its real place) beside the whole Firefox config, 240 runs, 0; the same under sixteen busy loops, 280 runs (copies and the real test), 0. One stall in ~590 real-shaped runs, and load did not raise it. Under load every step stays far inside its budget (`holder.take` p99 463 ms, max 1 005 ms; `creator.write` max 4.2 s).

**Not the Playwright Firefox defects (2026-10-03).** Neither of `firefox-1538`'s worker defects (`mem:follow-ups`, the Playwright entry) explains the stall. The test kills no young worker: its holder is a classic worker ended in `dispose()` after the test, and `creator`'s workers end in `close()` after a write — outside the SIGSEGV window. And the leaked threads cannot reach the 512-worker cap that froze the 2026-09-29 page: in a whole Firefox run every test page gets its own content process, peak 5 threads in one (`mem:measurements`, WORKER-LEAK). The stall's cause is still open; the step it names at the next sighting decides.

**The test now names its stall** (on `main` since 2026-09-28): every await raced against one deadline at 25 s, the failure reading `stalled in <step> … done: <steps before> … holder: <steps reached> … creator: … db: <pool debug state>`. Checked by sabotage — a `getDirectory` that never settles in the holder reports `stalled in holder.take … holder: booted > getDirectory`. **At the next sighting, read the step:**
- `holder.take`, holder last at `getDirectory` — the Firefox engine hang (`getDirectory()` never settles in a worker, the rstest/Firefox silent hang entry). Test-side: the holder must bound its worker and replace it, as the conformance probe does (`6560c9e`).
- `holder.take`, holder last at `createSyncAccessHandle` — Firefox neither grants nor rejects a handle the just-closed client still holds. Test-side: the holder bounds that wait itself.
- `holder.take`, `no step` — the blob worker never booted.
- `creator.write`, a worker `never initialized (boot: <step>)` — a fresh worker's open never finishes, and nothing in the client bounds a worker's startup (not verified beyond a grep): a consumer would hang the same way. Product-side. The step is `db.debug`'s `boot` since 2026-10-03, verified by holding the open lock from the page (`boot: waiting for the open lock`, both engines): `waiting for the client`, the `proceed` after the probe never came; `loading the build`, `instantiating wasm`, `loading the VFS module`, the engine never delivered a module; `creating the VFS`, `createVfsInstance` (its own retry is bounded, so a hang is inside the VFS's `create()`); `waiting for the open lock`, another worker or client holds `bsq:init`; `opening the database`, `openWithRetry`; `applying pragmas`, a pragma blocked; `no step`, the worker never ran `open`.
- `creator.close` — the drain never ends; the close path.
- `db.read` — the open under test after all; `openWithRetry` and `OPFSCoopSyncVFS`'s lock.

## The rstest/Firefox silent hang — CAUSE FOUND 2026-09-16, fix not taken — waits for the Playwright 1.64 bump (user, 2026-10-03)

**Tied to the Playwright 1.64.0 entry above, at the same level: nothing to do before that bump, then remeasure (user, 2026-10-03).** Every sighting is on Playwright's patched Firefox, whose young-worker segfault turned out to be the build's own and is fixed in 1.64, so this may be the same story. After the bump: the unguarded probe arm, Firefox, `OPFSWriteAheadVFS/sync`, 24 runs, against 4/24 then. **Gone** → close this entry: it was the build's, and the library was never concerned. **Still there** → try a stock Firefox: if stock hangs too, the library is exposed for real — its workers call `getDirectory()` in every OPFS VFS's `create()` and in `worker.ts`'s delete and inspect paths, and nothing in the client bounds a worker's startup (`db.debug`'s `boot` would read `creating the VFS`) — so the question becomes bounding worker startup in the client, then the one-probe-per-run design below for the tests, and the Mozilla report.


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
reason. `scripts/bounded.ts` now gives every browser script a deadline (exit 124), because the
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
  is now designed rather than speculated. Measured 2026-09-21, all three:
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
  console probe — 12 same-origin iframes × 4 workers, 3 rounds released together, each worker walking
  `getDirectory` → `getFileHandle` → two sync access handles, bounded — does NOT reproduce it (0 of 144;
  48 workers from one page, 0 either), only
  the suite's shape does — ~50 pages each asking a worker for the OPFS root within a few seconds.
  (2) Every sighting is on **Playwright's Firefox 153.0** (BuildID 20260722045007), a patched
  build; Mozilla will ask first, so confirm on a stock Firefox before opening, or the bug is
  Playwright's, not theirs. Then: `enter_bug.cgi?product=Core&component=Storage%3A%20Bucket%20File%20System`,
  blocks 1748667, keyword `hang`, and a `mozregression` range if it reproduces on stock.
