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
