# History — what each merged wave left that the code will not tell you

**Frozen since 2026-10-08: no new entry here.** Its last wave merged on 2026-09-15; what has merged since lives in the monthly tables of `mem:history` (`mem:history/2026-10` and on).

Part of `mem:history`. Moved from `mem:state` on 2026-10-03, newest first as it was written there.

## `OPFSCoopSyncVFS` hands its handle over between calls only — merged 2026-09-15

No spec: investigated with systematic debugging, the fix designed in chat and approved. Numbers in
`mem:measurements` (COOPSYNC-HANDOVER); the VFS fact in `mem:vfs`; the pin and the patch traps in
`mem:stack-and-build/wa-sqlite`. The fix is a wa-sqlite patch, proposed upstream as rhashimoto/wa-sqlite#347.

**Five things the code will not tell you:**

- **The cause is a re-prepare, not the protocol step COOPSYNC-BUSY named.** SQLite locks, unlocks
  and locks again inside one `step` when a cached statement's schema changed; the VFS released at the
  inner unlock; `retry()` tries twice. The 2026-09-03 read failures were the same mechanism, which
  `readWithRetry` absorbed; nothing produces them now and no test exercises that retry — fine by the
  user: the red-to-green test is what counts.
- **A task, not a microtask.** The JSPI build suspends at every VFS call; the microtask version was
  reasoned safe and measured wrong (`mem:lessons`). `coopsync-handover.test.ts` runs on `jspi` for that
  reason, and its mutation back to a microtask is recorded.
- **wa-sqlite is pinned by SHA (user).** Vendored, so a commit serves as well as a release: upstream
  HEAD `07ad48c` at the time — `93b9230` since 2026-09-21 — which carries #344, so the patch held the
  CoopSync change only, under the key
  `wa-sqlite@1.1.2`. #347 merged on 2026-09-26 and the pin carries it: that change left the patch.
- **#347's evidence is wa-sqlite's own suite, never this library** (user: a stable library is not
  argued from an unstable one — `mem:conventions`). Its `jspi` claim rests on our measurements: that
  suite skips `jspi` on current Chrome.
- **The same probe found the next subject.** `OPFSWriteAheadVFS` refuses a second client off
  Chromium, and the multi-client and cross-tab suites run on `OPFSAdaptiveVFS` alone
  (`mem:follow-ups`) — the next session.

**What it does NOT deliver.** Nothing for `OPFSWriteAheadVFS`. The NotFound fix rests on a small
natural sample (2 of 19 against 0 of 20) and on a test that forces the race with 30 orphaned
directories.

## Statement errors — merged 2026-09-15

Spec `docs/superpowers/specs/2026-09-14-statement-errors-design.md` — read its decisions D8-D10,
the user's amendments while it was built, and not only the first version. Plan
`docs/superpowers/plans/2026-09-14-statement-errors.md`; its code predates D10 and the final fix
wave, so the spec and the source are what is current. Merge `54c4492`.

**Four things the code will not tell you:**

- **Why `sqliteCode` is strict and `sqliteExtendedCode` open (D10).** The strict type makes
  `err.sqliteCode === SQLITE_EXTENDED_CODES.X` a compile error. The open one exists because the
  client deliberately lets a wrong read through (D9) — a 0, or 101 after a JS-side `MISUSE`. Do not
  tighten the extended type, and do not turn `subtypeOf` into a `>= 256` filter: either would hide
  a wrong read.
- **The stamp's three sites are an invariant, not a style** (`mem:architecture`).
- **`sqliteCodeOf` is why an open refused by OPFS carries no `sqliteCode`.** Before it, any
  numeric `code` crossed the boundary, and a DOMException's legacy code is numeric.
- **D10 rests on a measurement, not an assumption**: TypeScript's completion does offer numeric
  literals (5.9.3, 6.0.3), and `number & {}` keeps them from collapsing into `number`
  (`mem:stack-and-build` says how to probe it under TS 7).

**What it does NOT deliver.** No extended code at open or delete (D7); no named code per
result-code family (D1). A later statement's prepare failure in a fresh multi-statement string is
stamped by a site no test can falsify. `SQLITE_CODES` is re-transcribed by hand when wa-sqlite moves
to another SQLite.

## `IDBBatchAtomicVFS` during a long statement — merged 2026-09-14

No spec: a bounded fix, designed in chat and approved. Numbers in `mem:measurements` (IDB-SIGNAL);
the VFS fact in `mem:vfs`; what is left in `mem:follow-ups`.

**Five things the code will not tell you:**

- **The bench measured the library's option, not the VFS.** Its long query carried the row's
  signal; when a signal started reaching the worker (`f4b3fd7`), the verdict flipped with no change
  to the row. It now issues the long query bare (`mem:lessons`).
- **The yield during a statement is about IndexedDB, not about the handle.** `jLock` opens a readwrite
  IndexedDB transaction per statement, which commits only when the worker returns to its event loop.
  `yieldsDuringStatements` granted that yield to `IDBBatchAtomicVFS` alone; since 2026-10-02
  (`feat/always-abortable`) every statement on `async`/`jspi` yields, and the flag is gone.
- **The calibration verifies only a bound it did not time.** Re-running a timed bound ran Safari's
  `async` build down its slowdown and voided the IDB column; `longQueryCalibration` exports every
  timing, so a `null` explains itself.
- **On Safari the `async` build degrades and stays slow; `jspi` escapes it on 27.** `VFS.md` says
  so under *Build `async`*; since 2026-09-24 an omitted `build` loads `jspi` wherever the engine has it.
- **Measure Safari from the container.** The user opens `localhost:8099`, served from `_site`
  (`mem:conventions`); Playwright's Linux WebKit cannot stand in, its workers do not even load.

**What it does NOT deliver.** Safari 26 has no way around the slowdown for a VFS without a `sync`
build. The bench's `async` columns stay `null` on Safari whenever the slowdown has set in — honest,
not fixed. `OPFSAdaptiveVFS` on `jspi` was never measured on Safari 27.

## The pool capped by its environment — merged 2026-09-14

Spec `docs/superpowers/specs/2026-09-13-pool-environment-cap-design.md` — read its §9 and §10
amendments; plan `docs/superpowers/plans/2026-09-13-pool-environment-cap.md` (Tasks 1-13).
Merge `121b0f6`. Invariants in `mem:architecture`; numbers in `mem:measurements` (WORKER-LOST,
POOL-SIZE, DELETE-WA); VFS facts in `mem:vfs`.

**Six things the code will not tell you:**

- **The observation was a VFS design fact the repository once had right.** Off Chromium,
  `OPFSWriteAheadVFS` keeps its file exclusively for a connection's life; `70b2b7a` (2026-08-27)
  "refuted" that on a conformance pass that never counted workers. Conformance now fails on a lost
  worker and skips a two-worker invariant where the pool runs one (`mem:lessons`).
- **The decisions are the user's (spec D1-D11):** a capped pool is capped, not lost; the warning
  fires only on an explicit `poolSize`; a `db.poolSize` getter, not a callback; every surplus worker
  probes and declines itself; `WorkerLostEvent.size` is the effective size; `db.ready` was deferred to rc.6 (shipped 2026-09-23);
  `singleConnectionWithout` means "a pool beyond one buys nothing" and covers `OPFSAdaptiveVFS`;
  `OPFSCoopSyncVFS` has `maxPoolSize: 1` everywhere — **breaking, accepted**.
- **The probe reads the `mode` ATTRIBUTE inside a worker.** The page cannot probe:
  `FileSystemSyncAccessHandle` exists in dedicated workers only, and a probe worker of its own would
  still answer asynchronously and meet a consumer CSP without `worker-src blob:`. Passing the
  dictionary option proves nothing — WebIDL ignores it. Do not "simplify" either way.
- **The Firefox config no longer drives a pool against a rotated handle within one client.**
  `OPFSAdaptiveVFS`, `createTestClient`'s default, runs one worker there; the fifteen tests that
  need two workers run on `OPFSAnyContextVFS`, and rotation is exercised only between clients.
- **Conformance no longer agrees across engines, by design** — Chromium skips 14, Firefox 18: on
  Firefox two invariants skip `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which run one worker there.
- **The bench shows `pool N → M`** in a column header once `db.ready` resolves on a capped pool,
  and bounds the burst ranking by the effective size (2026-09-23); the export records `db.poolSize`.
  Seen on all three engines: Safari 27 on 2026-09-28 exports `poolSize` 1 for the `OPFSAdaptiveVFS`
  pairs, the `pool 4 → 1` expected. Since
  2026-09-14 it skips **three** rows on a one-worker column, not the two its commit message names:
  `reads-during-long-query` too — whether the other workers serve during a long query has no
  subject on one worker. So the bench no longer shows HANDLE-1 within a client off Chromium.

**What it does NOT deliver.** Safari is checked at n=4 on one Mac and Firefox at n=3 in this
container (SAFARI-CAP, `mem:measurements`): every cap holds. CoopSync writes can still take the transfer BUSY between clients; nothing guards the barrier
itself — `barrier.test.ts`'s schema tests guard the worker's column-name capture (spike
2026-09-25) —; D-09 has no falsifier by construction (`mem:follow-ups`). Orphan
`-wa0`/`-wa1` files left by deletions before the fix stay — harmless, by decision.

## The caught write abort — merged 2026-09-12

Spec `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md` (read its dated amendment in §4),
plan `docs/superpowers/plans/2026-09-11-tx-savepoint.md`. Branch `fix/tx-savepoint`, merge
`65a40d3`. Invariants in `mem:architecture`; numbers in `mem:measurements` (TX-SAVEPOINT,
TX-M1M2).

**Five things the code will not tell you:**

- **The rule is the user's, stated as use cases.** *"Je catch une erreur et je continue"* is
  normal: a statement abandoned by its own `signal`/`timeout` has no effect, and a callback that
  catches it goes on — SQLite's statement-level model, chosen over PostgreSQL's
  poison-until-rollback. All or nothing is what a transaction is for: the docs say "use a
  transaction", never "use `tx.bulkWrite`"; inside one, a caught error followed by a commit keeps
  what was written, `bulkWrite`'s completed batches included.
- **Approach B was the user's choice against the recommendation.** A — the transaction sending
  `SAVEPOINT`/`RELEASE` itself — was recommended for stability; the user chose B, the worker
  opening the savepoint inside the write's own message, after both were measured, holding that
  stability is what tests guarantee. Real B costs 0.016-0.019 ms per opted-in write on Chromium
  and 0.085 ms on Firefox. **Do not re-propose A on stability grounds without new evidence.**
- **The wait after a caught abort is unbounded by design (user, D3).** The next statement or the
  commit waits for the abandoned write to run to its end, with the write lock held; only the
  transaction's own `signal`/`timeout` and the waiting statement's own bound it. A `drainTimeout`
  bound and a fail-fast error code were both refused.
- **A failed savepoint conclusion rolls the whole transaction back in the WORKER**, which the
  final review added: the spec stated the rule, its test list did not, and nothing built it — a
  consumer's `…; RELEASE u` abandoned could commit a rejected write. The client learns of it
  through the existing D6 path (`inTransaction: false`).
- **What it does not deliver.** The isolated-build test does not pin that the step is actually
  CUT on a transaction death — redundant safeties keep it green under every single-cause mutation
  tried; only a timing bound would. T9 never has a batch in flight, so R4's in-flight undo is
  covered by construction only. `tx.savepoint()` is rc.6 (`mem:follow-ups`).

## The transaction closure — merged 2026-09-11

Spec `docs/superpowers/specs/2026-09-10-transaction-abort-design.md` (read its dated
amendments), plan `docs/superpowers/plans/2026-09-10-transaction-abort.md`. Branch
`fix/tx-statement-timeout`: step 1 honoured a per-statement `timeout` inside `transaction()`;
step 2 is what that exposed. Invariants in `mem:architecture`; campaigns in
`mem:measurements` (TX-AUTOCOMMIT, TX-HANDLE, TX-M1). Merge `eeabe06`.

**Five things the code will not tell you:**

- **The rule was chosen as a mechanism and corrected by the user's use cases.** "An abandoned
  write abandons its transaction" shipped through spec, plan, six tasks and a whole-branch
  review before the user wrote down what a consumer expects: a caught error goes on, an
  uncaught one stops everything. Two decisions followed, both recorded in the spec: D4
  reversed — a write whose own signal was already aborted at the call is simply rejected and
  the callback may go on — and `tx.signal` aborts on EVERY rejection of `transaction()`,
  not only an abort. The one case still off the user's model, a caught write abort while it
  runs, is the savepoint follow-up.
- **The savepoint option was refused once, and the refusal was right for what it was.** The
  version refused never cut a write, so a `timeout` bought nothing. The deferred variant cuts
  on a transaction-level abort and only spares a write the CALLER caught. Do not merge the two
  in memory.
- **`tx.signal` means "the transaction was interrupted", never "the callback stops"** (user,
  2026-09-10). Work the callback did not await outlives a successful transaction by design —
  the closed handle is what keeps it off the database. An abort after an explicit `commit()`
  still abandons the call: `transaction()` rejects, `tx.signal` fires, the commit stands.
- **Breaking, once:** a statement issued after the transaction's own `signal` fired reports
  `TRANSACTION_CLOSED` where rc.4 reported `signal.reason`. With D4 reversed, the write rule
  is not breaking — every behaviour it changes failed or committed an abandoned write.
- **One commit on the branch, `c2ef918`, landed with a failing `tsc` past the hook** and was
  fixed by `e45f566`; every other commit was proved green in clean worktrees. See
  `mem:lessons` before trusting a hook or a subagent's "pre-existing". How it got past — not
  a bypass; a commit created 25 s into a ~100 s hook — is traced in `mem:git-hooks`.

**What it does NOT deliver.** The savepoint variant. An eviction for any other reason — a
crashed worker — still loses a memory database, as it always has. Four review minors were
left by decision: the label of a poisoned rollback, the `settled`/`releasing` duplication, the
reused name `own`, and the `abandon` listener's lifetime on a caller-owned signal.

## The transaction's per-statement wait — merged 2026-09-10

No spec and no plan: brainstormed in chat, the user validating each step, like the write-lock
work below. Branch `fix/tx-statement-quiesce`. The invariant itself now lives in
`mem:architecture`; the numbers in `mem:measurements`, TX-QUIESCE.

**What it was.** A statement in a `transaction()` callback that ended before its result did
left the shared worker still finishing, and the next statement in the same callback met
`pool.ts`'s reuse guard. Four faces, one mechanism: `first()` on any query with a row left to
produce — its ordinary use — a `chunk()`/`stream()` `break`-ed out of BETWEEN two statements,
and `read`/`write`/`bulkWrite`/`output` cut short by a per-statement abort the callback caught.
Pre-existing, deterministic, both engines.

**Five things the code will not tell you:**

- **The scope was wrong in the backlog and reading the code is what fixed it.** The entry
  described a `tx.first()` defect for a week. `read`/`write` are immune on the normal path
  because they loop to `next.done` — that had to be READ, not inferred, and the entry said so.
- **Option B was designed and refused.** Making `pool.ts`'s reuse guard wait when
  `deferredChunk && stopped` would have covered the same four faces in one place, and cannot be
  forgotten by a seventh method. It loses on three counts: the discriminator holds only by an
  execution order established three layers away; the wait would be attributed to the innocent
  next statement rather than the culprit; and it sits before `runQuery` destructures its
  options, so the caller's own `signal` could not cut it. **Do not re-propose it without
  answering those three.**
- **The first version of the fix deadlocked, and only a boundary test found it.** Waiting
  unconditionally parks a statement the guard REFUSED behind a query it never claimed — which,
  for a generator the callback dropped, only `closeOpenStatements()` will ever close. Hence
  `owesWait` — replaced on 2026-09-12 by `mark.posted`, which states the same rule as "only a
  statement that was posted owes the wait" (`mem:architecture`).
- **A generator the callback merely DROPS is not covered and cannot be.** Nothing signals a
  drop; from outside it is indistinguishable from a consumer who means to come back to it. It
  still raises `GENERATOR_ABANDONED`, and that is now the only remaining trigger inside a
  transaction along with a deliberate overlap — which keeps the error reachable and its message
  true. The failure is clean and pinned: no eviction, rollback intact, client still serving.
- **Two comments in the repository were false and the measurement is what caught them.**
  `closeOpenStatements()` and `API.md` both said a transaction carrying no `signal`/`timeout`
  passes `abortable: false`. A transaction statement is ALWAYS abortable. What decides whether
  a running `step()` can be cut is the BUILD: the `sync` build without cross-origin isolation
  installs no progress handler at all. Both were corrected with the numbers.

**What it does NOT deliver.** The dropped generator above. And on the `sync` build without
isolation, a statement ending early waits for the current `step()` to finish — 360 ms on a
deliberately pathological query, `drainTimeout` at worst, with the write lock held. `API.md`
says exactly that, and no longer says anything about `signal`.

## The origin write lock — merged 2026-09-09

No spec and no plan: the design was settled in chat, in four steps the user validated one at a
time. Found by going looking for HANDLE-2 and finding something else.

**What it was.** A `transaction()` holds `bsq:write` for the whole of its callback — documented,
and the price of serializing writers across the origin. A callback that never returns held it
**for ever**: its lease is never released, so nothing released the lock, and every write in every
tab blocked with no error. `close()`, the only escape, terminated the workers, resolved, and left
the lock held. Deterministic, both engines, both VFS families. `mem:measurements`,
WRITELOCK-STUCK.

**Four things the code will not tell you:**

- **`PoolWorker.terminate()` is no longer the browser's method.** It poisons the transport
  first — see `mem:architecture`, which also carries the test-seam consequence. This is what
  turned "a statement after `close()` hangs for ever" into a rejection, and it is what let the
  transaction's fallback `ROLLBACK` fail instead of parking: that statement carries no signal by
  design, so nothing else could have reached it.
- **The asymmetry at `close()` is deliberate and the rule is durability, not transactions.**
  An ordinary write in flight is DRAINED, because each is its own commit and rejecting it would
  report failure for a row that landed — and on the `sync` build without isolation an abort
  stops the wait, not the work, so that lie would be routine. Nothing inside a transaction is
  durable before its `COMMIT`, so abandoning one misreports nothing. Stated in `API.md` under
  *Inside a transaction*.
- **Bounding the HOLDER was proposed and refused, and this is the only place that reasoning
  now lives.** A watchdog that abandons a transaction whose callback has gone quiet cannot
  work: a callback awaiting a slow but legitimate producer — an `output()` fed one row per
  `fetch` — and a callback stuck for ever are the same state seen from outside, and a single
  long statement is the mirror case. Any such bound kills sound work or misses dead work. The
  wait therefore stays unbounded by default and `timeout` on the waiting write remains the
  consumer's own choice. **Do not re-propose a default `transaction()` timeout: it caps exactly
  the long legitimate callback this refusal protects.**
- **A transaction left unawaited now surfaces an unhandled rejection** where it used to produce
  silence — it is in `CHANGELOG.md` under Breaking, and this repository's own suite had to be
  fixed for it. That is also how it was caught: `status` and `failedFiles` went red while every
  test passed, exactly as the baseline table warns.

**What it does NOT deliver.** Nothing bounds a stuck callback in a tab that stays open and never
closes. The victim's own `timeout` bounds the wait, closing the tab releases everything
(measured), and the timeout message now names whether this tab or another holds the lock — but
the holder is not policed, by decision.

## The abandoned generator — merged 2026-09-09, `ddd8270`

Design and its amendments A1-A5: `docs/superpowers/specs/2026-09-08-abandoned-generator-design.md`.
Plan: `docs/superpowers/plans/2026-09-08-abandoned-generator.md`. 25 commits, seven tasks, each
reviewed; two whole-branch reviews, three fix rounds. **Read the spec's amendments before the
spec** — two of its decisions were disproved by implementation.

**Four things the code will not tell you:**

- **The deterministic half is the one that matters.** The `FinalizationRegistry` is best effort
  and the documentation says so in those words; what makes the repair testable and bounded is
  that a `signal` or a `timeout` now runs the same teardown **at the abort**, not at the
  consumer's next pull. Every regression test is built on that half. D1 and D7.
- **`interrupt()` takes the transport it is stopping, and the argument is required.** Without it
  a late cleanup stops whatever the worker is running now — which silently truncated an
  unrelated query, 100 rows of 4000, bisected against `main`. Any new call site must name its
  transport; the type no longer lets it not.
- **A transaction closes the generators its callback left open**, interrupting the transport
  before returning them, because a method call on an async generator queues behind an in-flight
  `next()`. Getting that order wrong held the origin's write lock indefinitely.
- **`GENERATOR_ABANDONED`'s guard is structural.** It fires on "a query is already in flight on
  this worker", and its message leads with that rather than with a diagnosis — the premise that
  an abandoned generator is its only producer was checked and is false.

**What it does NOT deliver.** A generator abandoned while a `next()` is in flight is unreachable
by the registry until that `next()` settles — transient, and complementary to the leak, since a
worker with a request in flight is busy rather than stranded. And on the transaction path, a
generator abandoned with a `next()` outstanding and no `signal`/`timeout` costs up to
`drainTimeout` with the write lock held, then evicts the worker; that is written in `API.md`.

## Lot 10 — one `timeout`, eight methods — merged 2026-09-07

Design: `docs/superpowers/specs/2026-09-07-uniform-timeout-design.md`. Plan:
`docs/superpowers/plans/2026-09-07-uniform-timeout.md`. Eleven commits, five implementation
tasks, each reviewed; whole-branch review clean.

**It reverses D4 of the interruption design.** `timeout` was a budget of SQLite EXECUTION
time enforced inside the worker; it is now a **wall-clock deadline counted from the call**,
and it applies to eight methods rather than five. The generalization is what exposed the
problem: an execution budget does not extend to `transaction()`, `bulkWrite()` and
`output()` — none is one statement — and on the five it already had, a consumer writing
`timeout: 5000` had bounded nothing they could predict, since the clock only ran while
SQLite had the floor. Neither `timeout` nor `QUERY_TIMEOUT` had ever been released, so the
reversal cost no consumer anything.

**Four things the code will not tell you:**

- **The mechanism is that the abort REASON is the error.** `withDeadline` in `src/utils.ts`
  owns an `AbortController` and a `setTimeout` that aborts with the `SQLiteError` itself;
  `mergeSignals` relays a reason verbatim and every abort path already rejects with
  `signal.reason`, so there is no translation layer and nothing asks which signal fired.
  `AbortSignal.timeout()` is not used because it cannot carry a reason.
- **An external `signal` still rejects with `signal.reason`, verbatim — there is no
  `OPERATION_ABORT`, deliberately.** The rule is who owns the signal: a caller who supplies
  one already owns the rejection value, and the platform guarantees it comes back untouched.
  When the library creates the signal there is no caller reason to preserve. The asymmetry
  is that rule applied twice, not an inconsistency.
- **`timeout` and `signal` now share one limitation, by the user's decision (D6).** On the
  `sync` build without cross-origin isolation, `timeout` used to stop a running statement —
  a budget needs no channel, the worker reads its own clock — and now stops only the wait.
  That capability was removed knowingly; it was never released. It bought one table in
  `API.md` covering both options instead of a table plus an exception.
- **`errorCode` on the worker→client protocol lost its only producer** when
  `WorkerQueryTimeout` went. It is KEPT, with a comment saying so: the worker's check is
  structural, so it is the generic path by which a worker-minted code crosses the boundary,
  and it is the twin of the load-bearing `sqliteCode` branch beside it.

**One thing that happened and did not reproduce:** a `pnpm test` run hung on the Firefox
config for about two hours during task 2, then never recurred in any later run of the
branch. No report was emitted at all, which is itself the discriminator — an rstest timeout
produces a failure report, so a two-hour silence points at browser launch or the harness,
not at a test. Unresolved, and third in the queue above. The plan agreed on 2026-09-07:
`pnpm test:firefox` in a loop, wall-clock recorded per run, unattended — the normal band is
50-70 s, so 13 runs is about a quarter of an hour, and 13 is this repository's own bar, the
number that closed the `barrier` flake. All inside the band means a non-reproducing event and
this paragraph is the record. A recurrence gets captured with `DEBUG=pw:browser` to tell a
launch hang from a mid-suite one.

## Lot 9 — query interruption, merged 2026-09-05

`INTERRUPT-1` is closed. `timeout` is a per-query budget of SQLite EXECUTION time, on every
build with no isolation; `signal` now stops the statement itself, not only the wait. Design
and its decisions: `docs/superpowers/specs/2026-09-04-query-interruption-design.md` §5.
Numbers: `mem:measurements`. Merge `a06c349`, 20 commits.

**Three things about it that the code cannot tell you:**

- **The capability is detected as `cross-origin-isolated`, never as COOP/COEP.** Any header
  that grants isolation works, including `Document-Isolation-Policy`, which is Chromium-only
  and which a consumer may adopt without this library ever learning its name. Do not
  "clarify" the probe by naming a mechanism.
- **`SharedArrayBuffer` and `Atomics` must stay OUT of the API list `LIB_FLOOR` reads in
  `scripts/render-vfs-matrix.ts`.** They are used only behind that probe. Listing them raises
  the published floor for an optional capability — the `structuredClone` trap, which would
  have cost Chrome 92 → 98 for an error *cause*.
- **A fourth rstest project now exists and it is deliberately the only isolated one.** The
  ordinary projects stay un-isolated because that is what consumers deploy, and one test
  asserts the degraded `sync` behaviour there. `server.headers` in an rstest config is
  silently ignored; the isolation comes from a `modifyRsbuildConfig` plugin, beside the one
  that already existed for the same reason.

**What it does NOT deliver:** on the `sync` build without isolation — `OPFSWriteAheadVFS`,
`OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS` by default — a `signal` still stops
the wait and not the work. Those four accept `build: 'async'`, which is the escape hatch
that costs no hosting change. The README says all of this in one table.

## The documentation — three pages, reworked in full on 2026-09-08

`README.md`, `API.md` and `VFS.md`, on `main`. The split happened 2026-09-07; the whole
rework of the three pages happened 2026-09-08, in two commits plus a merge. **Six things the
files do not say about themselves:**

- **The recommendation is documentation and no longer lives in `src/`.** `RECOMMENDED_VFS`
  was an unexported constant in `src/types.ts`; it is now a two-element list in
  `scripts/render-vfs-matrix.ts`. Three `INVALID_OPTION` messages used to ship a VFS name to
  consumers in a string — they now point at `VFS.md` and the bench page and name none. A test
  pins that: the message must contain no key of `VFS_CAPABILITIES`.
- **The generator writes BOTH pages.** `scripts/render-vfs-matrix.ts` owns fourteen spans in
  `VFS.md` and one in `API.md` — the shared-store list in `deleteDatabase`'s warning. Its
  name says `vfs-matrix`; it has not been only that since 2026-09-08.
- **`VFS.md` has FOURTEEN generated zones, not two.** Counted 2026-09-08 with
  `grep -c 'BEGIN GENERATED' VFS.md`, which is how to re-check it; this file said eleven
  until then. The VFS table, the build table, one
  BEGIN/END pair per VFS for its header block, the footnotes, the shared-store list inside a
  blockquote, and the contents list. `pnpm docs:vfs` fails loudly if a marker pair is missing.
  The contents list is built from the headings present, so renaming a section moves its entry.
- **Two footnote systems, deliberately.** GFM footnotes were dropped for plain HTML
  (`<sup><a href="#fn-N">[N]</a></sup>` + `<sub>`) because GFM renders a note shared nine
  times as `1`, `1:2`, `1:3`. Identical note texts are folded on their TEXT, so the two Memory
  VFS share one. The muted grey of GFM's footnote block **cannot** be reproduced — GitHub
  strips `style` and custom `class` — and the generator says so; do not go looking again.
- **`VFS.md` entries carry no comparison between VFS (user, 2026-09-08).** An entry describes
  its VFS, its characteristics and its limits. Ranking belongs to *Recommendations* and to
  the *If you can guarantee a browser* table, and duplicating it per entry could only diverge.
  The word "upstream" is banned; say "wa-sqlite".
- **No measurements in the three pages (user, 2026-09-08).** Repeatedly enforced: the
  `poolSize` startup numbers, the statement-cache percentages, the `build: 'async'` factor,
  "102 of 104 browser tests on Firefox" — all removed. Constants of the code are not
  measurements and stay: `DELETE_TIMEOUT = 30_000`, the 32-statement cache, `SQLITE_MAX_VARS`.
- **Method sections share one shape:** presentation sentence, example, options table, prose.
  The table says what an option IS; effects go below it. `createSQLiteClient` is the one
  exception, with a sentence before its table explaining why `vfs` has no default.

**Cross-references were verified on 2026-09-08**: 205 links across the three files, markdown
and HTML, all resolving. Nothing keeps them that way — there is no link checker in CI.

## `poolSize` defaulted to a number the caller never chose — fixed 2026-09-08

`feat/pool-size-default`, one commit plus merge `add17b9`, outside the rc.5 lots. `poolSize`
resolved to `DEFAULT_POOL_SIZE` (2) unconditionally while the guard below rejected anything
above the VFS's cap, so `createSQLiteClient(name, { vfs: 'MemoryVFS' })` — with no other
option — threw `INVALID_OPTION` at construction, on the four single-connection VFS. A test
pinned that behaviour and its own comment called it a footgun.

The default is now `Math.min(DEFAULT_POOL_SIZE, capability.maxPoolSize ?? DEFAULT_POOL_SIZE)`.
**Only the default moved**: an explicit oversize still throws, and still names the size to
set. Resolution of `vfs`/`capability` had to move above the pool block, since `abortSlots`
sizes its `SharedArrayBuffer` from `poolSize`.

**The two lots of 2026-09-08 were not separable at hunk level**, and that is worth knowing
before attempting the same split again: the doc lot removed `RECOMMENDED_VFS` from
`src/types.ts`, which the pre-fix `src/client.ts` still imports, so a fix-only commit did not
typecheck until `types.ts` was also at HEAD. The way through was backing the five files up,
resetting to HEAD, re-applying the four fix edits, committing, restoring. Nothing was stashed.

## The dropped chunk — fixed on `main` 2026-09-04, outside the rc.5 lots

Found by the query-interruption lot's first task and fixed on its own branch from `main`,
deliberately: a released data-loss defect should not ride inside a feature branch, and the
user stopped the lot to take it first. `fix/dropped-chunk`, two commits, merge `e83d9b5`,
reviewed on the whole branch before merging. What it was and what it measured:
`mem:measurements`; what it teaches about testing a streaming API: `mem:lessons`.

## rc.5 so far: nine lots, merged 2026-09-02 to 2026-09-05

Five branches, each merged into `main` with `--no-ff` and verified on the merged result; all are
deleted and no stale ref remains. Lots 1-3 rode one branch — the user judged them three faces of one
feature and accepted a larger whole-branch review for it; lot 4 had its own, lots 5 and 6 shared
one, and lot 7 had its own. Each was verified
against the baseline table above, which is the only place that table lives.

**Not pushed.** `main` sits ahead of `origin/main`, which is normal here.

**Read the specs, not a summary** — lots 1-4 and 7 have one each in `docs/superpowers/specs/`, dated
2026-08-31, 2026-09-02 and 2026-09-03, and four carry amendments made during implementation. **Lots 5 and 6 have no
spec**: bounded, brainstormed in chat, and their whole case is the measurement campaigns in
`mem:measurements`. Lot 7 also has a plan in `docs/superpowers/plans/` — the only lot that does.

1. **Cross-tab coordination.** Writes serialize across every client and tab; read-your-own-writes
   holds across tabs on every VFS but `IDBMirrorVFS`. Mechanism and invariants: `mem:architecture`.
2. **The connection lifetime lock.** Every client holds `bsq:conn:<ns>:<file>` for its life —
   shared normally, exclusive where `exclusiveConnection` is declared, absent on the memory VFS.
3. **`deleteDatabase` reports.** `DATABASE_IN_USE` when a client holds it, `DATABASE_NOT_FOUND` when
   nothing is there. Two new public error codes.
4. **The statement cache is bounded in bytes**, 8 MB per worker, alongside the 32-entry bound it
   keeps. Internal only — no option changed. **It buys a ceiling, not a saving**, and the CHANGELOG
   says so in those words: one `bulkWrite` retained ~3 MB before and retains ~3 MB after. What was
   unbounded is an application accumulating many large templates.
5. **Per-VFS default PRAGMAs**, declared in `VFS_CAPABILITIES.defaultPragmas` and generated into
   the README's VFS table. Exactly one VFS clears the bar — `AccessHandlePoolVFS` gets
   `locking_mode=exclusive` + `journal_mode=wal`, ~4.7x on write-transaction overhead, measured.
   **Consumer pragmas are MERGED over the defaults, not substituted**, so setting `foreign_keys`
   no longer costs a default nobody knew was there; naming a key is how one is refused.
6. **COOPSYNC-BUSY fixed.** A read reported busy by SQLite is retried once, closing a defect
   where `OPFSCoopSyncVFS` surfaced a step of its own handle-transfer protocol as a failure —
   one ordinary read per session, early, **on both engines at the default `poolSize`**. The
   discriminator is `sqliteCode`, not a VFS name, so a `BUSY` this library raises to mean
   "stop" still fails fast. `stream()` and `chunk()` retry only before a row has been delivered.
7. **Database inspection.** `inspectDatabase(file, { vfs })` and `db.inspect()` report who is
   live on a database across the origin — clients, tabs, and the write lock's holder with the
   count of writers queued behind it — **without opening it**, which is the point: the question
   arrives from code holding no client. Read on demand, never maintained; each client holds an
   uncontended liveness marker `bsq:client:<ns>:<file>:<uuid>:<vfs>:<label>`. Plus five readonly
   getters on the client (`id`, `name`, `file`, `vfs`, `build`) and `UNSUPPORTED`, a new public
   error code. `db.debug.name` changed value — breaking.

8. **The benchmark page measures the VFS, and says what it could not establish.** Its dataset
   fitted seven times inside SQLite's page cache, so several read rows were timing the cache
   rather than storage; at 100 000 rows they reach the VFS, and every `—` cell went away
   (the cause was the clock, not the dataset — reads are now timed in groups). The pre-run
   sweep is bounded per operation and reports what it could not remove, in the page and in
   the export, which added `sweep`, `opfsRootAtStart` and `preview`. Two rows are new: an
   overwrite workload, the one shape every other write row here was missing, and
   `reads-during-long-query`, a verdict rather than a ratio — **it is the first per-VFS
   evidence for HANDLE-1**, and it immediately falsified three README claims
   (`CHANGELOG.md`, Documentation). Numbers and the four-platform campaign:
   `mem:measurements`. **No `src/` change.**

**Three consumer-visible behaviour changes, all from lots 1-3 and all in `CHANGELOG.md` under
Breaking:** two clients
writing at once no longer produce `BUSY` (the second waits); a refused deletion reports
`DATABASE_IN_USE` where it reported `WORKER_CRASHED` or nothing; and **deletion is no longer
idempotent**. **A fourth arrived with lot 7:** `db.debug.name` now carries the client name with
its index (`"SQLite 1"`) where it carried the bare `name` option — a value identical for every
client that passed nothing, so it identified nothing even inside one tab, and it had no reader
anywhere in the repository.

**What it does NOT deliver, and the README says so:** reads still wait on the rotated exclusive OPFS
handle wherever `readwrite-unsafe` is missing. `IDBMirrorVFS` gains nothing cross-tab.
`OPFSCoopSyncVFS`'s stalls are untouched. And deleting through the wrong VFS is still destructive
(in rc.5 — rc.6's per-VFS folders end it, `mem:vfs` CROSS-VFS)
within the `opfs-path` family — that family shares one file, which is measured and now carries a
README warning.
