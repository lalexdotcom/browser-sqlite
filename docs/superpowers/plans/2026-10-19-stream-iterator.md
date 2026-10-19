# Stream iterator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (after Task 0, which makes `client.stream()`/`client.chunk()` validate their arguments at the call) `client.stream()` and `tx.stream()` hand out rows through a hand-written async iterator over a generator of chunks, with no change of behaviour.

**Architecture:** A small adapter `flatten(source, options?)` in `src/flatten.ts` turns an `AsyncGenerator<T[]>` into an `AsyncGenerator<T>`, serving buffered rows with resolved promises. Every generator that owns a resource today (deadline, retry, lease, transaction queue, abandon) keeps it and yields chunks; `stream()` is the flattening of what `chunk()` already builds. `streamRows` goes away.

**Tech Stack:** TypeScript, Vitest (unit project in Node; browser projects through WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-10-19-stream-iterator-design.md` — read it before any task. Its two rules override everything: **no change of behaviour; maximum reliability.**

## Global Constraints

- Branch `perf/stream-iterator`, main checkout `/workspaces/wsqlite`, no git worktree. Every commit checks the branch in the same command: `test "$(git branch --show-current)" = perf/stream-iterator && git commit …`.
- Serena's symbolic tools are primary for code (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_*_symbol`, `replace_content`); Read/Edit/Grep on code only as fallback. Never `$1` in a `replace_content` replacement.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. `pnpm exec tsc --noEmit` before each commit; a failing hook is reported verbatim. After committing, `git log -1` and `git show --stat HEAD`.
- `pnpm check` after every modification. Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No change of behaviour visible to a consumer of `stream()`/`tx.stream()`; `stream()`'s declared type stays `AsyncGenerator<T, void, unknown>`. No change to `chunk()`, `tx.chunk()`, `read()`, `first()`, the worker or the transport.
- **An existing test that has to change means the behaviour changed: stop and report, do not edit it.** The single exception is Task 0, the one deliberate change (argument validation of `client.stream()`/`client.chunk()` at the call), whose updated tests are listed in its report.
- **Every new test is falsified once**: a deliberate mutation of the code under test makes it fail; the mutation and its failure are recorded in the task report, then reverted.
- Browser commands: `node scripts/test-plan.ts <files>` (both engines, both modes, complement), `--mode all-pairs <files>` (every eligible pair), `--pair <vfs>/<build>`. Long runs log to a file under `.scratchpad/stream-iterator/` (never piped through `tail`).
- Comments state the fact in one or two lines.

## Review Focus

- **A consumer that `break`s in the middle of a chunk** must free the lease (client) or the transaction's queue (tx) exactly as today. Pinned by Task 1's unit test, Task 2's differential, and the existing `early-exit`/`abandon` browser tests run in Tasks 3-4.
- **Two `next()` calls not awaited** (e.g. `Promise.all([it.next(), it.next()])`) must not start two chunk fetches. Pinned by Task 1.
- **`return()` while a chunk fetch is pending** must wait for it and then close the source once. Pinned by Tasks 1-2.
- **A `tx.stream()` left open when the callback ends** must be closed by the transaction, with no buffered row served afterwards. Pinned by Task 4's browser test, written and green on `main` first.
- **A savepointed `tx.stream()` aborted mid-chunk** must reject the next row and abandon the write as today. Pinned by Task 1 (the adapter calls `throw(reason)`) and Task 4's browser test, green on `main` first.

---

### Task 0: `client.stream()` and `client.chunk()` validate at the call (the one deliberate change, user 2026-10-19)

**The only behaviour change of the branch, decided by the user; rule 1 applies to every later task, measured from the state this task leaves.** Today both are `async function*`, so `queryArgs` (`INVALID_VALUE`: neither a string nor an `` sql`…` `` query, or a params array with an `` sql`…` `` query), `assertReadable` (`NOT_A_READ_QUERY`) and `prepareParams` (`INVALID_VALUE` on an unbindable value) run at the first `next()`. After this task they run at the call and throw from it, as `tx.stream()`/`tx.chunk()` already do. **The `timeout` timer (`withDeadline`) stays started at the first `next()`**: only its doc comment changes, to say so for `chunk()`/`stream()` instead of "counted from the call".

**Files:** Modify `src/client.ts` (`chunk`, `stream`), `src/utils.ts` (`withDeadline`'s comment); Test: the browser file(s) that pin `chunk()`/`stream()` argument errors (find them: `grep -rn "NOT_A_READ_QUERY\|INVALID_VALUE" tests/browser/pairs`), plus new literal `it`s where a case is missing.

**Interfaces — Produces:** inside `createSQLiteClient`, one internal async generator taking the validated `sql`, bound params, options and the method name (`'chunk'` or `'stream'`), running `withDeadline`, `streamWithRetry` and `chunkWorker` exactly as `chunk`'s body does today. `chunk(...)` = validate, then return that generator with `'chunk'`; `stream(...)` = validate, then today's row-flattening over that generator with `'stream'` (Task 3 swaps it for `flatten`). Public signatures and declared return types unchanged (check `dist/*.d.ts` after `pnpm build` against `main`'s).

- [ ] **Step 1: Tests first.** For `chunk()` and `stream()` each, one literal `it` per validation: a non-query first argument, an `` sql`…` `` query with a params array, a write statement, an unbindable param value — `expect(() => db.stream(...)).toThrow(SQLiteError)` with the code, and no worker leased (a following `read()` on a `poolSize: 1` client resolves at once). Existing tests that expect the rejection on `next()` are the ones this deliberate change updates: change only their expectation (throw at the call), list each in the report. Run them, see the new ones fail.
- [ ] **Step 2: Implement** per Interfaces; validations before any generator is created, nothing else moved.
- [ ] **Step 3: Run** — the changed/new browser files, then `node scripts/test-plan.ts` on `queries`, `results`, `routing`, `query-timeout`, `abandon`, `early-exit`, `stream-retention`, `params`, `sql-tag`; `pnpm test:unit`; `tsc`. Falsify one new test by moving one validation back inside the generator; record; revert.
- [ ] **Step 4: Commit, marked breaking** (`mem:conventions`, Git and versioning):
  ```
  feat(client)!: stream() and chunk() validate their arguments at the call

  <why: errors at the call, as tx.stream()/tx.chunk() and the promise-returning methods already report them>

  BREAKING CHANGE: an invalid query, a write statement or an unbindable param passed to stream() or chunk() throws from the call instead of rejecting the first next().

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
  with `BREAKING CHANGE:` in a paragraph of its own above `Co-Authored-By`.

---

### Task 1: The adapter

**Files:** Create `src/flatten.ts`; Test `tests/unit/lib/flatten.test.ts`.

**Interfaces — Produces:**
```ts
export function flatten<T>(
  source: AsyncGenerator<T[], void, unknown>,
  options?: { signal?: AbortSignal },
): AsyncGenerator<T, void, unknown>;
```

- [ ] **Step 1: Write the tests**, against a scripted source built per test (records every `next`/`return`/`throw` call on it, serves scripted chunks, delays and errors). One literal `it` each:
  - `touches the source only at the first next()` — creating `flatten(src)` makes no call on `src`.
  - `serves the rows of every chunk in order, skipping empty chunks` — chunks `[[1,2],[],[3]]` → 1, 2, 3, then `done`; source `next` called 4 times.
  - `serves buffered rows without calling the source` — after the first row of `[1,2,3]`, the next two `next()` make no call on the source.
  - `fetches one chunk for two next() not awaited` — `Promise.all([it.next(), it.next()])` on a source whose first chunk is `[1]` and second `[2]` → values 1 and 2 in call order, exactly two source `next` calls, never two pending at once.
  - `waits for a pending fetch before return() closes the source` — `return()` called while the source's `next()` is pending: the source's `return()` is called after that `next()` settles, once; the iterator is then `done`.
  - `closes the source once for two return()` — two `return()` → one source `return()`.
  - `closes the source once on a break in for await` — `for await` over `[[1,2,3]]` with `break` after 1 → exactly one source `return()`, no further `next`.
  - `forwards throw() to the source and ends` — `it.throw(e)` after the first row → source `throw(e)` called once, the call rejects with what the source rejects with, later `next()` is `done` with no source call.
  - `calls nothing on the source for return() or throw() before the first next()` — `return()` resolves `done`, `throw(e)` rejects with `e`, zero source calls, then `done`.
  - `ends on a source error` — source rejects at its second `next()`: the rows of chunk 1 arrive, the next `next()` rejects with that error, later `next()` is `done` without a source call.
  - `throws an aborted signal into the source before a buffered row` — with `signal`, chunk `[1,2,3]`, abort after row 1: the next `next()` calls source `throw(signal.reason)` once and rejects with what that rejects with; without `signal` the same scenario serves 2 and 3.
  - `is its own async iterator` — `it[Symbol.asyncIterator]() === it`.
- [ ] **Step 2: Run them, see them fail** — `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/lib/flatten.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement `flatten` in `src/flatten.ts`** per the spec's "The adapter" and "Settled after the builder check". The returned object must satisfy `AsyncGenerator<T, void, unknown>` under the library's `lib: ["ES2024", "DOM"]` without a cast that hides a missing member.
- [ ] **Step 4: Run them, see them pass; falsify** — same command → PASS. Then, one at a time, mutate (start the source at creation; drop the pending-fetch serialisation; call the source's `return()` on every `return()`; skip the signal check) and record which tests fail; revert. `pnpm check`, `tsc` clean.
- [ ] **Step 5: Commit** `src/flatten.ts tests/unit/lib/flatten.test.ts` — `perf(queries): an async iterator that flattens chunks without a generator per row`.

---

### Task 2: The differential test

**Files:** Test `tests/unit/lib/flatten-differential.test.ts`.

**Interfaces — Consumes:** `flatten` (Task 1).

- [ ] **Step 1: Write the reference** inside the test file. **The adapter replaces the innermost flattener but sits outermost** (controller ruling, ledger): its source is the layers that sit between the consumer and `streamRows` today (`streamWithRetry`, `releasing`), which receive the consumer's `throw()` as a throw. So both shapes include a recording `outer` layer standing for them (a `for await` over its input inside `try`/`catch`/`finally`, recording what reaches it: each value, a `catch` with its error, its `finally`), and the trace covers the chunk source's calls AND `outer`'s events:
  ```ts
  async function* rowsOf<T>(src: AsyncGenerator<T[]>) { for await (const c of src) for (const r of c) yield r; }
  // today: the consumer holds outer(rowsOf(chunks));  new: flatten(outer(chunks))
  ```
  `outer` is generic over what it yields (rows today, chunks after); its recorded events must be the same in both shapes except for the values it passes (a row vs the chunk holding it), which the trace normalises.
- [ ] **Step 2: Write the scripted scenarios**, one literal `it` each, each run against `outer(rowsOf(src))` and `flatten(outer(src))` over two identical recorded sources, asserting equal traces (rows received in order; the chunk source's calls `next`/`return`/`throw` in order; `outer`'s catch/finally events; the errors): read 2 rows of `[[1,2,3]]` then `break`; `return()` mid-chunk; `throw(e)` mid-chunk; source error at chunk 2; consumer throws in its loop body after row 2; read to the end over `[[1],[2,3],[],[4]]`; `return()` and `throw()` before the first `next()`; `next()` after `done`.
- [ ] **Step 3: Write the randomised comparison** — one `it`, seeded PRNG (a small deterministic one in the file), ≥ 5 000 cases: source = 0-8 chunks of 0-4 rows, an optional error at a random chunk, optional per-chunk delays (`await` of 0-2 microtasks or a resolved timer); consumer = a random sequence of `next()` awaited, two `next()` not awaited, `return()`, `throw()`, `break`. Both shapes as in Step 2; traces compared per case; a mismatch fails with the seed and the case printed. Run time under 10 s.
- [ ] **Step 4: Run and falsify** — `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/lib/flatten-differential.test.ts` → PASS. Falsify: the Task 1 mutations, one at a time, each turn this file red (record which case/seed); revert.
- [ ] **Step 5: Commit** — `test(queries): flatten matches the generator chain it replaces`.

If a mismatch is found that is not a bug of `flatten` but a difference the spec did not foresee: stop and report it (rule 1), do not adjust the reference.

---

### Task 3: `client.stream()` through the adapter

**Files:** Modify `src/client.ts` (`chunk`, `stream`); Modify `src/queries.ts` (`streamRows` — removed only in Task 4, when its last user goes).

**Interfaces — Consumes:** `flatten` (Task 1).

- [ ] **Step 1: Baseline** — on the branch after Task 0, before this change, run and keep the result lines: `node scripts/test-plan.ts tests/browser/pairs/{abandon,early-exit,stream-retention,query-timeout,interrupt,queries,results,routing,writer-spread,params,sql-tag}.test.ts`.
- [ ] **Step 2: Change** — `stream` returns `flatten(<Task 0's internal chunk generator>('stream'))` after its validations (which stay at the call, as Task 0 left them). **Trap: `withDeadline` must still start at the first `next()`** — it lives in the internal generator's body, which `flatten` starts at its first `next()`; keep it there. `stream`'s generics and parameters are unchanged; its declared return type stays `AsyncGenerator<T, void, unknown>` (check the emitted `dist/*.d.ts` after `pnpm build` against `main`'s for `stream`).
- [ ] **Step 3: Run** — the same files → the same result lines as Step 1; then `--mode all-pairs` on `abandon`, `early-exit`, `stream-retention`, `query-timeout`; then `BSQ_EXPOSE_GC=1 node scripts/test-plan.ts --browser chrome tests/browser/pairs/abandon-gc.test.ts`; `pnpm test:unit`. A test that fails or has to change: stop and report.
- [ ] **Step 4: Commit** — `perf(client): stream() flattens the chunk generator instead of a generator per row`.

---

### Task 4: `tx.stream()` through the adapter

**Files:** Modify `src/transaction.ts` (`tx.stream`); Modify `src/queries.ts` (remove `streamRows`); Test `tests/browser/pairs/tx-stream.test.ts` (new).

**Interfaces — Consumes:** `flatten` (Task 1); `releasing(source, entry, st, method)` and `OpenStatement` in `src/transaction.ts` as they are.

- [ ] **Step 1: Write the browser test on today's code and see it pass** (it pins today's behaviour; tags as the neighbouring `tx-*` tests). Literal `it`s:
  - `a tx.stream() left open when the callback ends is closed, and serves no later row` — inside `transaction()`, read the first row of a 5 000-row `tx.stream()` with `chunkSize` 1 000, keep the iterator, return from the callback; after the transaction resolves, `next()` on the kept iterator gives what it gives today (record it from `main`: `done`, or the error), and a following `client.read()` works (the worker is free).
  - `a savepointed tx.stream() aborted mid-chunk rejects the next row and the write is not lost` — a `tx.stream()` over a write with `RETURNING` (savepointed) and a `signal`, `chunkSize` 1 000, abort after row 1: the next `next()` rejects with the signal's reason; then assert what `main` gives for the write's effect and the transaction's outcome (record it from `main` first).
  - `a tx.stream() broken out of mid-chunk lets the next statement run` — `break` after row 1 of a 5 000-row stream, then `tx.read('SELECT 1')` in the same callback resolves.
- [ ] **Step 2: Run it on today's code** — `node scripts/test-plan.ts tests/browser/pairs/tx-stream.test.ts` → PASS on both engines; record the observed values the assertions encode.
- [ ] **Step 3: Change** — `tx.stream` builds the same source as `tx.chunk` (`chunkWorker` with the same options) and returns `flatten(releasing(source, entry, st, 'stream'), st.savepointed ? { signal: st.own } : undefined)`, and sets `entry.gen` to the adapter (so `closeOpenStatements` closes the adapter). Remove `streamRows` from `src/queries.ts` and its imports.
- [ ] **Step 4: Run** — `tx-stream.test.ts` and every `tests/browser/pairs/tx-*.test.ts`, `transaction*.test.ts`, `abandon-transaction.test.ts`, `pool-savepoint.test.ts`, `savepoint-api.test.ts` in complement mode, then `--mode all-pairs` on `tx-stream.test.ts`; `tests/unit/lib/transaction.test.ts`. Same result lines as before the change, apart from the new file. A test that fails or has to change: stop and report.
- [ ] **Step 5: Falsify the new browser test** — temporarily set `entry.gen` back to `releasing`'s generator: the first `it` must fail; temporarily pass no signal for the savepointed case: the second must fail. Record; revert.
- [ ] **Step 6: Commit** — `perf(transaction): tx.stream() flattens the chunk generator`.

---

### Task 5: Repetition and measurements

**Files:** `.scratchpad/stream-iterator/` (untracked); memories `measurements/footprint` (or the fitting topical file, under 40 000 characters), `follow-ups/stream-iterator`.

- [ ] **Step 1: Repeat** — the stream-related browser files of Tasks 3-4 with `--mode all-pairs`, three times in a row; every run's `Test Files` line recorded. One red run: stop and report (rule 2), with the failing test and its log.
- [ ] **Step 2: Measure** — `main`'s build and the branch's, as FAST-STEP (`mem:measurements/statement-cache-and-perf`): the direct harness rebuilt under `.scratchpad/stream-iterator/`, stock Chrome 153 and Firefox 155.0.1 from `node_modules/.cache/wdio/` launched by hand (`navigator.userAgent` logged per run, must read 155.0), alternated within each repetition, n ≥ 3, row counts checked: `client.stream()` 4 000 000 rows of two integers on `MemoryVFS`, `sync`/`async`/`jspi`, default `chunkSize` and 5 000; `tx.stream()` on `sync`; `chunk()` on `sync`. Then `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chrome --all` → `OK`.
- [ ] **Step 3: Record** — an entry with an ID (STREAM-ITER) in the fitting measurements memory and its index line in `mem:measurements`; no `.scratchpad/` path; grep for `$1`; sizes under 40 000.
- [ ] **Step 4: Commit** the memories — `docs(memory): the stream iterator measured in the library`.

---

### Task 6: Delivery

- [ ] **Step 1:** `CHANGELOG.md` through the `changelog-maintenance` skill, under `[Unreleased]` › Changed: `stream()` is faster, most on Firefox (no figures); and a **Breaking:** line — `stream()` and `chunk()` throw an invalid argument from the call instead of rejecting the first `next()` (Task 0's commit carries `!`).
- [ ] **Step 2:** `node scripts/hook-gate.ts delivery --run`, logged; the `Test Files` line, the skipped-with-reason list and the not-applicable counts compared with `mem:state`'s baseline.
- [ ] **Step 3:** The matrix on GitHub (the branch touches `src/transaction.ts`): the user pushes the branch, `gh workflow run matrix.yaml --ref perf/stream-iterator`, verdict read, remote branch deleted.
- [ ] **Step 4:** Report to the user and wait; the merge only on their approval, then the follow-up closed into history and `mem:state` updated.
