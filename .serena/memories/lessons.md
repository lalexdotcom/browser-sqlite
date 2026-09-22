# Lessons — paid for once each, do not relearn them

Append only. Each entry names what it cost and what to do instead.

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

## About debugging

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

## About claims and documentation

**A fact with no citable source does not enter a table.** "JSPI is Chromium-only" survived
three README locations, was inherited rather than sourced, and was contradicted by our own
measurement without anyone noticing. Named source and date, per cell, or it goes.

**Prose that duplicates a generated table will drift away from it.** JSPI-1's own fix went
stale in turn: the replacement text said "Safari support is not established here" while the
generated table beside it said `27+`. Point the prose at the table; do not restate it.

**A reviewer's data-loss claim is a hypothesis until measured.** A whole-branch review
asserted a double `output().close()` destroyed the target table. It did not — the
transaction rolled the `DROP` back. The neighbouring half of the same finding was real.
Measure before acting on either half.

**Reviews examine what changed, not what stayed the same.** Two independent reviews passed
over a scheduler branch without noticing it contradicted its untouched sibling path. When a
change adds a rule to one of two symmetric paths, review the pair, not the diff.

**It happened again on 2026-09-01, and the shape is worth naming.** Implementation found a
real hole in the cross-tab spec — a write's epoch marker must be published before the write
resolves, because reads take no lock and a foreign read can `query()` in the gap. The fix went
into `write()`. Nobody extended it to `transaction()`, which has the same `finally` and the
same hole; the task reviewer confirmed the fix was correct *for the path it was shown*, and
the controller confirmed the ruling was right without asking where else it applied. Only the
whole-branch review caught it. **A ruling made about one path is a question about every
sibling path** — when you accept a mid-flight correction, the next thing to do is grep for the
other callers of whatever it touched, not to close the finding.

**Plan defects reach implementers as instructions.** Four defects in the wave-3 plan — a
corrupting re-escape, an assertion matching messages instead of codes, a test that could
never reach its own failure case, a probe defeated by Node 24 shipping `navigator.locks` —
were caught only because the implementers were briefed to push back. Brief them to push
back.

**Match the house style of whatever repo you commit to.** The first upstream commit carried
a 30-line message and an 8-line comment into a project where 49 of the last 60 commits are
one line and no VFS file has an inline comment longer than 4. Measure before writing.

**A documented instruction that nothing exercises will drift.** Three instances found in
one session, 2026-08-27: the README's Vite snippet was copied verbatim into
`tests/consumer/vite.config.ts`, so the fixture *was* the snippet and could never falsify
it; the benchmark page imported names from `dist/` that no compiler checked; and the one
config line the README asks a consumer to write was exercised only at a Vite version where
it is a no-op. **When the README tells a consumer to write something, something must fail
when it is wrong** — and the fixture must not be a copy of the prose.

**Test the `.0.0`, not the latest patch, before writing "X+".** "Vite 6+" was about to ship
on the strength of 6.4.3. Vite **6.0.x fails entirely**, through its last patch, with the
same error as Vite 5; the fix landed in 6.1. The `.0` of a major is the only probe that
justifies a `+`.

**Separate the toolchain's floor from yours.** Old webpack fails on Node 24 in its own MD4
hashing, old Parcel in its own Babel, and `webpack-cli@7` refuses `webpack < 5.101` outright
— none of it a statement about this package. Before recording a floor, check whether the
failure is even reachable through the tool's own supported install.

**A premise ages faster than the workaround it justified.** A `browser-sqlite/vite` plugin
was designed, approved and carried in the backlog for nine days on the premise that "Vite
does not copy the worker's `.wasm`". By the time it was reached, Vite did — and the README
had been documenting a workaround for a bug that no longer existed. **Re-measure a
workaround's premise before building on it**, not after.

**A pointer to a file that may not travel is no use.** Recorded once for the worker's MIT
banner (hence `legalComments: 'inline'`) and missed a second time in the same repo:
`dist/NOTICE` said "see LICENSE" while `dist/` shipped without one, and `dist/` is
routinely served alone. When a rule is bought for one artifact, sweep the neighbours.

**A manual step you did not observe is not evidence.** A device failure was declared "not
residue" because it survived a hand-clearing of the browser's site data. Three runs later
the automatic sweep fixed it: the clearing had never reached OPFS. The refutation rested
entirely on an action nobody verified, and the instrument was right there — the page could
have reported whether the root was empty. **When a human step is a premise of a
conclusion, make the machine confirm it happened.**

**One run per device reads like reproduction when two devices agree.** It is not. Two
findings were written this way on 2026-08-27 and both were wrong, in opposite directions: a
flake recorded as a defect, and a real residue recorded as refuted. n≥3 per device is the
floor for a verdict, and it applies to failures as much as to the flaky row it was
originally written for.

## About this project's own memory

**A memory that goes stale states falsehoods with confidence.** The default VFS was wrong
in the state memory twice: once it said `OPFSCoopSyncVFS` and a dispatch repeated it,
sending an agent down the wrong path for a full round; then it said `OPFSPermutedVFS` and
kept saying it for four days after that VFS was deleted, which produced a false statement
about the project's reliability to the user. **When the VFS choice changes, `mem:vfs` and
`mem:state` are the first things to rewrite.**

**A design corrected by measurement must record the version that was wrong.** BP-1's first
proposal — "the worker awaits one credit *message* per chunk, so the await is both the
accounting and the yield, no counter needed" — **deadlocks**: credits sent ahead are
dispatched during the query's start-up awaits, each resolving a signal nobody is waiting
on, after which the worker awaits a fresh signal that never arrives. The probe found it by
hanging. **Accounting and yielding are two separate roles** — a counter for the first, an
unconditional task turn for the second.

## Abandonment needs an owner, or every `await` is a hole — 2026-08-27

`ABORT-1` looked like "give `bulkWrite` and `output` a signal". Three separate
places consulted none, and **each was found by one more device run**, never by
a test in this repo:

1. `bulkWrite`'s chained batches called `write()` without the signal, so a batch
   already in flight could not be rejected.
2. `scheduler.acquire` took no signal at all — so while the pool had nothing to
   lend, an abort could not land for **any** method. This predated the abort
   work by a wave.
3. `applyBarrier` drained a query on the worker with no signal, inside
   `acquireInstrumented`, so every method passed through it.

The common fact is the lesson: **no single place owned "this call may be
abandoned"**, so any `await` without a signal was a hole, and holes surfaced one
engine at a time. Chromium never reproduced any of them — it always frees a
worker eventually — so the repo's own suite was green through all three.

The fix that ends it is placement, not plumbing: the guard sits in
`acquireInstrumented`, which covers the only phase of a call that was not
already abortable, so an `await` added there later is covered without being
remembered. A top-level race per method was considered and dropped as
redundant once that was true.

**Two reflexes this bought.** A green suite on one engine proves nothing about
a pool that can stay empty — the benchmark page is the reproducer, and the
campaign is the verification. And when a fix "should have worked" and did not,
the count matters: at three, stop patching and ask what the three have in
common.

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

## A symbolic rename lands at stale offsets after a symbolic edit — 2026-08-27

`rename_symbol` on `Abortable` reported "5 changes applied" and **corrupted two
places** in a file whose body had been replaced with `replace_symbol_body`
earlier in the same session: `const { options, release } = …` became
`const AbortableOptions, release } = …`, and a comment lost three words. The
language server was renaming ranges it had computed against its own, older view
of the file.

It was loud — `tsc` failed immediately with a parse error — but it is exactly
the class of edit that would be silent if it landed inside a string or a
comment, and two of the five did land in prose.

**So: after replacing a symbol body, do not rename through the LSP in the same
breath.** Either re-read the file first, or rename textually with
`replace_in_files`, which works on the file as it is on disk and cannot desync.
Typecheck immediately after any rename either way — the second rename of that
session, done textually, was clean and `tsc` is what proved it.

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

## An empty `${{ }}` in a shell comment breaks a composite action — 2026-08-31

A comment inside a composite action's `run:` block explained that a value travels
through `env:` **rather than through `${{ }}` interpolation** — and wrote that
sequence literally, empty. GitHub's template parser scans the whole `run:` string,
comments included, found an expression with nothing in it, and refused the
manifest:

```
action.yml (Line: 146, Col: 12): An expression was expected
```

**What it cost:** a released action version that no consumer could load at all,
and a failed release tag. Every job pinned to it died at *Set up job*, before a
single step ran — so the error is nowhere near the code that caused it, and the
annotation names the action's line, not the workflow's.

**What to do instead:** never write the literal `${{` in a composite action, in
any position — a comment is not a hiding place. Name the mechanism ("a workflow
expression") instead of quoting it. `grep -n '\${{ *}}'` over the file catches
the empty case; the general form is that every `${{ … }}` in the file must
contain something.

**The tell:** a failure at *Set up job* with zero steps executed is never your
logic. It is the manifest failing to load or to parse.

## Check the upstream signal before waiting on the downstream one — 2026-08-31

After pushing a release tag, the agent polled npm for the new version on a loop
and sat there for ten minutes. The workflow had already failed sixty seconds in;
npm was never going to change. The user had to say so.

**What it cost:** ten minutes of silence during a live release, and the user
chasing the agent rather than the other way round.

**What to do instead:** wait on the thing that produces the outcome, not on the
outcome. Here that is the workflow run — its `status`/`conclusion`, then its
per-step conclusions. Only once it succeeds does the registry become worth
polling. The same shape applies anywhere a pipeline feeds a store: watch the
pipeline.

**The tell:** if your poll cannot distinguish "not finished yet" from "will never
happen", it is the wrong poll. A run's `conclusion` distinguishes them; a
registry listing does not.

## A subject routed to a list is a subject nobody owns — 2026-09-03

**What happened:** the ryow-barrier design deferred "a default `busy_timeout`" by
writing "perf list" in its out-of-scope table. Nothing was created. Ten days later
`feat/perf-measure` closed *the performance backlog* by name, deciding two items it
could see and never learning this one existed. On 2026-09-02 the subject was
rediscovered from the original external assessment, reopened in `mem:follow-ups` as
though it had been forgotten — and it had, but not by anyone who could have known.

**Then it got worse before it got better.** The reopened entry was written without
reading `mem:vfs`, which already held the decision on the PRAGMA half. So a closed
decision was reopened, argued for a turn, and had to be closed again.

**What to do instead:** a deferral names a destination that EXISTS. An entry in
`mem:follow-ups`, or a line in a spec's own §Deferred that the closing branch will
read. "The perf list", "the backlog", "later" are not destinations — nothing can be
handed to them and nothing can be checked against them.

**The tell:** if closing a list would not surface the item, the item is not on the
list. And before reopening anything, grep every memory, not the two that seem
relevant — the decision that made the reopening wrong was one file away.

## A plan written by the same head that wrote the spec inherits its blind spots — 2026-09-03

Nine tasks, executed by fresh subagents. **Five defects were in the plan, not in the
implementations**, and every one was caught by someone who did not write it:

- a test asserting `db.debug.name === 'ledger 1'` where `clientIndex` is a per-realm module
  counter, so the index depends on how many clients earlier tests created — the assertion
  was simply unreachable, and the fix is an anchored regex;
- a unit test calling `inspectWith` with no `ownMarkerName`, which routes into a nonce path
  that cannot succeed against a stub — and which would nonetheless have passed whenever two
  other tests ran first, because the realm id memoises at module scope;
- a browser test returning a queued writer's promise from inside a transaction callback,
  which **deadlocks**: the transaction holds the very lock the queued writer awaits;
- "the unit project runs on Node, where `navigator.locks` is absent" — false, **Node 24
  ships Web Locks**, so the degenerate-case test would have resolved instead of rejecting;
- a README sentence describing behaviour the code did not have, left over from a design
  decision the user had reversed two messages earlier.

**The pattern is one thing, not five.** Every defect is a claim the plan asserted rather
than checked, and the controller could not catch any of them, because the controller is
what wrote them. The implementers caught four by running the code; the fifth was caught by
a reviewer told to check every documented claim against the source.

**So: state the assumption in the dispatch, in the words that make it checkable.** "The
unit project runs on Node, where `navigator.locks` is absent" got corrected because it was
written down as a fact an implementer could disprove. An unstated assumption reaches
production as behaviour.

**And a reviewer asked to verify documentation against the code will find things nobody
else can.** The Critical of this branch — `db.inspect()` answering a memory VFS with an
empty roster where `inspectDatabase` refuses — was found by a DOCUMENTATION review, because
checking whether a sentence was true meant reading two entry points side by side. No
task-scoped review had both in view.

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

## A deadline belongs to an operation CLASS, and abandoning a wait is not free everywhere — 2026-09-04

Two halves of the same mistake, both paid on the bench page's sweep.

**One budget for "storage calls" was wrong.** 2 s was chosen from "these are local operations
and 2 s is already generous", which is true of an OPFS `removeEntry` and false of an
`indexedDB.deleteDatabase`: on iPadOS Safari 27.0 the latter takes more than 2 s and less than
5 s after a completed run. The too-tight budget did not merely report a timeout — it made the
page abandon a store the run was about to need, and two columns then died at `opens` with 14
`not-run` cells behind them. **The standing hypothesis was that something held the store
permanently; it was simply slow.** Split the budget per operation class, then; a single
number covering two classes will be wrong for one of them.

**And abandoning a wait does not stop the work.** This project already knew that for
`close()` — `ColumnAbandoned` states it — but the consequence differs by API. An OPFS
`removeEntry` you stop waiting for holds nothing. An `indexedDB.deleteDatabase` stays queued
against that database, and IndexedDB processes a database's requests in order, so it BLOCKS
every later `open` of the same store. A comment claiming the abandoned promise "holds nothing
we need back" was written and shipped before this was noticed.

The general rule: **before bounding a call, ask what the abandoned request keeps doing**, not
just how long it usually takes.

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

## An install that "succeeded" can be missing an optional dependency — 2026-09-04

`pnpm test:consumer` failed twice in a row at 21/24, with Parcel dying on
`Cannot find module '@swc/core-linux-arm64-gnu'`. It looked exactly like a regression from
the branch under test — it was not, and it was not even a change: **an optional dependency
that fails to download does not fail `npm install`.** The scaffold stage reported success,
and the absence only surfaced when Parcel tried to load its native binding.

Two runs agreed, which is what made it convincing. What settled it: a clean-room `npm
install` of the same fixture pulled the package fine, the two-install sequence the script
uses reproduced nothing, and the next `pnpm test:consumer` was 24/24.

**Before concluding that a consumer-smoke failure is yours: re-run it, and run it on
`main`.** Both were done here — but both failing runs were minutes apart and shared the
transient cause, so agreement between them proved nothing. Two observations of one flake
are one observation. The fixtures pin floating ranges on purpose (they test the newest
bundlers), so this failure mode stays possible and will return wearing another package's
name.

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

## A branch can produce the defect it exists to remove, three times — 2026-09-09

The abandoned-generator branch fixed a generator that stranded its pool worker. Along the way it
introduced, and had to fix, **three defects of that same class**:

1. a `Promise.race` tie that silently dropped 3900 of 4000 rows (above), bisected against `main`;
2. a permanent pool wedge on Firefox — evicting a worker stranded the rotated exclusive OPFS
   handle, and nothing could open the database again (`mem:vfs`, HANDLE-2);
3. an `await gen.return()` parked behind an in-flight `next()`, so a transaction never rejected,
   never returned its lease, and held the origin's write lock indefinitely.

**None was found by re-reading the plan.** Each was found by a whole-branch review or by an
implementer who would not work around a red test. The controller wrote all three, reviewed them,
and passed over them.

Two things follow. **A fix in this area is not more trustworthy for being a fix** — it is code in
the same place, written under the same assumptions, and it earns the same review as the defect
it replaces. And **the whole-branch review is the only step that caught two of the three**: task
reviews saw diffs, and the defects lived in the interaction between a change and the untouched
code beside it.

## A wait you add must be owed by the statement that pays it — 2026-09-10

The transaction quiesce fix made every statement wait for its worker before resolving. Correct
for a statement that ran; **catastrophic for one that never started.** A statement refused by
`pool.ts`'s reuse guard has claimed nothing, so waiting for the worker parks its rejection
behind somebody else's query — and where that query is a generator the callback dropped, only
`closeOpenStatements()` will close it, at the end of the callback, which is exactly where the
rejection was heading. The two waited for each other and the test timed out at 30 s.

**It was found by a test written to pin a LIMIT, not to prove the fix.** The fix's own three
regression tests were green. What surfaced the deadlock was writing down "here is what A does
not cover" and asserting it — the boundary case, which nobody asks for and which is the only
thing that exercised the refused path.

**Two rules out of it.** When adding a wait to a shared resource, ask what the waiter has
actually acquired — a post-condition on work you did not do is a deadlock waiting for a
scheduler. And **pin the boundary of a fix, not only its subject**: the assertion "this case is
still broken, and cleanly" is where the second defect lives.

## A comment can outlive the premise of the branch beside it — 2026-09-10

Two merges landed the same day, 2026-09-09: the abandoned-generator work and the origin
write-lock work. The first left a comment in `closeOpenStatements()` saying a transaction with
no `signal` and no `timeout` passes `abortable: false`. The second added `closeSignal`, merged
into every statement's signal — which made that sentence false the moment it merged. `API.md`
carried a `[!WARNING]` resting on the same premise. Both survived a whole-branch review and
four weeks of reading, including mine: I reasoned from that comment twice in one session and
told the user something wrong on the strength of it.

**Measurement is what caught it**, not reading: `first()` on a query whose second row costs a
3 M-row recursion returns in 2.4 ms inside a transaction and 683 ms on the client path. A
comment cannot be that wrong about an interruptible statement.

**The rule: when two branches merge in the same window, each one's comments describe the
other's pre-state.** Grep the merged files for claims about the mechanism the sibling changed.
Here one `grep -n 'abortable' src/` would have done it.

**And the general tell:** a comment that asserts a value a function COMPUTES — `abortable:
false`, `signal === undefined` — is a claim with an expiry date. Prefer naming the condition
("whether the build can interrupt a running step") over transcribing the value.

## A pre-merge verification is not ceremony — 2026-09-09

The session's closure was stopped by `pnpm test` going red on the merged-to-be tree, on a
one-in-eighteen flake, after every task review had passed and a whole-branch review had said
ready. The user's own challenge — *"on clôture ne bypass pas la revue de branche normalement"* —
was right on a second count: four commits had landed after the last whole-branch review and none
had been reviewed at that level.

**A red suite at closure is the cheapest place to find a defect, and the last one.** What
followed was a full systematic-debugging session that turned a flake into HANDLE-2. Had the
merge gone through on a green-looking summary, the wedge would have shipped in rc.5.


## A hook that ends with `tsc` is not proof that a commit typechecks — 2026-09-10

Commit `c2ef918` landed with `tsc` failing, although the pre-commit hook ends with
`pnpm exec tsc --noEmit`. Traced the next day from the implementer's transcript: nobody bypassed
it — its previous attempt was refused by the hook's `tsc` — but the attempt that landed was a
commit in `git log` 25 s after it started, while the hook's suite alone takes ~100 s. The
likeliest cause, not proven, is the agent's tool cutting the command mid-hook
(`mem:follow-ups`, the pre-commit hook entry; evidence in
`.scratchpad/hook-forensics/c2ef918-timeline.md`). Three checks passed over it: the implementer's report called
the error "pre-existing, not related to this task" twice; the task reviewer ran lint only;
the controller's own verification ran `pnpm test` only. It surfaced when the NEXT commit, a
documentation-only one, was refused.

**Two rules out of it.** A verification run is `pnpm test` AND `pnpm exec tsc --noEmit`,
never the suite alone. A subagent's "pre-existing" is a claim about the base commit: check it
there before accepting it. What proved the rest of the branch was a per-commit check in
clean worktrees — `git worktree add /tmp/rev-<sha> <sha>`, symlink `node_modules`, run `tsc`
and the linter, remove the worktree — and it is the only proof that does not trust a hook.

## A design's "read from the code, not measured" is a hypothesis — measuring one found a released defect — 2026-09-10

The transaction-closure spec justified one rule with an aside: `tx.rollback()` carries no
guard, so an abandoned callback "could" roll back a connection serving someone else. The
user asked for it to be verified. The probe did not only confirm it — its generalization
found that a handle used after a NORMAL commit rolled back, or silently joined, the next
transaction on the same worker, a defect present in rc.4. **When a design leans on a hazard
read from the code, probe it before planning**; the probe is cheap, and what it finds next to
the claim is usually the larger thing.

## Put a design to the consumer's use cases before its mechanism — 2026-09-10

"An abandoned write abandons its transaction" was chosen, specified, planned, implemented,
task-reviewed and whole-branch-reviewed as a mechanism. The gap showed only when the user
wrote down their three use cases — caught errors go on, uncaught ones stop everything —
because a caught WRITE abort did not go on. It cost a reversed decision (D4), a changed
`tx.signal` rule and a deferred design. **Ask what the consumer's `try/catch` and uncaught
paths should do before choosing a mechanism**; a consumer states in three lines what an
option table hides.

## A deadline "counted from the call" includes everything before the callback — 2026-09-10

A plan's test gave a transaction `timeout: 100` and waited on `tx.signal` inside the
callback. Green alone, red in the full suite: the deadline counts from the call, so the lease
and `BEGIN` spent it before the callback ran and the captured signal was never assigned. A
test around a wall-clock deadline must budget for what precedes the code it observes, and
assert its precondition — `expect(seen).toBeDefined()` — so a lost setup reports itself.

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

## Code a plan hands over verbatim must compile under the repo's own flags — 2026-09-15

Task 2 of the statement-errors plan gave its implementer exact code, and it failed `tsc` three
times over: `exactOptionalPropertyTypes` refuses `{ sqliteCode: maybeUndefined }` for an optional
property. The implementer adapted it; the next task's dispatch had to warn about the same trap.
The plan had been written without type-checking a line of it. **When a plan carries code to
transcribe, put it through `tsc` under this repo's `tsconfig.json` before handing it over** — a
scratch file is enough. `exactOptionalPropertyTypes` is the flag that bites: pass an optional
field through a conditional spread, never as `key: value | undefined`.

## A fix round can move a test's only falsifier — 2026-09-15

The worker stamps SQLite's extended code at the query level, and a missing-collation test was its
falsifier. A task review found a path where that stamp came too late; the fix added a second stamp
nearer the failure — on the path the test itself ran. From then on the test went red only if both
stamps were removed, the query-level one had no falsifier, and the test's comment still named it.
The ruling on that fix round had asked whether the NEW path could be tested, and not what the fix
did to the existing test. The final review caught it. **When a fix changes which code a test runs
through, re-run the falsifier the test's comment names** — a green suite cannot show that a test
stopped guarding what it claims.

## Publishing a value that used to be dropped publishes its sloppiest producer — 2026-09-15

For months the worker copied any numeric `code` off a thrown value into `sqliteCode`, harmlessly:
the client kept the field only for 5 and 6. Once the client kept it everywhere, a DOMException's
legacy code — SecurityError is 18, InvalidStateError 11 — would have reached the consumer as
`WORKER_CRASHED` with `sqliteCode: 18`, which reads as `SQLITE_TOOBIG`. Nothing in the branch
touched the producer; the final review found it by asking where the value came from. **When a
change starts publishing a field that was filtered before, audit every producer of it, not only
the consumer you changed** — a check that was loose but unreachable becomes a published lie. The
fix is `sqliteCodeOf`, which accepts wa-sqlite's own `SQLiteError` only.

## A hand edit inside a generated span is erased by the next render — 2026-09-15

`3dd0897` wrote the Safari paragraph into `VFS.md`'s generated *Build `async`* section by hand.
Nothing local runs the render; CI does, and CI had not run since `d3a5755`. So the first CI run of
rc.5 failed on it — at a step before the typecheck, the build and every test, which therefore did
not run either. **Text inside a generated span belongs in the generator's source** (here
`BUILD_NOTE` in `scripts/render-vfs-matrix.ts`), and a doc edit near one is checked with
`pnpm docs:vfs && git diff VFS.md` before it is committed; the `pre-push` hook now does it. **And a
CI job that fails early hides every later step**: a red run is not "the tests failed" until the
failing step is read.

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

## What can run inside a WASM call depends on the build — 2026-09-15

The CoopSync hand-over fix first deferred the release to a microtask, argued safe: a `step` is one
synchronous call, and nothing else runs until it returns. True on `sync` and `async`, measured clean
there — and false on `jspi`, where wa-sqlite wraps every VFS import in `WebAssembly.Suspending`,
synchronous ones included, so pending microtasks run at each VFS call, mid-`step`. Firefox's `jspi`
still failed 9-18 times in 20 (COOPSYNC-HANDOVER, `mem:measurements`). **A claim about what can
interleave inside a WASM call is a claim about the build: measure all three, and give the test the
build that breaks the claim** — `coopsync-handover.test.ts` runs on `jspi` for exactly this, and a
mutation back to a microtask turns it red.

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

## A subagent handed a 16-file triage reads for fifteen minutes before it writes anything — 2026-09-15

Three batches behaved identically: 10-18 minutes of reading, no edit, no report. What fixed it was one line
in the brief — *work file by file; write your first table row within ten minutes* — plus a controller
message when the ledger showed no edit after ten. **Split a batch before dispatching it, and give the first
artifact a deadline.** A monitor that counts the report's rows, not only the modified files, shows the
difference between thinking and stalling.

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