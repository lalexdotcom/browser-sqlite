# SQLite routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQLite decides read or write: `run()`/`all()`/`stream()`/`chunk()` take any single statement and are routed by a worker's verdict; `first()` alone refuses writes, in the worker; `read()`/`write()` go; multi-statement strings are refused.

**Architecture:** A pure classifier (`src/classify.ts`) turns what SQLite reports at prepare (`stmt_readonly`, `stmt_isexplain`, the authorizer's pragma/attach actions) into `'read' | 'write'`. The worker computes it at every prepare, guards on it (`refuseWrite`), answers `verdict` requests on a lane of their own, and steps a streamed write to its end before delivering it. The page keeps a per-client verdict memo, asks verdicts through a third scheduler kind served first, and routes on the answer.

**Tech Stack:** TypeScript, wa-sqlite (pinned, SQLite 3.53.0), Vitest (unit project in Node; browser projects through WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-10-26-sqlite-routing-design.md` — read it whole before any task; every decision here argues from it.

## Global Constraints

- Branch `feat/sqlite-routing`, main checkout `/workspaces/wsqlite`, no git worktree. Every commit checks the branch in the same command: `test "$(git branch --show-current)" = feat/sqlite-routing && git commit …`.
- Serena's symbolic tools are primary for code (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_*_symbol`, `replace_content`); Read/Edit/Grep on code only as fallback. Never `$1` in a `replace_content` replacement.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. `pnpm exec tsc --noEmit` before each commit; a failing hook is reported verbatim. After committing, `git log -1` and `git show --stat HEAD`.
- `pnpm check` after every modification. Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **A task marked breaking commits as `type(scope)!:` with a `BREAKING CHANGE:` paragraph of its own above `Co-Authored-By`.**
- Every commit lands green (unit project and the browser files the task touches). A failing test and the code that satisfies it belong to the same task.
- **An existing test that has to change is listed in the task's report with the reason**; each task names the ones it expects to change. Any other existing test going red: stop and report.
- **Every new test is falsified once**: a deliberate mutation of the code under test makes it fail; the mutation and its failure are recorded in the task report, then reverted.
- Unit: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit <file>`. Browser: `node scripts/test-plan.ts <files>` (both engines, both modes), `--mode all-pairs <files>` (every eligible pair). Long runs in the background, logged under `.scratchpad/sqlite-routing/`, never piped through `tail`; a progress line every two minutes.
- Comments state the fact in one or two lines. No counts in docs or comments outside measurements.
- Values the spec pins: memo `VERDICT_MEMO_ENTRIES = 256`, `VERDICT_MEMO_MAX_LENGTH = 4096` (characters); the error code `MULTIPLE_STATEMENTS`; the result property `rows`; `first()` refuses with `NOT_A_READ_QUERY`, a read-only transaction with `READ_ONLY_TRANSACTION`.

## Review Focus

- **The same unknown SQL issued concurrently** (`Promise.all` of ten `db.run(sql)` before any verdict is memoised) must give ten correct results and ask **one** verdict: the memo holds the in-flight promise. Pinned in Task 6.
- **A worker that dies while answering a verdict** must not hang the caller: the verdict rejects with the death's error and the call is asked again once on another worker, or fails with `WORKER_CRASHED`. Pinned in Task 5 (pool) and Task 6 (client).
- **A signal or `timeout` that fires while a call waits for its verdict** rejects with that reason and returns the verdict lease; `close()` while verdicts wait rejects them with `CLIENT_CLOSED`. Pinned in Task 6.
- **A streamed write abandoned right after it completed, before any row is read** keeps the write, releases the write lock at once and returns the worker after the delivery is cut. Pinned in Task 8.
- **`` sql`…` `` queries** are memoised under their rendered text, so two calls of one call site share a verdict and two different `sql.list` lengths do not. Pinned in Task 6.

---

### Task 1: The classifier, pure

**Files:**
- Create: `src/classify.ts`
- Modify: `src/utils.ts` (the pragma lists move out; `isReadQuery` imports them back until Task 10)
- Test: `tests/unit/lib/classify.test.ts`

**Interfaces:**
- Produces:
  - `export type StatementKind = 'read' | 'write'`
  - `export type PrepareFacts = { pragma?: { name: string; value: string | null }; attach?: true; explain: boolean; readonly: boolean }`
  - `export const classifyStatement: (facts: PrepareFacts) => StatementKind`
  - `WRITING_PRAGMAS`, `BARE_WRITING_PRAGMAS`, `INTROSPECTION_PRAGMAS` exported from here (moved, contents unchanged).

The rule is § The classification of the spec: a pragma is classified by the lists on `name` (lower-cased) and `value` (`value !== null` and name outside `INTROSPECTION_PRAGMAS` → write; name in `BARE_WRITING_PRAGMAS` → write; else read), and `stmt_readonly` is ignored for it; `attach` → write; else `explain` → read; else `readonly ? 'read' : 'write'`. A name in `WRITING_PRAGMAS` with a value is a write by the first clause already.

- [ ] **Step 1: Write the failing test** — a table-driven `it.each` over the measured facts of 2026-10-27, one row per case:

```ts
const cases: Array<[string, PrepareFacts, StatementKind]> = [
  ['SELECT', { explain: false, readonly: true }, 'read'],
  ['INSERT', { explain: false, readonly: false }, 'write'],
  ['EXPLAIN INSERT', { explain: true, readonly: false }, 'read'],
  ['PRAGMA journal_mode (bare, readonly 0)', { pragma: { name: 'journal_mode', value: null }, explain: false, readonly: false }, 'read'],
  ['PRAGMA journal_mode = wal', { pragma: { name: 'journal_mode', value: 'wal' }, explain: false, readonly: false }, 'write'],
  ['PRAGMA optimize (bare, readonly 1)', { pragma: { name: 'optimize', value: null }, explain: false, readonly: true }, 'write'],
  ['PRAGMA cache_size(10) (readonly 1)', { pragma: { name: 'cache_size', value: '10' }, explain: false, readonly: true }, 'write'],
  ['PRAGMA table_info(t)', { pragma: { name: 'table_info', value: 't' }, explain: false, readonly: true }, 'read'],
  ['PRAGMA TABLE_INFO(t) (case)', { pragma: { name: 'TABLE_INFO', value: 't' }, explain: false, readonly: true }, 'read'],
  ['PRAGMA user_version = 3', { pragma: { name: 'user_version', value: '3' }, explain: false, readonly: false }, 'write'],
  ['PRAGMA wal_checkpoint', { pragma: { name: 'wal_checkpoint', value: null }, explain: false, readonly: false }, 'write'],
  ['PRAGMA cache_size (bare)', { pragma: { name: 'cache_size', value: null }, explain: false, readonly: true }, 'read'],
  ['ATTACH (readonly 1)', { attach: true, explain: false, readonly: true }, 'write'],
];
it.each(cases)('%s', (_, facts, kind) => expect(classifyStatement(facts)).toBe(kind));
```

- [ ] **Step 2: Run it, expect FAIL** (module not found).
- [ ] **Step 3: Implement `classifyStatement` in `src/classify.ts`**, moving the three sets from `src/utils.ts` (their doc comments with them) and importing them back into `utils.ts`. `src/classify.ts` imports nothing; the worker bundle will import it.
- [ ] **Step 4: Run it, expect PASS; run the whole unit project** (`pnpm test:unit`), expect green with `tests/unit/lib/routing.test.ts` unchanged.
- [ ] **Step 5: Commit** — `feat(classify): classify a statement from what SQLite reports at prepare`.

---

### Task 2: The worker classifies every statement it prepares, and `first()` refuses writes there

**Files:**
- Modify: `src/worker/worker.ts` (authorizer, query path), `src/types/protocol.ts` (`SQLOptions.refuseWrite`), `src/pool.ts` (`PoolWorkerQueryOptions.refuseWrite`, forwarded), `src/queries.ts` (`firstWorker` forwards it), `src/client.ts` (`first`), `src/transaction.ts` (`checksql`, `first`)
- Test: `tests/browser/pairs/routing.test.ts` (new `describe('first() and a read-only transaction refuse writes in the worker')`)

**Interfaces:**
- Consumes: `classifyStatement`, `PrepareFacts`, `StatementKind` (Task 1).
- Produces:
  - protocol `SQLOptions.refuseWrite?: 'NOT_A_READ_QUERY' | 'READ_ONLY_TRANSACTION'`, and the same key on `PoolWorkerQueryOptions`.
  - In the worker, `kindOf(stmt: number, sql: string): StatementKind`, used by Tasks 3, 4 and 8.

What it does:
- The authorizer records, while a statement is prepared, `SQLITE_PRAGMA` (19: `operation` = name, the next argument = value or `null`) and `SQLITE_ATTACH`/`SQLITE_DETACH` (24/25), returning `SQLITE_OK` for them; its transaction-control behaviour is unchanged. The recorded facts are kept per SQL text beside the statement cache, **as `controlSql` is**, because the authorizer does not run on a cache hit; an entry goes when its statement leaves the cache (eviction, `markUncacheable`, `drain`), so the map stays bounded by the cache.
- `kindOf` reads `Module._sqlite3_stmt_readonly(stmt)` and `Module._sqlite3_stmt_isexplain(stmt)` (both exported by the three builds, not wrapped by `sqlite-api.js`) plus the recorded facts, and calls `classifyStatement`.
- With `refuseWrite` set, a statement classified `'write'` is refused **before its first `step`**, cache hits included: the worker throws an error carrying `errorCode` = the value of `refuseWrite` (the protocol's existing `errorCode` path), message `first() only accepts reads; this statement writes.` for `NOT_A_READ_QUERY` and today's `Cannot write in a read-only transaction.` for `READ_ONLY_TRANSACTION`.
- `client.first()` and `tx.first()` drop `assertReadable` and send `refuseWrite: 'NOT_A_READ_QUERY'`; every statement of a `readOnly` transaction sends `refuseWrite: 'READ_ONLY_TRANSACTION'` and `checksql` drops its `isWriteQuery` test. `read()`, `chunk()`, `stream()` keep `assertReadable` until Task 10.

- [ ] **Step 1: Write the failing tests** (browser, `routing.test.ts`, one `it` each, `t(a INTEGER PRIMARY KEY, b)` seeded with one row):
  - `first('PRAGMA optimize')` rejects `{ code: 'NOT_A_READ_QUERY' }` — the case the regex also refused, now refused by the worker (falsify: drop the pragma clause of `classifyStatement`).
  - `first("SELECT 'INSERT'")` resolves `{ "'INSERT'": 'INSERT' }`.
  - `first('EXPLAIN INSERT INTO t VALUES (9, 9)')` resolves a row (an opcode listing), and `t` still has one row.
  - `first('PRAGMA journal_mode')` resolves a row with a `journal_mode` key.
  - `first('PRAGMA table_info(t)')` resolves `{ name: 'a', … }`.
  - `first('PRAGMA cache_size = 5')` rejects `NOT_A_READ_QUERY`.
  - `first('INSERT INTO t VALUES (2, 2) RETURNING a')` rejects `NOT_A_READ_QUERY` **and `t` still has one row** (refused before `step`).
  - The same `first('INSERT …')` a second time (a cache hit) rejects the same way.
  - `transaction(tx => tx.write('INSERT INTO t VALUES (3, 3)'), { readOnly: true })` rejects `READ_ONLY_TRANSACTION` and `t` keeps one row; `transaction(tx => tx.read('SELECT \'DELETE\''), { readOnly: true })` resolves.
- [ ] **Step 2: Run** `node scripts/test-plan.ts tests/browser/pairs/routing.test.ts` — expect the `SELECT 'INSERT'`, `EXPLAIN` and readOnly-`SELECT 'DELETE'` cases to FAIL (the regex refuses them today).
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** the file with `--mode all-pairs`, then `pnpm test:unit`; expect green. Expected to change: unit tests in `tests/unit/lib/transaction.test.ts` that pin the page-side `READ_ONLY_TRANSACTION` throw (now a worker rejection) — list them.
- [ ] **Step 5: Commit** — `feat(worker): classify every prepared statement; first() refuses writes in the worker`.

---

### Task 3: Multi-statement strings are refused (breaking)

**Files:**
- Modify: `src/worker/worker.ts` (query path: detection, refusal; `isSingleStatement` and the multi-statement branch `live`/per-statement finalize and the binding `cursor` go), `src/types/errors.ts` (`MULTIPLE_STATEMENTS` in `SQLiteErrorCode` and its doc line), `src/types/protocol.ts` (`SQLOptions.multi?: true`), `src/pool.ts` (`PoolWorkerQueryOptions.multi`), `src/client.ts` (`applyBarrier` sends `multi: true`)
- Test: `tests/browser/pairs/params.test.ts` (the `describe('a multi-statement string')` block is replaced), `tests/browser/pairs/sql-tag.test.ts` (`binds each statement of a multi-statement string…` replaced), `tests/unit/lib/errors.test.ts` if it enumerates codes

**Interfaces:**
- Produces: `SQLiteErrorCode` gains `'MULTIPLE_STATEMENTS'`; protocol/pool option `multi` (internal, the barrier only).

Detection (spec § Multi-statement strings are refused): after preparing the first statement, prepare the tail; a tail that yields no statement is single; a tail that yields a statement **or an error** is a refusal — `errorCode: 'MULTIPLE_STATEMENTS'`, message `Only one statement per call; this string holds more.` — raised before any `step`, every prepared handle finalised, nothing cached. The verdict (Task 4) uses the same detection. `multi: true` (set only by `applyBarrier`, whose SQL is `PRAGMA x=1; <barrier>; PRAGMA x=0` on VFS with a catch-up pragma) keeps today's multi-statement execution for that message alone. A single statement keeps the cache as today; a statement followed only by `;`, whitespace or a comment is single and cacheable (today's text comparison made it uncacheable). **The library's own statements other than the barrier are single** — a transaction's `exec` (`BEGIN`/`COMMIT`/`ROLLBACK`), the `__bsq_sp` control, `bulk.ts`'s statements, `renderPragmas`' output: check each by reading its SQL; one that is not gets split, not flagged.

- [ ] **Step 1: Write the failing tests** (browser):
  - `params.test.ts`: `db.write('INSERT INTO t VALUES (1, 1); INSERT INTO t VALUES (2, 2)')` rejects `{ code: 'MULTIPLE_STATEMENTS' }` and `t` is empty; `db.write('CREATE TABLE n(a); INSERT INTO n VALUES (1)')` rejects the same and `n` does not exist; `db.read('SELECT 1; ')` and `db.read('SELECT 1 -- note')` resolve `[{ 1: 1 }]`.
  - `sql-tag.test.ts`: ``db.write(sql`INSERT INTO t VALUES (${1}, ${2}); INSERT INTO t VALUES (${3}, ${4})`)`` rejects `MULTIPLE_STATEMENTS`.
  - The barrier still runs on a VFS with a catch-up pragma: the existing `tests/browser/pairs/barrier.test.ts` is the test (unchanged, run in Step 4).
- [ ] **Step 2: Run** `node scripts/test-plan.ts tests/browser/pairs/params.test.ts tests/browser/pairs/sql-tag.test.ts`, expect FAIL.
- [ ] **Step 3: Implement.** Expected to change: the two multi-statement binding tests (removed with the feature).
- [ ] **Step 4: Run** the two files and `barrier.test.ts` with `--mode all-pairs`, then `pnpm test`; expect green.
- [ ] **Step 5: Commit (breaking)** — `feat(worker)!: refuse multi-statement strings`, `BREAKING CHANGE: a string holding more than one statement is refused with MULTIPLE_STATEMENTS before anything runs; the per-statement binding of anonymous parameters is gone.`

---

### Task 4: The verdict, in the worker and on the transport

**Files:**
- Modify: `src/types/protocol.ts`, `src/worker/worker.ts`, `src/pool.ts`
- Test: `tests/browser/pairs/verdict.test.ts` (new; reaches the workers through `interceptWorkers()` from `tests/browser/helpers`: `pool.ts` assigns the `PoolWorker` members onto the native `Worker`, so `(records[0].worker as PoolWorker).verdict(sql)` is the pool's method, and `record.posted` lists the message types sent)

**Interfaces:**
- Consumes: `kindOf` (Task 2), the multi-statement detection (Task 3).
- Produces:
  - protocol client message `{ type: 'verdict'; callId: number; sql: string }`; worker replies `{ type: 'verdict'; callId: number; kind: 'read' | 'write' | 'refused' }` or `{ type: 'verdict-error'; callId: number; message: string; sqliteCode?: SQLiteResultCode; sqliteExtendedCode?: number }`.
  - `export type Verdict = 'read' | 'write' | 'refused'` (in `src/types/protocol.ts`).
  - `PoolWorker.verdict: (sql: string) => Promise<Verdict>` — rejects with `STATEMENT_FAILED` (carrying `sqliteCode`) on a failed prepare, with the transport's poison reason on death.

What it does:
- **One SQLite call at a time in the worker**: the `query` and `verdict` handlers take a worker-local async mutex around every SQLite call sequence (the whole prepare-to-settle of a query between its yields is already one owner; a verdict takes the mutex for its prepare/classify/finalize). On the `sync` build the handlers never interleave; the mutex is what makes `async`/`jspi` safe.
- The verdict prepares (the authorizer runs, so transaction control is refused with `AUTH` → `verdict-error`), classifies, checks the tail, and runs nothing. **Cache:** a hit is classified without touching the handle; on a miss the statement is inserted in the cache only when `sqlite3_get_autocommit(db)` is 1 (no transaction open on this connection), otherwise finalised.
- Pool: its own pending map by `callId` (ids from the same counter as queries, so they never collide); no effect on `currentCallId`, the reuse guard, `deferredChunk`, `inTransaction`, `onServed` or the debug request. Death or `terminate()` rejects pending verdicts with the poison reason.

- [ ] **Step 1: Write the failing tests:** `verdict('SELECT 1')` → `'read'`; `verdict('INSERT INTO t VALUES (1, 1)')` → `'write'` and `t` stays empty; `verdict('EXPLAIN INSERT …')` → `'read'`; `verdict('PRAGMA optimize')` → `'write'`; `verdict('SELECT 1; SELECT 2')` → `'refused'`; `verdict('SELECT * FROM nope')` rejects `{ code: 'STATEMENT_FAILED', sqliteCode: 1 }`; `verdict('BEGIN')` rejects (authorizer); a verdict on a worker held by an open `transaction()` between two statements answers and the transaction's next statement then runs normally; a verdict on a worker terminated with `killSilently()` rejects.
- [ ] **Step 2: Run, expect FAIL** (`verdict` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `verdict.test.ts` with `--mode all-pairs`, then `pnpm test`; green.
- [ ] **Step 5: Commit** — `feat(worker): answer a statement's verdict without running it`.

---

### Task 5: A third scheduler kind, and the lease that steps down

**Files:**
- Modify: `src/scheduler.ts`
- Test: `tests/unit/lib/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `acquire: (kind: 'read' | 'write' | 'verdict', signal?: AbortSignal) => Promise<Lease<W>>`.
  - `Lease<W>` gains `borrowed?: true` (set only on leases from `offer`) and `demote: () => void`.
  - `offer: (worker: W) => boolean` on `Scheduler<W>` — serves the head of the verdict queue with a **borrowed** lease on a worker the scheduler does not own (a transaction's), returning whether it did; a borrowed lease's `release()` touches no availability.
  - `stats()` gains `verdict: number`.

Rules (spec § Routing by verdict, Ordering): verdict waiters are a FIFO served **before** writers and readers in `handOver` and `add`; a free worker at the call serves a verdict at once; a verdict lease never touches the designation (rule 1 applies). `demote()` on a lease whose worker holds the designation clears it and, if writers wait and a worker is available that `canDesignate`, designates it and serves the head writer; it is idempotent and a no-op on a lease without the designation; the worker stays leased.

- [ ] **Step 1: Write the failing tests** (unit, the file's existing fake workers): a verdict waiter is served before a queued writer and a queued reader when a lease is released; a verdict lease never sets the designation (a write acquired after it designates normally); `offer(w)` serves a waiting verdict and returns `true`, returns `false` with none waiting, and the borrowed lease's `release()` leaves `available` unchanged; a verdict waiter aborted by its signal is removed, as readers are; `shutdown` rejects verdict waiters; `demote()` on a write lease lets a queued writer be served on another available worker while the first stays leased; `demote()` twice is harmless; `stats().verdict` counts waiters.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit project, green.
- [ ] **Step 5: Commit** — `feat(scheduler): serve verdicts first; let a write lease step down`.

---

### Task 6: The memo and the routing, with `run()` and `all()` on the client

**Files:**
- Create: `src/verdicts.ts`
- Modify: `src/client.ts`, `src/queries.ts` (`writeWorker` returns `{ rows, affected }` under the new name `runWorker`; `readWorker` stays for `all()`'s read path), `src/api.ts` (`run`, `all`, `SQLiteRunResult<T>`), `src/transaction.ts` (`offer` on statement settle)
- Test: `tests/unit/lib/verdicts.test.ts`, `tests/browser/pairs/run.test.ts` (new)

**Interfaces:**
- Consumes: `Verdict`, `PoolWorker.verdict` (Task 4); `acquire('verdict')`, `offer`, `Lease.borrowed` (Task 5).
- Produces:
  - `createVerdictMemo(bounds: { maxEntries: number; maxLength: number }): VerdictMemo` with `VerdictMemo = { get(sql: string): Verdict | Promise<Verdict> | undefined; set(sql: string, v: Verdict | Promise<Verdict>): void; delete(sql: string): void; readonly size: number }` — LRU, a text longer than `maxLength` is never stored.
  - `VERDICT_MEMO_ENTRIES = 256`, `VERDICT_MEMO_MAX_LENGTH = 4096` beside `DEFAULT_STATEMENT_CACHE_SIZE` in `src/client.ts`.
  - In the client: `kindFor(sql: string, signal?: AbortSignal): Promise<StatementKind>` — used by `run`, `all`, `stream`, `chunk` (Task 8) and by the transaction (Task 7).
  - `export type SQLiteRunResult<T> = { rows: T[]; affected: number }` (`src/api.ts`); `run<T>()` → `Promise<SQLiteRunResult<T>>`, `all<T>()` → `Promise<T[]>`, both overloaded like `read` (the `SQLQuery` form first). Declared on `SQLiteDB` in this task; Task 7 moves both declarations to `SQLiteQueryAPI` when the transaction implements them.

`kindFor`: memo hit (value or in-flight promise) → it; else store the in-flight promise, `scheduler.acquire('verdict', signal)` (**not** `acquireLease`: no barrier, no write lock, no debug request), `lease.worker.verdict(sql)`, release. On `STATEMENT_FAILED`: if the lease is not borrowed, `applyBarrier(worker)` and ask once more on the same lease; a second failure rejects the call with that error; on a borrowed lease, ask again through `acquire('verdict')` (a free worker). `'refused'` rejects `MULTIPLE_STATEMENTS`. A death rejects through `WORKER_CRASHED` after one retry on another worker. The memo keeps `'read' | 'write' | 'refused'`; an error deletes the in-flight entry. `transaction.ts` calls `deps.offer(worker)` when a statement settles and its queue is empty (the worker is idle and still the transaction's).

`run()`: `kindFor` → `'read'`: the read path (`readWithRetry`, `readWorker`), `{ rows, affected: 0 }`; `'write'`: today's `write()` body (`acquireInstrumented('write')`, `runWorker`, `afterWrite`). `all()` = `run()`'s `rows`. The `timeout` counts from the call and covers the verdict wait. Both keep `assertStatementAllowed`.

- [ ] **Step 1: Write the failing tests.** Unit (`verdicts.test.ts`): LRU eviction at 256 by recency; a 4097-character text is not stored, a 4096 one is; an in-flight promise is returned to a second `get`; `delete` removes. Browser (`run.test.ts`): `run('INSERT INTO t VALUES (1, 1)')` → `{ rows: [], affected: 1 }`; `run('INSERT … RETURNING a')` → `{ rows: [{ a: 1 }], affected: 1 }`; `run('SELECT a FROM t')` → `{ rows: [{ a: 1 }], affected: 0 }`; `all('SELECT a FROM t')` → `[{ a: 1 }]`; `all('DELETE FROM t RETURNING a')` → `[{ a: 1 }]` and `t` empty; `run('SELECT 1; SELECT 2')` rejects `MULTIPLE_STATEMENTS`; `run('SELECT * FROM nope')` rejects `STATEMENT_FAILED`; **read-your-own-write**: `await run('INSERT …')` then `all('SELECT …')` sees it at `poolSize: 2`; the Review Focus items: ten concurrent `run` of one unknown SQL → ten results and **one** verdict (`interceptWorkers()`: `records.flatMap((r) => r.posted).filter((t) => t === 'verdict').length === 1`), an aborted signal while waiting for a verdict with every worker leased rejects with its reason and a later `run()` on the same `poolSize: 1` client resolves (nothing left queued), `close()` with a waiting verdict rejects `CLIENT_CLOSED`, a verdict worker killed mid-verdict (`killSilently`) leaves the call resolving, ``run(sql`SELECT ${1} AS x`)`` twice asks one verdict; a `transaction()` holding one worker of a `poolSize: 2` client whose other worker runs a long read: a `run()` issued meanwhile gets its verdict from the transaction's worker between two of its statements (spy: the verdict's `callId` went to that worker) and the transaction completes.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `run.test.ts` with `--mode all-pairs`, `pnpm test:unit`, then `pnpm test`; green.
- [ ] **Step 5: Commit** — `feat(client): run() and all(), routed by a memoised verdict`.

---

### Task 7: Transactions: `tx.run()`, `tx.all()`, and the savepoint decided without the regex

**Files:**
- Modify: `src/transaction.ts`, `src/api.ts` (`SQLiteTransactionDB` gains `run`/`all` through `SQLiteQueryAPI`), `src/client.ts` (passes `kindFor` in the transaction's deps)
- Test: `tests/browser/pairs/tx-write.test.ts`, `tests/browser/pairs/tx-savepoint.test.ts` (new cases), `tests/unit/lib/transaction.test.ts` (T7's parameterisation gains `run`/`all`)

**Interfaces:**
- Consumes: `kindFor` (Task 6) — the transaction's deps gain `kindOf: (worker: PoolWorker, sql: string, signal?: AbortSignal) => Promise<StatementKind>`, which the client implements as: memo hit, else `worker.verdict(sql)` on **that** worker, memoised.
- Produces: `run`/`all` move from `SQLiteDB` to `SQLiteQueryAPI`; `tx.run<T>()` → `Promise<SQLiteRunResult<T>>`, `tx.all<T>()` → `Promise<T[]>`; no routing, the transaction's worker; `refuseWrite: 'READ_ONLY_TRANSACTION'` when `readOnly` (Task 2).

`opensSavepoint` becomes `async (sql, own, abortedAtCall) => own !== undefined && !abortedAtCall && (await deps.kindOf(worker, sql, own)) === 'write'`, consulted **inside `settled`, after `queueWait`**, so the verdict runs at the statement's turn on the idle connection; `withSignal`'s callers that read `savepointed` before that point read it after (builder: the stream path reads it at its first `next()`, inside `chunkSource`). A statement without its own signal or timeout asks nothing. `isWriteQuery` leaves `transaction.ts`.

- [ ] **Step 1: Write the failing tests:** `tx.run('INSERT … RETURNING a')` → `{ rows: [{ a }], affected: 1 }` and the row is there after commit; `tx.all('SELECT …')` → rows; a `tx.run('INSERT …', [], { signal })` aborted while it runs is undone and the transaction goes on (the existing `tx-savepoint` case, rewritten from `tx.write` to `tx.run`, must keep its assertions); `tx.run("SELECT 'INSERT'", [], { signal })` opens **no** savepoint (spy on the worker's `savepoint` option, as the existing D4 test does); `transaction(tx => tx.run('INSERT …'), { readOnly: true })` rejects `READ_ONLY_TRANSACTION`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every `tests/browser/pairs/tx-*.test.ts` and `transaction*.test.ts` with `--mode all-pairs`, the unit project, then `pnpm test`; green.
- [ ] **Step 5: Commit** — `feat(transaction): tx.run() and tx.all(); the savepoint asks SQLite`.

---

### Task 8: `stream()` and `chunk()` take writes; a streamed write completes before delivery

**Files:**
- Modify: `src/types/protocol.ts` (`SQLOptions.drainWrites?: true`; worker message `{ type: 'affected'; callId: number; affected: number; drained: boolean }`), `src/worker/worker.ts`, `src/pool.ts` (`PoolWorkerQueryOptions.drainWrites`, `onAffected?: (affected: number, drained: boolean) => void` called from `onmessage`), `src/queries.ts` (`chunk` forwards both), `src/client.ts` (`chunk`, `stream`, `chunkRows`, `streamWithRetry`), `src/transaction.ts` (`chunk`, `stream`; the kept `drainToEnd`/`st.savepointed` paths), `src/api.ts`, `src/flatten.ts` (the returned iterator carries `affected`)
- Test: `tests/browser/pairs/stream-write.test.ts` (new), `tests/browser/pairs/tx-stream.test.ts` (writes again)

**Interfaces:**
- Consumes: `kindFor`, `Lease.demote` (Tasks 5-6).
- Produces: `export type SQLiteStream<T> = AsyncGenerator<T, void, unknown> & { readonly affected: Promise<number> }` and `export type SQLiteChunkStream<T> = AsyncGenerator<T[], void, unknown> & { readonly affected: Promise<number> }` (`src/api.ts`); `stream()`/`chunk()` and `tx.stream()`/`tx.chunk()` return them.

Worker, with `drainWrites` (sent by every `stream`/`chunk`, client and transaction): after the prepare, a statement classified `'read'` posts `affected` `{ affected: 0, drained: false }` and streams as today; a `'write'` is stepped to `SQLITE_DONE` first, its encoded chunks kept, then `affected` `{ affected: <total_changes delta>, drained: true }` is posted, then the chunks go out under the credit gate as today, then `done`. A `stop` during the drain interrupts it (the write rolls back, as an interrupted statement does today); a `stop` after it cuts the delivery only.

Client: `chunk`/`stream` drop `assertReadable`; `kindFor` at the first `next()` (the call still validates its arguments and starts the deadline, as today); `'read'` → today's path; `'write'` → `acquireInstrumented('write')`, the query with `drainWrites`, and on `onAffected(_, true)`: `afterWrite(worker)`, release the write lock, `lease.demote()` — `acquireLease`'s write lease gains `releaseWriteLock(): void` (idempotent; what its `release()` does today after `lease.release()`, i.e. `publishing.then(releaseWrite)`), and `release()` then only returns the worker plus a `releaseWriteLock()` that has not run; the lease itself returns when the delivery ends or is abandoned, through the existing `quiesce().then(release)`. **A write is never retried** (`streamWithRetry` retries only when the kind is `'read'`). `affected` resolves from `onAffected`, rejects with the statement's error, and has a no-op `catch` attached at creation.

Transaction: `chunk`/`stream` drop the read-only refusal of `fix/tx-api-consistency` (`checksql(sql, 'chunk'|'stream')` → `checksql(sql)`), send `drainWrites`, and the savepointed branches come back into use: abandoning a savepointed streamed write **before** `affected` arrives undoes it (today's `drainToEnd` path), **after** it releases the savepoint and keeps the write (spec § Streaming a write).

- [ ] **Step 1: Write the failing tests** (`stream-write.test.ts`, seeded `t` with 2 000 rows): `for await` over `stream('DELETE FROM t RETURNING a')` yields 2 000 rows and `t` is empty; its `affected` resolves `2000` **before the first row is consumed** (await it first, then iterate); a second client's `run('INSERT …')` issued after `affected` resolved and before the stream is read resolves without waiting for the stream (the write lock is free); `chunk('UPDATE t SET b = 1 RETURNING a', [], { chunkSize: 100 })` yields 20 chunks; `stream('SELECT a FROM t').affected` resolves `0`; abandoning (`break`) a `DELETE … RETURNING` stream after its first row, on a `poolSize: 1` client, leaves `t` empty and a following `all('SELECT 1')` resolves (the worker came back); an abort before `affected` (a `timeout: 1` on a `WITH RECURSIVE` delete of 10⁶ rows) leaves `t` untouched; in a transaction, `tx.stream('INSERT … RETURNING a')` delivers its rows, a savepointed one aborted before `affected` is undone and the transaction commits the rest.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Expected to change: the `tx-stream`/`tx-chunk` tests that pin the refusal of writes (`NOT_A_READ_QUERY`), now accepted.
- [ ] **Step 4: Run** `stream-write.test.ts`, `tx-stream.test.ts`, `chunk-delivery.test.ts`, `backpressure.test.ts`, `early-exit.test.ts`, `abandon*.test.ts` with `--mode all-pairs`, then `pnpm test`; green.
- [ ] **Step 5: Commit** — `feat(client): stream and chunk take writes, completed before delivery`.

---

### Task 9: Migrate every caller to `run()` and `all()`

**Files:**
- Modify: every file under `tests/` that calls `.read(`/`.write(` on a client or a transaction (`grep -rln "\.read(\|\.write(\|\.read<\|\.write<" tests`), `scripts/bench/` (the page and its runners), `scripts/consumer-smoke.ts` and `tests/consumers/`, `src/bulk.ts` (its `read`/`write` deps become an internal `all` and an internal `writeDirect` — the client's write path without a verdict, one lease per batch as today)

Mechanical: `.read(` → `.all(`; `.write(` → `.run(`; a `write()` result's `.result` → `.rows`. Two kinds of test change meaning and are rewritten, not renamed, each listed in the report: a test asserting `read()` refuses a write (`all()` takes it now — the refusal is `first()`'s, tested in Task 2), and a test asserting `write()`'s `result` key by name.

- [ ] **Step 1: Run the rewrite** with a script under `.scratchpad/sqlite-routing/` (never committed); review its diff file by file; fix by hand what a pattern cannot (destructured `{ result }`, a helper that wraps `read`).
- [ ] **Step 2: Run** `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm test:conformance`, `pnpm test:consumer`, `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chrome --all`; all green, and the `Test Files` line shows no failed file.
- [ ] **Step 3: Commit** — `test: call run() and all() instead of write() and read()`.

---

### Task 10: Remove `read()`, `write()` and the regex (breaking)

**Files:**
- Modify: `src/api.ts` (`read`, `write`, `SQLiteWriteResult` go; `SQLiteRunResult` stays), `src/client.ts`, `src/transaction.ts` (`InternalTransactionDB`'s `write` becomes the internal `writeDirect` `bulk.ts` uses), `src/queries.ts`, `src/utils.ts` (`isReadQuery`, `isWriteQuery`, `assertReadable`, `READ_PRAGMA`, `INTROSPECTION_PRAGMA` regexes, `WRITE_KEYWORDS` go), `src/index.ts` if it names a removed type
- Test: `tests/unit/lib/routing.test.ts` (regex tests go; whatever it pins that is still true moves to `classify.test.ts`), `tests/unit/lib/exports.test.ts` (the export list), `tests/browser/pairs/routing.test.ts` (regex cases that no longer apply)

- [ ] **Step 1:** Update `exports.test.ts` to the new public names (`SQLiteRunResult`, `SQLiteStream`, `SQLiteChunkStream`; no `SQLiteWriteResult`) — expect FAIL.
- [ ] **Step 2: Remove** as listed; `grep -rn "isReadQuery\|isWriteQuery\|assertReadable\|SQLiteWriteResult" src tests scripts` returns nothing.
- [ ] **Step 3: Run** `tsc`, `pnpm test`, `pnpm test:conformance`, `pnpm test:consumer`; green.
- [ ] **Step 4: Commit (breaking)** — `feat(api)!: run() and all() replace write() and read()`, `BREAKING CHANGE: write() is removed, run() replaces it and its result's rows are named rows; read() is removed, all() replaces it and also takes writes; first() is the only method that refuses a write.`

---

### Task 11: Documentation and CHANGELOG

**Files:**
- Modify: `API.md`, `README.md`, `VFS.md` (only if a per-VFS fact changed; `pnpm docs:vfs` must leave it unchanged otherwise), `CHANGELOG.md` (through the `changelog-maintenance` skill), JSDoc in `src/api.ts` and `src/client.ts` that still says `read()`/`write()`/"provably reads"

CHANGELOG `[Unreleased]`, **separate `**Breaking:**` lines** (user, 2026-10-27): the renamed methods (`read()` → `all()`, `write()` → `run()`); `result` → `rows`; multi-statement strings no longer supported (refused with `MULTIPLE_STATEMENTS`), with the rc.10 per-statement binding gone. Non-breaking entries: `stream()`/`chunk()` take writes and expose `affected`; `first()` refuses writes in the worker (accepting reads the old rule refused, such as `SELECT 'INSERT'`, `EXPLAIN …`). The migration is written in the Breaking entries (no stable version yet). No figures, no mechanism.

- [ ] **Step 1:** Edit the three files; show the user the diff; iterate without committing each pass (`mem:conventions`, consumer documentation).
- [ ] **Step 2:** `pnpm docs:vfs && git diff --exit-code VFS.md README.md` (or the expected diff), `pnpm check`.
- [ ] **Step 3: Commit** once the user approves — `docs: run(), all(), streamed writes, single statements`.

---

### Task 12: Measure the memo and the verdict, and close

**Files:**
- Create: a throwaway harness under `.scratchpad/sqlite-routing/` (never committed)
- Modify: `.serena/memories/measurements/*` (the theme's sub-memory, through Serena), `.serena/memories/follow-ups/sqlite-routing.md`, `.serena/memories/state.md`

- [ ] **Step 1: Measure**, per build (`sync`, `async`, `jspi`) on Chrome and Firefox, `OPFSWriteAheadVFS`/`OPFSAdaptiveVFS` and `MemoryVFS`, n ≥ 3 interleaved: (a) the first `run()` of a statement against `first()`-equivalent reads (the verdict's cost), (b) 10 000 `all()` of one statement with the memo against `VERDICT_MEMO_ENTRIES = 0` (built for the measurement only). Record date, method, medians and ranges.
- [ ] **Step 2: Report** to the user: keep or remove the memo — their call.
- [ ] **Step 3:** The delivery gate `node scripts/hook-gate.ts delivery --run`, its report read; the matrix on GitHub before the merge (ask the user to push the branch; `gh workflow run matrix.yaml --ref feat/sqlite-routing`).
- [ ] **Step 4: Commit the memories** — `docs(memory): sqlite-routing measured and delivered`.
