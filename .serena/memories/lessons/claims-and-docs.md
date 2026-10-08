# Lessons — claims, documentation, upstream

Part of `mem:lessons`, which indexes every entry.

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

## A measurement the maintainer cannot rerun is not evidence for them — 2026-09-23

#361's first draft argued the change with `cut / natural`: how much of an abandoned write a statement
gives back. Every figure came from our harness, and that metric cannot be BUILT in wa-sqlite — no
interrupt, no pool, no abortable statement in its `test/`. The user caught it with one question: *"comment
le mainteneur peut les relancer ?"* The answer was that he could not, of any figure in the body.

**The fix is not to explain the harness, it is to find the quantity underneath that is directly
measurable in theirs.** Here: the ratio is a consequence, `checkpoint()`'s wall time is the cause, and an
explicit `PRAGMA wal_checkpoint` with the automatic one disarmed times exactly the patched function — on
upstream's own demo page, no new file, no build, the two arms one `git switch` apart. It also came out
*stronger*: 40× on both engines, where the ratio had suggested a Chromium problem.

So, before writing an upstream PR body: **name the arm a maintainer runs, and run it yourself first.**
A recipe that has not been executed is a guess, and this one needed a proof the disarming had taken
effect — the database file staying at 0 bytes — which only running it produced.

## A changed default is described in more places than the spec lists (2026-09-24, `feat/default-build`)

The spec named the docs to update — CHANGELOG, two `API.md` rows, `VFS.md`'s Builds prose and notes, one JSDoc — and all were done and reviewed green. The final review then found six more places still describing the old default: the `build` option's JSDoc and `deleteDatabase`'s `@defaultValue` (both shipped in the `.d.ts`), the build-order note above `VFS_CAPABILITIES` (which also said "`jspi` is Chromium-only"), the Recommendations bullet in `VFS.md`, the options example in `API.md`, and `client.build` in `API.md`. **When a spec changes a behaviour, its doc list is a starting point: grep the tree for every way the old behaviour is phrased (`first build`, `default`, the old value by name) before writing the list, and again before merging.** Every per-task review passed because each checked its own brief; only the whole-branch review was placed to see it.

## Before calling a design new work, look for the mechanism already there (2026-09-28, `fix/writeahead-read-to-current`)

Asked whether the library could decide when a read catches up, the answer given was "possible, but it needs a write epoch per client and per worker in the pool". Both existed: the epoch barrier runs a read exactly on a worker behind a commit, origin-wide. That misjudgement tilted the first recommendation towards a default pragma that measured seconds per read during a large write. **When a proposal needs state, grep for who already keeps it.**


## A PR description says what was observed, and labels what was constructed (2026-09-30, wa-sqlite #351)

The description said "SQLite writes a 512-byte journal header, then a full page at the same offset". SQLite does not; the sequence was our own VFS-level test, written to force a shape we had only deduced. The maintainer asked how that could be, and answering cost more than a day of measurement. **For each sentence of the form "SQLite does X", name the trace that shows it.** A shape reached only by calling the VFS directly is written as such, and the description says whether SQLite is known to reach it.

## A reservation written down is a probe not yet run (2026-09-30, wa-sqlite #351)

The first report closed on "one reservation, and no test will lift it": the new block might shadow a block further along. It was excused by analogy — the extension branch "has the same property" — and the analogy was false: that branch writes past the end of the file, where nothing can start. The reservation was the defect, and one direct `jWrite`/`jRead` test shows it. **Before posting, turn every stated reservation into a test or a measurement; an argument for why it is harmless is a claim to falsify, not a reason to skip.**

## A defect of a VFS is not an exposure of the library until the library's path is followed (2026-09-30)

Three wa-sqlite leaks were recorded as "library exposure, untested", and the backlog recommended one as the next thing to do. Measured with each fix reversed, two of the three cannot reach a consumer: a worker whose open fails is terminated by `handleDeath`, and what it kept goes with it. Only a VFS the library retries inside one worker was exposed. The CHANGELOG had already told consumers that opens "waited forever". Before writing "exposure", follow the failure through the library's own code — who retries, who terminates — and reverse the fix.

## Remove each part of a multi-part fix once before sending it (2026-10-03, wa-sqlite #371)

Ten ablations of a nine-part fix: three parts made no test and no probe change and were dropped; one (journal removal on close) looked useless until a scenario was written for exactly what it guards, then failed 12/12 without it. **A part with no falsifier is either dead code or an untested case — find out which before posting.** The PR body's ablation table came straight from this.

## A platform gap measured with one tool version is a fact about that version (2026-10-05, Discussion #373)

"Playwright's WebKit on Linux has no OPFS" was measured once, on Playwright 1.62's WebKit, and written as a property of the Linux port — into `post-create.sh`, three memories and an upstream discussion. The maintainer's question (private mode?) sent us to measure again: 1.63's WebKit has OPFS in a persistent context, and the absence had been fixed upstream a month before. **Record a missing capability with the tool version it was measured on, and re-measure before repeating it to someone else** — the more often a claim is copied, the less anyone rereads where it came from.

## A runner image's README lists SDKs, not what is installed (2026-10-08, `xcode-27`)

The `xcode-27` README lists "Simulator - iOS 27.0/27.1/27.2". The user was told iOS 27.2 was available, and a job was written for it. The image holds only the iOS 27.0 runtime: the other rows are SDKs, one of them from an Xcode beta. **Ask the machine (`xcrun simctl list runtimes`) before telling anyone what an image provides.**
