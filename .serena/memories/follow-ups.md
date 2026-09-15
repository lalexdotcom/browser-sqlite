# Follow-ups — the open backlog

One short entry each, and every entry OPEN. Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

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
SharedWorker cannot open a connection on the four VFS that matter (`mem:state`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

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

## `tx.savepoint()` returning a rollback callback — for rc.6 (user, 2026-09-11)

A feature, so rc.6 by the triage rule. Raised while settling rc.5's savepoint rule: three writes
in one `try`, the third times out — rc.5 keeps the first two, as SQLite does for any statement
error. A consumer who wants the three all-or-nothing without abandoning the whole transaction
needs a nested block; the user's shape is a `tx.savepoint()` that returns a callback rolling
back to it. Not designed. It will sit on the savepoint machinery merged on 2026-09-12 (`via`, `__bsq_sp`,
`mem:architecture`): a new entry point must go through the facade, which concludes the library's
savepoint before opening its own.

## `db.ready` — a promise for the pool's startup, for rc.6 (user, 2026-09-13)

A feature, so rc.6 by the triage rule. Raised while designing the environment pool cap:
`db.poolSize` is exact once every worker has opened or declined, and nothing public signals that
moment — only a query that went through the scheduler's startup gate. Shape agreed in chat, not
designed further: a property `db.ready: Promise<void>`, not an `onReady` option — it resolves
when the gate opens, rejects with `failClient`'s error on a total startup failure and with
`CLIENT_CLOSED` on a `close()` before it, and carries an internal `.catch` so a consumer who never
reads it sees no unhandled rejection. It derives from the scheduler's `gateDeferred.promise`.
Once it exists, `db.poolSize`'s contract becomes "exact once `db.ready` resolves".

**The bench's column header waits for it too (user, 2026-09-14).** It shows the declared
`poolFor` today, and the burst row divides its ideal gain by it — 4 for `OPFSAdaptiveVFS` on
Firefox and Safari, which run 1. Once `db.ready` exists the header shows the requested `poolSize`
→ the effective `db.poolSize`, when they differ. The export already records `db.poolSize`.

## Default to the first build the environment supports — `jspi` before `async`, for rc.6 (user, 2026-09-14)

A behaviour change, so rc.6. `defaultBuildFor` returns `builds[0]` whatever the engine, and the
client then refuses a build the engine lacks (`missingFeature`, `src/client.ts`) — so merely
listing `jspi` first would break every engine without JSPI, Safari 26 included. The agreed shape:
list `jspi` before `async` for the five `async`-first VFS (`OPFSAdaptiveVFS`,
`IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS`, `MemoryAsyncVFS`) and resolve the default
as the first declared build whose `BUILD_REQUIREMENTS` `detectFeatures()` meets; `async` stays the
fallback. The `sync`-first VFS do not move.

**Why:** Safari's Asyncify slowdown (IDB-SIGNAL, `mem:measurements`), which `jspi` escapes on
Safari 27. On Chromium and Firefox the bench corpus says `jspi` is equal or faster — full scan
×0.41-0.66, list page ×0.40-0.86, bulk insert ×0.72-1.04 — except two Chromium IDBBatchAtomicVFS
rows: single write ×1.18 (3.0 → 3.55 ms) and 500 UPDATEs ×1.13 (median of 10 exports each).

**To do:** the resolution everywhere `defaultBuildFor` is called (client, worker, `deleteDatabase`);
a test of the no-JSPI fallback; the stale JSDoc at `src/client.ts` ("JSPI is Chromium-only" — VFS.md
says Firefox 153+, Safari 27+); `VFS.md`; a CHANGELOG entry, the default changing. **Check first:** a
consumer who passes one `.wasm` URL without `build`. **Measure first:** `OPFSAdaptiveVFS` on `jspi`
on Safari 27, the pair whose default would change for the most consumers.

## The rstest/Firefox silent hang — priority, it threatens CI (2026-09-15)

Three sightings in ~15 full Firefox runs in one afternoon: the build completes, then nothing — no output,
Firefox content processes at 0 % CPU, machine idle. The per-test timeout is 30 s, so the hang is OUTSIDE a
test body (cleanup, `onTestFinished`, a file transition) — **not established**. The first sighting was on
the untouched tree (`e5d0152`), so it predates the second-client branch; two target projects per engine
make it likelier. `pnpm test:matrix` bounds each run and reports the cell as timed out; `pnpm test` does
not, so a hook or a CI run can sit for ever. To chase it: a single-file Firefox run under the sixteen busy
loops (ABANDON-WEDGE's method), and rstest's own reporter rather than the agent one.

## What the full matrix found, and nobody has triaged (2026-09-15)

Numbers and grouping in `mem:measurements`, MATRIX-1. Open work, in the order that costs least:

- **A test-infrastructure defect:** `createTestClient` never closes its client and removes OPFS entries by
  name, which frees no slot in `AccessHandlePoolVFS`'s pool — ~40 `WORKER_CRASHED` per cell there come
  from the previous test's client still holding the database.
- **Three probable product defects:** `IDBBatchAtomicVFS` hangs on an abandoned write through `tx.first()`
  inside a transaction (both engines); `IDBMirrorVFS` fails 11 tests with `database disk image is
  malformed`; `OPFSCoopSyncVFS` answers `DATABASE_NOT_FOUND` to one `deleteDatabase` of a database the
  test created. Each needs a diagnosis before a fix, as `output()` did.
- **Tests that assume what they do not declare:** a pool of two workers, shared storage, persistence, a
  raw OPFS file. The `Need` vocabulary would grow by `shared-storage`, `persistent` and `opfs-file` — the
  list grows by decision, and the user has not taken it.

## Mixing VFS of the `opfs-path` family on one database (2026-09-15)

Measured while the second-client guard was built: on Chromium an `OPFSAdaptiveVFS` client beside a LIVE
`OPFSWriteAheadVFS` client opens and reads an **empty** database (`no such table`) — WriteAhead's writes
live in its own `-wa0`/`-wa1` files; on Firefox it waits while WriteAhead holds `bsq:conn` exclusively,
then gets `WORKER_CRASHED` once that client closes. **Not measured:** the successive shape (WriteAhead
writes, closes, another VFS reopens), where the same write-ahead files are the reason to fear a stale
read. CROSS-VFS (2026-09-02) already showed deletion through any member destroys the others' data.

**The user's idea, on the table:** a short per-VFS prefix in the file name, which would make "one database,
one VFS" true by construction, as it already is for the `idb-store` and `opfs-pool` families. Its own
branch: the migration of existing databases is the design's core (rc.4 is published under `latest`), and
the prefix spends part of wa-sqlite's 56-character path budget.

## Smaller things this branch left open (2026-09-15)

- A **refused client still appears in `inspectDatabase().clients`** until it is closed —
  `AccessHandlePoolVFS` behaved that way before the branch too.
- **Interrupt latency differs per pair:** `OPFSWriteAheadVFS/async` cuts an abandoned write at ≈0.6 of its
  natural length on Chromium where `OPFSAdaptiveVFS/async` cuts below 0.5. `tx-savepoint` T3/T4's bound was
  widened to `natural * 0.8` for it; nobody has measured the others.
- **`handleDeath`'s guard for a slot-0 loss before the probe has no test** — no path was found that reaches
  it with the probe unanswered; it is defensive (`a0373c0`).
- **Three tests of `multi-client.test.ts` carry no falsifier** (their claims were run and refuted): "never
  refuses a read-only transaction opened under a writer", "gives back a usable client after a transaction
  is aborted mid-contention", "commits at most one more batch after a bulkWrite is aborted". Their comments
  now say what was tried. Whether to find a real falsifier or delete them is the user's call.


## Three browser tests guard less than their comments said (2026-09-14)

Found by `fix/pool-environment-cap`'s Task 10 and its reviews:

- **`barrier.test.ts` does not guard the barrier.** Deleting `BARRIER_SQL` in `applyBarrier` leaves
  it green on `OPFSAdaptiveVFS` (Chromium, real multi-connection) and on `OPFSAnyContextVFS` alike —
  pre-existing, not caused by the migration (checked by the task reviewer).
- **`long-query.test.ts`'s `interrupt()` falsifier was already inert at 14be4ee**, on Adaptive.
- **Concurrency D-09 has no falsifier by construction.** Every VFS with an exclusive handle now runs
  one worker per client where that matters, so a second worker never reaches the init lock, and
  `OPFSAnyContextVFS` opens two connections at once without harm. The lock still serialises opens
  across clients and tabs; a two-client test is what would guard it. Its comment says so.

## What the `IDBBatchAtomicVFS` long-statement fix left open (2026-09-14)

- **On Safari, wa-sqlite's `async` (Asyncify) build slows down after a few long statements, and
  stays slow.** Measured 2026-09-14 on Safari 26.6.2 (IDB-SIGNAL, `mem:measurements`): after four
  ~1.5 s reads, `IDBBatchAtomicVFS` and `OPFSAnyContextVFS` ran their fourth at 11-30 s, and every
  `async` column's cached full scan ran 8-17× slower afterwards; `MemoryVFS` on the `sync` build did
  not move. Not IndexedDB (a 32 MB cache changes nothing), not the library's yield (no signal in the
  probe, and rc.4 shows it). Pre-existing; Chromium and Firefox never showed it. **The `jspi`
  build escapes it** (Safari 27.0, flat long reads and a cached scan back at baseline), and on
  that Safari the bench's two `jspi` columns answer `true` where both `async` ones stay `null`.
  The library defaults to a VFS's first declared build (`defaultBuildFor`), which is `async` for
  `OPFSAdaptiveVFS` — a recommended VFS — `IDBBatchAtomicVFS`, `IDBMirrorVFS`,
  `OPFSAnyContextVFS` and `MemoryAsyncVFS`; `OPFSAdaptiveVFS` itself was not probed.
  The default build is decided for rc.6 (the entry "Default to the first build the environment
  supports"). Still open: saying it in `VFS.md`, and an upstream report (wa-sqlite or WebKit).
- **Whether a yielding statement lets a rotated OPFS handle move between clients.** HANDLE-1 says a
  long statement never returns to its event loop; an abortable one on `async`/`jspi` now does,
  every 100 000 VM ops. Unmeasured.

## wa-sqlite's `OPFSAdaptiveVFS.js` reads `FileSystemSyncAccessHandle.prototype` at module load (2026-09-14)

Line 9, unguarded, and it is bundled into the one worker file, so where the interface is missing no
VFS loads at all, memory VFS included: Playwright's Linux WebKit 26.5 failed every column's `opens`
with `TypeError: undefined is not an object (evaluating
'globalThis.FileSystemSyncAccessHandle.prototype')`. Safari on macOS has the interface, and
Playwright's Linux WebKit was set aside earlier for limits of this kind (user). Unmeasured whether
a consumer environment lacks it; an insecure context is the candidate. Pre-existing, not scheduled.

## A timed-out read on Firefox can leave the next query meeting `GENERATOR_ABANDONED`, under load (2026-09-14)

`query-timeout.test.ts :: rejects with OPERATION_TIMEOUT and leaves the client usable` failed once
in a pre-push `pnpm test` on a loaded machine, with "Worker 1 already has a query in flight".
**What 2026-09-15 established about that test** (CI-QUERY-TIMEOUT, `mem:measurements`): it ran on
`MemoryVFS`'s default `sync` build, which cannot cut a running statement without isolation, so the
query it timed out kept its worker for its whole natural length — 22 s on Firefox, 60 s loaded.
The follow-up read was racing a worker that was still busy. The test now runs on `async` and
bounds that read. **Not established:** whether the library itself can hand a query to a worker
still inside the previous one, which is what the message says — the lease should be held until
quiesce. Reliability by the triage rule; not scheduled. To chase it, reproduce on `sync` with the
busy-loop method (ABANDON-WEDGE) first.

## The pre-commit hook — three hooks since 2026-09-11 (user)

Decided and installed on 2026-09-11, in `package.json` under `simple-git-hooks`:

- `pre-commit` — `tsc`, then `lint-staged`, then the unit project: ~1.5 s. **While concluding a
  merge that stopped on a conflict** (`MERGE_HEAD` exists) it runs `pnpm test` instead of the
  unit project, because the commit that concludes such a merge fires `pre-commit` and never
  `pre-merge-commit`.
- `pre-merge-commit` — `tsc`, `biome ci .`, `pnpm test`. Every merge here is `--no-ff`, so
  every merge into `main` pays the full suite.
- `pre-push` — the same, as the backstop for commits made directly on `main` before anything
  reaches CI. Since 2026-09-15 it also runs CI's VFS table check, `pnpm docs:vfs && git diff
  --exit-code VFS.md` (user), after a hand edit inside a generated span of `VFS.md` failed the
  first CI run of rc.5 before it reached a single test.

Verified in a scratch repository: an ordinary commit, a clean `--no-ff` merge, a conflicted
merge concluded by `git commit` and by `git merge --continue`, and a push each fire the
expected hook and only it.

**The user's principle: the agent runs the full verification when it delivers; the hooks are
braces on the belt, not the gate** (`mem:conventions`). The full suite cost ~80 s per commit —
chromium+unit 19 s, firefox 49 s, isolated 12.5 s, measured 2026-09-11 — against under 2 s for
`tsc`, biome and the unit project together.

What the change gives up, knowingly: a browser-only regression on a feature branch surfaces
at the merge, not at the commit that caused it; a flake is sampled once per merge rather than
once per commit; a direct commit on `main` can sit red locally until the next push. And every
hook still checks the working tree, not the staged tree.

What the entry established before the decision, kept for its evidence:

- **What it has caught.** A one-in-eighteen Firefox flake at a closure, after every task
  review had passed (`mem:lessons`, "A pre-merge verification is not ceremony"); and a
  Firefox-only flake that CI alone had shown as noise for weeks, once the per-engine split put
  Firefox in the hook (`mem:lessons`, "A test that waits for a TRANSIENT state").
- **What it does not guarantee.** On 2026-09-10 commit `c2ef918` landed with a failing
  `tsc`, although the hook ends with `tsc`. Traced on 2026-09-11 from the implementer's
  transcript — full evidence in `.scratchpad/hook-forensics/c2ef918-timeline.md`:
  - **Nobody bypassed it.** No `--no-verify`, no `SKIP_SIMPLE_GIT_HOOKS` anywhere in the
    agent's commands. Its attempt at 15:11:52 was REFUSED by the hook's `tsc`.
  - **Its next attempt, started 15:13:40, was already a commit in `git log` at 15:14:05** —
    25 s in, when that hook's suite alone takes ~100 s; the captured output stops at the start
    of the suite. The hook cannot have reached `tsc`.
  - **Hypothesis, not proven:** the agent's tool cut or backgrounded the command mid-hook,
    and the hook exited without failing. The timeline file says how to test it in a scratch
    clone. If it holds, "the hook passed" is not evidence whenever the committer's shell can
    drop a long command.
  - Separately, the hook runs `tsc` against the WORKING TREE, not the tree being committed,
    and honours `SKIP_SIMPLE_GIT_HOOKS=1` and `$SIMPLE_GIT_HOOKS_RC` — two more ways a green
    hook can differ from a green commit. Only a per-commit check in a clean worktree proved the
    rest of that branch.
- **The hook file is rewritten by design, and that is harmless.** `"prepare":
  "simple-git-hooks"` reinstalls `.git/hooks/pre-commit` — same content — on every
  `pnpm install` and every `pnpm pack`, so `pnpm test:consumer` rewrites it (its first stage
  packs). A changed mtime on that file is not evidence of tampering: on 2026-09-10 at 15:02:52
  it was a subagent's unasked `pnpm store prune && pnpm install`; on 2026-09-11 it was the
  consumer smoke.

## Notes, with nothing to fix

### An abort through the shared slot reports `done`, not `error` — and that is right

The worker breaks out of its row loop rather than throwing, so the query ends with `done` and
the pool's `onServed` fires exactly as for a completed query. That looks like a
misclassification and is not one: `onServed`'s only effect is `slot.restarts = 0` in
`src/supervisor.ts`, and it means "this worker executed SQL and came back", which an
interrupted worker has just demonstrated. Withholding it would make the supervisor readier to
condemn a healthy worker. Raised by the final review of the query-interruption lot,
2026-09-05, and deliberately not changed.

### Twelve `any` remain in `src/`, and they are structural

The return type of the dynamic VFS and WASM imports inside their `satisfies`
constraints; the VFS instance, which upstream does not type (it declares only
`examples/tag.js`); `bulk.ts`'s `{ [K in KEYS]: any }` row shape, where `unknown`
breaks the `keys.map((k) => data[k])` indexing; and one overload dispatch in
`locks.ts`. Thirty-seven became twelve on 2026-08-31 and the remainder is not
worth chasing. **Re-count before citing this.**

**Kept deliberately, do not "clean up":** the no-op degradation branch in
`locks.ts`, unreachable in Node ≥ 21 and every current browser. Spec-mandated,
correct, zero maintenance.


### The library's floor is computed, not transcribed (2026-08-28)

`LIB_FLOOR` in `scripts/render-vfs-matrix.ts` is read from
`@mdn/browser-compat-data` (a devDependency) over a named list of the APIs the
published bundle uses, mobile columns from `chrome_android` / `safari_ios`
rather than inherited from desktop. The computed floors reproduced the
transcribed ones byte for byte, so the old numbers were right — they simply
could not stay right on their own. `bcdVersion` throws rather than guessing when
BCD gives `true` or `false` instead of a version.

**`FEATURE_SUPPORT`, right above it, is still transcribed by hand and cannot be
fully mechanised**: JSPI's `Safari: '27'` comes from a WebKit blog post, not from
BCD. Its "checked 2026-08-24" comment is load-bearing; do not delete it under the
impression that the file now reads everything from BCD.

**`structuredClone` was the trap.** It would have raised the floor from Chrome 92
to 98 — for an error *cause*. `cloneable()` now probes with `MessageChannel`
(Chrome 2, Firefox 41, Safari 5), which runs the same algorithm and throws the
same `DataCloneError`. The probe exists because a cause that cannot be cloned
makes `postMessage` throw *inside a catch block*, so the client receives no reply
at all and waits for ever. It lives in `src/worker/cloneable.ts` — pure, and
tested in Node, for the reason `statement-cache.ts` is.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome
86+, so a pre-86 engine cannot run the six OPFS VFS at all. What was built
instead is a classic ES5 script ahead of the module in the bench page that
watches for the module having started and, after 8 s, replaces the banner with
what is missing. It tests for the module *running*, not for syntax, so it also
covers a failed `dist/` fetch. Falsified by blocking that fetch, not reasoned
about.

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says
supported but gives no first version, the cell keeps `?` rather than adopting the
library's number — the true floor is at least that and may be higher.

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer.
`HAS_UNSAFE_HANDLES` stays on the page because it needs a worker and two access handles.

**The live rule: changing either copy obliges a review of the other, both directions.** The
page's row ids are normalized from the conformance `describe()` titles, so a row whose id
no longer maps to a `describe()` is the signal. Two places where the copies legitimately
differ and must **not** be aligned: the page returns `'blocked'` where invariant 6 logs a
`console.warn` and passes (a table has somewhere to render a third state, a suite does
not); and the page reopens the column's client after `survives-reopen` and `close-settles`,
because it runs every row against one client where the suite gets a fresh one per `it()`.

## Three things about the statement cache that no test can see

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".

**An abandoned statement's read transaction is unobservable.** `settle` resets the statement
on every non-error exit, and the reset is what ends its implicit read transaction. That an
aborted query leaves its statement cached and reusable **is** tested, with a verified
falsifier. That it leaves no read transaction open is not. With the reset removed, a second
client writing the same file still succeeds and a later read still observes it — in
`journal_mode=DELETE` and in WAL. Either the statement had already reached `SQLITE_DONE`
before the abort landed, or the lock goes back on some other path; nobody has established
which. **The prior question, if this is ever chased:** can the abort be made to land strictly
inside a `step()` that has not yet returned `DONE`? Until that is answerable, no assertion
here can discriminate.

**The one-query-per-worker invariant became load-bearing.** The cache needs no lock because a
worker holds one lease at a time. Before the cache, breaking that would have produced
confusing behaviour; now it is a `reset` on a statement another query is stepping. Nothing at
the place where someone would break it says so.
