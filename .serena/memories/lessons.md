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
