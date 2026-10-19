# Follow-ups — the open backlog

One short entry each, and every entry OPEN. **An entry marked DORMANT waits for an event and needs no action until it comes: it is not part of the backlog and is not listed when the user asks for it (user, 2026-10-03).** Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**The test-planner design (no identical repetitions in the browser suite) lives in `mem:follow-ups/test-planner-design` (2026-10-12)**: decisions taken with the user point by point, before any spec. **Proposals to wa-sqlite for a cheaper `step()` live in `mem:follow-ups/wa-step-upstream`, the `stream()` iterator in `mem:follow-ups/stream-iterator` (2026-10-16).** **Entries waiting on an event live in `mem:follow-ups/dormant`** — `open-retry` on Firefox and wa-sqlite #297 `trace_v2`, moved there on 2026-10-05 to keep this file under 40 000 characters.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## In sub-memories (user, 2026-10-16 and 19)

`mem:follow-ups/stream-iterator` (its own branch), `mem:follow-ups/wa-step-upstream` (optional, upstream's), `mem:follow-ups/tx-validation` (tx methods throw, not reject), `mem:follow-ups/timeout-start` (when `timeout` starts).

## `multi-client` bulkWrite interleave on chromium `IDBMirrorVFS/async` — seen, not reproducible (2026-10-07)

`tests/browser/pairs/multi-client.test.ts` :: "two clients writing at once > interleaves a bulkWrite with another client, refusing neither" failed once in the `feat/binary-protocol` matrix: client A read 0 of B's first 2 047-row batch over its 5 s of polling (`expected +0 to be 2047`, test 10.9 s). Replays the same afternoon: the test alone 10/10 on the branch and on `main`; the file under 16 busy loops 15/15 each; the full cell on the branch 1 failure in 5 then 0 in 15 (and 0 in 12 with `debug: true` and a diagnostic of B's `close()` and A's late count), on `main` 0 in 20. Another session's Firefox was loading the machine during the failing runs. Left by the user's decision ("on ignore et on enchaîne, et on consigne"). At the next sighting: rerun the cell with the diagnostic (B's `writer.close()` outcome — a failed batch against a slow one — and A's count after it), and compare with `main` at the same load.


## wa-sqlite's suite on stock browsers — WebDriver PR accepted, ours to send (Discussion #373, 2026-10-10)

**Where it stands.** On the user's go, a top-level comment was posted on rhashimoto/wa-sqlite#373 on 2026-10-08 (discussioncomment-18824045). It revises the plan he had validated, after two days of measurements on the fork (`mem:measurements/test-browsers`). **He accepted it on 2026-10-10 at 18:11 UTC: "Okay, let's see what a WebDriver PR looks like! For CI triggers, I'm fine with just Linux for now." The PR is ours to send.** That reply went unrecorded until 2026-10-14, and this entry said "waiting on him" for four days: **read the thread (`gh api graphql`, discussion comments and their replies) before reporting a Discussion as waiting.** The user's principles behind it are in `mem:conventions` (§ Testing in browsers).

**2026-10-10: he questioned it, and was answered the same day.** He was not convinced that Playwright's browsers fall short for tests of storage, Web Locks and `BroadcastChannel`, asked for cases where Chrome or Safari differ from Playwright's builds, and whether WebDriver is slower than Playwright, and by how much. Answered on the user's go (discussioncomment-18853671), with no new measurement — the user: WebKit and Firefox are justified enough, and uniformity is the reason for Chrome. Chromium: no difference seen, WebDriver for one launcher and one configuration, versions pinnable there too (only Safari follows macOS). WebKit: Playwright's trunk build already has WebKit 324094's fix while Safari 27.0.1 does not; the DataView race shows on Safari 26 only; OPFS depends on Playwright's version and context. Firefox: the Juggler build's `await` cost (FF-PW-AWAIT). Speed: the two launchers not timed against each other; the driver mostly opens pages; the whole suite on stock Chrome through WebDriver takes 2-3 min on Linux runners. **For upstream the runner stays `@web/test-runner`; Vitest is the library's** — the two were mixed up once in drafting (user, 2026-10-10). He answered within the hour (above): WebDriver it is, Linux-only triggers for now.

**What the comment proposes:**
- **Stock browsers through WebDriver** (`@web/test-runner-webdriver`), Playwright dropped, which revisits his answer 1 (Playwright's bundled Chromium). The reason given: test what users run; patched builds are noise.
- **Development:** `yarn test` runs Chrome only by default, and `WTR_BROWSERS` picks others (`chrome,firefox`, plus `safari` on macOS).
- **CI:** one reusable workflow with the steps, and one small workflow per platform: Linux (Chrome, Firefox), Windows (Chrome, Firefox), macOS (Chrome, Firefox, Safari). Triggers are his to choose per platform; the example given is all on a release, Linux on PRs and pushes to master, and any by `workflow_dispatch`. The WASM is built once with `make` and shared by every job.
- **The DataView race** (SAFARI26-DATAVIEW-RACE) goes as its own commit in the test PR, not a PR of its own: only Safari exposes it.
- **`sql_0005` on `IDBMirrorVFS`** is skipped on Safari before 27 with `pending()` and its reason (SAFARI26-IDBMIRROR-KILL).
- **The `readwrite-unsafe` skips** stay as agreed.
- **Windows:** geckodriver comes from the runner, and the docs will tell Windows contributors to install it.
- **Mobile:** iOS Safari can follow the macOS images' simulators (iOS 26 works, iOS 27 refuses). Chrome on Android is not explored, only said possible.

**What his go calls for.** The PR branch, from upstream `master`, in this order:
1. **Test and harness commits:**
   - the capability skips: `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` without `FileSystemSyncAccessHandle.prototype.mode`, and `vfs_open_last_error` accepting `InvalidStateError`;
   - `sql_0005` registering each worker's cleanup before its open;
   - `TestContext.create()` rejecting when the worker reports an error;
   - `destroy()` closing the VFS before `terminate()`;
   - the DataView race fix, ported from `68aae811` on the fork;
   - the Safari-before-27 skip, through a `TestContext` helper reading `Version/NN` from the user agent (the same on macOS and iOS).
2. **Config:** `WTR_BROWSERS`, with Chrome as the default.
3. **Workflows:** as proposed above, but only Linux (Chrome, Firefox) is triggered — "just Linux for now" (2026-10-10). Open, for the user: also ship the Windows and macOS workflows on `workflow_dispatch` only, or ship Linux alone with the reusable workflow ready for the others.
4. **Docs:** a "Running the tests" section per OS.

Before opening it, measure reliability: about 10 runs per environment, through `workflow_dispatch` on the fork. Upstream's JSPI flag is not needed on stock Chrome 154.

**Still open:**
- Linux Firefox lost two files at the launcher once in 8 runs, unexplained — on the Linux-only target, so to watch in the reliability runs.
- Windows Firefox has only one complete run.
- iOS 27 simulators refuse WebDriver sessions; the image `20261006` with Safari 27.0.1 is untried.
- The fork's `probe/stock-browsers` (head `437e6de1`) and `probe/webkit-opfs` are throwaway.

**History, compressed.**
- **2026-10-03:** asked, about Firefox.
- **2026-10-04:** he pointed at WebKit and Playwright's private mode.
- **2026-10-05:** we measured WebKit's OPFS in a persistent context and proposed WebKit; he asked for all three browsers by default, with an environment variable to restrict to one.
- **2026-10-06:** design questions (discussioncomment-18773230). He answered: Playwright's Chromium, `WTR_BROWSERS`, drop the pre-build pass, both skips, `create()` rejecting, `destroy()` closing the VFS, one PR.
- **2026-10-07:** confirmed (discussioncomment-18791734).
- **2026-10-08:** revised proposal, stock browsers through WebDriver (discussioncomment-18824045).
- **2026-10-10:** his questions on Playwright's browsers and WebDriver's speed; answered the same day (discussioncomment-18853671); at 18:11 UTC he accepted: "let's see what a WebDriver PR looks like", Linux-only triggers for now.

The Firefox findings that started it (WA-FIREFOX-SQL-HANG): `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` assume two connections, which Firefox without `readwrite-unsafe` refuses. Three harness traits then turn that failed open into a hang:
- `sql_0005` registered a worker's cleanup only after its open, so the failed worker was never destroyed;
- `maybeReset` retried `NoModificationAllowedError` for 10 s, then rejected without posting a port;
- `TestContext.create()` waited for ever for that port.

Jasmine's random order decides whether a resetting spec follows the failure. None of this is a VFS defect, and none of it reaches the library.

## The library's tests on stock browsers — what stays open after the Vitest + WebdriverIO migration (user, 2026-10-10)

Delivered on 2026-10-10; the decisions (D1-D11), the order and the risks are in `docs/superpowers/specs/2026-10-10-vitest-webdriverio-design.md`, the setup in `mem:stack-and-build` (§ Test suites), the numbers in `mem:measurements/suite-and-matrix`. Open:
- **The rebuild after delivery passed (2026-10-10):** on a fresh container `post-create.sh` installed the browsers' apt packages (apt resolved the pre-t64 names to their t64 packages), `node scripts/browsers.ts install` printed `ok` for both, and `pnpm test` gave 2616 passed / 12 skipped.
- **Closed 2026-10-13: the matrix is green on GitHub** (run 38387953580, `ci/test-planner`, dispatched: `plan` + 22 pair jobs, 23/23, ~8 min). It confirms the two fixes of 2026-10-12 to the first GitHub matrix's failures (run 38184863157: `abort-slot`'s cache test, `abandon`'s deadline test).
- **CI verified on 2026-10-11.** The first push (`main`, run 38172794856) ran no Chrome test: a cold-cache download race (`EACCES` on chromedriver) and AppArmor denying Chrome for Testing its sandbox (`consumer-smoke`, "Chrome instance exited"). Fixed by two workflow steps (`mem:stack-and-build/ci`); PR #7's run 38182346151 is green: `pnpm test` 2616 passed / 12 skipped as locally (9 jobs in 457 s, the step ~18 min with the build and the merge), conformance 162/32, consumer smoke 24/24.
- **The next piece of work:** Windows and macOS runners, Safari and the iOS simulator, per-platform triggers, the WASM built once and shared (`mem:conventions`, § Testing in browsers).
- **Parallelism: delivered 2026-10-10** (`scripts/test-parallel.ts`, `mem:stack-and-build`); on CI (2026-10-11, run 38182346151) the 9 jobs of `pnpm test` took 457 s, 3 at a time, the slowest cell 276 s (`firefox-OPFSWriteAheadVFS-sync`).
- **WPE WebKit in the Linux tests (user, 2026-10-11):** add WPE WebKit 2.54 with its MiniBrowser and WPEWebDriver to the Linux runs (dev container and CI), beside Chrome and Firefox. Not designed. To check first: whether a WebDriver session gets a persistent website-data session — WebKitGTK's MiniBrowser under `--automation` takes `webkit_web_context_get_network_session_for_automation()`, an ephemeral session (read in WebKit's source, not run; STOCK-BROWSERS, `mem:measurements/test-browsers`), and Playwright's ephemeral WebKit contexts have no OPFS (WA-WEBKIT-SUITE) — so OPFS under WPEWebDriver is unknown; and how 2.54 is installed on Debian 13 and on `ubuntu-latest`.
- **Unmeasured, needs Safari:** the library's `IDBMirrorVFS` with several connections on Safari 26 may stall the way wa-sqlite's `sql_0005` does (SAFARI26-IDBMIRROR-KILL).

## wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR awaits rhashimoto

Issue by jwaltz, 2026-09-25: the `.ahp-*` sweep in `#initialize()` gets the lock while the evicted page's worker still holds its temp handles, and `removeEntry` throws `NoModificationAllowedError` (only `NotFoundError` is tolerated, since our #347). Same root as #381, but in a cleanup: tolerate, don't retry. His try/catch works (the issue's "0 of 48" counts failures). Measured 2026-10-16 (LEAK-LIB, `mem:measurements`): `master` fails the first open 18 of 18, tolerating the error 0 of 18. The library masks it (`createVfsInstance`'s retry, ~85 ms). **Commented 2026-10-16 (issuecomment-6215879523), offering the one-line PR with a test; the PR waits for rhashimoto's go (user).** #381 edits the same file (`#requestAccessHandle()`): say so in the PR (`mem:conventions/upstream`); carrying both regenerates the patch (`mem:stack-and-build/wa-sqlite`).

**To do (user, 2026-10-16): a browser test of the real navigation.** None exists (`vfs-create-retry.test.ts` holds a pool file, no navigation); Safari is unmeasured. Chrome for Testing under WebDriver caches a page not served `no-store`; a Vitest test runs in an iframe, never cached, so it needs a top-level page — to design.

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
SharedWorker cannot open a connection on the four VFS that matter (`mem:architecture/cross-tab`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

### Recycling the params buffer through `done` — an idea, kept out of the binary protocol (user, 2026-10-07)

The worker hands the transferred params buffer back in `done`, the page reuses it for the next send. Measured (BINARY-PROTOCOL, `mem:measurements/binary-protocol`): on 200 writes of a 1 MiB text it halves the peak again over the plain binary path (Chromium 29-40 → 16 MB, Firefox 50-77 → 25 MB), and gains nothing on small queries. Cost: each worker keeps its largest buffer for life (~3 MiB for a 1 MiB text, worst-case sizing), and `done` grows an optional field — so it can be added later without breaking the protocol. If taken up: cap the size kept per worker; the cap is unmeasured.

### Buffer strategy of the binary blocks, both directions — a measurement to take if the choice is questioned (user, 2026-10-08)

The two sides grow their buffers differently, on purpose: `ParamsWriter` knows the size before writing (`encodeParams` sizes for the worst case; `bulkWrite` batches are large), so it uses 1 MiB segments and never copies; the result `RowWriter` (spec 2026-10-08) learns the size row by row, so it keeps one buffer per chunk that doubles by copy, sized from the query's previous chunk. Growable `ArrayBuffer`s (`resize`, `transfer`) were refused on 2026-10-07 for raising the browser floor (Firefox → 122-128). Unmeasured alternative for rows: segments of doubling size capped at 1 MiB (no copy, a test per value at decoding). Should either choice be questioned, measure both arms on each side with the direct harness (RESULT-BINARY / BINARY-PROTOCOL).

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


## What the matrix showed, and what it shows now (2026-09-16, resolved 2026-09-18)

**The three product defects are gone.** Full matrix on 2026-09-18 after the fixes: 65 of 66 cells
green, 1 failing test, 1 distinct group — against 62 cell-failures and 20 groups on 2026-09-16.
**Re-measured 2026-09-21 once that one was fixed (`2be2ae6`): 66 of 66 cells green, 0 failing
tests, 2650 s.** Every one of the three traced to a
wa-sqlite defect rather than to this library, and each is upstream with a falsifying test in
wa-sqlite's own suite: `OPFSCoopSyncVFS` → #350 plus our own `deleteDatabase` probe (a file's
existence, not an open), `IDBBatchAtomicVFS` → #351, `IDBMirrorVFS` → #352 and #353. Reports in
`docs/upstream/`, patch inventory in `mem:stack-and-build/wa-sqlite`.

Kept for its method rather than its content — the original entry, now closed:

Numbers in `mem:measurements`. `scripts/matrix-triage.ts` regenerates the grouping from any
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


## Read workers refuse writes themselves, with `sqlite3_stmt_readonly` — not started (user, 2026-10-04)

Today the one-writer invariant rests on the client's routing regex (`isReadQuery`: an allowlisted opening keyword and no write keyword anywhere). Proposed by the user after the transaction-control guard (`feat/tx-savepoint`): the worker checks each prepared statement on a read lease — cache hits included — before its first `step`, so a misrouted write can never run on a read worker. **The primitive is `sqlite3_stmt_readonly`, not the authorizer**: one wasm export call per prepared statement, SQLite deciding, no per-action JS callback (so no Firefox `jspi` relay cost); `Module._sqlite3_stmt_readonly` is exported by all three builds (checked 2026-10-04), not wrapped by `sqlite-api.js`. It complements the routing, which picks the worker before any prepare; it could then let the regex relax its false positives (`SELECT 'INSERT'` serialized through the writer, `db.read("SELECT … 'BEGIN'")` refused) — but inside a transaction `tx.first()`/`tx.chunk()`/`tx.stream()` accept writes (`INSERT … RETURNING`, they run on the writer), so they keep the regex or retry on the writer. On the client those methods refuse a write (`assertReadable`, `NOT_A_READ_QUERY`; checked 2026-10-14).

**Known (2026-10-09, wa-sqlite's SQLite 3.53.0):** `PRAGMA cache_size(10)` answers `stmt_readonly` = 1 and runs on a read-only connection, though it changes the connection — so `stmt_readonly` alone would admit setting pragmas. **Measure first:** what `stmt_readonly` answers for the other statements that change only connection state — `ATTACH`, `DETACH`, `PRAGMA x = y`, `CREATE TEMP TABLE` — which would make one read worker diverge from the others; those may need the authorizer (`SQLITE_ATTACH`, `SQLITE_DETACH`, `SQLITE_PRAGMA` with a value) or the client rule kept. And the cost per prepare.

## `jspi` before `sync` in the build order — to examine (user, 2026-10-05)

Measured on 2026-10-05 (JSPI-VS-SYNC, `mem:measurements/statement-cache-and-perf`): `jspi` runs row walks as fast as `sync` on Chromium and Firefox, where `async` pays 1.2-1.8×, and it interrupts a running statement with no cross-origin isolation. So declaring `jspi` first on the VFS that list `sync` first (`OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS`) would make the default interruptible where the browser has JSPI, at no measured cost. To weigh before deciding: Safari 27 is not measured; the Firefox figure rests on #375's glue, merged upstream and in the pin since 2026-10-05; `transaction-throughput` on `OPFSWriteAheadVFS`/Chromium read 1.27× with a 1.03-1.94× spread (`MemoryVFS` 0.87×), to re-measure; the open path and memory of `jspi` against `sync` are not measured; and a changed default is a consumer-visible change (CHANGELOG, `VFS.md`'s Builds and Recommendations, the `build` JSDoc — `mem:lessons/claims-and-docs`, "A changed default is described in more places than the spec lists").


## Params as an object, bound by name — not designed (user, 2026-10-09)

`db.read('SELECT … WHERE id = :id', { id: 1 })`: an object as params, today refused with `INVALID_VALUE`. The worker would bind by name — for each statement, `sqlite3_bind_parameter_name(stmt, i)` looked up in the object, a key `id` matching `:id`, `@id` and `$id` (and SQLite reads `#id` too) — because SQLite numbers named parameters per statement in order of first appearance, so no client-side translation to indexes can work across a multi-statement string. Gains for the string form: multi-statement strings bind correctly, and a missing key can throw instead of binding `NULL`. Open: what an extra key does (ignored, or refused once every statement ran), and refusing a positional `?` in a named query; the name→index map could live with the cached statement — measure the lookup. Touches the worker and the protocol, so the full matrix. The `sql` tag does not need it: it uses numbered `?N` (spec 2026-10-08, D11, kept for D14). Positional `?` across statements already binds correctly since `fix/multi-statement-params` (2026-10-09).

## Firefox + OPFS: every file create/open/close/delete costs fsyncs — what the library can avoid (user, 2026-10-14)

Firefox keeps a per-origin SQLite metadata database for OPFS (`storage/default/<origin>/fs/metadata.sqlite`, in the profile) in rollback-journal mode: one create + `createSyncAccessHandle` + `close` + `removeEntry` cycle runs 7 transactions, 21 fsyncs (Chrome: 0). Reported upstream as [Mozilla bug 2072928](https://bugzilla.mozilla.org/show_bug.cgi?id=2072928) (third party, 2026-09-17, UNCONFIRMED, unassigned, no Mozilla reply; `PRAGMA journal_mode = WAL` in Firefox's `GetStorageConnection` takes a cycle from 75 to 1.9 ms on Linux) — no Windows numbers there. Data reads/writes are unaffected; the cost is per metadata operation and scales with the cost of an fsync: Linux 79 ms/cycle in that report, macOS ~4× Chrome (its `fsync` does not flush the drive). Not reachable from a page: the fix is Mozilla's.

**Measured on Windows (2026-10-14, OPFS-PROBE, `mem:measurements/held-handles`):** Firefox pays 40-220 ms per OPFS file operation on `windows-latest` (Chrome 0.5-2 ms, Firefox on Linux and macOS 1-7 ms); Firefox OPFS tests run 7-16× slower than Chrome there.

**What the library could do (unmeasured, to count per VFS first):** keep access handles open (WriteAhead/Adaptive do; `OPFSCoopSyncVFS` hands them over between clients and pays continuously — its handover tests exceed 120 s on Windows Firefox); `journal_mode = PERSIST`/`TRUNCATE` instead of `DELETE` where a VFS creates and deletes `-journal` per write transaction; `temp_store = MEMORY` (the AnyContext entry below); `AccessHandlePoolVFS` creates nothing at run time. First step: count OPFS metadata operations per write transaction, per VFS and journal mode, on Firefox.

**The library's default open timeout (30 s, `src/client.ts`) can be too short on Firefox on Windows (2026-10-15, run 38721500216):** a single `OPFSWriteAheadVFS` client (`bulk-write` › "writes nothing when the abort beats the first batch") got `TIMEOUT: Worker 1 did not become ready within 30000 ms. No client of this library holds it` under the suite's 3 parallel jobs. A user with several tabs, or a loaded machine, could meet it. To decide (user-visible): an adaptive default, a larger one, or a note in `VFS.md`. Meanwhile the tests stretch the default by BSQ_TIME_SCALE (`tests/browser/helpers/library.ts`, the `browser-sqlite` alias of the browser tests; the build itself unchanged at factor 1).

**Two CoopSync clients on Windows Firefox, with wa-sqlite #381 carried (2026-10-16, COOPSYNC-381-WINDOWS, `mem:measurements/held-handles`):** under the tests' 120 s open timeout, 54 two-client attempts of `coopsync-handover` failed no statement, where before #381 the first test met 12 × the 30 s open `TIMEOUT` and 2 raw errors in 20 attempts. An attempt takes 25-60 s there (~150 ms on Linux), so the file runs 3 attempts on Firefox on Windows instead of 20; its skip there was removed on 2026-10-16. Unmeasured: whether the library's 30 s default lets a second client open there — the paragraph above. A user with two tabs on Windows Firefox pays that hand-over cost; the library paying less per hand-over is the path the user wants to explore, or a Firefox that fixes bug 2072928 (it counts once `scripts/browsers.ts` pins it). A changed default is consumer-visible. Also possible: a note in `VFS.md` on Firefox + OPFS. Open, the user's: whether to add our Windows numbers to bug 2072928.

## A worker terminated with an open sync access handle frees its Web Lock before its file — what #381 leaves open (2026-10-15)

Found through `coopsync-handover` on Windows Firefox (run 38693552137): besides the 30 s open `TIMEOUT`s, 2 × `undefined: No modification allowed` — an error with no `SQLiteError` code. Path: `OPFSCoopSyncVFS.#requestAccessHandle` took the Web Lock, called `createSyncAccessHandle()` ONCE and rethrew; the rejection left the SQLite call as a raw JS exception, which `statementError` (`src/pool.ts`) makes a plain `Error`. Every engine and OS has the race; Windows Firefox widens the window tenfold (HANDOVER-PROBE, `mem:measurements/held-handles`).

**Fixed for `OPFSCoopSyncVFS` by rhashimoto/wa-sqlite#381** (opened 2026-10-15, branch `opfscoopsync-retry-held-handle`, head `3c75a3c8`; retry every 10 ms up to 5 s; report `docs/upstream/2026-10-15-wa-sqlite-381-coopsync-held-handle.md`), **carried as a `pnpm patch` since 2026-10-16** (`mem:stack-and-build/wa-sqlite`); on Windows Firefox two CoopSync clients then fail no statement (COOPSYNC-381-WINDOWS). Once it merges and is pinned, `openWithRetry` is redundant for that VFS; `createVfsInstance`'s retry stays for `AccessHandlePoolVFS`.

**Open:**
- **`OPFSAdaptiveVFS`: the same race, worse — rhashimoto/wa-sqlite#382 opened 2026-10-16** (branch `opfsadaptive-retry-held-handle`, head `d6dd6ba0`; report `docs/upstream/2026-10-16-wa-sqlite-382-adaptive-held-handle.md`, numbers ADAPTIVE-382 in `mem:measurements/held-handles`). Without `readwrite-unsafe` (Firefox, Safari) a held file in `jLock()` left the lock held with no handle: on Firefox `asyncify` hung B and every other connection, `jspi` failed raw and B's `close()` never returned. The change retries as #381 does and gives the lock back on failure; **carried as a `pnpm patch` beside #381 since 2026-10-16.** Upstream's other lock-then-file sites, surveyed: none left (ADAPTIVE-382).
- **The name differs by engine:** Chrome and Firefox raise `NoModificationAllowedError` for a held file, Safari/WebKit `InvalidStateError` (the library on 2026-09-13, `src/const/vfs.ts`; wa-sqlite's `vfs_open_last_error` on WebKit, Discussion #373). The library's worker open retry matches only `HELD_ELSEWHERE = 'NoModificationAllowedError'` (`src/worker/worker.ts`), whose comment says "the same on both engines" — true of Chrome and Firefox only, so on Safari a file held by a dying worker fails the open without a retry (for the Safari piece, or before). `mem:vfs` already noted that the name "marks a few milliseconds after `terminate()`".
- The throwaways are removed: the fork's `probe/held-handle` branch deleted; `scripts/probe-handover.ts` last at `6050a53`, `scripts/probe-opfs.ts` at `6ec7616`, both on `ci/windows-macos` (`git show <sha>:<path>` to rerun).

## A worker's JS exception reaches the caller with no `SQLiteError` code — not designed (user, 2026-10-15)

`statementError` (`src/pool.ts`) turns a query failure that SQLite did not report — a JS exception in the worker — into a plain `Error` ("as before"): the caller gets no `code` to branch on. Seen as `undefined: No modification allowed` (the entry below). Fixing that case's cause (the CoopSync retry) removes that instance, not the class. To decide: wrap such failures in a `SQLiteError` (`WORKER_CRASHED`, or a dedicated code) with the original as `cause`. Consumer-visible (CHANGELOG, `API.md`'s error codes).

## The Windows/macOS CI: deferred minors of its final review (2026-10-15)

- `scripts/bounded.ts` calls `killTree` on the child's PID after it exited; on Windows that is `taskkill /T /F` on a PID Windows may have recycled (narrow window).
- `scripts/hook-gate.ts`: `shell: true` with an args array prints DEP0190 on Node 24 under Windows (cosmetic; the argv guard test stands).
- `tests/unit/tooling/processes.test.ts` › "hands an argument with spaces and a middle dot over intact" spawns Node itself and exercises no project code; its "Falsifiable" comment is wrong.
- Windows bounds: (2400 + 1800) × 4 s = 280 min of `bounded.ts` budget against a 240-min job; a job GitHub cancels uploads no logs (`if: failure()` does not run on cancel).

## `close.test.ts` › "rejects a queued request and every later call" — its falsifier is refuted (2026-10-14, pre-existing)

Checked while widening its window on `ci/windows-macos`: with `closeAbort.abort(closingError)` removed from `close()` (`src/client.ts`, ~l. 1483 then), the test stays GREEN on `firefox · OPFSWriteAheadVFS/sync` — the comment's stated falsifier does not bite. Likely a second guard producing the same rejection (`mem:lessons/tests`, "A falsifier that stays green may be one guard of two"). To do: find the second guard, then either pin what only `closeAbort` buys or rewrite the comment to the pair, running the mutation. Reported to the user, not fixed.

## The matrix on Windows and macOS — later (user, 2026-10-15)

`matrix.yaml` (every vfs/build pair, 52 cells) runs on `ubuntu-latest` only; `tests.yaml` gives Windows and macOS `pnpm test` (complement mode) and conformance only (spec 2026-10-14, D6). The planner already produces an all-pairs plan; `matrix.yaml` would need a `runs-on` input and `BSQ_TIME_SCALE`. Cost to weigh: on Windows, Firefox's OPFS makes a full matrix take hours.

## `browsers.ts` as the only installer, under an inter-process lock — the next piece after the Windows/macOS CI (user, 2026-10-14)

Today browsers and drivers are downloaded on two paths: `node scripts/browsers.ts install` (the CI setup action, `post-create.sh`), and WebdriverIO itself at every session start, in every process (each Vitest job, `consumer-smoke`, `bench/check.ts`), since `browserCapabilities` passes only a name and a version. On a cold cache, parallel jobs download into `node_modules/.cache/wdio` at once with no lock — the `EACCES` chromedriver race of the first CI run (2026-10-11); a warm cache is safe (install is idempotent: 3.8 s, nothing downloaded, measured 2026-10-14). A lock inside `install` alone would not help: the race is on path 2. The user's design direction: `browserCapabilities` hands WebdriverIO the exact binaries from the cache (`goog:chromeOptions.binary`, `wdio:chromedriverOptions.binary`, `moz:firefoxOptions.binary`, the geckodriver binary), resolved by `browsers.ts`, which installs what is missing under an inter-process lock that **the OS releases when its holder dies** — a local socket (`net`: a Unix socket file on POSIX, a named pipe `\\.\pipe\…` on Windows): the first process to `listen` leads, checks the cache, installs if needed and answers "ready" to every client that connects (at once when already done); the others get `EADDRINUSE`, connect and wait; a client that sees `close` before "ready" re-runs the election. To design: a stale socket file after a crash on POSIX (connect → `ECONNREFUSED` → unlink and retry), a leader that ends before the others (harmless: the next finds everything installed), the ~104-byte socket path limit on macOS (a short name derived from the cache dir), and an async Vitest config. Node has no cross-process shared memory (a SharedArrayBuffer is shared between `worker_threads` only) and no `flock` in its API; a file lock (`mkdir` / `open 'wx'`, holder's PID checked with `process.kill(pid, 0)`) is the fallback, at the cost of polling. Not planned in the Windows/macOS piece (user: no single launcher-side install either).

## Read methods that write inside a transaction — not designed (user, 2026-10-14)

On the client, `read()`, `first()`, `chunk()` and `stream()` refuse a write (`assertReadable` → `NOT_A_READ_QUERY`, `src/client.ts`). Inside a transaction they do not: `tx.first()`, `tx.chunk()`, `tx.stream()` (and `tx.read()`) run on the writer and accept any write, `INSERT … RETURNING` or not; only a `readOnly` transaction refuses (`READ_ONLY_TRANSACTION`, `src/transaction.ts` `checksql`). The user finds that illogical: technically possible, inconsistent with the client surface. To decide: refuse writes in the transaction's read methods as the client does, or allow only `… RETURNING` there, or keep and document. Consumer-visible either way (CHANGELOG, `API.md`); tests that use it today: `tx-savepoint.test.ts` (`tx.chunk(… RETURNING x)`), `tx-abort.test.ts` (`tx.first(BIG_INSERT)`, a write through `first()`, spec 2026-09-10 D5). Relates to the `sqlite3_stmt_readonly` entry above.

## `temp_store` on `OPFSAnyContextVFS` — a default pragma to weigh (user, 2026-10-14)

SQLite's temporary files (a `RETURNING` table, sorts, temp indexes) open through the VFS; `OPFSAnyContextVFS` makes them OPFS files reached through the async API, where `OPFSAdaptiveVFS` uses sync handles. Measured 2026-10-14, Chrome `jspi`, `INSERT` of 1M rows `RETURNING x` inside a transaction: AnyContext `first()` 5 030 ms with `temp_store` FILE (the default) against 1 589 ms with MEMORY, `write()` 6 802 → 2 169 ms, a plain `INSERT` ~1.3 s either way; Adaptive 634 → 553 ms. The cost of MEMORY, measured in native SQLite 3.46.1 (Python, not the WASM build): process RSS +25.5 MiB at the first row against +6.6 MiB with FILE, for 10.5 MiB of data (2 693 pages of 4 KiB); 200 000 rows +7.4 MiB — so ~19 MiB per 1M integer rows, growing with what spills. In WASM the heap never shrinks: a worker keeps its peak until it ends, and each worker of the pool has its own. Option: `defaultPragmas: { temp_store: 'memory' }` on `OPFSAnyContextVFS` (`src/const/vfs.ts`) — consumer-visible (CHANGELOG, `VFS.md`); unmeasured in the WASM heap, on Firefox, and for the other VFS that might reach temp files through async I/O. Found through `tx-abort`'s `first()` test, which timed out under matrix load on AnyContext because of its `RETURNING` (removed on 2026-10-14: it served nothing the test checks).

## More `types` values for `bulkWrite()` — not designed (user, 2026-10-06)

`types` accepts only `'JSONB'` (spec 2026-10-06, D7). The user sees it later carrying conversions such as `string → number`.

## Notes, with nothing to fix

In `mem:follow-ups/notes`.
