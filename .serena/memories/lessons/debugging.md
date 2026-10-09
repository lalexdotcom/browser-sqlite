# Lessons — debugging, probes, measurement

Part of `mem:lessons`, which indexes every entry.

## About debugging

**The environment an agent runs in is not neutral, and a local reproduction that does not
neutralise it compares two different things.** rstest chooses its reporters from the
environment: it defaults to `md` when it detects an agent — Claude Code sets `AI_AGENT` —
and to `default` otherwise. `scripts/test-matrix.mjs` parses the ```json block of that
markdown report, so the report existed on this machine and on no runner, and every cell of
the first CI matrix was called "timed out" while all of its tests passed. It cost four tags
and three refuted hypotheses (slow runner, `readwrite-unsafe`, `GITHUB_ACTIONS`).

Two things made it take that long, and both are the lesson rather than the bug:

- **A falsification run that leaves the real variable set proves nothing.** Comparing the old
  and new invocation gave identical output — because both ran with `AI_AGENT` still there.
  The flag's effect is only visible where the agent is absent. `env -u AI_AGENT` reproduced
  the CI format in one command; `GITHUB_ACTIONS`, `CI` and `FORCE_COLOR` each changed nothing.
- **Reverse-engineering `node_modules` when the behaviour is documented.** Half an hour went
  into reading rstest's dist; the answer is one sentence of its reporters page. Search before
  disassembling — the user had to ask.

**Pin the format wherever code parses output; never where a human reads it.** The fix is
`--reporter md` in `test-matrix.mjs`, which is the only thing here that parses a test report.
The CI jobs that run `pnpm test` are read through GitHub annotations, which come from the
`github-actions` reporter rstest adds on a runner — pinning those would remove the tool that
named `statement-cache.test.ts:157` and the two `long-query` tests earlier the same day.

**A verdict that covers two causes sends you after the wrong one.** `test-matrix.mjs` returned
`timed-out` both for a run its own timer killed and for a run whose report it could not parse;
its comment admitted the two look alike. The word sent three release cycles looking for
slowness. What broke the deadlock was printing the failing cell's last 60 lines, because the
script writes each run's output to `.matrix/` and prints only a verdict — and that directory
dies with the runner.

**A green cell can mean the test never ran there.** `isolated` showed 0 failures on
`IDBBatchAtomicVFS` and `IDBMirrorVFS` throughout the 2026-09-18 triage, and it nearly sent the
diagnosis the wrong way. That config reads `tests/browser/isolated/**` only — a separate
three-file suite, 7 tests against 334. **Before reading a zero as evidence, check the cell ran the
subject**: `grep -c '<the test name>'` on its report answers it in one command.

**A defect named after the log line it carried outlives its own refutation.** HANDLE-2 was named,
filed and reasoned about for twelve days as "Firefox does not release the OPFS handle", on the
strength of one `NoModificationAllowedError` in one run. Measurement then refuted the cause
(Firefox releases in 1-6 ms), the wedge stopped reproducing anywhere (~70 attempts, and 0/40 at the
very commit where 9/40 had been recorded), and a different defect — a transaction callback holding
`bsq:write` for the origin — was found to reproduce the same symptom every time. Yet the entry
survived all three, because closing it meant contradicting its NAME. **The tell is an entry whose
every factual claim has been replaced while its title has not.** When that happens the question is
not "what else could cause this?" but "is this the same defect at all?". Closed 2026-09-21.

**A test that really waits seconds is a load generator, and its neighbours may be measuring time.**
A browser test waiting seven seconds — it had to outlast a five-second advisory — reddened
`tx-savepoint`'s T4 on `chromium · OPFSWriteAheadVFS/jspi`, which measures INTERRUPT LATENCY against
a bound calibrated on an idle machine. Measured: 2 failures in 4 runs with it present, 0 in 5 with
it skipped, 5 of 5 green once it moved. **A matrix cell is one browser running one project's files;
a slow test does not wait politely in its own corner.** The fix is to remove the load, not to widen
the neighbour's bound — a timer-driven behaviour belongs in the unit project on fake timers, where
it costs nothing and asserts the same thing. `rstest.useFakeTimers()` and
`advanceTimersByTimeAsync()` exist and were unused here until 2026-09-22.

**Check what has SHIPPED before calling a change breaking.** `GENERATOR_ABANDONED` was filed for
rc.6 as a public-surface rename, twice, on the reasoning that a published error code cannot move.
It had never been published: it was added after rc.4, in the still-open section of `CHANGELOG.md`,
and `package.json` has sat at `1.0.0-rc.4` throughout. The user corrected it in five words. **The
repository states this plainly and it is one command away** — everything since rc.4 is unreleased,
so "breaking" applies to rc.4's surface and to nothing added since.

**A concurrency library needs `Promise.all` in its tests, or its core contract is untested.** On
2026-09-21 this repo had `Promise.all` in 17 of 50 browser test files and in NONE of the eight
transaction ones. Every transaction test awaited each statement in turn — which is the one shape
that cannot expose a serialisation defect. Two reads created in the same tick lost the whole
transaction, and a `bulkWrite` batch posted after a read issued later, so the read returned stale
rows. Both had shipped through rc.4 and every rc.5 lot. **The tell is a suite whose every call is
awaited immediately**: it tests the library's sequential behaviour and calls it coverage.

**On a queue, test the ABORT axis separately from the ORDER axis — they fail differently.** The
ordering tests for that queue were all green while a real defect sat underneath: a statement
aborted by its own signal WHILE WAITING released its place at once, although it had never waited
for that place, so the statement behind it started while the head was still in flight. Only a test
that aborted a QUEUED statement found it. The rule the fix encodes is worth carrying to any queue:
**a place left early is handed on, not cancelled.**

**Your own instrumentation can be the artefact — prove the defect without it.** Chasing the
`IDBMirrorVFS` corruption, a probe showed `block.set(pData, 0)` leaving the destination at zero
with a valid source, which is impossible for a `Uint8Array`. The right move was the control that
came far too late: one read-only probe, nothing in the write path, which confirmed the stored bytes
were zeroes regardless. Only then was it worth explaining. (The cause was that `pData` is a
`Uint8ArrayProxy` with no indexed access — `set()` read `undefined` everywhere.)

**The scenario a defect is found through is rarely the one that demonstrates it.** #353's first
test reproduced a storage leak through a rolled-back transaction — the path the investigation came
from — which made it depend on another PR and fail on upstream's master for the wrong reason, and
stay red after the fix. `DELETE` + `VACUUM` reaches the same truncation without rolling anything
back, runs on master unchanged, and shows the leak more plainly (531 blocks against 93). Ask what
the smallest thing that triggers this is, not what happened to trigger it.

**Six refuted hypotheses are a signal to stop guessing, not to guess better.** The same
investigation refuted misalignment, a short read, an inconsistent deduced size, a changed block
size, an orphan block and `BATCH_ATOMIC` — each a plausible read of the code. What worked was a
trace: the VFS posting its events on a `BroadcastChannel` that a throwaway test carried into its
assertion, because a worker's console never reaches the report. Three candidate fixes were refuted
the same way afterwards, including one the trace itself seemed to point at.

**A pile of failures can be one defect — and can be two, when nothing suggests it.**
`IDBMirrorVFS`'s 46 failures over twelve subjects were a single cause; `OPFSCoopSyncVFS`'s 7 were
**two unrelated ones** that shared a VFS and nothing else. Count causes by measurement, never by
the shape of the pile.


**Instrument the product, not the test.** Every probe placed in a hanging test made the bug
disappear — bounding the call, enabling `debug: true`, shortening a sleep. A trace array on
`globalThis`, written from `client.ts`/`pool.ts`, caught it in five runs.

**Instrumentation can hide the bug.** Wrapping `Worker` shifted a millisecond-scale race
and turned the failure green. When a probe disagrees with the plain run, **trust the plain
run** and find a lighter instrument — here, sampling `db.debug` statuses instead of
wrapping the constructor.

**How to get evidence out of a test that never finishes.** A timed-out test still runs its
`afterEach`, and `browserLogs: false` swallows `console.log` — so an `afterEach` that
**throws** the trace is the way out. Gate the throw precisely: set a flag on the test's last
line and dump only when that flag is unset. Two loose gates were tried first and both fired
on healthy paths.

**A control that differs by two things controls nothing.** The first attribution compared
`main` against a branch that differed by a source change *and* by an added test file. Four
combinations were needed to exonerate the source change — and the real bug turned out to be
reachable on `main` all along. State each arm's single variable before running it.

**A probe that does not reproduce the failure is measuring something else.** The abandon
path was blamed for hours on a reasonable-looking trace; a standalone reproduction passed
at 0 ms while the real test failed at 29 s. Only instrumenting *the failing test in place*
showed why.

**A catastrophic-looking number can be uninformative.** WebKit's 9/104 was one missing API,
not 95 defects. Read the first failure's cause before reading the count.

## For a sub-millisecond effect, count the round trips — 2026-08-27

`lastWriterIndex` saves one worker round trip per read that follows a write. Timed on this
machine it is worth about 0.2 ms against a 1.1 ms read, so a before/after harness returned
differences that went **both ways** between pool sizes — the signature of noise, not of a
gain. Firefox made it worse in a way no run count fixes: it reduces `performance.now()` to
1 ms precision by default, five times the effect, so p50 and p95 come back as integers.

What settled it was a **counter**: the barrier test asserts that the read pays no
`BARRIER_SQL` statement, which is deterministic, engine-independent, and falsifiable by
deleting the branch. The claim shipped as "one round trip fewer", never as "faster", and
nothing about it reached the README.

**Before building a timing harness, ask whether the thing being changed can be counted
instead.** A count survives a fast machine, a clamped timer and an n of one; a duration
survives none of them.

## Use every platform you have before announcing a measurement — 2026-08-27

The same session installed a Firefox selector for the browser suite, then measured
`lastWriterIndex` on Chromium alone and *offered* Firefox as a follow-up. The user's
correction was blunt and right. Firefox then produced the finding that mattered — the 1 ms
timer clamp — which Chromium alone could never have shown.

**Two engines are installed here** (`~/.cache/ms-playwright`: chromium, firefox, webkit;
WebKit is useless for OPFS on Linux). A measurement announced from one of the two is half a
measurement.

## When a timing says nothing, count a state instead — 2026-08-31

A benchmark page ran much faster on Firefox after the readiness gate shipped, and
the question was why. Two probes timed queries: one from client creation, one for
a burst after a warm-up. Both came back flat on both engines, and the second
looked like a clean refutation — the gate simply costs its ~15 ms of serialised
opens and buys nothing.

Both were measuring the wrong quantity. The third probe counted **how many
workers had ever reported `initializationTime`**, and answered on the first run:
without the gate, two Firefox runs in three ended with one worker opened out of
four, permanently. The effect was never in latency. It was in the size of the
pool, and a duration cannot see the difference between forty small reads on one
worker and on four.

**What it cost:** most of a morning, and a confident negative that would have
closed the question wrongly had the user accepted it.

**What to do instead:** before timing anything, ask what STATE the hypothesis
claims is different, and whether an observable for it already exists. Here
`db.debug` had exposed it all along. A duration is a last resort — it aggregates
every cause at once, so a flat one refutes nothing in particular.

**The tell:** a probe that returns "no difference" on *both* engines, when the
mechanism under test exists on only one of them, is not evidence about the
mechanism. It is evidence that the probe does not reach it.

## `Promise.race` breaks ties among already-settled inputs by ARRAY ORDER — 2026-09-08

`drain` races the pending chunk against the abort. Once a cleanup's `iterator.return()`
completes the transport **synchronously**, the next loop turn enters the race with **both**
inputs already settled — and `Promise.race` then resolves in array position, not by settlement
time. The chunk won, the loop saw `done`, and **the abort was lost outright rather than
delayed**. So with two inputs that can both be pre-settled, the array order *is* a priority
declaration.

**The reachability condition is narrower than "two things settle at once", and the difference
is the whole lesson.** An async generator's `yield` performs an implicit `Await`, so
`iterator.next()` is never *pre*-settled merely because data is queued. It takes an **external,
synchronous `.return()`** completing the iterator while a live loop sits between turns. That is
why the defect is reachable on `chunk()` and not on `writeWorker`, whose callers all await it
immediately — and the controller's first analysis, which said `writeWorker` had a milder version
of the same bug, was wrong for exactly this reason.

Found because an implementer refused to work around a test that would not go green and built a
standalone Node reproduction before touching the source. It cost one red test to find and would
have cost a silent data loss to miss.

## A probe must touch what it measures — 2026-09-14

POOL-SIZE's first "read during a long query" timed `SELECT 1` behind a recursive CTE. Neither
touched a table, neither needed the access handle, and the column reported a pool serving
concurrent reads where it served only file-less queries. Caught on reading the first run and
re-run with a table scan against a row read. **Check that each workload exercises the resource in
question before reading its number.**

## A verdict that flips across a corpus is split by commit before engine — 2026-09-14

`IDBBatchAtomicVFS`'s `reads-during-long-query` came back `true` in this container, and it read
as a Firefox 153 or container difference. Split by each export's `preview` commit, the corpus
partitioned exactly — every `false` before `f4b3fd7`, every `true` after, Chromium included. The
row passes a `signal`, and `f4b3fd7` changed what a signal does in the worker: the row's question
changed with no change to the row (IDB-SIGNAL, `mem:measurements`). **A measurement that hands the
library an option measures that option's path; when the option's semantics move, the measurement
moves with them.**

## A swallowed cleanup turns one defect into an unreadable cascade — 2026-09-16

`createTestClient`'s cleanup ended its `deleteDatabase` with `.catch(() => {})`. On
`AccessHandlePoolVFS` that call was failing on every test that had just killed a busy worker —
the dying worker still held the directory — so the pool slot was never given back. Six slots,
then nothing opened, and the later tests failed with `sqlite3_open_v2`, which names no cause at
all. **The defect was one line away from the evidence and the evidence was being deleted.**

**A cleanup that cannot clean must say so.** Tolerate exactly the outcomes that are a test's
subject — here `DATABASE_NOT_FOUND`, for the several tests whose client never creates a file —
and let everything else reach the test. `.catch(() => {})` in a cleanup is not defensive, it is a
decision to hide whatever the cleanup was for.

**The corollary, and it is what cost the time:** the same silence made a PRODUCT defect look like
test infrastructure. `close()` then `deleteDatabase()` is the sequence a consumer writes, and it
was failing for real. It was written off as "our test helper leaks" for hours because nothing
ever printed.

## A delay that does not fix it has only refuted the delay you tried — 2026-09-16

Chasing the same defect, delaying the worker respawn by 250 ms and then 1000 ms changed nothing,
and both were read as "not a timing race". The release actually takes ~2000 ms (HANDLE-CORPSE,
`mem:measurements`): both probes were under the threshold. **A negative result from a magnitude
you chose by feel refutes that magnitude, not the hypothesis.** Measure the quantity before
bisecting on it — the direct measurement (terminate, then poll until reopen succeeds) took one
run and answered exactly.

Two more traps from the same afternoon, both of which produced confident wrong readings:

- **The first probe measured the connection lock, not the engine.** It reopened while the first
  client was still alive, so it was reading `bsq:conn`'s exclusivity — `-1` on every trial, which
  reads like "never released". Close the thing that is not under test.
- **rstest prints `console` output only for tests that FAIL.** A probe that logs its measurement
  and passes prints nothing. Carry the value in the assertion (`expect(measured).toBe('X')`) — and
  keep it short, the report truncates the message.

## A defect identical on every backend may live in the layer they all share — ours included (2026-09-25, `fix/barrier-falsifier`)

The barrier's spec measured staleness "40 runs, 40 stale, across four VFS and three builds" and concluded "the common factor is wa-sqlite itself", so the barrier was declared permanent architecture. The common factor was also our own worker, and that is where it was: column names read before the first `step()`, so a statement SQLite re-prepared on a changed schema returned fresh rows under stale names. `aee3859` fixed it in passing, a month later, and the barrier's tests went inert without anyone noticing. **When a symptom does not vary with the backend, list every layer the backends share and suspect each, starting with the one you wrote.** And a test that stops failing when its mechanism is removed is telling you the mechanism is no longer what it guards: run the falsifier after every change to the code around it, not only the day the test is written.

## Two harnesses disagreeing by 45× is a harness finding until a pure probe says otherwise (2026-09-28, `fix/writeahead-read-to-current`)

The same `WriteAhead` scan cost 60 ms in wa-sqlite's runner and 2.8 s in ours. Build, binary and transpilation were ruled out one run each; instrumenting the scan put the time in `read()` calls, and a probe with no library at all reproduced the gap — rstest's pages are off-the-record (RSTEST-OTR). The first reading, "the library makes it dearer", would have sent the fix to the wrong layer. **When one harness's absolute number is out of line, run the same dependency-free probe in both before blaming the code under test.**

## A VFS fix is not verified until SQLite has been run through it (2026-09-30, wa-sqlite #351)

Upstream's suite was green on a fix that threw `DataError` on a one-byte write, which SQLite makes to invalidate a stale journal header, and green on a fix that left overlapping blocks. Both were found by driving real SQL through the VFS with three checks: a byte-exact copy of what SQLite writes compared with what it reads back, a content hash before a transaction and after its `ROLLBACK`, and a randomised sequence of statements and cache sizes. **Run that probe on the fix before trusting the unit suite, and vary the journal mode: `DELETE` hides what `PERSIST` shows.**

## Wrong bytes in the store are not wrong bytes read (2026-09-30, wa-sqlite #351)

The first comparison found thousands of journal bytes that did not read back, and the draft for upstream was heading for "corruption". Splitting the reads SQLite actually makes between the transaction in flight and leftovers of earlier ones gave 0 for the first, in every run. **Measure what the consumer of the data reads before naming the consequence**; say "the store returns something other than what was written" when that is all that is shown.

## The traps of a page-level VFS probe (2026-09-30, wa-sqlite #351)

Each cost a wrong result or a lost quarter of an hour:

- `jWrite` and `jRead` receive a `Uint8ArrayProxy` over the WASM heap: `typedArray.set(proxy)` copies zeroes. Take `pData.slice()` first. (The same trap as IDBMirrorVFS's #352.)
- A wrapper around a VFS method must be `async` exactly when the original is: `FacadeVFS` decides from the function's kind and throws "unexpected Promise" otherwise.
- A reference copy of a file must be dropped on `jDelete`, or a `DELETE`-mode journal compares against the previous transaction.
- Read a file back by the runs SQLite wrote, not by fixed chunks: `jRead` short-reads across a range never written and zeroes the rest of the chunk, which reads as loss.
- A `Promise.race` against a `setTimeout` deadline keeps Node alive until the timer fires, long after the result printed. End the script with `process.exit`.
- `pkill -f <pattern>` kills the shell that runs it when the pattern is in its own command line; and a progress stream piped into `tail` shows nothing until the process ends.
- A session slower than the harness's budget reads as a hang. Replay it alone, with a trace and a longer budget, on the fix and on the baseline, before calling it one.

## A probe that always throws hides its own cleanup (2026-09-30)

A probe reporting through a thrown message fails by design, so an error in its `onTestFinished` never shows. The test written from it failed at once, in the cleanup: two `AccessHandlePoolVFS` clients in one test, and the first one's `deleteDatabase` running while the second was still open. `onTestFinished` handlers run in registration order. Turn a probe into a test by running it green, not by copying it.

## A reader that finds nothing may be the one that erased it (2026-10-01)

"A second client counts 0 tables" read as data the first client never persisted. A dump of the store taken just before the second open showed the opposite: the data was there, beside a journal that should not have been, and the second client's own open rolled it back. When a reader sees missing data, snapshot the storage before the reader touches it; a recovery path (hot journal, `pendingVersion` cleanup) is a writer too.

## A rare crash is amplified, not waited for (2026-10-03)

Ten days of sightings at ~3 % never named the Firefox `lifecycle.test.ts` crash, and a 40-pass A/B on the original condition saw none at all. Looping the suspect file 40 times in one page made it 10/10 in under a minute, and every later question — which test, which step, which delay — was answered in a few passes each. When a failure is rare, raise its rate first; an A/B at 3 % costs hours and concludes nothing.

**A library-free reproduction must match the library's shape before it clears the library.** Classic workers crashed without the library, and that was briefly reported as "the library is out". The library's workers are module workers, which did not crash on that schedule in a plain page; the real trigger — terminating any worker in its first milliseconds — was only found by bisecting the library's own sequence. Check the obvious attributes (worker type, how the script is served, timing) before concluding.

## A VFS that fails a write inside SQLite's batch window gets a journal it never asked for (2026-10-03, wa-sqlite #371)

Failing every `IDBMirrorVFS` call after an aborted commit looked like the safe, minimal fix — `OPFSPermutedVFS` does it. It corrupted the store on the next open. `sqlite3PagerCommitPhaseOne` (3.53.0) retries a batch-atomic commit with a rollback journal when the batch fails with any `IOERR`-class code but `IOERR_NOMEM`; that journal stayed in the VFS's memory and was played back over the store. **When a VFS must refuse a commit, refuse it where SQLite expects failure and keeps no journal (`SQLITE_FCNTL_SYNC`, outside the batch), and let writes that only reach memory succeed.** Found only because a reopen in the same VFS instance was probed; a fresh worker would have hidden it.

## Reload a VFS's view only where SQLite revalidates or discards its cache — and never under a journal written on the old view (2026-10-03, wa-sqlite #371)

Safe points, measured: `SHARED` from `NONE` (SQLite rechecks the change counter) and right after a commit SQLite saw fail (`pager_unlock` resets the cache, exclusive mode too). Unsafe, measured: the same reload when the refused transaction had spilled to a journal — SQLite rolls back through the handle it already holds and writes the old view's pages over the new one (12/12 corrupt). Removing the journal from the VFS's map does not help; the handle is open.

## `IDBTransaction.abort()` throws once `commit()` was called (2026-10-03, wa-sqlite #371)

So an aborted transaction cannot cancel the ones queued after it from its `onabort`; the first idea (cascade aborts) silently did nothing behind a `try`. What works: give the later transaction a first request — it runs only after the earlier overlapping ones finished, so its callback sees the abort and can still abort its own transaction. Use it only while another commit is pending: on every commit it cost 15-30 % on exclusive `full`.

## A probe summary that drops a field can invent a defect (2026-10-03, wa-sqlite #372)

The library probe printed B's count after its write and a fresh client's count, not B's write result. `2` where `3` was expected read as a lost update — a stale writer overwriting a stored commit — and was announced as such. B's write had failed with `BUSY`; nothing was overwritten. A trace showed it, and a count taken before B wrote (A's row there, 48/48) settled it. **Before naming an outcome, print every step's own result, the failures above all; an aggregate that omits one cannot tell "lost" from "refused".**

## Playwright's Firefox is not a neutral place to measure memory (2026-10-07)

Under Playwright, Juggler keeps every value a page consumes through `for await` alive (FF-JUGGLER, `mem:measurements/footprint`), and it roughly halves Firefox's speed. A day of Firefox memory figures for `stream()`/`chunk()` was inflated by it, a correct fix looked partial, and `chunk()` became an "open question" that did not exist. What exposed it: a pure-JS probe with a control (a plain loop) that the instrument could pass, then the same binary launched by hand. **Before a Firefox memory finding is believed, reproduce it in a Firefox launched without automation** (`--headless --no-remote --profile`, the page driving itself from its query string, results POSTed back) — and validate every instrument against a control it must pass: a `FinalizationRegistry` probe also needs tenured witnesses, since a short-lived object proves only a minor GC.

**A module worker with top-level await drops the first message (2026-09-16, Chromium 151 and Firefox 153, Playwright 1.62.1).** A `new Worker(url, { type: 'module' })` whose script awaits at top level (`await SQLiteESMFactory(...)`) never receives a message the page posted at construction: it reaches its `self.onmessage = …` assignment and nothing is delivered — dropped, not queued. It looks exactly like a deadlock (nothing settles, no error, no `onerror`), and it alone is why the reproduction published in wa-sqlite #341 hangs. Any worker harness here has the worker announce itself (`postMessage({ ready: true })`) and the page send work only in reply; before calling a never-settling worker test a lock or VFS bug, check the handshake.

**A retention test can still live in the Playwright suite (2026-10-07):** read with `next()` by hand, stop mid-query, allocate garbage that survives minor GCs until every tenured witness is finalized, and only then count. Waiting for a natural GC there gave a different answer depending on the test's position in the page; forcing one gave 29/30 against 0/30 on every arm. **And a residue after a fix is not a retention until pressure fails to free it**: `chunk()` stayed at +700 MB after the read on an idle page, and 4 s of allocation took it to +24.

## A runner that reports a file only when it ends makes a slow file look like a hang (2026-10-07, wa-sqlite on Windows Firefox)

`@web/test-runner` prints a file only once it finishes, in random order. A Windows Firefox run sat at 12 of 16 files for 16 minutes, and it was cancelled and reported to the user as a hang. One runner invocation per file, each bounded at 10 minutes, finished every file green in about 20 minutes: `sql` alone took 478 s. **Before calling a run hung, run its files one at a time under a bound, so the slow one is named and timed.**

## A page the browser kills leaves no crash report; ask the browser's own log (2026-10-08, Safari 26)

Safari 26 lost its WebDriver session during one spec, every time. Two runs collecting `DiagnosticReports` found nothing. One run of `log show` filtered on WebKit's subsystems gave the whole story at once: the page's footprint climbing to 9 GB, an IPC queue of 265 000 messages, and `reason=ExceededMemoryLimit`. **When a browser drops a page with no crash, read its unified log first.**

## Counting a component's activity names the stuck party; a hypothesis about load does not (2026-10-08, Safari 26)

Two hypotheses about the load the test put on Safari each cost a run: the number of proxies, then the retry rate. Neither changed anything. Per-worker counters reported live every 2 s did: the VFS calls in flight, the pending IndexedDB requests and lock requests, and `navigator.locks.query()`. They showed at once one worker inside its commit, its IndexedDB writes pending for 8 s while it held every lock, and the others polling. **Instrument what each party is waiting on before varying the load.**

## A race load cannot reproduce may yield to parking the one await it lives in (2026-10-09, `WORKER_BUSY` after an abort)

Seen twice under full matrices, the failure did not come back once in 35 runs under 16 busy loops — the test alone, its file, its whole cell. Reading the stack instead did it: the error came from the SECOND read's barrier, so the first read's lease had come back while something of its own was still to be posted; the only await between a lease and a posted statement was `applyBarrier`'s `originMax()`. Patching `LockManager.prototype.query` in the test page to park until released turned a once-a-matrix flake into a failure on every run. **When a race has a window, find the await that is the window and hold it open; more load only widens it by chance.**
