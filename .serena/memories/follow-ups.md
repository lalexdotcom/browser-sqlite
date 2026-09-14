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

## `OPFSCoopSyncVFS` writes can fail with the handle-transfer BUSY between clients (2026-09-14)

Found while rewriting `coopsync-retry.test.ts` for the one-worker cap (`fix/pool-environment-cap`,
Task 11): two `OPFSCoopSyncVFS` clients on one file, constructed together, make a **write** fail
with the `SQLITE_BUSY` its `jLock` returns while a handle transfer is in flight — reproducibly, on
both engines. COOPSYNC-BUSY retries a read once (and `stream()`/`chunk()` before their first row);
nothing retries a write. Two clients is what two tabs are. Pre-existing; the branch lowered the
odds, since a client now runs one CoopSync worker. **Reliability by the triage rule, so an rc.5
candidate; not scheduled** — logged on the recommendation at the 2026-09-14 closure, the user not
having ruled on it. The question to answer first: is retrying a write safe? A BUSY at `xLock`
precedes the statement, but inside a transaction it is another matter, and the origin's write
lock is held meanwhile. The test's header names the shape it avoids on purpose.

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

- **On Safari, `IDBBatchAtomicVFS` long reads slow down run after run, after writes.** ~1.6 s
  cross-joins ran 1.6, 1.6, 3.7-10, then 33-35 s in succession, at `poolSize` 1 as at 4, new SQL
  text or not, with point reads between them unaffected (IDB-SIGNAL, `mem:measurements`). On the
  rc.4 page too, so pre-existing; Chromium and Firefox never showed it. Cause unknown — what grows
  with each long statement is the question. A consumer would meet it as long reads that suddenly
  take tens of seconds. Not scheduled.
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

## `SQLITE_FULL` reaches the client with neither `code` nor `sqliteCode` (2026-09-10)

Seen in TX-M1 (`mem:measurements`): a caught INSERT failing with *database or disk is full*
arrived as an error whose `code` and `sqliteCode` were both undefined. `BUSY` keeps its
numeric code through `busyFromCode`; other SQLite result codes may not reach the client as a
`SQLiteError` at all. Verified from the code on 2026-09-11, and broader than the title: the worker sends
`sqliteCode` for every SQLite error (the query case of `src/worker/worker.ts`), but `workerError`
in `src/pool.ts` keeps it only for `BUSY`/`LOCKED` — a constraint violation, `FULL`, `IOERR`,
`READONLY` all reach the consumer as a plain `Error`, told apart only by the message. **Reliability
by the triage rule, so an rc.5 candidate; not scheduled.** The shape discussed and not decided: a
`SQLiteError` with a new public code carrying `sqliteCode`.

## The pre-commit hook — three hooks since 2026-09-11 (user)

Decided and installed on 2026-09-11, in `package.json` under `simple-git-hooks`:

- `pre-commit` — `tsc`, then `lint-staged`, then the unit project: ~1.5 s. **While concluding a
  merge that stopped on a conflict** (`MERGE_HEAD` exists) it runs `pnpm test` instead of the
  unit project, because the commit that concludes such a merge fires `pre-commit` and never
  `pre-merge-commit`.
- `pre-merge-commit` — `tsc`, `biome ci .`, `pnpm test`. Every merge here is `--no-ff`, so
  every merge into `main` pays the full suite.
- `pre-push` — the same, as the backstop for commits made directly on `main` before anything
  reaches CI.

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
