# Resume Plan — how to pick this project back up

Read `mem:project-state` for what the code is, `mem:follow-ups` for the issue backlog.
This file holds only: what is in flight, what is undecided, in what order we work, and
what changed last.

> **Reading warning, added 2026-08-24.** Sections §1 to §4 are a **historical record**: the
> decisions as they were taken, with the reasoning of the day. Two things they say are no longer
> true of the code, and they are left unedited on purpose because the reasoning still explains why
> later choices were made. Do not act on them:
> - **`OPFSPermutedVFS` is deleted** and the default is `OPFSAdaptiveVFS` (Asyncify) since
>   `be314db`. Every §1/§4 passage describing Permuted's asynchronous BroadcastChannel commit
>   propagation is describing a VFS that is gone. Staleness turned out to be a property of the
>   multi-connection setup, identical on every VFS.
> - **Cross-origin isolation is not required.** The `SharedArrayBuffer` and `orchestrator.ts` are
>   gone since wave 4; every "COOP/COEP is a hard requirement" passage is history.
>
> **§0 and §0.1 are the current state. Start there.**

## 0. Current state

The stack upgrade of 2026-08-17 is **done and verified green** — see `mem:project-state`
for the resulting versions and the TS 7 editor notes. Nothing is in flight.

**Wave 0 is done and closed** (2026-08-17, see §4), safety net included: CI, typed tests,
characterization suites, and a consumer smoke test covering the published tarball.

**Wave P is done and closed** (2026-08-17, see §4). B10 and B8 are resolved. The
package is consumable from four modes (Vite dev, Vite preview, rsbuild preview,
no-bundler). 11/11 consumer smoke stages pass; `consumer-smoke` CI job is now blocking.

**Wave 1 is done and closed** (merged into `main` on 2026-08-18, 15 commits). Final
whole-branch review returned no Critical findings; its two Important findings were fixed and
re-reviewed clean.

Closed by this wave: **B1**, **B9**, **FLK-1**, the abort listener leak, **W-arch**, **W-route
half 1**, and part of **W-types**. See `mem:follow-ups` for the evidence on each.

**Three defects were found during execution that the plan had not anticipated** — worth knowing,
because each was invisible to the tests that existed at the time:
1. `scheduler.add` did not drain the wait queues, so a query issued while the pool was still
   initialising asynchronously waited forever.
2. `releaseWorker` never claimed the writer designation when serving a queued writer with none
   set, so a **second writer** could be designated — the same invariant as B1, one layer over.
3. The routing allowlist was written wrong **twice** (once in the plan, once in the controller's
   correction of it) before an adversarial review caught that it ignored everything after a `;`.

**Standing lesson from this wave: assert falsifiability, not passage.** Seven tests written during
wave 1 passed identically with and without the behaviour they claimed to pin. The habit that caught
them: for each test, state which line, if deleted, makes it fail. Ask it of every test from now on.

**Wave 2 is done and closed** (merged into `main` on 2026-08-19, 17 commits, **193 tests
green**, no `it.fails` anywhere). Closed: **B2**, **B3**, **W-route half 2**. See `mem:follow-ups`
and §4 for the evidence. The merged result was verified green on `main`: `tsc --noEmit`, 193 tests,
and the consumer smoke at 11/11.

**Wave 3 is done, closed and MERGED into `main`** (2026-08-19, 24 commits, merge commit
`5eb5ace`). B4, B5 and B6 are closed. The merged result was verified **on `main`, not just on the
branch**: `pnpm check` clean, `tsc --noEmit` clean, **272 tests / 0 failures**, consumer smoke
**11/11** across four bundler modes, six consecutive full browser suites with no failure, and no
`it.fails` anywhere. See §4 for what shipped and what it cost.

**Wave 4's first half is DONE, CLOSED and MERGED into `main`** (2026-08-20, merge commit `5292b70`,
26 commits, branch deleted). The merged result was verified **on `main`, not just on the branch**:
`pnpm check` clean, `tsc --noEmit` clean, **272 tests / 0 failures**, consumer smoke **11/11** across
four bundler modes with no COOP/COEP header served anywhere. **BP-1 and D2 are closed** — see their entries in
`mem:follow-ups`. 272 tests green, consumer smoke 11/11 with no COOP/COEP header served anywhere. The
final whole-branch review returned no Critical or Important findings after one documentation fix wave.

**`feat/vfs-default` is DONE, CLOSED and MERGED into `main`** (2026-08-20, merge commit `be314db`,
8 commits). It is not a wave and has no spec or plan document — it opened with a probe
(`a68047b`) and the measurement is in that commit's message, which is where to read it. What
shipped: `OPFSPermutedVFS` **deleted** (24 % stale cross-connection reads, deprecated upstream),
`OPFSAdaptiveVFS` on Asyncify as the new default (0 stale in 360 samples), a public `build`
option validated at construction, the single `VFS_BUILDS` table as the source of truth, and
`SQLiteError('INVALID_OPTION')`. Its whole-branch review returned two Critical and two Important
findings, **all four documentation or coverage debt on a breaking change** — the README described
the old world in seven places and the new guard had no falsifiable test. See `mem:project-state`
for the resulting facts.

Its documents: design `docs/superpowers/specs/2026-08-19-wave-4-backpressure-design.md` (§3.6 and §6.2
carry in-place corrections dated 2026-08-20 — execution proved both wrong), implementation plan
`docs/superpowers/plans/2026-08-20-wave-4-backpressure.md` (8 tasks).

**~~What wave 4 still owes: the commit-propagation barrier and D6.~~ The barrier shipped and merged
(`36c664e`); the stickiness it unblocked was relaxed on 2026-08-21 (`feat/writer-stickiness`) and
the two `poolSize: 1` pins are gone. What wave 4 still owes is D6 alone.** Historic text follows.
The barrier
deserves its own brainstorming and unblocks RYOW-1, the writer designation's stickiness, and the two
browser tests pinned to `poolSize: 1`. ~~A lead recorded 2026-08-20 and not yet examined: `OPFSWriteAheadVFS`
implements write-ahead logging inside the VFS, and a synchronous WAL-based VFS may have quite different
cross-connection visibility from `OPFSPermutedVFS`.~~ **Measured and DEAD, 2026-08-20: `OPFSWriteAheadVFS`
is stale 12/12 across its three builds, exactly like every other VFS. See `mem:follow-ups` RYOW-1 (4).**

**Six defects the execution caught that the plan had not anticipated, all of one family — things that
could not fail, or that failed silently:**
1. Three tests asserted properties they could not detect. The gate's `stop()`-wakes-a-wait test passed
   with `wake()` deleted; `first()`'s look-ahead test was racy in its pre-fix state; the filtering-scan
   test passed for a reason unrelated to what it claimed.
2. A silent truncation with **three** legs — `close()` broadcasting `stop`, the worker replying a plain
   `done` after a stop it did not initiate, and `pool.ts` clearing `deferredChunk` on `error` so a
   consumer suspended at `yield` resumed into a loop that had already exited.
3. **Spec §3.6 was simply wrong**, and only implementation revealed it: the row-counter tick counted
   *returned* rows, never fired for the filtering scan it was written for, and could not fire before the
   per-chunk tick at default settings. The regression it targeted does not exist — a filtering scan is a
   single long `sqlite3_step`, so the old shared-memory flag could not interrupt it either.

**Standing lesson, paid for a second time: a claim of falsifiability that nobody executed is worth
nothing.** Every load-bearing test in this wave had its falsifiability verified by hand — delete the
line, watch it go red, restore it — and that practice is what caught §3.6.

Its first act was **BP-1's four-combination measurement**, and that is now complete.

**Where the session stopped (2026-08-19).** Four commits on the branch; the source tree is
identical to `main`'s, so nothing is half-applied. `dc96f57` / `bbf31b9` are the first probe and
its removal, `fae6423` / `d82c673` the second probe and its removal, plus a memory commit. The
DRAFT design is `docs/superpowers/specs/2026-08-19-wave-4-backpressure-design.md` — **read it
first when resuming; it carries both measurement tables, the approved mechanism, and the notes
already gathered for the sections that were never presented.**

Brainstorming reached **section 1 of 4, approved**. Sections 2 (scope per method, `first()`, the
`SharedArrayBuffer` removal), 3 (failure modes) and 4 (testing) are outstanding and listed in the
DRAFT's §6. After them: spec self-review, user review of the spec, then `writing-plans`. Nothing
may be implemented before that — the DRAFT says so at the top.

**The design changed once under measurement, and the corrected form is what §3 of the DRAFT
holds.** The first proposal — "the worker awaits one credit message per chunk, so the await is
both the accounting and the yield, no counter needed" — deadlocks, and the probe found it by
hanging. Credits sent ahead are dispatched during the query's start-up awaits, each resolving a
signal nobody awaits; the worker then waits on a fresh signal that never comes. **Accounting and
yielding are two roles: a counter for the first, an unconditional task turn for the second.**

Wave 3's own documents, both committed and still accurate except where this file records a
correction: design `docs/superpowers/specs/2026-08-19-wave-3-sql-safety-design.md`, implementation
plan `docs/superpowers/plans/2026-08-19-wave-3-sql-safety.md` (13 tasks). **Read them with the
caveats in §4's merge entry**: the spec's §2.5 names a counter `rowsNotAttempted` that shipped as
`rowsNotWritten`, its §2.4 gives the wrong reason for dropping `temp`, its §3.1 understates how
much of the debug request level had to be rebuilt, and neither document knows about the scheduling
rules, which were settled after both were written. The plan also contains four defects that were
caught during execution — they are listed in §4 so nobody re-implements them from the plan text.

**Wave 4 has grown, and this is the single most important thing to carry forward.** It was
BP-1 + removing the `SharedArrayBuffer`. It now also owns the **commit-propagation barrier**,
because wave 3 established that one brick unblocks three separate things: RYOW-1 (reads may serve
a pre-commit view), the writer designation being releasable at all (see rule 3 in
`mem:project-state` — currently sticky by measured necessity), and the two browser tests pinned to
`poolSize: 1` that should go back to the default pool size once it exists.

Its first act is still **BP-1's four-combination measurement**, not a design. Wave 3 narrowed the
hypothesis without answering it — §1.5's amendment says exactly what was measured and what was not.

~~**Next up: wave 3** — B4 (`quoteIdent()` + pragma allowlist, which also gives read PRAGMAs back
to `read()`), B5 (`output()` rebuilt as staging + atomic rename per §1.1), B6 (debug wired per
§1.3). The `navigator.locks` primitive enters the codebase here (D3, §1.1).~~ **Struck 2026-08-24
— wave 3 shipped on 2026-08-19. The next step is COOP-1; see §0.1.**

**Original wave 1 statement, for reference** — extract pool + scheduler, fix exclusivity (B1), relayer the query
API on `chunk()` (D4, §1.2), fix abort once inside it (covers `stream()`'s early `break`
and B9). Two `it.fails` tests are waiting for it: B1 in
`tests/browser/transaction.test.ts`, B9 in `tests/browser/concurrency.test.ts`.
Remember: an `it.fails` turning red means the bug is fixed — drop `.fails`, do not
re-add it.

Wave 1, when we get to it: extract the pool + scheduler, make `releaseWorker` the single
owner of `available`, relayer the query API on `chunk()` (§1.2), fix abort once. Two
`it.fails` tests are already waiting for it: B1 in `tests/browser/transaction.test.ts`,
B9 in `tests/browser/concurrency.test.ts`. Remember the convention: an `it.fails` turning
red means the bug is fixed.

## 0.1 HOW TO RESUME — written 2026-08-21. **SUPERSEDED by §0.2; read that first.** Kept for the barrier and stickiness detail, which stays accurate.

**Repository state.** Nothing is in flight. The commit-propagation barrier (`36c664e`) and the
writer-stickiness work (`4f215f8`) are both **merged into `main`**, both branches deleted. The
session was closed on 2026-08-21 with the merged result verified **on `main`, not just on the
branch**: `pnpm check` clean, `tsc --noEmit` clean, **308 tests / 0 failures** three runs running,
and consumer smoke **11/11** across the four bundler modes.

**Re-verified 2026-08-24, still nothing in flight:** working tree clean, `pnpm test` at **308 tests
/ 0 failures**. `main` is **163 commits ahead of `origin/main` and still not pushed** — that number
only grows, and it is the one piece of unfinished housekeeping that predates every open item.

Three local branches remain and **all three are fully merged** — `git rev-list --count main..<b>`
is 0 for each, verified 2026-08-24: `feat/vfs-default`, `wave-1-pool-scheduler`,
`wave-3-sql-safety`. They are leftovers to delete, not work to resume.

**`feat/vfs-default` in particular is LIVE, not pending.** An earlier version of this section
listed it among "stale branches ... none of them is live work", which reads as *unmerged*. It
merged on 2026-08-20 as `be314db`: `OPFSPermutedVFS` is deleted, `OPFSAdaptiveVFS` is the default,
and the `build` option exists. `mem:project-state` carried the old default for four days because
of this wording and a false claim about the project's reliability reached the user on 2026-08-24.
Say "merged" or "unmerged"; never "stale".

Barrier spec: `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md` — accurate except §2.2's
claim about the alternating-load worst case, which measurement contradicted (see step 1 below).
The stickiness work has **no spec and no plan document by design**: it was classified as a bounded
change, designed in chat, and approved there.

Spec: `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md`. Plan:
`docs/superpowers/plans/2026-08-21-ryow-barrier.md`. Read the spec before touching any of this; it
carries every measurement and every rejected alternative, so nothing below needs re-deriving.

**What shipped.** A per-database commit epoch in the realm-wide symbol registry
(`Symbol.for('browser-sqlite.epochs.v1')`), so every client in a tab shares it; each worker carries
the epoch it absorbed; before a leased worker serves anything, if it is behind, one discarded
`SELECT count(*) FROM sqlite_master` opens a real read transaction. One choke point —
`applyBarrier` inside `acquireInstrumented` — covers reads, writes, transactions and bulk. Plus:
`SQLiteError` code `BUSY` for lock conflicts on both the query and open paths; eviction of a worker
left holding an open transaction after a failed fallback `ROLLBACK`; and one normalized database
name everywhere, in **relative** form.

**The acceptance evidence, and it is the part worth trusting.** `output()`'s two tests that were
pinned to `poolSize: 1` run at the default pool size again, **20/20 green**. They predate the
barrier, were not written for it, and one of them failed ~7.5 % before it was pinned.

**New finding, 2026-08-21 — the staleness domain is narrower than believed.** The bug needs **DDL
without material growth of the file**. Barrier disabled, forced configuration: a write that grew the
file 3 → 253 pages left the primed connection **fresh** 3/3; a tiny write leaving it at 2 pages left
it **stale** 3/3, and 3/3 on each of six structural variants — eighteen runs, all stale. The
differential is the growth alone. **Mechanism inferred, not observed** (a file-size mismatch check
re-reading page 1). It explains why `output()` is the reliable trigger: its staging table is small,
so the file never grows and nothing auto-heals the connection. See spec §1.1.

**Do these in this order.**

1. ~~**Relax the writer stickiness.**~~ **DONE and MERGED 2026-08-21 (merge commit `4f215f8`),
   308 tests green, 14 consecutive full-suite runs clean on the branch and 3 more on `main`.** `e2f454b` releases the designation in
   `handOver`; `07b075a` fixes SUP-1, a pre-existing client-hangs-forever bug found while measuring
   it (see `mem:follow-ups`). Measured gain: five writes in 30-32 ms against 934-1052 ms when a long
   read holds worker 0; **neutral on every ordinary load**, so it buys the pathological case only.
   One plan claim did NOT survive measurement: relaxing stickiness does **not** fix the barrier's
   alternating-load worst case — on an idle pool the write and the following read take the same
   lowest free worker, so there was nothing there to fix. Spec §2.2 says otherwise; it is wrong.
2. **`COOP-1`** — **this is the next step, and it is now scoped.** Its mechanism was analysed from
   the wa-sqlite source on 2026-08-24 and the full entry lives in `mem:follow-ups` as a dedicated
   block (hypothesis, falsifiable prediction, five-option table, and the prior question of whether
   CoopSync has a niche left at all). Read that block before anything else. Three things it
   establishes: the README already contains a **dangling cross-reference** and a **false
   "Constraint: None"** that are worth fixing on their own; the likely destination is a `poolSize:
   1` guard plus documentation, because CoopSync rotates one exclusive handle and so buys no
   concurrency in a pool; and the decision depends on two other entries — VFS-COV (the fallback
   candidate `IDBBatchAtomicVFS` has zero tests) and RWU-1 (no non-Chromium browser has ever been
   run). **Open with the measurement, not the design:** pin the failure as a red test, then probe
   `busy_timeout` against a retry in our own layer.
3. **The README's per-VFS trade-off section**, last, because 2 changes what it says. The RYOW
   wording is already rewritten and correct. Step 1 turned out to change nothing here: stickiness
   was never documented publicly (`grep -i sticky README.md src/` is empty).

**Also open, and the user's own idea, worth a measurement not a deduction:** reads preferring the
last writer over the lowest index, as a pure freshness hint. Filed in `mem:follow-ups` under
Performance with the baseline census it has to beat, and with the two reasons it may turn out to be
worth nothing.

**D6 is still owed** and still undesigned — see §1.4.

**Dead leads — struck, do not revive without new measurement.** `PRAGMA data_version` (8/8 stale).
`OPFSWriteAheadVFS` (12/12 stale across three builds). `SELECT rowid FROM sqlite_master LIMIT 1` as a
cheaper prelude (0/6 — but note the barrier tests passed under it; it failed an unrelated pinned row
count in `backpressure.test.ts`, so the door is not closed, see spec §10.1). "Growth heals the
connection, so skip the barrier after a large write" — rests on the inferred mechanism, not on the
measurement; rejected until the threshold is measured.

**Three lessons this session paid for.**

**A control that cannot fail proves nothing.** The first probe of the page-1 question compared
barrier-on against barrier-off and got identical numbers, which was consistent both with "the
staleness is harmless here" and with "the harness never primed". Two extra rounds were needed to
separate them. Before trusting any zero, ask what result would have looked different.

**Scan each task against itself, not only against its neighbours.** The pre-flight conflict scan
looked for contradictions *between* tasks and found none. Two tasks contradicted *themselves* — a
formula against its own test case, and a pair of tests that could not fail — and only implementation
caught them.

**Here, comments drift faster than code.** Most findings the review loop retained were comments that
lied: a `// Falsifiable:` naming a line that did not exist, another asserting a result the
measurement contradicted, a JSDoc describing the plan's buggy formula rather than the code beneath
it. In a codebase where comments carry measurements, that is a defect class, not a tidiness one.


## 0.5 WHERE THE WORK IS — written 2026-08-25, end of the WebKit session. READ FIRST.

Branch `feat/vfs-capabilities`, merged into `main` at the close of this session. Still not
pushed — `origin/main` sits behind, deliberately.

**What this session settled.**

1. **ANYCONTEXT-1 is solved and it was a WebKit bug** — `FileSystemWritableFileStream.write()`
   ignores a view's `byteOffset`/`byteLength` and writes the whole `ArrayBuffer`, which for
   wa-sqlite is the WASM heap. Patched here (`patches/wa-sqlite@1.1.1.patch`), pushed to a fork
   for upstream. Full account, reduced repro and the list of what was ruled out:
   `mem:follow-ups` ANYCONTEXT-1. **`OPFSAnyContextVFS` is now the best concurrent-read VFS on
   WebKit (1.70×) and on Firefox (2.0–2.2×)** — which reopens DEFAULT-1's premise, though not
   its conclusion.
2. **RESIDUE-1 is new** — `AccessHandlePoolVFS` and `IDBMirrorVFS` store under their class name,
   and it cost two false VFS failures in one evening. See `mem:follow-ups`.
3. **The bench page moved to `scripts/bench/`** (`62c2b0c`), page at
   `scripts/bench/html/index.html`, scripts at `scripts/bench/{assemble,check,dev}.mjs`. The user
   overruled a reasoned objection here and was entitled to; do not relitigate the layout.
4. **OS detection was reporting every Mac as an iPad** (`0c7f435`) — `navigator.standalone`
   exists on macOS since Safari 17, so the presence test that replaced the touch test in
   `6691df5` was wrong the day it was written. Now `maxTouchPoints > 1` guarded by
   `matchMedia('(pointer: coarse)')`, which an iPad keeps even with a trackpad (WebKit 209292).

**Owed, and none of it started.**

- **Re-run Safari 27, iOS 26, iPadOS 27** with the patch. Only Safari 26.5.2 has been measured.
- **`no-read-inside-transaction` is not deterministic on Safari.** Two runs an hour apart flipped
  it in *opposite* directions — `OPFSAdaptiveVFS/async` pass→blocked, `OPFSCoopSyncVFS/async`
  blocked→pass. n≥3 before touching the `OPFSCoopSyncVFS` README entry, which rests on that row.
- **Android 145 vs 151 differ by a factor 2.6** on bulk insert, same emulator. Regression or
  noise; a single run cannot say.
- **Chrome Android 109 crashes the bench page before any run starts.** Deliberately dropped by
  the user (2026-08-25) since 145 and 151 produce full exports. Note the exposure: the README
  claims `Android 109+` on four VFS rows, and the only observation we hold for that version is a
  crash. The init path is short — the two candidates are the un-timeout'd `await
  probeUnsafeHandles()` and the unbounded `while (t1 === t0)` clock spin, both in
  `scripts/bench/html/index.html`. Triage: banner after 8 s → the probe; frozen page → the spin.
- **The `feat/*` deployment rule** on the `github-pages` environment is still owed removal.
- **The upstream PR** is pushed but not opened; body drafted at `.work/PR-body.md` (gitignored).

**Two working conventions the user corrected this session** — both are in the auto-memory, and
both generalise:

- **The README is for the consumer.** State the constraint and what it costs them; the mechanism,
  the evidence and the investigation go to code comments, these memories, or a PR description. A
  fifteen-line Known Limitations entry about a WebKit bug was cut to one sentence plus `26+` in
  the generated table.
- **Batch diagnostic probes.** When the user has to run probes by hand, send a whole battery in
  one paste, each written for the case where the previous came back clean. Four round trips were
  burned on one-hypothesis-at-a-time before they called it.

**And match the house style of whatever repo you are committing to.** The first upstream commit
carried a 30-line message and an 8-line comment into a project where 49 of the last 60 commits
are one line and no VFS file has an inline comment longer than 4. Measure before writing.

## 0.4 WHERE THE WORK IS — written 2026-08-25, end of the benchmark-page session. **Superseded by §0.5.**

**§0.3 below is superseded on one point: the benchmark page is built.** Everything else in it stands.

**Branch state.** `feat/vfs-capabilities`, ~15 commits ahead of `origin` at the time of writing
(`812d273` local vs `827acfa` pushed) — check `git log origin/feat/vfs-capabilities..HEAD` rather
than trusting that count. Working tree clean. `main` is at `8b8dfa0`: it carries a registration-only
copy of `pages.yaml` that was pushed so GitHub would expose `workflow_dispatch` (the trigger is only
offered for workflows present on the default branch — that cost an hour to discover). **At merge,
`pages.yaml` conflicts: main's copy still has `push: branches: [main]`, the branch's is
`workflow_call` + `workflow_dispatch`. Take the branch's.**

**What shipped: `bench/index.html`**, one self-contained file served beside a verbatim `dist/`.
Conformance rows mirroring the six invariants, nine measurements, capability-derived picker grouped
by VFS with a tri-state parent, a verdict naming the best per criterion (never an aggregate score —
see DEFAULT-1), and a JSON export carrying `reasons`, `clockMs` and per-column calibration.
`pnpm bench:dev` / `bench:serve` / `bench:build`; `scripts/bench-check.mjs` drives it by hand and is
deliberately not in CI.

**Publishing is release-only.** `pages.yaml` is `workflow_call` + `workflow_dispatch`;
`release-and-publish.yaml` calls it with `needs: release`, so the site tracks the published package
and a reusable workflow runs at the caller's ref, which builds the tag. **One Pages site per repo,
last deploy wins** — a manual dispatch from a branch replaces whatever the last release published.
The `github-pages` environment now allows `main`, `v*` (tag) and `feat/*`; the tag rule was missing
and would have failed rc4 before its first step.

**Owed, and easy to forget: remove the `feat/*` deployment rule once the pre-rc4 device testing is
done** (user, 2026-08-25 — it was re-added on that day only so the page could be dispatched from
the branch onto a real iPhone and an Android tablet). While it stands, any manual dispatch from a
feature branch replaces the published site, and the only thing distinguishing the two is the
page's own banner reading "development build". Settings → Environments → github-pages →
Deployment branches and tags → Remove `feat/*`.

**What the campaign settled**, on real Chromium ×2, Firefox 154 and Safari 26.5.2 (macOS):

- **MIRROR-1 is measured and the declaration is corrected** — `IDBMirrorVFS` is now
  `multiConnection: false`, `maxPoolSize: 1`.
- **ANYCONTEXT-1 is new** — `OPFSAnyContextVFS` fails to open on Safari with `SQLITE_NOTADB`,
  reproduced on a swept root. On Firefox it measured the *best* read concurrency of any VFS.
- **The consequence that matters: `IDBBatchAtomicVFS` is now the only persistent multi-connection
  VFS working on all three desktop engines.** The default is untouched and still right —
  `OPFSAdaptiveVFS` is degraded off Chromium (3.24x read burst there, ~1x elsewhere) but never
  broken — the margin is simply thinner than it was.
- The README's reduced-mode claim was narrowed to what reproduces (write transactions, not long
  reads) and `OPFSCoopSyncVFS` finally has its Known Limitations entry.

**A trap for anyone running the page on a browser used before 2026-08-25:** early runs leaked
`AccessHandlePoolVFS/`, whose six slots are consumed by databases nothing ever freed. The sweep
cannot reclaim it — the directory predates the ownership record, so it is protected as a third
party's. Symptom: `AccessHandlePoolVFS` fails to open with `sqlite3_open_v2` on *every* build,
first run. Remedy: clear site data for that origin once. Do not re-diagnose this.

**`.bench/` is gitignored** and holds device exports; they are read, never committed.

**Two working preferences the user stated on 2026-08-25, both worth honouring beyond this branch:**

- **The README is edited iteratively — do not commit each pass.** Several round trips are normal;
  committing after every one forces the user to brake. Make the edit, show what changed, wait.
- **Do not explain compatibility in prose.** Version numbers in the tables are enough. An earlier
  Requirements subsection arguing *why* each API mattered was cut for exactly this reason.

**A Chrome 81 Android tablet cannot run the page or the library** — no OPFS at all (Chrome 86+),
plus both floors above. Decided not to support below the baseline; a classic ES5 script now reports
the incompatibility instead of leaving the banner on "detecting…". See BASELINE-1.

**Blocking rc4:** the four commits `d2af8a2`..`a22bd48` have still never been reviewed. Nothing else
does.

## 0.3 WHERE THE WORK IS — written 2026-08-24, end of the VFS-wiring session

**`feat/vfs-capabilities` is the live branch and is NOT merged, by the user's decision.** The
benchmark page will be developed **on this same branch, in a different session**. Do not merge it
to `main` and do not branch off `main` for that work — continue here.

State at handoff: 16 commits on top of `3909f2f`, working tree clean, `pnpm test` 323/0,
conformance green on Chromium (68/8/0) and Firefox (59/17/0), consumer smoke 11/11. Nothing is
pushed; `main` is untouched.

What shipped on it: the four remaining VFS wired (nine public), `VFS_CAPABILITIES` as the single
compiler-checked table, guards moved onto it, the table exported from the package entry, a separate
`conformance` rstest project with six invariants, and a README whose VFS and per-build tables are
generated from that table with a CI drift check.

**Reviewed through commit `20cd59f` only.** The commits after it — the plan correction, the
capability-model change and the README work — postdate the whole-branch review and have not been
reviewed. Review them before any merge.

**The benchmark page's requirements are in §0.2 item 3**, and item 2b records a design that was
tried and rejected — read the rejection before proposing anything about per-browser data.

## 0.2 HOW TO RESUME — written 2026-08-24 (browser-matrix session). READ THIS FIRST.

**Repository state.** Nothing in flight, working tree clean, **308 tests / 0 failures**, `main`
pushed and level with `origin/main` for the first time in the project's history — the 165-commit
backlog is gone. Last commits: `89d4f79` (install the three engines, cache key names them),
`495a7c4` (memory), `ee2e9f3` (drop WebKit). CI green on all of them.

**Tooling now in place.** Chromium and Firefox installed in the devcontainer and in both CI jobs,
under a cache key that names its contents. `rstest.config.ts` still runs Chromium alone — **the
matrix is possible, not yet enabled.** WebKit is deliberately absent, see `mem:follow-ups`.

**What this session settled, all by measurement.** RWU-1 is **closed**. COOP-1 is **demoted** and
largely absorbed. **HANDLE-1 is new and is the important one.** The engine capability table is in
`mem:project-state`. Read HANDLE-1 before planning anything about VFS.

**The one-sentence version of HANDLE-1:** off Chromium there is a single exclusive OPFS access
handle, a worker inside a long uninterruptible `sqlite3_step()` never releases it, so one abandoned
long query serializes the whole pool for its full duration — and there is no remedy in our code.

### The plan, as the user set it 2026-08-24

**Accepted premise: `readwrite-unsafe` cannot be worked around.** The answer is not a fix, it is a
documented VFS recommendation per browser, justified by measurement.

1. **Measure the two VFS that structurally escape HANDLE-1** — `IDBBatchAtomicVFS` (untested) and
   `OPFSAnyContextVFS` (not even wired into `VFSConfigs`). The trade to price is **write latency
   against pool non-blocking**. Do NOT shortcut to `OPFSCoopSyncVFS`: it rotates one exclusive
   handle and inherits the defect wholesale, its 104/104 on Firefox notwithstanding. Gated on
   VFS-COV.
2. **Then document the per-browser VFS recommendation** in the README, which also finally closes
   its dangling CoopSync cross-reference and its false "Constraint: None".
2b. **A `Browser compatibility` column in the README table (user, 2026-08-24).**

   **Scope was cut back by the user on 2026-08-24, after an over-engineered first design.** The
   rejected version had the conformance run emit `docs/conformance/<browser>.json` per engine,
   committed, merged into the table by the generator, with per-cell provenance and a
   documented-vs-observed two-layer model. The user's verdict: *"on s'est peut-être emballé sur la
   conformité"* — and they are right. **Do not rebuild that.**

   **What to build instead: one column, generated, from documented sources.** Sanctioned sources
   are **caniuse.com** and **MDN browser-compat-data** (raw JSON on GitHub —
   `api/StorageManager.json`, `api/FileSystemFileHandle.json`). **A fact with no citable source
   does not enter the table** — that rule is what would have caught JSPI-1 in `mem:follow-ups`.

   Conformance stays what it is: a gate that proves the declarations are true. It is **not** a data
   source for the documentation, and nothing it produces is committed.

   Verified 2026-08-24 from MDN BCD: OPFS (`getDirectory`, `createSyncAccessHandle`) is Chrome 86 /
   Firefox 111 / Safari 15.2 / iOS 15.2; the `mode: 'readwrite-unsafe'` option is **Chrome 121**,
   and `false` for Firefox and Safari — so the old "Chromium-only as of June 2024" note now has a
   version. JSPI in Firefox from **153** (caniuse), which our own run independently confirmed.

   **The capability model needs three more fields, and the third is the important one:** `storage`
   (`opfs` / `indexeddb` / `memory`), `requires[]` (hard — without it the VFS fails:
   `OPFSWriteAheadVFS` → `readwrite-unsafe`), and **`degradesWithout[]`** (soft — the VFS uses the
   feature when present and works without it: `OPFSAdaptiveVFS` → `readwrite-unsafe`). Without the
   third, a spec-derived column would mark `OPFSAdaptiveVFS` broken on Firefox. It is not — 102/104
   — and saying so is reassuring information the README currently gives nowhere. Its degraded mode
   costs HANDLE-1, which is both documented and observed.

   **Playwright's WebKit is NOT Safari** and licenses no conclusion about it. Safari and iOS rows
   come from caniuse alone — or from a user running the benchmark page on a real device. **This is pass/fail, not measurement**, so it does not
   violate the no-benchmarks-in-the-README rule. Do NOT put this on `feat/vfs-capabilities`: that
   branch is reviewed and clean, and this would invalidate the review for no gain.

3. **Before release: a static benchmark page** that uses the library and lets anyone run the
   benchmarks in their own browser, hosted on GitHub Pages if reachable. **This is easier than it
   looks and it is wave 4's dividend: no COOP/COEP is required any more**, so plain Pages over
   HTTPS is a sufficient secure context with no special headers. Start from the "no bundler" mode
   that `scripts/consumer-smoke.mjs` already exercises rather than a fresh page — `dist/` already
   serves the worker and the three `.wasm` on relative paths.

   **Three requirements the user set on 2026-08-24, before the page's spec is written:**
   - **It runs the conformance invariants, not only the benchmarks.** At minimum, whether each VFS
     opens at all. Without this a user on Safari returns numbers and zero compatibility
     information, which is the one thing no machine here can produce.
   - **A readable display** for the human who opened it.
   - **An export in exactly the shape of `docs/conformance/<browser>.json`** (see 2b). That is what
     makes the loop close: the user runs the page on Safari or iOS, sends the file back, it is
     dropped in and the README regenerates. No transport format to invent, no manual translation,
     and Safari enters the table through the same path as Chromium. The compatibility half of the
     page's output is therefore a *deliverable*, distinct from the benchmark half, which stays on
     the user's machine and never reaches the README.
4. **A VFS × browser benchmark table**, which is the output of 1 and 3 combined.

### Also open, smaller

- **Wire Firefox into `rstest.config.ts`** — blocked on the two Firefox failures in
  `mem:follow-ups`, since a browser cannot be made a blocking gate while it is red. One of them is
  HANDLE-1 (not fixable, so the test needs a per-browser expectation); the other is probably
  timing calibration and nobody has traced it.
- **COOP-1's adversarial test**, if COOP-1 survives at all — it may simply be removed with the VFS.
- **D6** (the `browser-sqlite/vite` plugin subpath) is still owed and still undesigned, see §1.4.

### Lessons this session paid for

- **A probe that does not reproduce the failure is measuring something else.** The abandon path was
  blamed for hours on a reasonable-looking trace; a standalone reproduction passed at 0 ms while the
  real test failed at 29 s, and only instrumenting *the failing test in place* showed why.
- **Instrumentation can hide the bug.** Wrapping `Worker` shifted a millisecond-scale race and
  turned the failure green. When a probe disagrees with the plain run, trust the plain run and find
  a lighter instrument — here, sampling `db.debug` statuses instead of wrapping the constructor.
- **A catastrophic-looking number can be uninformative.** WebKit's 9/104 was one missing API, not 95
  defects. Read the first failure's cause before reading the count.

## 1. Decisions — D1 to D5, all settled

| # | Decision | Recommendation | Consequence |
|---|---|---|---|
| D1 | Keep wa-sqlite, or move to `@sqlite.org/sqlite-wasm`? | **Keep wa-sqlite.** The official build's OPFS SAHPool VFS is single-connection, which removes the concurrent-read pool — i.e. the library's reason to exist. Fix the packaging complaint (B8) by vendoring the prebuilt WASM+glue at build time instead. | Reopening it means a rewrite, not a refactor. |
| D2 | Drop the `SharedArrayBuffer` (→ `navigator.locks` + a `postMessage`-driven boolean)? | **Yes** — and D3 now makes `navigator.locks` mandatory anyway (multi-tab `output()` cleanup), so the primitive must exist by wave 3. **But the two SAB usages do not have the same replacement date — see §1.5, corrected 2026-08-18.** | Touches `orchestrator.ts`, `worker.ts`, and the rstest browser plugin. Full removal is gated on back-pressure, not on wave 4 alone. |
| D3 | What shape does `output()` take? | **Decided 2026-08-17: staging table + atomic rename, `navigator.locks`-guarded, multi-tab safe.** See §1.1. | Implementation lands in wave 3. Hard prerequisites: B1 (real exclusivity) and a `navigator.locks` primitive. |

| D4 | Should the query API be layered on an explicit `chunk()` primitive? | **Decided 2026-08-17: yes.** See §1.2. | Lands in wave 1, together with the abort fixes. Renaming `stream()` is a silently-shaped break — accepted, we are in RC. |
| D5 | Wire the debug subsystem, or delete it? | **Decided 2026-08-17: wire it**, behind `debug?: string \| boolean`. See §1.3. | 221 dead lines become live. The unbounded `requests` array must be capped first or it leaks. |

Status: **D1 and D2 decided-with-recommendation; D3, D4, D5 decided** as of 2026-08-17.

**Standing assumption (user, 2026-08-17): there is NO consumer on `1.0.0-rc.3`, and none
can appear before we choose to create one.** Nothing is published until every correction
wave is done, and publishing only happens on a `v*.*.*` tag — merging to `main` ships
nothing. D3's and D4's breaking changes are therefore free, and stay free for the whole
sequence.

### 1.1 D3 — the decided design

The question was reframed during the 2026-08-17 session. It was recorded as
"does `output()` leave the core for an optional module?"; that framing came from
calling `output()` an "ETL helper". The user's actual design intent is **MongoDB's
`$out`** — a pipeline sink used to build staging tables. Under that intent the
relocation question is minor organisation (variant B below), and the real question
is whether `output()` delivers `$out`'s defining guarantee. Today it does not.

**Why not one big transaction.** SQLite's DDL *is* transactional, so
`BEGIN; DROP; CREATE; INSERT…; COMMIT;` would be atomic — but it holds the single
writer worker for the entire reload (today `write()` releases the worker after every
statement, so unrelated writes interleave between `bulkWrite` batches) and the WAL
cannot checkpoint until COMMIT. Rejected on both counts.

**The chosen shape** — `bulkWrite` is unchanged (un-transacted batches, worker
released between each):

1. Populate `__bsq_staging_<uuid>` in `main` (a normal table, **not** `TEMP` — a
   `TEMP` table lives in the `temp` database and `ALTER TABLE … RENAME TO` cannot
   move a table across databases).
2. Final short transaction: `DROP TABLE IF EXISTS <target>;
   ALTER TABLE <staging> RENAME TO <target>;` then **create the indexes inside that
   same transaction, after the rename** (decision (a)). SQLite has no
   `ALTER INDEX … RENAME`, so indexes built on the staging table would keep
   `__bsq_staging_…` names forever; building them with final names before the swap
   collides with the old table's indexes. The lock lasts the index build, which is
   small next to the row inserts.

**Cleanup, three stacked nets:**

1. `try/finally` around the populate → `DROP TABLE IF EXISTS <staging>`. Covers
   application-level failure, the common case.
2. Sweep at the client's **first `output()`** (not at `open()` — the writer is only
   designated lazily on the first write, and a sweep at open would race the *n*
   workers): `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE
   '__bsq_staging_%'`, drop everything not in flight. Recovers orphans from a closed
   tab or a crashed session. **Guarded by `navigator.locks`** so it is safe when
   several tabs run `output()` concurrently — this is a user requirement, not an
   option.
3. If the final transaction fails, the staging table survives and net 2 collects it.

**Consequences:**
- `temp: true` is incoherent under this design (un-renameable across databases, and
  invisible to the other pool workers since `TEMP` is per-connection). It must either
  require `poolSize: 1` or be dropped. Open.
- Multi-tab `output()` is now a **supported** scenario. The rest of the client stays
  uncoordinated across tabs — see `W-multitab` in `mem:follow-ups`.
- Relocation (variant B: implementation moved to its own module, `db.output` kept as
  a thin delegation) is now a free organisational choice, no longer a breaking change,
  so it no longer gates the version number. Do it opportunistically in wave 3 for the
  Node-testability win.

### 1.2 D4 — the query API layered on `chunk()`

The hierarchy already exists inside `client.ts`, unnamed and unexposed. The single
primitive is `worker.query()` (an async generator yielding `T[] | number` — chunks,
then the affected count); `readWorker` / `writeWorker` / `streamWorker` / `oneWorker`
are thin derivations of it, and every public method is the same 6-line
acquire → delegate → `finally releaseWorker` wrapper. Making the layering explicit is
mostly deletion.

```
worker.query()                                  primitive
  └─ chunk()   AsyncGenerator<T[]>              chunkSize lives HERE
      ├─ stream()  AsyncGenerator<T>            flattens
      ├─ read()    Promise<T[]>                 drains
      ├─ first()   Promise<T | undefined>       first row + internal abort (was one())
      └─ write()   Promise<{result, affected}>  drains + captures the number
```

- **`signal`: on every method**, and **added to `one()`**, which currently excludes it
  (`Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>`). Cancellation is call-site
  semantics, not transport configuration — an earlier draft of this decision wrongly
  lumped it with `chunkSize`. `one()` consolidates the caller's signal with its own via
  `AbortSignal.any([caller, internal])`. **Implementation trap:** the two aborts do not
  mean the same thing — the internal one means "got my row, stop" (resolve normally),
  the caller's means "cancelled" (reject with `AbortError`). Test `caller.aborted`
  afterwards; the combined signal alone does not say which fired. Verify
  `AbortSignal.any`'s browser baseline — it is more recent than OPFS.
- **`chunkSize`: on `chunk()` and `read()` only.** Real transport knob on `read()`
  (1M rows at 500 = 2000 `postMessage`; at 50000 = 20). Meaningless on `write()`
  (writes rarely return rows; `RETURNING` can use `chunk()`). **Harmful on `one()`** —
  its only correct value is 1, and a caller passing 5000 would fetch 5000 rows for one.
  Revisit whether `read()` really needs it once D5 makes it measurable.
- **`one()` is renamed `first()`** (user, 2026-08-17). More accurate as well as clearer:
  the method returns the first row of a result set, not the only one, and it does not
  assert or enforce that exactly one row matched. Land it with the rest of D4 in wave 1 —
  the relayering already rewrites every one of these methods, so renaming costs nothing
  extra there and would cost a second breaking change later. ~~Loud CHANGELOG entry~~ —
  **no CHANGELOG (user, 2026-08-18): at `1.0.0-rc.3` with no consumer, a migration note
  addresses a reader who does not exist. The breaking changes are recorded here instead.**
  ~~Note the internal-abort trap described above stays attached to this method under its
  new name.~~ — **the trap is removed, not carried: `first()` `break`s instead of aborting
  (wave 1 brainstorming, 2026-08-18). See §1.2's amendment below.**
- **`chunk()` stays public.** It is the performance path (a row-wise generator costs a
  microtask per row) and the place where back-pressure will live.

**Why in wave 1, not a later API pass:** wave 1 already rewrites `stream()`'s abort
(B1's early-`break` half, and B9). Both defects, plus the future back-pressure
credit/ack scheme, collapse into the single `chunk()` primitive — fix once instead of
four times. Doing the abort work in the old shape and then moving it is double work.

**Cost, stated plainly:** `stream()` changing its yield from `T[]` to `T` is a
*silent* break — an existing `for await (const chunk of db.stream(…))` keeps running
and `chunk[0]` becomes `undefined` on a row object. TypeScript catches it for typed
consumers, the runtime does not. Accepted because RC is exactly that window, and the
double-loop wart is otherwise permanent. ~~Requires a loud CHANGELOG entry.~~ **No
CHANGELOG — see the `first()` bullet above.** The zero-risk alternative (keep `stream()` =
chunks, add `rows()`) was rejected: it keeps a `stream` that does not stream.

**Amendment, 2026-08-18 — the internal-abort trap is designed out.** This section
prescribed `AbortSignal.any([caller, internal])` plus a post-hoc `caller.aborted` test to
tell "got my row, stop" from "cancelled". Wave 1's brainstorming replaced the mechanism:
**`first()` `break`s out of the loop instead of aborting.** A `break` triggers
`gen.return()`, hence `chunk()`'s `finally`, hence the same worker-stop routine — by the
normal path, without an exception. So: caller signal → error; early exit → normal
completion. Two unambiguous mechanisms, no consolidation, and `AbortSignal.any` is no
longer used anywhere — its browser-baseline question is void. Full design in
`docs/superpowers/specs/2026-08-18-wave-1-pool-scheduler-design.md` §6.3.

### 1.3 D5 — the debug subsystem is wired, not deleted

`debug.ts` is **not a logger** — there is no `console.*` in it (the only one in `src/`
is a stray `console.error` at `client.ts:412`). It builds a live introspection tree
exposed as `db.debug`: client config, both queue depths, and per worker a request
history with `startTime` / `acquireTime` / `releaseTime` / `affectedRows` and a query
history. `status` is a `Proxy` getter delegating to `orchestrator.getStatus(index)`, so
it is never stale. This is exactly the instrumentation wave 5 needs; the design is
sound, it was simply never plugged in — `client.ts:302-307` destructures
`{} as ReturnType<typeof createClientDebug>`, so all four bindings are `undefined` and
`createClientDebug` is an `import type` only.

`debugSQLQuery(sql, params)` is a separate utility: renders copy-pasteable SQL with
parameters substituted, quote-aware. **Display only, forever** — it concatenates user
values into SQL.

**Option shape (user's convention):** `debug?: string | boolean` on the client —
`string` is the log prefix, `true` falls back to the existing `clientPrefix`
(`"${name ?? 'SQLite'} ${clientIndex}"`, `client.ts:286`, already used to name workers
as `"SQLite 1 / Worker 2"`). Note this reveals a missing brick: wiring `debug` revives
*state collection*, it produces no console output. A real prefixed logger has to be
added for the convention to mean anything. The per-query `debug?: string` label already
present in `SQLiteQueryOptions` is the matching request tag.

**Fix before wiring — in this order:**
1. **Memory leak.** `MAX_QUERY_HISTORY_LENGTH` (50) caps only `currentRequest.queries`.
   `worker.requests` is pushed to on every request and never trimmed — wiring as-is
   grows memory with the client's total query count. Cap it too.
2. ~~`Buffer.isBuffer` / `Buffer.from` at `debug.ts:76`~~ — **done 2026-08-17**, during
   the wave 0 packaging fix.
3. `status: 'HAHA'` (`debug.ts:158`) — unobservable behind the Proxy, but it ships.
4. Off-by-one: `if (length > MAX) shift()` peaks at 51 before trimming to 50.

### 1.4 D6 — asset resolution: we own the Vite integration, and `wasmUrl` is the escape hatch

Decided 2026-08-18, after asking what more could be done about VIT-1 given it is *not*
an artefact defect. It is not a defect, but it is ~25 lines of boilerplate pushed onto
every Vite consumer, and the version we published in the README is fragile. Four items,
all approved:

1. **Ship the plugin ourselves** — a `browser-sqlite/vite` export subpath returning a
   Vite plugin that does both corrections itself: push `optimizeDeps.exclude`, and copy
   `dist/worker/*` using the **resolved** `build.assetsDir` instead of a literal
   `dist/assets`. Consumer config collapses to `plugins: [browserSqlite()]`.
   **Zero-runtime-dependency is preserved**: a Vite plugin is a plain object, so `vite`
   stays a devDependency (types only) — do not let it become a runtime or peer dep.
   Coverage is free: smoke mode 2 already exercises this path, the fixture just switches
   to the shipped plugin. **Wave 4** (with the rest of the packaging work).
2. **The documented snippet is fragile and must die with item 1.** Two hard-coded
   assumptions: `dist/assets` (wrong the moment a consumer sets `build.assetsDir`) and
   `node_modules/browser-sqlite/dist/worker` (a flat node_modules — wrong in a pnpm
   workspace or monorepo). Resolve the package via `import.meta.resolve`. If item 1 ever
   slips, fix the snippet in place — it is wrong as written either way.
3. **`wasmUrl`, optional** — an explicit base URL for the three `.wasm`. **When omitted,
   behaviour is exactly today's** `new URL('wa-sqlite.wasm', import.meta.url)` resolution,
   which works in most setups (user requirement, 2026-08-18): this is an escape hatch, not
   a new default, and the default config must not change by a single byte. It covers the
   wider "assets re-hosted on a CDN at another path" case, of which Vite is one instance.
   It does **not** replace the copy step — the files still have to exist somewhere.
   This closes the "WASM location" open question left by wave P (§2.1).
4. **Turn the hang into a diagnostic** — see B2 in `mem:follow-ups`. Belongs to **wave 2**,
   and is not Vite work: a `Worker` `onerror` that rejects with the attempted URL and a
   README pointer. This is what downgrades a misconfigured consumer from "hangs forever"
   to "reads an error".

**Rejected: inlining the `.wasm` as base64** into `worker.js`. It would remove the
external-asset problem for every bundler at once, but costs +33 % on 2.4 MB raw and gives
up streaming compilation. Acceptable only as an opt-in subpath entry, never as the default.

**Rejected: waiting for Vite.** The `import.meta.url` rewrite during esbuild pre-bundling
is intended behaviour, not a bug in flight — do not plan around a fix.

### 1.5 D2, corrected — the SAB's two usages have different replacement dates

Found 2026-08-18 while reading `worker/worker.ts` for wave 1's brainstorming. D2 as
originally written assumed `navigator.locks` + a `postMessage`-driven boolean replaced
**both** SAB usages, so the whole SAB could go in wave 4. That is true of one usage only.

| SAB usage | Replacement | Available from |
|---|---|---|
| Init mutex (`lock`/`unlock`, `Atomics.wait` worker-side) | `navigator.locks` | Wave 3 (D3 already brings the primitive in) |
| Per-worker `ABORTING` status byte | a `postMessage`-driven boolean | **Only once back-pressure exists** |

**Why the abort flag is different.** The worker's row loop
(`worker/worker.ts:170-205`) is an unbroken chain of `await sqlite.step()`. It never
returns to its event loop for the duration of a query, so **a `postMessage` sent during
a query is never delivered**.

> **MEASURED 2026-08-19 — the sentence above is CONFIRMED, and this is now a settled result.**
> It had been reasoned, never observed, and was doubtful for the **default** VFS
> `OPFSPermutedVFS`, which runs wa-sqlite's **Asyncify** build and unwinds the WASM stack around
> each asynchronous VFS call. The four-combination probe was run and found **zero** messages
> handled during a query — on the Asyncify build as well as the synchronous one, and on an
> I/O-bound query as well as a CPU-bound one. Every ping was handled immediately *after* the
> query, so they queue rather than being lost, and a positive control confirms the channel works
> when the worker is idle. Full table, method and consequences: BP-1 in `mem:follow-ups`. The
> probe lives in git history only (`dc96f57`, reverted in `bbf31b9`) — do not re-run it.
> **This section can now be built on.** Shared memory is the only channel that reaches a worker in
that state — which is exactly why the SAB exists. The flag becomes replaceable only when
the worker awaits a client message per chunk, i.e. the credit/ack scheme currently filed
under wave 5 perf.

**Amendment, 2026-08-19 — what wave 3 established, and what it did NOT.** Wave 3 confirmed by
measurement that the default VFS is `OPFSPermutedVFS` (the Asyncify build) and that it propagates
commits to other connections over BroadcastChannel + IndexedDB — a worker's message handlers demonstrably
run and update its view between queries. That is real evidence about this VFS's messaging, and it is
the first hard data behind §1.5's doubts.

**It is not the BP-1 measurement, and must not be mistaken for it.** What was observed is delivery
*between* queries; BP-1's question is whether a message posted *during* a query is delivered — i.e.
whether the Asyncify unwind hands control back to the JS event loop mid-statement. The stale-read
race said nothing about that, because the read that saw stale data was a separate, later query.
Run the four-combination probe as specified below. Wave 3 narrows the prior; it does not answer it.

**Answered 2026-08-19 by the probe:** a message posted *during* a query is **not** delivered, on
either build. Wave 3's prior pointed the wrong way; the deduction it doubted was right. See the
blockquote above and BP-1 in `mem:follow-ups`.

**Arbitrated 2026-08-18 (user): the credit/ack scheme moves into wave 4**, as `BP-1` in
`mem:follow-ups`, so D2 completes in one go. The alternative — removing only the init
mutex in wave 4 — leaves a SAB behind for the abort flag and therefore banks **none** of
D2's actual benefit. BP-1 was promoted out of wave 5's unnumbered perf list because it is
not an optimisation: it gates D2, it is FLK-1's root cause, it is what gives `first()` a
hard bound, and unbounded chunk pile-up already contradicts the README's stated memory
guarantee. The rest of wave 5's perf work (statement cache, default PRAGMAs, shared WASM
compilation) is independent and stays there.

**Verified the same day: no VFS forces cross-origin isolation.** `grep -rE
'SharedArrayBuffer|Atomics\.'` over the whole of `node_modules/wa-sqlite` (`src/` and
`dist/`) returns nothing — not in the six VFS examples, not in the Emscripten glue, not
in the shipped `.wasm`. The OPFS VFS rely on `FileSystemSyncAccessHandle`, which does not
require isolation; `OPFSAdaptiveVFS` requires JSPI, an unrelated constraint. So the
COOP/COEP requirement is **entirely self-imposed by our `orchestrator.ts`**, and D2 really
does remove it. W-sab asserted this; it is now measured.

## 2. Order of work

Each wave is independently shippable. The ordering rationale that matters: **the test
safety net comes first**, before the scheduler refactor — the original review put tests
last, which is backwards. B1 survived precisely because the scheduler is only reachable
through slow browser tests.

The stack upgrade in §0 lands **before** wave 0 — no point writing the safety net on a
toolchain we are about to replace.

Wave **P** was inserted in front on 2026-08-17 rather than renumbering, so that every
"wave 1 / wave 3" cross-reference already written into §1.1-§1.3 stays true.

| Wave | Contents | Covers |
|---|---|---|
| P ✅ | **Packaging — make the package consumable, nothing more.** See §2.1. Closed 2026-08-17. | B10, B8 |
| 0 ✅ | CI running the suite; put `tests/` in the tsc program; characterization tests for `transaction` / `bulkWrite` / `output`; fix the assertions that cannot fail | B7 |
| 1 | Extract pool + scheduler into a pure module unit-testable in Node (parameterized over a minimal `{ available: boolean }` shape); make `releaseWorker` the single owner of `available`; **relayer the query API on `chunk()` per §1.2** and fix abort once inside it (covers `stream()`'s early `break` and B9). Plus **W-route's first half** (routing allowlist, commit #6) — routing that bypasses exclusivity is the same defect as B1, one layer up. **Exit criteria in §2.2 — FLK-1 is one of them.** | B1, B9, FLK-1, W-arch, W-route (half), part of W-types |
| 2 | `onerror` / `onmessageerror`, per-request timeouts, distinct `open-error` message, `close()` handshake that settles in-flight work and calls `sqlite.close()`. Plus **W-route's second half**: `write()` routes to the writer unconditionally, `read()` rejects a write query instead of silently running it — API strictness, same subject as the error surface. The `onerror` message must name the worker URL it failed to load (see B2 in `mem:follow-ups`). | B2, B3, W-route (half) |
| 3 ✅ | **Done and merged 2026-08-19 (`5eb5ace`).** `quoteIdent()` + pragma allowlist; **debug wired per §1.3** (do it here, before wave 5, so the perf work is measurable); **`output()` rebuilt as staging + atomic rename per §1.1** (needs a `navigator.locks` primitive — pull it forward from wave 4); `bulkWrite` surfaces per-batch failures | B4, B5, B6 |
| 4 | **Now also owns the commit-propagation barrier (added 2026-08-19 by wave 3's findings): one brick that unblocks RYOW-1, the writer designation's stickiness, and two tests pinned to `poolSize: 1`.** B10/B8 and the `consumer-smoke` gate moved to wave P and are **done**. What is left here: **BP-1 (back-pressure, credit/ack) — it is the prerequisite, do it first, and it opens with a MEASUREMENT, not a design: run the four-combination probe specified in BP-1's entry in `mem:follow-ups` before writing a line. §1.5's claim that a `postMessage` cannot be delivered during a query was deduced, never observed, and is doubtful for the default Asyncify VFS**; then remove the SAB entirely (D2, §1.5), which drops the COOP/COEP requirement; then **D6 (§1.4): the `browser-sqlite/vite` plugin subpath + the optional `wasmUrl` escape hatch**, which retires the fragile README snippet. | BP-1, W-sab, VIT-1 |
| 5 | Performance, **with the debug instrumentation live** so the gains are measurable | perf section |

Correctness items not tied to a wave (`W-route`, `W-multitab`, `W-types`) fold into
whichever wave touches the same code.

### 2.2 Wave 1 — exit criteria

Added 2026-08-18. The wave is not closed until all of these hold, on top of the standing
three (CI green, memories updated, git clean):

1. Both pinned `it.fails` (B1 in `transaction.test.ts`, B9 in `concurrency.test.ts`) have
   turned red and had `.fails` removed.
2. **FLK-1 is gone, and gone for the right reason.** The abort check must live **client
   side**, in `chunk()`, evaluated before each yield — not only worker side. Rationale:
   `INT-09` fails intermittently because the worker pushes all 20 chunks into the
   `postMessage` queue before the `ABORTING` flag is read (no back-pressure), so the
   consumer drains an already-full buffer and `chunkCount` reaches 20. Stopping the
   worker loop alone does **not** fix that; refusing to yield what is already queued does,
   deterministically. Fixing B9 and the worker ack without this leaves the flake alive.
3. **Exclusivity is not bypassable by routing.** `VACUUM` / `ALTER` / `ANALYZE` /
   `REINDEX` / `SAVEPOINT` / manual `BEGIN` reach the writer, each named by a test
   (W-route half 1, spec §6.5). Fixing B1 while routing still sends those to the read pool
   would close the front door and leave the service entrance open.
4. `INT-09`'s assertion is tightened to an exact value (`toBe(1)`, or `<= 2` if one chunk
   in flight is tolerated). Leaving `< 20` on a now-deterministic mechanism recreates the
   unfalsifiable-assertion defect wave 0 was spent removing.

5. **The abort ack already exists — do not invent a protocol.** After breaking on
   `ABORTING`, the worker still posts `done` (`worker/worker.ts:227`). The client simply
   does not wait for it: `query()`'s `finally` republishes the worker while that `done` is
   still in flight, which is the second half of B1 (a worker freed while still inside
   `sqlite.step()`). The fix is to await the pending `done` / `error` before releasing.
   **Caveat:** that wait hangs forever if the worker died — it depends on wave 2's
   per-request timeout for robustness. Note the dependency; do not pull wave 2 forward.

**Settled at wave 1's brainstorming, 2026-08-18** (was left open here):
- **A caller abort rejects with `AbortError`** on `chunk()` / `stream()` / `read()` /
  `write()`, matching `fetch` and the web streams. The decisive argument: today a caller
  aborting on a timeout cannot tell "I received everything" from "I was cut off", and
  processes a truncated result set as complete. `first()`'s *internal* abort stays
  distinct and resolves normally — the D4 §1.2 trap, unchanged.
- **Full W-arch split in this wave**, with `bulkWrite` and `output` together in `bulk.ts`
  (user). This also resolves D3 §1.1's open relocation question: the target is `bulk.ts`.
  Risk accepted and mitigated by commit sequencing — pure code movement first, semantic
  changes after, so a move bug stays distinguishable from a logic bug.
- **Exclusivity by opaque lease.** `PoolWorker.available` is deleted outright; availability
  lives inside the scheduler. No module outside it can write the flag, so B1's `finally` is
  not fixable-but-rewritable — it is inexpressible. `release()` is idempotent.
- Module layout: `scheduler.ts` (pure, Node-testable) / `pool.ts` (transport) /
  `queries.ts` / `transaction.ts` / `bulk.ts` / `client.ts` (assembly).

### 2.1 Wave P — packaging

**Goal (user, 2026-08-17): the package as it stands today, defects included, must be
consumable — both through a bundler and without one.** Explicitly NOT in scope: B1, B2,
B9, or any other correctness work. The library may still hang on a worker crash; it must
simply install and run.

**Two requirements, one fix.** Vendoring satisfies both consumption modes at once:

- *With a bundler*: today `dist/esm/index.js` points `new Worker(new URL(…))` at a
  `worker.ts` that is not in the tarball → hard build failure. Building `worker.ts` as a
  second entry fixes that, but its bare specifiers (`wa-sqlite/src/sqlite-api.js`,
  `wa-sqlite/dist/*.mjs`, `wa-sqlite/src/examples/*.js`) would then have to be resolved
  by the *consumer's* bundler, which needs wa-sqlite installed — i.e. B8's `github:`
  specifier, which breaks behind a registry proxy.
- *Without a bundler*: the criterion is binary — **the published bundle must contain zero
  bare specifiers**. A browser cannot resolve `@lalex/promises` or `wa-sqlite/…` without
  an import map, and we will not base bundler-free support on a third-party CDN's `/+esm`
  rewriting.

So: bundle wa-sqlite's glue and the VFS files *into* `dist/esm/worker.js`, copy the
`.wasm` files beside it, resolve them via `import.meta.url`. wa-sqlite becomes a
devDependency and leaves consumer lockfiles entirely. **B8 and B10 are the same piece of
work, not two.**

Replacing `defer()` with native `Promise.withResolvers()` (already a cleanup item) drops
`@lalex/promises` too — the package then has **zero runtime dependencies**, which is the
end state to aim for.

**Open for this wave's own brainstorming:**
- *Weight.* Three WASM variants (`wa-sqlite`, `-async`, `-jspi`), ~1.2 MB each, and the
  VFS is chosen at runtime so we cannot know which is needed. Ship all three (~3.7 MB
  tarball), or make `-async`/`-jspi` opt-in via an `exports` subpath?
- *WASM location.* Automatic resolution via `import.meta.url` is elegant but breaks if the
  consumer re-hosts assets on a CDN at another path. Add a `wasmUrl` escape hatch?
- *Licensing.* Vendoring means shipping wa-sqlite's code — MIT, SQLite itself public
  domain. The notices travel with it.

**Definition of done:** `pnpm test:consumer` green in both Vite modes, and its CI job
flipped from `continue-on-error` to blocking. Consider adding a bundler-free mode to the
smoke test (plain `<script type="module">`, no Vite) since that is now a supported use.

**COOP/COEP is NOT solved by this wave.** Cross-origin isolation stays a hard requirement
on the consuming page — that is D2 (drop the `SharedArrayBuffer`), still slotted at
wave 4. "Consumable" after wave P means "installs and runs in a cross-origin-isolated
page", not "drop it in any page".

## 2.3 Standing lessons, paid for once each — do not relearn them

- **Wave 1: assert falsifiability, not passage.** For every test, name the line whose deletion
  makes it fail. Wave 3 spent **seven fix rounds** on tests that passed with and without the
  behaviour they claimed to pin — more than on any other cause — so this is not a solved habit.
  What works in practice: make the implementer *delete the line, observe red, restore, observe
  green*, and report both. A reasoned claim of falsifiability is worth nothing; four of wave 3's
  reasoned claims were wrong.
- **Wave 3: measure the test, not the argument.** A correct ordering analysis is not evidence that
  a test is stable. A test restored on a sound argument turned out 7.5 % flaky, and the cause was
  a property the test incidentally depended on, not the one it was written for.
- **Wave 3: a reviewer's data-loss claim is a hypothesis until measured.** The final whole-branch
  review asserted a double `output().close()` destroyed the target table. It did not — the
  transaction rolled the DROP back. The neighbouring half of the same finding was real. Measure
  before acting on either half.
- **Wave 3: reviews examine what changed, not what stayed the same.** Two independent reviews
  passed over a scheduler branch without noticing it contradicted its untouched sibling path. When
  a change adds a rule to one of two symmetric paths, review the pair, not the diff.
- **Stickiness session (2026-08-21): a control that differs by two things controls nothing.** The
  first attribution compared `main` against the branch — which differed by a source change *and* by
  a newly added test file. Four combinations were needed to exonerate the source change, and the
  real bug (SUP-1) turned out to be reachable on `main` all along. Name each arm's single variable
  before running it.
- **Stickiness session: instrument the product, not the test.** Every probe placed in the hanging
  test made the bug disappear — bounding the call, enabling debug, shortening a sleep. A trace array
  on `globalThis` written from `client.ts`/`pool.ts` caught it in five runs. Corollary worth
  knowing: a timed-out test still runs its `afterEach`, and since `browserLogs: false` swallows
  `console.log`, an `afterEach` that **throws** the trace is how you get evidence out of a test that
  never finishes.
- **Stickiness session: a falsifiability claim can be disproved, and then you delete the test.** The
  comment claiming "move this line above the call and a second writer appears" was checked by moving
  it: everything stayed green, because the next call reclaims the designation immediately. The test
  asserting it was removed and the comment rewritten to what the experiment actually showed. This is
  the third time this file records that an unexecuted claim is worth nothing — but the new half is
  that executing it sometimes *refutes* you, and the honest response is deletion, not rewording.
- **Wave 3: plan defects reach implementers as instructions.** Four defects in the wave-3 plan
  (a corrupting re-escape, an assertion matching messages instead of codes, a test that could never
  reach its own failure case, a probe defeated by Node 24 shipping `navigator.locks`) were caught
  by implementers only because they were briefed to push back. Brief them to push back.

## 3. Working conventions for this project

- Follow `AGENTS.md`: user leads, one step at a time, French in chat / English everywhere
  else, no unsolicited action on a question, `pnpm check` (biome) after every modification.
- Serena symbolic tools are primary for code; built-in Read/Edit for `.md`/JSON/config only.
- Agent framework is **superpowers**. The old `.planning/` directory was deleted on
  2026-08-17 — do not recreate it or trust anything quoting it.
- These memories live in `.serena/memories/`, which is **not** gitignored — commit them.
- **Phase workflow (user, 2026-08-17).** Each wave/phase is implemented **on its own
  feature branch, by a subagent** — not on `main`, not inline in the main session. A phase
  is closed only when all three hold: **CI green** (types, format, lint), **memories
  updated**, **git clean**. Groundwork already validated by the user outside a phase
  (dependency bumps, specs) lands on `main` directly.
- **Unplanned working-tree changes are committed, not discarded — but only after the user
  confirms.** Never resolve a dirty tree by reverting or stashing on your own initiative.
- **Pushing is not part of committing (user, 2026-08-24).** `main` may sit ahead of
  `origin/main` for as long as the user wants; do not recommend pushing as housekeeping.
  Push only when asked, or when the point is to trigger CI and the user has said so. The
  one push this project has made was deliberate and explicitly requested.
- **"On clôture la session" is a defined procedure (user, 2026-08-17), not a figure of
  speech.** It means the work continues in a *different* session, so nothing may be left
  live in this one. Three steps, in order:
  1. **Merge the feature branch into `main`.** The phase's closure conditions must hold
     first — CI green, memories updated, git clean.
  2. **Write the Serena memories.** Anything the next session needs and cannot re-derive
     from the code: decisions and their rationale, traps paid for, open items with their
     evidence. Whatever lives only in a scratch ledger or in the conversation is lost.
  3. **Commit whatever is still outstanding.** Obvious leftovers go in directly; for
     anything that is not obvious, ask first.
- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one. The open items are listed per wave in `mem:follow-ups` and in §1.

## 4. Changelog of this plan

- **2026-08-21 (later session)** — **Step 1 done and merged: the writer designation is released
  once nothing is queued** (`e2f454b`, merge `4f215f8`). Classified as a bounded change — designed in
  chat, no spec, no plan document. Measured 30-32 ms against 934-1052 ms in the head-of-line case,
  neutral everywhere else. Two things the session settled beyond the change itself. **Spec §2.2 is
  wrong**: relaxing stickiness does not mitigate the barrier's alternating-load worst case, because
  on an idle pool the write and the next read take the same lowest free worker. And **SUP-1**
  (`07b075a`), a pre-existing bug where a replacement worker dying before `ready` left the client
  alive, empty and silent forever — found by chasing a 1-in-8 full-suite hang, fixed with a
  `spawned` event, pinned deterministically. Next: `COOP-1`.
- **2026-08-20** — **RYOW-1's root cause found, and the barrier's shape with it.** The stale read
  after `output()` is caused by **priming**: any earlier read on the connection that later serves
  the read leaves it holding a stale page 1, so it returns fresh data under the old schema — an
  incoherent snapshot, not a lagging one. `output()` guarantees such a read through its sweep.
  Verified necessary (sweep off → 0 stale) and sufficient (one bare `read()` → stale). **Not a lag**:
  neither an event-loop turn nor 150 ms cures it; what looked like convergence was the second read.
  **Not the VFS**: 40 runs, 40 stale, across `OPFSAdaptiveVFS` / `OPFSWriteAheadVFS` /
  `OPFSCoopSyncVFS` / `IDBBatchAtomicVFS` on every declared build — so the default-VFS choice is not
  reopened and the barrier is permanent architecture. Two recorded leads died under measurement:
  `PRAGMA data_version` and the WAL VFS. Evidence and the design space: `mem:follow-ups`, RYOW-1
  block (4). No source file was changed — every probe was reverted.

- **2026-08-19 (later)** — **Wave 3 merged into `main`** (`5eb5ace`), after the user reworked the
  scheduling rules. What changed between the first "done" below and the merge:
  - The **writer-preference for reads was removed** on user instruction. Their objection was the
    shape, not just the scope: it entangled read scheduling with writer designation, and the two
    acquisition paths disagreed (`handOver` cleared the designation when the writer served a queued
    read, `takeAvailable` deliberately kept it — so the hazard `takeAvailable`'s comment described
    was reachable through its sibling). **Neither review caught that asymmetry; the user did**,
    from a plain reading of the rules. Worth remembering: the reviews examined the added branch,
    never its symmetry with the untouched path.
  - The user also asked that the designation be **released** once no write is outstanding or
    queued, so the next write could take the first free worker. Built, measured, **reverted with
    evidence** — see rule 3 in `mem:project-state`. Stickiness is now proven necessary rather than
    inherited.
  - A test this controller had **insisted on restoring** (against the implementer's judgement)
    turned out to be **7.5 % flaky** (4 failures in 53 runs). Root cause measured, and it was not
    the sweep: `no such table: target_a`, i.e. the RYOW hole, because the test read back what it
    wrote across workers. Fixed by `poolSize: 1` on both clients — which keeps two connections and
    two Web Locks, so the cross-client property is untouched. 20/20 after, and still red when the
    sweep's staleness filter is defeated. **Lesson: a correct ordering analysis is not evidence
    that a test is stable. Measure the test, not the argument.**

- **2026-08-19** — **Wave 3 implemented on `wave-3-sql-safety`, 21 commits, 273 tests green.** B4, B5, B6 closed — evidence per item in `mem:follow-ups`. What is worth
  carrying forward beyond that:
  - **The default VFS is `OPFSPermutedVFS`, not `OPFSCoopSyncVFS`.** `mem:project-state` said
    otherwise, a dispatch repeated it, and an agent spent a full round debugging on the wrong
    premise. Corrected at the top of that file.
  - **A 40 %-reproducible flake was root-caused, not suppressed.** After `output().close()`
    resolved, a `read()` could return the pre-swap schema: `OPFSPermutedVFS` propagates commits
    asynchronously, and a read landing on a worker that had not yet received the broadcast served
    a stale view. The first proposed fix — a `read('SELECT 1')` nudge — was rejected before review:
    its own comment conceded it only touched the lowest-index worker, so it was calibrated to the
    test's 2-worker pool rather than to the guarantee. The accepted fix makes reads prefer the
    designated writer (RYOW-1). **This is a scheduling policy change inside an SQL-safety wave** and
    is the one item needing the user's judgement.
  - **`temp` was removed from `output()` for a different reason than D3 §1.1 gave.** Staging inside
    `temp` would rename fine — both in the same database. The real defect is that a TEMP table lives
    on one connection and is invisible to the rest of the pool.
  - **A review claim was disproved by measurement.** The final whole-branch review said a double
    `output().close()` destroys the target. It does not: the second `ALTER` fails and `transaction()`
    rolls the `DROP` back, leaving the table and its rows intact. The underlying finding was still
    half-right — `enqueue()` after a successful `close()` silently buffered rows nobody would flush —
    and that is fixed with a `closed` flag. **Do not accept a data-loss claim on reasoning; measure it.**
  - **The wave's dominant failure mode was unfalsifiable tests, again.** Seven of the fix rounds
    were spent on tests that passed with and without the behaviour they claimed to pin — more than
    on any other cause, and the same lesson wave 1 recorded. Four of those defects originated in the
    plan document itself, not in the implementations. The habit that worked: require the implementer
    to delete the target line, observe red, restore, observe green, and report both.
  - **Four plan defects were caught by implementers before review**, which is the argument for
    briefing them to push back: a literal re-escape that corrupted already-valid SQL literals, a
    `toThrow(/CODE/)` that matches messages rather than codes, a batching test that could never reach
    the failure it asserted, and a degradation test defeated by Node 24 shipping `navigator.locks`.


- **2026-08-18** — **Wave 2 implemented on `wave-2-error-surface`, awaiting merge. 193 tests green.**
  What shipped:
  - **B2 closed.** `onerror` rejects the in-flight query with `WORKER_CRASHED` and names the failed
    URL (the actionable load-failure diagnostic that makes VIT-1 non-blocking). `messageerror` rejects
    the in-flight query with `PROTOCOL_ERROR` while keeping the worker alive. `ready` is only posted on
    success; failure posts `open-error` instead (the multi-tab exclusive-lock failure is now surfaced).
    Every `cause` is structured-clone-probed before crossing the thread boundary.
  - **B3 closed.** `close()` is now `() => Promise<void>`: `scheduler.shutdown(CLIENT_CLOSED)` rejects
    queued work, the pool drains in-flight work (bounded by `drainTimeout`), each worker receives a
    `close` message and calls `sqlite.close(db)` before posting `closed`, then is terminated. Post-close
    queries receive `CLIENT_CLOSED` immediately. Second call returns the same promise.
  - **W-route closed (half 2).** `write()` routes to the writer unconditionally; `read()`, `chunk()`,
    `stream()`, and `first()` reject a non-read statement with `NOT_A_READ_QUERY` before any lease is
    taken. Every PRAGMA currently routes to the writer — B4 (wave 3) gives read PRAGMAs back. A test
    in `tests/browser/routing.test.ts` pins the current rejection and turns red when B4 lands.
  - **`supervisor.ts` (new, 81 lines).** Pure per-slot restart policy, zero imports: never restarts a
    slot that never reached `ready`; resets the counter on a served request (not on `ready`);
    `maxWorkerRestarts` bounds it; eviction leaving no live slot fails the client permanently; `evicted`
    flag makes eviction permanent against a late `ready`.
  - **`errors.ts` (new, 25 lines).** `SQLiteError extends Error` with `code` and `name` mirroring each
    other. Five codes: `NOT_A_READ_QUERY`, `CLIENT_CLOSED`, `WORKER_CRASHED`, `TIMEOUT`,
    `PROTOCOL_ERROR`. Exported from `index.ts`.
  - **New constructor options:** `maxWorkerRestarts` (default 1), `openTimeout` (default 30 000 ms),
    `drainTimeout` (default 60 000 ms).
  - **`pool.ts`** gained `interrupt()`, `quiesce()`, and `close()` on `PoolWorker`; bounded
    stop-and-drain; `onerror` and `messageerror` handlers.
  - **`scheduler.ts`** gained `remove(index)` and `shutdown(reason)`; a per-index generation counter
    makes a stale lease's `release()` inert after the slot was removed and revived.
  - **`queries.ts`** got `makeAbortRace`; the abort races the pending chunk instead of being tested
    after it; the caller never awaits the drain.
  - **`worker/worker.ts`**: `ready` only on success, `open-error` on failure, every `cause`
    structured-clone-probed, `sqlite.close(db)` on `close` message, exhaustive message dispatch.
  - **`utils.ts`**: `assertReadable(sql, method)` throws `NOT_A_READ_QUERY` before any lease is taken.
  - **Tests:** 148 → 193. New unit files: `errors.test.ts`, `supervisor.test.ts`. New browser files:
    `lifecycle.test.ts`, `close.test.ts`, `long-query.test.ts`, `routing.test.ts`.
  - **Known residual (B2).** A worker killed silently while a query is in flight is noticed only if
    the caller aborts. During a query the worker's row loop is an unbroken chain of `await sqlite.step()`
    — no heartbeat can arrive and the SAB status byte does not move. A caller who wants a bound writes
    `AbortSignal.timeout(n)`. BP-1 (wave 4) removes this residual: a per-chunk ack is a heartbeat.
  - **Two tooling facts recorded for future waves.** (1) `it.each` does not exist in rstest 0.11.8 —
    parameterised tests use a plain `for` loop calling `it()` directly. (2) rsbuild renames the emitted
    worker chunk (`webpackChunkName: "browser-sqlite"`), so no test may assert a `worker/worker.js`
    substring in an error message — assert the stable wording instead.
  - **Next up: wave 3** — B4 (`quoteIdent()` + pragma allowlist), B5 (`output()` staging + rename),
    B6 (debug wired).

- **2026-08-18** — **Wave 1 implemented on `wave-1-pool-scheduler`, 15 commits, 148 tests green,
  awaiting merge.** What shipped:
  - `client.ts` split into `scheduler.ts` (pure, no `Worker`/DOM/orchestrator import, driven by 15
    Node unit tests) / `pool.ts` (transport) / `queries.ts` / `transaction.ts` / `bulk.ts`, with
    `client.ts` reduced to assembly.
  - **B1 fixed by construction**: `PoolWorker.available` deleted outright, availability private to
    the scheduler, handed out as idempotent leases. The offending `finally` cannot be written any
    more. `transaction()` holds one lease for its whole lifetime.
  - **Abort implemented once, in `chunk()`**: up-front `signal.aborted` check (B9); refusal to
    yield anything already queued once the signal fires (FLK-1); listener removal in the `finally`
    (the leak); and the in-flight `done` awaited before the lease returns (B1's second half).
  - **`first()` breaks instead of aborting**, which designed out D4 §1.2's internal-abort trap
    entirely — `AbortSignal.any` is not used anywhere and its browser-baseline question is void.
  - `one()` → `first()`, `stream()` yields rows, `chunk()` public, `signal` on every method.
  - **W-route half 1**: allowlist requiring an allowlisted opening keyword AND no write keyword
    anywhere — the second clause matters because the worker executes `;`-separated statements.
  - **FLK-1 verified dead by 10 consecutive full browser-suite runs**, not by one green run.
  - **Transaction error masking fixed** (found by the final review, fixed on user instruction rather
    than deferred to wave 2). `commit()`/`rollback()` set `done = true` *before* running their
    statement, and the `catch` rolled back unconditionally — so a callback that terminated the
    transaction itself and then threw got "cannot rollback - no transaction is active" instead of
    its own error. `done` is now set *after* the statement succeeds and the catch is guarded by
    `if (!done)`, which preserves the case that matters: a failed `COMMIT` leaves the transaction
    active, so that path must still roll back. The reorder also closed a worse latent case — a
    failed COMMIT whose error the callback swallowed used to leave the transaction **open** on a
    worker that was then returned to the pool.
  - Verification commands are now bounded (`timeout -k 30`), and the `unit` project has an explicit
    `testTimeout`. A per-test bound does not catch a suite that finishes and never exits on an open
    worker handle, which is what `pool.ts`'s drain loop risks until B2 lands.

- **2026-08-18** — **D6 decided** (see §1.4). VIT-1 stays "not an artefact defect", but the
  boilerplate moves from the consumer to us: a `browser-sqlite/vite` plugin subpath in
  wave 4 (`vite` stays a devDependency — the zero-runtime-dependency state from wave P is
  not to be traded away), plus an **optional** `wasmUrl` whose absence keeps today's
  `import.meta.url` resolution byte-for-byte (user requirement). The README snippet was
  found fragile on two counts (hard-coded `dist/assets`, flat-node_modules path) and is
  retired by the plugin. Wave 2's `onerror` work gains an explicit requirement: name the
  attempted worker URL, so a misconfigured consumer reads an error instead of hanging.
  Inlining wasm as base64 and waiting for a Vite fix were both considered and rejected.

- **2026-08-17** — **Wave P closed.** B10 and B8 resolved. What shipped:
  - Two rslib entries: `index` (rslib defaults, keeps `import.meta.url` literal) and
    `worker` (`importDynamic: true`, `url: false`, `asyncChunks: false`, wa-sqlite
    fully inlined). Source file moved: `src/worker.ts` → `src/worker/worker.ts`.
  - Three `.wasm` copied flat beside `worker.js` via `output.copy` (no content hash).
    `url: true` was the original design but was rejected: its webpack runtime anchor
    (`__webpack_require__.b`) cannot be followed by Rollup or a consumer's rspack.
  - `exports["./dist/*"]` dropped (surface too wide before any consumer exists).
  - `@lalex/promises` removed; `Promise.withResolvers()` native. `dependencies: {}`.
  - `NOTICE` added: full verbatim MIT text (year 2023) + inline `/*!` banner on
    `worker.js`. The plan's draft linked the text instead of reproducing it and used
    year 2024 — both corrected.
  - Four consumer smoke modes green (11/11 stages); `consumer-smoke` CI now blocking.
  - **Task 7 (chunked worker) permanently wontfix.** Rollup refuses `format=iife`
    for a code-splitting build; Vite always re-bundles worker entries that way. The
    monolithic worker (117,405 bytes gzip) is the permanent shape. Recorded as W-chunks
    in `mem:follow-ups`.
  - **Surprise (genuine limitation):** Vite requires consumer configuration — esbuild
    pre-bundling rewrites `import.meta.url` in dev, and prod build does not copy wasm
    beside the emitted worker. Documented in README, recorded as VIT-1 in
    `mem:follow-ups`. rsbuild/no-bundler modes need nothing.
  - **Flaky test found (pre-existing):** `AbortSignal INT-09` in
    `tests/browser/concurrency.test.ts` timing-races intermittently. Recorded as FLK-1
    in `mem:follow-ups`; can block commits and CI.
  - Spec (`docs/superpowers/specs/2026-08-17-wave-p-packaging-design.md`) and plan
    (`docs/superpowers/plans/2026-08-17-wave-p-packaging.md`) amended with an
    "Amendments" section at the end of each. Both originals are unmodified above it.

- **2026-08-17** — **wa-sqlite bumped v1.0.9 → v1.1.2** (commit `2bf1c59`), ahead of wave P
  and at the user's instruction, because wave P vendors these exact binaries into the
  tarball — vendoring an eleven-month-old build and bumping afterwards would mean redoing
  the whole four-mode packaging validation. Verified green: `tsc --noEmit`, `biome check`,
  `pnpm build`, **105/105 tests**, and both `it.fails` (B1, B9) still failing as expected —
  the upstream `retry()` change did not silently mask either bug. Payload: SQLite
  **3.50.1 → 3.53.0** in all three `.wasm`; `retry()` in `sqlite-api.js` bounded to 2
  attempts instead of a potentially infinite `do/while`, with a new `Module.pendingOps`
  whose errors surface as a return code; `OPFSCoopSyncVFS` (our default) wraps access-handle
  creation in `try/catch/finally` so a failure no longer pins `isRequestInProgress` at
  `true` forever; three WAL fixes from v1.1.1. No API break on anything `worker.ts` calls.
  A sixth VFS appeared upstream (`OPFSWriteAheadVFS`) — opt-in, `VFSConfigs`'s
  `satisfies Record<SQLiteVFS, …>` is unaffected. No source file was touched.

- **2026-08-17** — **B10 + B8 pulled to the front as wave P** (user decision). The stated
  goal for the next phase is that the package as it stands, defects included, becomes
  consumable — via a bundler and without one. Design and open questions in §2.1. Wave 4
  keeps D2 / the SAB removal. ~~Watch item: publishing a consumable RC would create the very
  consumers whose absence justified D3's and D4's breaking changes.~~ **Closed by the user
  the same day: nothing is published until all the correction waves are done.** Publishing
  is tag-driven (`release-and-publish.yaml` fires only on `v*.*.*`), so merging to `main`
  never ships anything. Wave P makes the package *buildable and testable* as a consumer
  would use it; it does not make it public.

- **2026-08-17** — **Wave 0 gap closed: the safety net covered the sources, not the
  published package.** Added `scripts/consumer-smoke.mjs` + the `tests/consumer/` Vite
  fixture + a non-blocking `consumer-smoke` CI job. It immediately reproduced **B10** —
  the published tarball cannot be consumed at all (no worker artifact beside `index.js`);
  `vite build` fails outright and `vite dev` hangs forever, which also demonstrates B2.
  Two packaging bugs fixed along the way: the published `types` field pointed at a
  missing `dist/esm/index.d.ts` (pre-existing), and wave 0's `tsconfig` change had started
  shipping `dist/esm/tests/**` (my regression). Both fixed by `tsconfig.build.json`
  scoped to `src` + `rootDir`, which in turn surfaced the `Buffer` bug in `debug.ts` as a
  compile error — also fixed. 105 tests still green.
- **2026-08-17** — **D4 and D5 decided** (see §1.2, §1.3). D4: the query API is relayered
  on an explicit `chunk()` primitive — the hierarchy already exists internally, so it is
  mostly deletion; `signal` on every method including `one()` (an earlier draft wrongly
  proposed removing it — cancellation is call-site semantics, not transport config);
  `chunkSize` narrowed to `chunk()` and `read()`. Pulled into wave 1 because it collapses
  B9, `stream()`'s early-`break` abort and the future back-pressure scheme into one place.
  D5: the debug subsystem is wired, not deleted, behind `debug?: string | boolean` with
  `clientPrefix` as the `true` fallback; moved into wave 3 so wave 5's perf work is
  measurable. Found while tracing `clientPrefix`: the instrumentation call sites already
  exist, optional-chained into no-ops, so D5 is far smaller than "221 dead lines" implied.
- **2026-08-17** — **D3 decided** (see §1.1). Reframed from "does `output()` leave the
  core?" to "does it deliver MongoDB `$out`'s guarantee?" after the user stated the
  design intent. Chosen: staging table + atomic rename, indexes built inside the final
  transaction, three-net cleanup, `navigator.locks` so multi-tab `output()` is
  supported. One big transaction was considered and rejected (monopolises the single
  writer for the whole reload, WAL cannot checkpoint). Knock-ons: `navigator.locks`
  moves from wave 4 to wave 3; `temp: true` becomes incoherent and is now an open
  sub-question; relocation drops to a free organisational choice and no longer gates
  the version number — the `rc.4` vs `2.0.0` framing recorded earlier is moot.
- **2026-08-17** — **Wave 0 completed** (B7 closed). Added `.github/workflows/ci.yaml`
  (biome ci + tsc + build + full suite, on push to main and on every PR, Chromium cached);
  added `tests` to the tsconfig `include` (it type-checked clean, no fallout);
  `createTestClient()` now takes a `CreateSQLiteClientOptions` override. New suites:
  `transaction.test.ts`, `bulk-write.test.ts`, `output.test.ts`, `vfs.test.ts`.
  Fixed both unfalsifiable abort assertions in `concurrency.test.ts` — the second one
  immediately exposed **B9** (already-aborted `AbortSignal` ignored, 100/100 chunks
  delivered). 81 → 105 tests, all green; no source file was touched.
- **2026-08-17** — Stack upgrade **completed and verified green**: TS 7.0.2, rslib 0.23.2,
  rstest 0.11.8, biome 2.5.8, playwright 1.62.1. Two devcontainer rebuilds (the second for
  the VS Code TS-7 extension swap). Only fallout was a one-line `biome.json` migration.
  `tsc --noEmit`, `biome check`, `pnpm build`, 57 unit tests and 24 browser tests all pass.
  No source file was touched.
- **2026-08-17** — Created. Triaged `docs/reviews/2026-08-17-0759-browser-sqlite.md`,
  verified B1/B6/B8 and the SAB usage directly in source, re-graded severities, inverted
  the review's test-vs-refactor ordering, and closed D1 with a recommendation. No code
  changed yet; work has not started.
