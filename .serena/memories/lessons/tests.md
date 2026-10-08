# Lessons — tests and falsifiers

Part of `mem:lessons`, which indexes every entry.

## About tests

**Assert falsifiability, not passage.** For every test, name the line whose deletion makes
it fail. Seven tests written in wave 1 passed identically with and without the behaviour
they claimed to pin; wave 3 then spent **seven fix rounds** on the same cause — more than
on any other. It is not a solved habit.

**A reasoned claim of falsifiability is worth nothing.** Four of wave 3's reasoned claims
were wrong. What works: make the implementer *delete the line, observe red, restore,
observe green*, and report both.

**A falsifiability claim can be disproved, and then you delete the test.** A comment
claiming "move this line above the call and a second writer appears" was checked by moving
it: everything stayed green, because the next call reclaims the designation immediately.
The test was removed and the comment rewritten to what the experiment actually showed. The
honest response to a refuted claim is deletion, not rewording.

**Measure the test, not the argument.** A correct ordering analysis is not evidence that a
test is stable. A test restored on a sound argument turned out 7.5 % flaky, and the cause
was a property it incidentally depended on, not the one it was written for.

**The `it.fails` convention does not fit a low-rate flake.** A characterization test
pinning a defect that appears 1.7 % of the time would itself fail most runs.

## Reading a test report needs four fields, not three — 2026-08-27

`pnpm test` was reported green from `tests`, `passedTests` and `failedTests`
while `status` was `fail` and `failedFiles` was 1: an unhandled rejection had
escaped **outside** any test, which the per-test counters cannot show. Grep
`status` and `failedFiles` too, or a file-level failure reads as a pass.

What it was hiding is worth keeping: making `scheduler.acquire` reject a queued
request moved the rejection **into `abort()`**, synchronously, where it used to
wait for a lease. A caller that attaches its handler after the next `await`
then lets the promise cross a microtask checkpoint unhandled. That is a real
consumer-visible timing change, and it is in `CHANGELOG.md` for that reason.

## A declaration and the skip it causes confirm each other — 2026-08-27

`OPFSWriteAheadVFS` declared `requires: ['readwrite-unsafe']`. That declaration made the
conformance suite skip exactly the pairs that would have falsified it, so nine entries
skipped themselves on the strength of their own claim, and `mem:vfs` carried an inferred
mechanism — "the second connection cannot take the handle, and the pool breaks with no
error naming the cause" — that had never been executed. Forced onto Firefox with
`HAS_UNSAFE_HANDLES=false`, the VFS passed all three build pairs and all six invariants,
concurrent writes included, at `poolSize` 1, 2 and 4.

**When a declaration decides whether its own test runs, it is unfalsifiable by
construction.** Look for that shape: a `requires`, a capability probe, a feature flag that
gates the suite that would check it. The fix was `requires: ['opfs']` with
`degradesWithout: ['readwrite-unsafe']`, which changed no runtime behaviour and un-skipped
nine conformance entries.

A second cost, paid separately: the long-running question "accept it, or design an async
probe?" was about a defence that did not exist — `missingFeature` skips `UNPROBEABLE`
features, so that `requires` had never blocked anything at construction on any engine.

## A test that waits for a TRANSIENT state must bound the wait — 2026-09-03

`close.test.ts` polled for a worker holding a request it had not released, with
`while (!predicate()) await sleep(0)`. A one-row INSERT can start and finish between two
polls; after that the predicate is false for ever and the loop runs until the test itself
gives up at 30 s, printing nothing about what it was waiting for. About one Firefox run in
three.

**Two things were wrong and fixing either alone would have been worse than useless.** The
window was microseconds wide — widened to milliseconds with a recursive CTE, leaving every
assertion after the wait untouched, because it was the PRECONDITION that could not be
observed, not the behaviour under test. And the wait was unbounded — now 5 s, throwing with
the thing it waited for named. Widening alone postpones the hang to the day the window closes
again; bounding alone turns a mute timeout into a red test that still fails one run in three.

**The general shape: a predicate over a state that can pass between two samples is not a
wait, it is a bet.** Either make the state monotonic, or make the window wide enough that the
bet cannot be lost, and bound the wait either way so a lost bet reports rather than hangs.

**And it was invisible for weeks for a reason worth remembering.** `pnpm test` ran Chromium
only, so the pre-commit hook never saw it; only CI did, once per push, where an occasional red
reads as noise. Splitting the suite per engine put Firefox in the hook and the flake became a
commit that fails one time in three — found while committing, five minutes later. **Coverage
that runs where the work happens finds what coverage that runs elsewhere does not.**

## A regression test's shape can delete the race it was written to pin — 2026-09-03

**What happened:** the CoopSync handle-transfer `BUSY` was reproduced by a probe issuing eight
mixed read/write operations concurrently. The regression test written from it awaited the
write first, *then* issued the reads — tidier, and reading almost the same. It passed. It also
passed with the fix removed: sequencing the write had eliminated the contention, so it
reproduced nothing and asserted nothing.

**What caught it:** running the claimed falsifier. Nothing else would have — the test was
green, the fix was real, and the suite would have carried a permanently vacuous test.

**What to do instead:** when a test pins a race, keep the concurrent shape of the probe that
found it, and treat any `await` you add between operations as removing a race until proven
otherwise. Then run the falsifier before believing the test.

**The tell:** a test for a concurrency defect that contains a sequential setup of the very
operations that must overlap.

## A streaming API tested by a consumer that never pauses is not tested — 2026-09-04

`stream()` and `chunk()` dropped rows for four releases and the suite never saw it. The
transport held one slot for an in-flight chunk while the credit window puts two in flight,
so a chunk arriving while the pool's generator was suspended at its `yield` resolved a
promise nobody would ever await. The condition for loss is therefore *the consumer does
something between chunks* — the nominal case for the API's whole purpose — and 501 of 1001
rows came back, silently, on both engines.

**Every test consumed at full speed.** `for await (const rows of …) result.push(...rows)`
returns to the await inside the same microtask, so the generator was always the one waiting
when a chunk landed. The suite exercised the transport's happy interleaving exclusively,
and no amount of coverage on that shape could have found this.

**The rule: a streaming test must `await` in its loop body**, and `await sleep(0)` is
enough — one turn of the event loop was the entire precondition. The same applies to any
API whose consumer holds a generator open: what is being tested is the suspension, not the
data.

**Its corollary, learned the same afternoon:** `read()`, `first()` and `write()` were
immune for exactly the same reason, so a defect in the shared transport was invisible from
three of the five surfaces that use it. Immunity by accident reads as correctness.

## A test that measures the END of a query cannot pin an INTERRUPT — 2026-09-05

Three tests in the query-interruption lot were written to prove that an abort stops a
running statement. All three passed against an implementation with the feature REMOVED. They
were caught one at a time, the last of them after the whole-branch review had said ship.

**The shape of the mistake is the same every time: they asserted that the query ENDED
quickly, and a query always ends.** The bound they asserted was simply larger than the time
the statement took to run to completion on its own — 500 ms against ~400 ms, 1 500 ms
against a step that finished by itself. Nothing in the test discriminated "was interrupted"
from "was short".

**Two mechanisms made it worse, and both are worth knowing on their own:**

- **The first run of any SQL goes through `sqlite.statements()`, whose async generator
  carries a macrotask boundary before the first step.** A `stop` posted during that window is
  delivered BEFORE the step begins, so the loop's between-steps check breaks it and the abort
  never reaches the progress handler at all. A test that aborts a cold query is testing the
  pre-existing between-steps stop, not mid-step interruption. The fix is a warm-up run so the
  measured run takes the cached path.
- **Where the clock starts decides what is measured.** Taking the timestamp after
  `await expect(promise).rejects` measures only the query that follows, because the promise
  rejects immediately by contract. The drain being measured happens after that line.

**The discipline that would have caught all three on day one: neutralise the FEATURE and
watch the test go red — not a helper near it.** Removing `worker.interrupt()` proved nothing
because the `stop` message still arrived by another path; only killing the progress-handler
installation, or the `Atomics` read itself, tests what the test claims. And a mutation is
worth running even when the review says ship, because a green suite is evidence about the
tests, not about the code.

**A test that cannot discriminate should say so in its own comment.** Three tests in that
lot now do: they name what they pin — the immediate-rejection contract, the connection state,
the degraded behaviour — and say plainly that they do not pin the feature. That is worth more
than a test quietly believed to cover something it does not.

## A timeout budget can reintroduce the failure a helper was written to prevent — 2026-09-05

Making the interrupt tests discriminate required a warm-up run that costs ~15 s on Firefox,
against a 30 s project default. A machine half the speed exceeds it — and **a test that
exceeds its timeout does not fail, it expires without naming what it was waiting for**, which
is precisely the failure `waitUntil` exists to prevent. The budget would have reintroduced it
from the other side. That test carries its own 90 s timeout and a comment saying why.

## A documentation heading can be asserted by a test — 2026-09-07

Renaming the README's *Bundler Configuration* section to lowercase `configuration` while
splitting the documentation broke nothing visible, so the same rename was carried into the
error message `pool.ts` raises when the worker URL 404s. That message is asserted at the
character level: `tests/browser/lifecycle.test.ts` expects
`stringContaining('Bundler Configuration')`. The suite would have caught it at commit — the
pre-commit hook runs all three configs — but only after several minutes, and the diagnosis
from a browser test failing on a string is not obvious.

**Before renaming a documentation heading, grep the repository for its exact text.** Two
kinds of things cite one: an error message that tells a consumer where to read, and a test
pinning that message. Here the fix was to restore the original casing on both sides rather
than to edit the test — the section had that name first, and the string is what a consumer
sees.

The general form: prose in `src/` is not free of coupling. The same split left seven
comments and one error message pointing at README sections that had moved to `API.md` and
`VFS.md`; nothing failed, and nothing would have. `grep -rn README src/` is the sweep, and
it is worth running whenever a documentation file is reorganised.

## A plan's list of tests to invert is a guess until the tests are grepped — 2026-09-11

The savepoint spec and plan listed the tests the new rule would invert, from memory of the
previous branch. They missed one: `tests/browser/tx-handle.test.ts` pinned the superseded rule
through `tx.signal` — a caught abandoned write aborted it. The core task's implementer stopped
BLOCKED with the suite red on a file outside its brief, which cost a round trip and a ruling.
**Before planning a rule change, grep the tests for what the old rule makes observable** — here
`TRANSACTION_CLOSED` after an abandoned write, and `tx.signal.aborted` — and list every hit, not
the ones remembered.

## Deleting a function orphans every Falsifiable comment that names it — 2026-09-11

Twice on one branch: removing `isAbandonedWrite` left two tests whose comments told the reader to
mutate it, and removing the `abandon` listener left a third. Each cost a fix round. The comments
were right when written; the deletion made them name code that no longer existed, and a test
whose only documented falsifier is gone has none. **The task that deletes a symbol greps
`tests/` for its name and rewrites every falsifier that cites it, running each.**

## A falsifier also stays green when a second guard produces the same outcome — 2026-09-12

R2's two tests — a statement whose own signal fires while it waits behind an abandoned write
rejects alone — named "remove the race in `entryWait`" as their falsifier. The final
whole-branch review ran it: both stayed green, because after the wait `throwIfAborted()` still
rejected the statement alone, so the mutation only cost latency. Three reviews had accepted the
comments on reading. **Where the code has belt-and-braces guards, mutating one of them proves
nothing; assert what only that guard buys** — here timing: the rejection must arrive before the
abandoned write ends, or the test must deadlock without the race. It is "a reasoned claim of
falsifiability is worth nothing" again, in a shape it had not taken yet.

## A spec rule with no line in its own test list does not get built — 2026-09-12

The savepoint spec's §4 said, in one sentence, that a failed savepoint conclusion kills the
transaction. Its §8 listed no test for it. Eight tasks, their reviews and the implementers all
passed over it; the final review found it unbuilt, and found the path that made it matter — a
consumer's `…; RELEASE u` carrying its own timeout, abandoned, pops the library's savepoint with
`u`, and the rejected write was committed. **Every consequence a spec's mechanism states needs a
line in its own test list**, or the plan — which argues from the test list — silently drops it.

## A conformance that does not count live workers can refute a true claim — 2026-09-13

`70b2b7a` (2026-08-27) declared false the README's "off Chromium the first connection opens and
the second cannot take the handle", because conformance passed `OPFSWriteAheadVFS` on Firefox at
`poolSize` 1, 2 and 4. The claim was true: every worker but one failed to open, and a pool of one
passes every invariant. For two weeks a correct statement stood refuted, and every bench export of
that VFS off Chromium ran on one worker of four. **A suite that proves a VFS works must also prove
how many workers it worked with** — conformance now fails on any lost worker
(`expectNoWorkerLost`) and skips a two-worker invariant where the pool runs one (`oneWorkerHere`).

## `pnpm test` stops at the first red config — 2026-09-14

It chains three configs with `&&`. In a dry run the chromium+unit config failed by design, so the
Firefox config — the only one that mattered — never ran, and its silence read as green until the
reports were counted. **Count the reports before reading any of them, and run configs separately
when a failure is expected.**

## A dry run finds the tests that turn red, not those that turn vacuous — 2026-09-14

Capping `OPFSAdaptiveVFS` at one worker on Firefox was sized by a dry run: twelve tests failed and
moved to a VFS that keeps a pool. The final review found three more, green on Firefox through
another path — a declined worker instead of an opened one — whose falsifiers no longer bit there.
**When a change removes a capability, grep for every test that exercises it: a red list only shows
the tests that noticed.** Kin of "a plan's list of tests to invert is a guess until the tests are
grepped".

## A fix round can move a test's only falsifier — 2026-09-15

The worker stamps SQLite's extended code at the query level, and a missing-collation test was its
falsifier. A task review found a path where that stamp came too late; the fix added a second stamp
nearer the failure — on the path the test itself ran. From then on the test went red only if both
stamps were removed, the query-level one had no falsifier, and the test's comment still named it.
The ruling on that fix round had asked whether the NEW path could be tested, and not what the fix
did to the existing test. The final review caught it. **When a fix changes which code a test runs
through, re-run the falsifier the test's comment names** — a green suite cannot show that a test
stopped guarding what it claims.

## A timeout test on a build that cannot interrupt measures the query's length — 2026-09-15

`query-timeout.test.ts` claimed "the statement really stopped" and bounded the rejection, which is
immediate by contract. On `MemoryVFS`'s default `sync` build without isolation nothing stopped: the
next read and `close()` waited out the whole query — 4 s on Chromium, 22 s on Firefox, past 30 s
on the first CI runner (CI-QUERY-TIMEOUT, `mem:measurements`). Two more traps sat under it. **A
fresh client's first call can time out while still queued for the worker**, so under load the test
sometimes ran no statement at all and passed instantly; one loaded run was green for that reason.
And **`async` alone did not fix it**: a statement yields only when it is abortable, so an
unsignalled holder kept its worker on `async` too. The 2026-09-05 discipline, extended: bound what
only an interruption buys — the NEXT call's latency — warm the client and the statement, give every
statement the test expects to cut a signal or a timeout, and run the falsifier (`sync`: 4.2 s
against a 2 s bound).

## A test can pin a defect as the contract — 2026-09-15

`pool-cap.test.ts` T5 makes a raw worker hold an `OPFSWriteAheadVFS` file, then asserts that the
client fails with `WORKER_CRASHED` — its subject was the error message, and the refusal went in as the
expected outcome. The same refusal, met by a second client, is a defect the multi-client work of rc.5
never saw (`mem:follow-ups`), while its multi-client and cross-tab suites ran on one VFS out of nine.
**When a test asserts a failure, ask whether the failure is the contract or the defect — and a
promise made across VFS is tested across VFS.**

\1

## A suite pinned to one VFS hides every defect in the VFS it does not run — 2026-09-15

Running the whole browser suite on the SECOND recommended VFS found, in one afternoon: `output()` broken on
`OPFSWriteAheadVFS` (a deferred `BEGIN` that VFS refuses by design, leaving the connection unusable), a
second client that could break the FIRST one, and ~200 further failures across the other seven VFS. Those
tests had been green for months. **What made it cheap was making the VFS a runtime target rather than a
literal in each file**: one mechanism, one command per pair, and a test declares what it needs
(`two-workers`, `interruptible`) instead of naming a VFS.

## `afterEach` registered from inside a test body NEVER RUNS in rstest — 2026-09-16

`createTestClient`'s cleanup called `afterEach(...)` from the test that was running. rstest
silently drops it: instrumented on one file, **30 registrations and 0 executions**. So no
browser test had ever removed the database it created, on any VFS, since the helper was
written — and a comment in the same file asserted the opposite ("suite-scoped when called
inside a test body"), which is how it survived so long. `onTestFinished` is the test-scoped
hook that does run, and the same file already used it, with a comment explaining the
difference, twenty lines below.

**A registration is not an execution — instrument both ends before believing a hook.** One
`console.error` at the registration and one at the entry answered in a single run what two
rounds of reading the code and two whole-matrix runs (80 minutes) had not.

**And the triage entry that sent me there named a mechanism that was measurably false.** It
said "createTestClient never closes its client, and removing OPFS entries by name returns no
slot to the pool". Closing was necessary but does nothing for the pool — `jClose` returns no
slot, only `xDelete` does — and the cleanup that was supposed to do the removing never ran
at all. Its ORDER was right, its cause was wrong. `mem:follow-ups` already says to verify an
entry against the source before scheduling work on it; **this is the first time the entry
also carried a stated cause, and the cause is exactly the part that rotted.** Treat a
backlog entry's diagnosis as a hypothesis with a date on it, never as a finding.

## A falsifier claim written months ago is a claim, not a fact — 2026-09-15

Of six carried by `multi-client`/`cross-tab`, two reproduced everywhere, one only on some VFS, and three
were refuted: the `src/` lines they named were redundant, so deleting them changed nothing observable.
**Re-run a falsifier whenever its test starts running somewhere new** — and when it is refuted, say so in
the comment rather than rewording it into something that sounds true.

## A falsifier that stays green may be one guard of two (2026-09-25, `lifecycle.test.ts`)

Removing the pool check in `onGateOpen` left "fails the client rather than hanging" green, before and after the test was rewritten. The supervisor's `'lost'` verdict had become a second, independent guard: either alone fails the client. Only removing both hung it. **Before calling a test inert, look for a second path to the same outcome; the honest comment then names the pair.**

## A readiness predicate that matches any activity lets a test act on the wrong event (2026-09-27, `fix/abort-waits-for-its-query`)

`aWorkerIsRunning` was true for any running statement, and a fresh client's first one is the freshness barrier. Tests that waited on it and then aborted aborted the barrier on Chromium every time: the query they named was never sent, they passed, and one of them (`abort-slot`'s dead-worker test) was inert under its own falsifier. It also produced a fake engine difference that cost a wrong diagnosis ("a worker lent back mid-statement"), refuted only by listing the statements actually sent. **A wait before an action must identify the thing acted on, not a state it shares with something else.**

## A mutation run covers the three configs, and a mutant that survives is traced before it is called untested (2026-09-28, `test/falsifiers`)

`pnpm test:browser` runs Chromium and Firefox, not `rstest.isolated.config.ts` — the only project with cross-origin isolation, hence the only one where the `sync` build's abort slot works. A mutation of `drain()`'s `interrupt()` was declared "unguarded" after `test:browser` alone; the path it serves exists only in the isolated project. Mutate against `pnpm test`'s three configs, or name the config left out. And a surviving mutant is not yet a missing test: here the obvious scenario (a `break` without a signal) could not fail either, because such a query is not abortable at all — reading which path the mutated line serves came before writing the test that finally failed 10 of 10.

## A suite count says nothing about the builds that were skipped (2026-09-30, wa-sqlite #351)

"2910 passing" was reported for a PR whose branch predated upstream's fix to its JSPI detection: every JSPI test was skipped, silently, and the count looked complete. **Before quoting a suite result, check that each build it claims appears in the output, and measure on a branch that contains current master.**

## A green arm needs an arm that must go red in the same harness (2026-09-30, wa-sqlite #362)

The first back/forward-cache run was green on both engines and both arms — because no page was cached at all: Playwright's headless shell never uses the cache, and its Firefox disables it by a preference. The arm running wa-sqlite alone, which the issue says must fail, is what showed it. A scenario that depends on a browser feature gets a control that proves the feature was on.

## Find a request in `db.debug` by what it is, never by sniffing its SQL (2026-09-30)

A fresh worker's first request carries the freshness barrier, `SELECT count(*) FROM sqlite_master`, whether it is a read or a write. A test that found "the read" as the first request with a query containing `SELECT` found the `CREATE TABLE` write instead — and the pre-branch version of that test had been inspecting the barrier of that write all along, passing because it asserted only `sql.includes('SELECT')`. Match a request by `kind`, and a query by its exact text.

## A failure count that changes run to run in one family of assertions, on every backend, points at the harness (2026-10-08, wa-sqlite on Safari 26)

Safari 26 failed 72, then 81 `vfs_xOpen`/`vfs_xClose` assertions. They all read 0, and `MemoryVFS` failed too. A defect in nine VFS at once does not vary in count; a race does. It was the harness: an output `DataView` passed by `Comlink.proxy()` is written on its own port, unordered with the reply. **When every backend fails the same way and the count drifts, look at what the tests share before looking at what they test.**
