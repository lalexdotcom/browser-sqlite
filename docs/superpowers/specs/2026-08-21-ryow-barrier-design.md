# Wave 4 — RYOW-1: the commit-propagation barrier

**STATUS: complete, awaiting user review. 2026-08-21.**

All six brainstorming sections are approved, plus two amendments raised during
review (§7, §8). The next step after review is the implementation plan, via the
writing-plans skill.

Branch: `feat/ryow-barrier`, to be cut from `main` at `f427018`.

Scope note: this document covers **RYOW-1 only** — making a read observe a
commit that a *different* worker performed. It does not cover cross-tab
visibility, mutual exclusion between clients, relaxing the writer stickiness, or
`COOP-1`. §9 lists each exclusion and where it is tracked.

## 1. What is broken, and the evidence this design rests on

A pool worker is a SQLite connection with a private page cache. Nothing is
shared between workers except the file itself.

A connection that has already read holds page 1 — the schema and the change
counter — and refreshes it only by opening a **real read transaction** on the
file. When another worker commits, a connection that never re-opens such a
transaction keeps serving from a page 1 that predates the commit while reading
data pages fresh from the file. The result is an **incoherent** snapshot, not a
lagging one: the observed stale row is `{"old_col": 42}` — the new data under
the old column name.

Every claim below was measured on 2026-08-20 and is recorded in
`mem:follow-ups` under RYOW-1 block (4). None of it is re-derived here.

**Trigger.** Any earlier read on the connection that later serves the read.
`output()` guarantees one through its `navigator.locks`-guarded sweep, which is
dispatched to the lowest available index — exactly the index reads prefer —
while the writer designation lands elsewhere whenever worker 0 loses the ready
race. Verified in both directions: sweep short-circuited, 0 stale in 8 runs;
sweep disabled with one bare `db.read()` restored, 3 stale in 8. In the forced
configuration: primed 5/5 stale, unprimed 4/4 correct.

**Not the VFS, not the WASM build.** 40 runs, 40 stale, across four VFS and
three builds. `OPFSWriteAheadVFS` on the `sync` build behaves like
`OPFSAdaptiveVFS` on JSPI. The common factor is wa-sqlite itself. The barrier is
therefore permanent architecture, not a stopgap awaiting a better VFS.

**Prelude candidates, executed on the reading connection immediately before the
read, forced configuration.**

| Prelude | Result |
|---|---|
| *(none — control)* | 8/8 stale |
| `PRAGMA data_version` | 8/8 stale |
| `PRAGMA schema_version` | 8/8 stale |
| one event-loop turn (`setTimeout 0`) | 8/8 stale |
| 150 ms wait | 6/6 stale |
| `SELECT 1` | 6/6 stale |
| `SELECT * FROM out_replace` (the target table) | 6/6 correct |
| **`SELECT count(*) FROM sqlite_master`** | **6/6 correct** |

Three consequences fix the shape of the barrier:

1. A primed connection is not behind, it is **stuck**. Neither an event-loop
   turn nor 150 ms changes anything. Waiting is not a mechanism.
2. The statement that triggers the refresh **still returns the stale result**;
   the next one is correct. So the barrier must be a **separate statement**,
   whose result is discarded.
3. `SELECT 1` touches no page and does not qualify; a generic read of
   `sqlite_master` does. **The barrier does not need to know the query's
   tables** — which is what keeps it out of SQL parsing.

## 2. The model

Three notions, and that is the whole mechanism.

**The epoch `E`** — a monotonic integer, one per database, counting commits
performed *in this realm*. Its absolute value means nothing; only the comparison
matters.

**A worker's `seen`** — the value of `E` that this connection has absorbed.

**The invariant** — before a worker serves any statement, if `worker.seen < E`,
run the prelude and update `seen`.

No lock, no wait, no coordination: an integer comparison, and one discarded
statement only when it is due.

### 2.1 The three rules that keep it honest

**Capture `E` before the prelude, assign the captured value.** If another client
commits while the prelude is in flight, that commit was not observed by this
connection; recording it would be a silent lie.

**Every ambiguity resolves toward one prelude too many.** An extra prelude costs
one worker round-trip. A missing one serves wrong data. There is no case in this
design where the two are weighed against each other.

**A new worker starts at `seen = -1`.** A worker opens the file — and reads
page 1 — *before* it enters the pool. A commit can land in between:

```
t0   w1 opens the file        → its cache is at commit 5
t1   w0 (already ready) writes → E becomes 6
t2   w1 becomes ready, add()   → marking it seen = 6 would be false
t3   read on w1                → no prelude → STALE
```

This is the nominal startup ordering at `poolSize: 2`, not a rare race:
`createSQLiteClient` is synchronous, workers start in the background, and the
first query dispatches as soon as *one* worker is ready. Starting at `-1` costs
one prelude per worker lifetime and removes the entire class of reasoning about
when page 1 was last read.

### 2.2 Cost

After a commit, at most `poolSize` preludes in total — one per worker, at its
next use — then nothing until the next commit. Under sustained read-only load:
zero.

**Known worst case, stated up front.** Under an alternating `write / read` load,
the barrier costs a prelude on nearly every read: stickiness sends all writes to
one worker, so each commit leaves the *other* worker behind, and reads prefer
the lowest free index. In that shape the conditional design degenerates to the
cost of an unconditional one. Relaxing the stickiness (a later step) is what
mitigates this, not the barrier.

## 3. The epoch registry

### 3.1 Interface

```
epochsFor(file) → { current(): number, bump(): number }
```

Nothing else. A worker's `seen` lives on `PoolWorker`; the registry does not
know workers exist.

Both operations are **synchronous**. See §9 for what changes when a locks-backed
implementation replaces this one.

### 3.2 Identity: the normalized file name, and nothing else

**The key is `file` alone, not `(vfs, file)`.** Two clients opening `'data'`
under two different OPFS VFS target the same OPFS path, hence the same database;
splitting them would lose the guarantee. `'data'` in OPFS and `'data'` in
IndexedDB are genuinely distinct, and merging them costs only preludes. Error
direction decides it.

**The name is normalized once, at the entry of `createSQLiteClient`:**

```
file = new URL(file, 'file://').pathname
```

This is not an invention — it is what four of the five shipped VFS already do
internally (`OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `OPFSPermutedVFS`,
`IDBBatchAtomicVFS` via `new URL(zName, 'file://')`; `AccessHandlePoolVFS` via
`#getPath` with base `'file://localhost/'`, same `pathname`). Doing it at the
entry makes the normalized name the identity key for the epoch registry and every
lock name (`initLockName` inside the worker, `stagingLockName`, `sweepLockName`
on the client). The string handed to `sqlite3_open_v2` stays as the caller wrote
it: SQLite core checks `nPathname + 8 > mxPathname` (64,
`node_modules/wa-sqlite/src/VFS.js:10`) before `xOpen` — measured at task 1:
passing the normalized name broke all 96 browser tests on 56-char names.

| Input | Normalized |
|---|---|
| `data/file`, `./data/file`, `/data/file`, `data\file` | `/data/file` |
| `data/../file` | `/file` |
| `café`, `caf%C3%A9` | `/caf%C3%A9` |
| `data//file` | `/data//file` — *not* collapsed |
| `SQLite` vs `sqlite` | distinct — case is significant |

It is idempotent for all five VFS, and it fixes one live defect on the way:
`initLockName(file)` previously keyed on the raw string, so two clients spelling
the same file differently took different init locks and failed to serialize their
opens. This is now fixed worker-side: `initLockName(normalizeDatabaseFile(file))`
in `src/worker/worker.ts`.

The `OPFSWriteAheadVFS` `'./data'` defect (splits on `/`, keeps `.` as a segment,
calls `getDirectoryHandle('.')`, throws) is **not** fixed here: `sqlite3_open_v2`
receives the raw name, and `OPFSWriteAheadVFS` sees it. Fixing it requires
normalizing inside the worker before the open call, which the `mxPathname` budget
(64) does not allow without raising that limit.

**One behavioural caveat, and it is the only one.** A non-ASCII name on
`OPFSWriteAheadVFS` currently creates a file literally named `café`, where
normalization names it `caf%C3%A9` — as the other four VFS already do. An
existing database opened with *that* VFS under *that* kind of name would become
invisible. `OPFSWriteAheadVFS` was made public on the previous branch and has no
tests at all (VFS-COV), so exposure is negligible — but it is real and must
appear in the changelog.

One minor visible effect: lock names change shape, so during a hot upgrade an old
tab and a new tab would not serialize with each other. Locks hold no persistent
state; the effect dies with the reload.

### 3.3 Where the registry lives

A `Map` stored under `globalThis[Symbol.for('browser-sqlite.epochs.v1')]`.

`Symbol.for` uses the realm-wide symbol registry, so two *copies* of the module
— Vite pre-bundling in dev and re-bundling in prod, two versions in a pnpm
workspace, a dual ESM/CJS resolution — land on the same symbol and therefore the
same `Map`. This is what makes "two clients in one tab see each other" true by
construction rather than true when the bundler cooperates.

The `v1` suffix separates incompatible shapes. It is bumped **only** if the
shape changes, never per release — bumping it per release recreates exactly the
fragmentation it exists to prevent.

### 3.4 Lifecycle: entries are never removed

Deleting an entry when the last client closes would restart `E` at 0. A worker
still alive elsewhere with `seen = 5` would then read `5 > 0`, believe itself
current forever, and serve stale data. A counter that only goes up does not
reset.

Cost: one `string → number` entry per database name opened in the page. A
handful in real use; a few hundred over a test session, which uses a UUID name
per case. Kilobytes, in a realm that dies with the page.

## 4. The two hooks

### 4.1 Acquisition — one site

`acquireInstrumented` (`client.ts:434`) is already the single path taken by
`read`, `chunk`, `stream`, `first`, `write`, `transaction`, and by
`bulkWrite`/`output` through those.

```
lease  = await scheduler.acquire(kind)
target = epochs.current()                     // captured BEFORE
if (lease.worker.seen < target) {
    await exec(lease.worker, PRELUDE_SQL)     // fully drained
    lease.worker.seen = target                // only on success
}
return lease
```

The lease is already held, so nothing can interleave a statement on that
connection between the prelude and the real query. The lease — which existed to
stop two queries sharing a worker — supplies the atomicity of the pair for free.

The prelude goes straight through `worker.query`; it does not re-enter the
scheduler. It must be **fully drained**: it is the opening *and closing* of the
read transaction that refreshes page 1, not the dispatch. It is tagged in the
debug state as a barrier statement so traces stay readable.

`PRELUDE_SQL` is a single named constant, initially
`SELECT count(*) FROM sqlite_master` — the measured form. See §10.1.

### 4.2 The bump — after the commit, before the write resolves

**Not on lease release.** Release is asynchronous:

```js
} finally {
  void lease.worker.quiesce().then(() => lease.release(), () => lease.release());
}
```

`write()` resolves *before* `release()` runs, so an `await db.write(...)`
followed by `db.read(...)` would acquire before the increment, observe the old
epoch, and skip the prelude — reproducing the exact bug being fixed.

The bump is therefore posted **synchronously in the `finally`, before the
`void`**, at two sites: `write()` (`client.ts:551`) and `transaction()`
(`transaction.ts:137`). `bulkWrite` and `output` route through both and are
covered. A one-line helper called from each.

It runs in `finally`, so **also when the write failed**. A failed write committed
nothing and the increment is wasted; it costs a prelude, never an error.

**Rejected variant, recorded so it is not re-proposed.** Bumping at *acquisition*
of a write lease would centralize everything into §4.1 and is wrong: a worker
could run its prelude during the write — before the commit — mark itself
current, and serve a stale read afterwards.

### 4.3 The `seen` advance rule

Left as is, the worker that just committed pays a prelude on its next statement,
although it is the connection that performed the commit. At `poolSize: 1` — the
documented workaround, and what two tests are pinned to — that would be a
prelude on every single query.

```
target = epochs.current()      // §4.1
...
next = epochs.bump()           // §4.2
if (next === target + 1) worker.seen = next
```

The condition is what makes the rule safe under concurrent clients: if another
client committed during our lease, `next` skipped, our connection did not observe
that commit, and it stays marked behind. Without the condition we would mark
current a connection that is not — the only class of bug this design must make
impossible.

This rule is extracted as a pure function and unit-tested in Node (§6.1).

### 4.4 When the prelude fails

**It is never swallowed.** A silently failed barrier is worse than no barrier: it
serves stale data while claiming otherwise. The error propagates unchanged and
the caller's query rejects.

**`seen` advances only on success**, so the next attempt re-posts the prelude.
There is no state to repair.

**Worker death during the prelude** is the existing `onDeath` path: `remove(index)`
bumps the generation, the outstanding lease detects it is stale, the query
rejects, and the respawned worker enters at `seen = -1`.

## 5. The test seam and the writer policy

### 5.1 Why it is required

The defect only occurs when the writer is not the worker serving the read, which
happens by startup chance roughly 3 times in 10. A test that fails 30 % of the
time pins nothing, before or after the fix. Forbidding the writer designation on
index 0 makes the failing configuration deterministic: **8/8 stale** as a
control.

### 5.2 Shape: a predicate, not a numeric bias

The designation is set at three sites in `scheduler.ts`, with the rule implicit
and duplicated:

| Site | Current rule |
|---|---|
| `takeAvailable` (`write` branch) | lowest free index |
| `handOver` | the returning worker, if none is designated |
| `add` | the joining worker, if none is designated |

`handOver` and `add` carry the *same* writer-first branch, copied. It is
factored out — a targeted improvement to code this change already touches, not
an opportunistic refactor.

All three ask one question, so one predicate covers them:

```ts
canDesignateWriter: (index: number) => boolean   // default: () => true
```

- `takeAvailable` filters candidates through it, then takes the lowest index;
- `handOver` and `add`, when it refuses, do not serve the writer queue from that
  worker: they fall through to the reader queue, else to `available`.

The default accepts everyone, so **production behaviour is unchanged, line for
line**. The test injects `(i) => i !== 0`.

Documented at the definition: a predicate that refuses everyone leaves writes
queued indefinitely. It is a test tool, used with `poolSize >= 2`.

### 5.3 How the option enters

- `InternalSQLiteClientOptions = CreateSQLiteClientOptions & { __unsafeTestWriterPolicy?: (index: number) => boolean }`,
  declared in `scheduler.ts` — not reachable from `src/index.ts`, which exports
  only `./client` and `./errors`, so it appears in no published `.d.ts` and in no
  consumer's autocompletion. `CreateSQLiteClientOptions` is pulled in with
  `import type`, which is erased at build time and therefore creates no runtime
  cycle with `client.ts`.
- **One cast**, at the entry of `createSQLiteClient`: read, validate that it is a
  function, hand it to `createScheduler`. A non-function is ignored silently — an
  unsupported option must not be able to break a consumer.
- Tests import the type from `../../src/scheduler` and call fully typed, with
  **no `as`**.
- A comment at the read site states it is test-only, unsupported, and removable
  without notice. No mention in the README or in any JSDoc.

### 5.4 What it does not buy

The predicate covers *who may be the writer*. Relaxing the stickiness later also
needs to change *when the designation is released* — today, never, except on
worker death. This seam helps that work; it does not prepare it.

## 6. Testing

Every property is pinned by a test verified **by hand** to go red when the
property is removed, following the convention already in the suite
(`// Falsifiable: …` in `tests/browser/routing.test.ts`).

### 6.1 Node — pure, fast, no browser

**Scheduler.** The default predicate reproduces today's behaviour exactly
(regression guard); a predicate refusing index 0 makes `takeAvailable` choose
`w1`; `handOver` and `add` of a refused worker do not serve the writer queue but
do fall through to the reader queue. Degenerate case: when only refused workers
are free, the write **stays pending** — the wait is asserted, not an error.

**Registry.** Normalization (`data`, `./data`, `/data`, `data\file` → one entry;
`data//file` and case differences → distinct entries); monotonicity; and
**anti-fragmentation**: pre-seed `globalThis[Symbol.for('browser-sqlite.epochs.v1')]`
before loading the module and assert it adopts that registry instead of creating
one. Without this test, the property that survives a duplicated module copy is
invisible until it breaks in a consumer's build.

**The `seen` advance rule** (§4.3), as a pure function: `next === target + 1`
advances; `next > target + 1` does not. Two assertions, no browser — and the only
place in this design where an error yields wrong data rather than an extra
prelude.

### 6.2 Browser — the test that pins the barrier

Forced configuration (`__unsafeTestWriterPolicy: (i) => i !== 0`,
`poolSize: 2`), therefore deterministic: writer `w1`, reads on `w0`. The scenario
reproduces the identified cause — a read first on `w0` (what `output()`'s sweep
does), then the schema-changing write on `w1`, then the read that must observe
the new data.

Falsifiability is verified by hand before the test is considered acquired:
barrier removed, it must go red — the measured control is 8/8, so no tolerance is
granted.

### 6.3 Browser — the test that keeps the barrier conditional

After a write, a second read on the same worker must **not** post a prelude.
Barrier statements are counted through the existing `debug: true` instrumentation.

This test does not check correctness; it checks the design's reason to exist.
Without it, anyone could one day silence a flake by preluding unconditionally:
every other test would stay green and the conditional barrier would have silently
become an unconditional one, with its cost.

### 6.4 Browser — the guarantee the user set as the floor

Two clients in one tab on the same database: A writes, B reads, B observes. Plus
a variant where the two spell the file differently (`data` and `./data`), pinning
normalization end to end. Falsifiable by replacing the shared registry with a
per-client counter.

### 6.5 Acceptance criterion, not a test

**The two tests pinned to `poolSize: 1` return to the default pool size** —
`drops and replaces a pre-existing table with a different schema` and `does not
collect a staging table that is still in flight`. This is the real evidence that
the barrier works on the actual path rather than on a scenario written for it.
Protocol: 20 green runs, the same bar that was used to pin them.

## 7. Amendment 1 — `database is locked` becomes a typed error

Raised during review. In scope because the guarantee this branch ships makes the
multi-client pattern attractive, and its failure mode is currently
undiscriminable.

**Today.** wa-sqlite raises its own `SQLiteError(message, code)` with a numeric
SQLite result code (`sqlite-api.js:11`; `SQLITE_BUSY` = 5, `SQLITE_LOCKED` = 6).
The worker re-posts only `message` and `cause` (`worker/worker.ts:265`), so the
code is **dropped at the `postMessage` boundary**, and `pool.ts:223` can only
rebuild a bare `Error`. Discriminating a lock conflict from a syntax error
requires matching on `err.message`.

**Change.**

1. The worker carries `sqliteCode` when the caught error has one.
2. `pool.ts` mints `SQLiteError('BUSY', …)` for codes 5 and 6, preserving the
   numeric code on the error for anyone who needs to tell them apart.
3. **Everything else keeps today's shape** — a plain `Error` with SQLite's
   message. No other error changes type, so no existing consumer breaks.

One code added to `SQLiteErrorCode`: `BUSY`.

**It is not only the write path.** The conflict also surfaces at open — the
`openTimeout` message already says *"The database may be held under an exclusive
lock by another tab or another client"* — and on **reads**, because with no
default PRAGMA the database runs `journal_mode=DELETE`, where a writer blocks
readers. The mapping applies wherever SQLite reports 5 or 6.

**Not in scope, and named as such in the README:** there is no `busy_timeout`, so
a conflict is not waited on or retried; it rejects immediately. This amendment
makes that failure discriminable, not survivable. A default `busy_timeout` stays
a separate decision, which this error contract does not have to change.

## 8. Amendment 2 — a worker is never released with an open transaction

Raised during review, and it invalidates a premise of §4 if left open.

**The hole.** In `transaction.ts:127`, if `COMMIT` fails and the fallback
`ROLLBACK` fails too, the original error is preserved — the right choice — but
`done` stays `false` and **the transaction is still open on that connection**.
The lease is then released normally and the worker returns to the pool. Nothing
resets it.

**Why it matters here specifically.** A read inside an open transaction reads
that transaction's snapshot. The prelude would run, succeed, mark the worker
current, and the worker would still serve stale data. It is the only scenario
found in which this design lies silently.

**Decision: the worker is evicted.** When the fallback rollback fails, it is
treated as a dead worker — `remove(index)`, generation bumped, supervisor
respawns.

Rejected alternative: mark the worker dirty and retry the rollback at its next
use. That introduces a *dirty worker* state the barrier would then have to reason
about. Eviction removes the state instead of managing it, reuses machinery that
already exists and is tested, and yields a connection that is transaction-free by
construction — the barrier's assumption becomes an invariant rather than a
clause.

Accepted cost: a worker restart on a rare path, and a possible false positive if
the `COMMIT` in fact succeeded and the rollback fails with *"no transaction is
active"* — a needless respawn, harmless and rare.

## 9. What this does NOT fix

| Excluded | Why | Tracked in |
|---|---|---|
| **Cross-tab visibility** | The Web Locks lead (locks as a *registry*, not mutual exclusion: hold `bsq:epoch:<file>:<n>`, read the maximum via `navigator.locks.query()`) is better than `BroadcastChannel` — state, not delivery, so no in-flight message race. But its cost per acquisition is **unmeasured**, and `query()` is specified as a diagnostic snapshot. | `mem:follow-ups`, as an explicitly unverified lead with the measurement that settles it |
| **Mutual exclusion between clients' writes** | No integrity risk — the VFS takes real file locks and the loser gets `database is locked`. It is a robustness subject, not a visibility one; merging it here would make the next debugging illegible | W-multitab |
| **Relaxing the writer stickiness** | Already sequenced after the barrier, with its own test (a load mixing spread writes with concurrent readers) | resume plan, step 3 |
| **A `consistency: 'strict'` option** (unconditional prelude) | Nobody asked for it. `epochsFor` leaves it reachable without re-cutting anything | this document only |
| **A default `busy_timeout`** | Separate decision; §7 makes it possible later without changing the error contract | perf list |
| **`COOP-1`, `VFS-COV`, `RWU-1`** | Independent | `mem:follow-ups`, unchanged |

**A locks-backed registry is a drop-in on the read side only.** `current()` is
consumed at one site. `bump()` is not: a locks-backed bump becomes
**asynchronous**, so it can no longer sit in the write path's `finally` — it must
be awaited before the write's promise resolves, or a read issued right after
would observe a not-yet-incremented epoch. That re-plumbing is localized
(`write`, `transaction`, `bulk`), known in advance, and deliberately not paid
now.

## 10. Documentation

`README.md:215` and `README.md:228`, plus the JSDoc on `read` / `chunk` /
`stream` / `first`. The mechanism description already there is accurate; the
conclusion is what changes.

- **Guaranteed:** once a write has resolved, any read issued afterwards from any
  client **in the same tab** on the same database observes it, whatever the pool
  size.
- **Not guaranteed:** across tabs. Stated as an absence of a guarantee, with no
  promise of convergence — no bound has been measured, and announcing one would
  be inventing it.
- **Retired:** `poolSize: 1` and "read inside the same `transaction()`" stop
  being the answer for in-tab RYOW. They remain valid, they are no longer
  required.
- **Cost, shown:** one extra worker round-trip on each worker's first statement
  after a write; nothing under read-only load.
- **The new adjacent gap:** the guarantee makes "several clients on one database"
  attractive, while nothing serializes their writes. Concurrent writers can fail
  on a lock; the failure surfaces as `SQLiteError` with code `BUSY` (§7) and is
  **not** retried. True before this branch too, but nobody was invited to depend
  on the pattern.

**Untouched:** the README's per-VFS trade-off section, which is sequenced after
the stickiness work that will change what it says.

### 10.1 Two measurements owed at implementation time

**The prelude statement.** `SELECT count(*) FROM sqlite_master` against
`SELECT rowid FROM sqlite_master LIMIT 1`, six runs each in the forced
configuration; the cheaper one is adopted **only if it is 6/6**. `sqlite_master`
has its b-tree root on page 1, so the `LIMIT 1` form touches exactly the page
that must be re-read and nothing else — but the dominant cost of a prelude is the
`postMessage` round-trip, not the SQL, so the difference may well be noise.
Carried as a criterion, not as an intention: the current constant is the only
measured form.

**The saving.** A count of preludes under a read-dominated load, to put a number
on what the conditional barrier saves against an unconditional one.
