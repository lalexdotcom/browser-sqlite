# `close({ immediate: true })` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `close({ immediate: true })` that interrupts the statements in flight instead of draining them, and terminates at once a worker whose statement cannot be stopped.

**Architecture:** A client-wide `immediateAbort` controller, aborted with the same `CLIENT_CLOSED` error `close()` already builds, is merged into the signal of every call — so an immediate close reaches each statement through the interruption path `signal`/`timeout` already use, and the calls reject with `CLIENT_CLOSED` by construction. `close()` then replaces each `drainTimeout`-bounded wait with a short grace, and terminates without posting `close` a worker that is still serving a statement it cannot give up (`sync` without cross-origin isolation). An immediate call during a draining close escalates it.

**Tech Stack:** TypeScript, Web Workers, wa-sqlite, Vitest + WebdriverIO browser tests (tags read by the test planner).

**Spec:** `docs/superpowers/specs/2026-11-12-close-immediate-design.md` — read it whole before Task 1.

## Global Constraints

- `close()`, `close({})` and `close({ immediate: false })` behave exactly as today. No existing test of `tests/browser/pairs/close.test.ts` changes.
- Every call interrupted by the option rejects with `CLIENT_CLOSED`, message `The SQLite client has been closed.` — the `closingError` `close()` already builds.
- Under the option, `close()` never waits `drainTimeout` on any build. The grace is `CLOSE_IMMEDIATE_GRACE_MS = 300` (agent's call, the order of `QUIESCE_GRACE_MS` in `src/pool.ts`).
- Unchanged under the option: `closeAbort`, `scheduler.shutdown`, the held write locks released after the workers are gone, `connLockPromise`, `openLockFree()` with its bound, `bsq:conn` and the marker released, the `setTimeout(0)` yield; a second call returns the same promise object.
- `transaction.ts` gets no second client-wide signal: `closeSignal` already interrupts a transaction's statement.
- Code files are read and edited through Serena (`AGENTS.md`); `pnpm check` after every modification; a bound a test writes goes through `scaled()`, never a value handed to the library as its subject (`drainTimeout` is one); an unreached precondition goes through `exercised()` after the test's own cleanup (`tests/browser/helpers/exercised.ts`).
- Every implementer prompt carries `mem:conventions` § What every implementer prompt forbids (never `--no-verify`, never `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never `pnpm install` / `pnpm store prune`; `pnpm exec tsc --noEmit` before each commit; check the branch in the same command as the commit: `test "$(git branch --show-current)" = feat/close-immediate && git commit …`).

## Review Focus

1. **A paused `stream()` under the option** — the consumer read one chunk and stopped; the lease is held by the consumer, not by a statement. Expected: `close({ immediate: true })` resolves within the grace, and the next `next()` rejects with `CLIENT_CLOSED`. Pinned in Task 1, test `rejects a paused stream at once`.
2. **A transaction whose callback never returns** — its lease never comes back to the scheduler. Expected: an immediate close does not wait `drainTimeout` for it. Pinned in Task 1, test `does not wait for a transaction that never finishes`.
3. **An uninterruptible statement under the option** (`sync` without isolation). Expected: terminated at once, no `close` posted to it. Pinned in Task 2.
4. **A cut write.** Expected: absent after reopen, database readable. Pinned in Task 2.
5. **`close({ immediate: true })` after a draining `close()`.** Expected: same promise, resolved within the grace. Pinned in Task 3.

---

### Task 1: The option, and the interruptible path

**Files:**
- Modify: `src/api.ts` (`SQLiteCloseOptions`, `close` signature and TSDoc on the client interface, line ~514)
- Modify: `src/index.ts` (export `type SQLiteCloseOptions` beside the other option types)
- Modify: `src/client.ts` (`createSQLiteClient`: `immediateAbort`, the call-signal merge at every `withDeadline` site — `readDirect`, `chunk`, `stream`, `writeDirect`, `runStatement`, `first` — and `close`)
- Test: `tests/browser/pairs/close-immediate.test.ts` (new)

**Interfaces:**
- Produces: `export type SQLiteCloseOptions = { immediate?: boolean }`; `close: (options?: SQLiteCloseOptions) => Promise<void>`; inside `createSQLiteClient`, `immediateAbort: AbortController` and `CLOSE_IMMEDIATE_GRACE_MS` (module constant in `src/client.ts`). Tasks 2 and 3 use both.

- [ ] **Step 1: Write the failing tests** in `tests/browser/pairs/close-immediate.test.ts`, `describe('close({ immediate: true })')`. Reuse `longQuery`, `theQueryIsRunning`, `waitUntil`, `scaled`, `interceptWorkers`, `createTestClient` from `../helpers`; prime the statement as `interrupt.test.ts`'s `frees the worker` does, so the step has started before the interruption.

  - `interrupts a running statement and closes the worker cleanly`, tags `['requires:interruptible']`: `poolSize: 1`, `debug: true`, `drainTimeout` left at its default. `const long = db.all(longQuery(2_000_000_000))`, wait until running, `const t0 = performance.now(); await db.close({ immediate: true })`.
    - `await expect(long).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })`
    - `expect(performance.now() - t0).toBeLessThan(scaled(5_000))`
    - trace of `interceptWorkers()`: `recv:closed` before `terminate`.
  - `rejects a paused stream at once`, no tag: a `stream()` of `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 10000000) SELECT x FROM c`; read the first chunk through its iterator, then `close({ immediate: true })`.
    - `close()` resolves within `scaled(5_000)` (a draining close would wait the paused consumer out for `drainTimeout`)
    - `await expect(iterator.next()).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })`
  - `does not wait for a transaction that never finishes`, no tag: as `close.test.ts`'s `is bounded when a transaction never finishes`, with `drainTimeout` at its default and `close({ immediate: true })`: resolves within `scaled(5_000)`; the transaction rejects with `CLIENT_CLOSED`.
  - `rejects a bulk load's close()`, no tag: `const load = db.bulkWrite('t', …)`, a few `enqueue()`, `await db.close({ immediate: true })`, `await expect(load.close()).rejects.toMatchObject({ code: 'BULK_WRITE_FAILED', cause: { code: 'CLIENT_CLOSED' } })` (ruling 2026-11-13: what the default close already does). This pins the documented outcome; it does not discriminate the option from the default.

- [ ] **Step 2: Run them, see them fail**

  Run: `pnpm exec tsc --noEmit` — Expected: errors on `close({ immediate: true })` (no parameter). Then the file alone, the planner placing each test on its eligible pairs: `node scripts/test-plan.ts tests/browser/pairs/close-immediate.test.ts` (add `--pair <vfs>/<build>` to pin one, `--plan-only` to see the placement). Expected: FAIL.

- [ ] **Step 3: Implement**
  - `SQLiteCloseOptions` and the `close(options?)` signature in `src/api.ts`, TSDoc stating the option in one paragraph (interrupts the statements in flight, rejects them with `CLIENT_CLOSED`, does not wait `drainTimeout`); export the type from `src/index.ts`.
  - `immediateAbort = new AbortController()` in `createSQLiteClient`. A local helper wraps `withDeadline(options, method)` and merges its signal with `immediateAbort.signal` through `mergeSignals`, releasing both; every `withDeadline` call site in `client.ts` goes through it. `bulk.ts` is left alone: its batches run through the client's write path and are reached there.
  - `close(options)`: under `immediate`, `immediateAbort.abort(closingError)` right after `closeAbort.abort(closingError)`; every `bounded(…, drainTimeout)` in `close` takes `CLOSE_IMMEDIATE_GRACE_MS` instead; a worker whose `close()` did not answer within the grace is terminated with `closingError` as today.

- [ ] **Step 4: Run them, see them pass**, then `close.test.ts` unchanged and green on the same pair.

- [ ] **Step 5: `pnpm check`, then commit**

```bash
git add src/api.ts src/index.ts src/client.ts tests/browser/pairs/close-immediate.test.ts
test "$(git branch --show-current)" = feat/close-immediate && git commit -m "feat(close): let close() interrupt the statements in flight"
```

### Task 2: The non-interruptible path

**Files:**
- Modify: `src/pool.ts` (`PoolWorker`: add `serving`; `createPoolWorker` implements it)
- Modify: `src/client.ts` (`close`)
- Test: `tests/browser/pairs/close-immediate.test.ts`

**Interfaces:**
- Consumes: `immediateAbort`, `CLOSE_IMMEDIATE_GRACE_MS` (Task 1).
- Produces: `PoolWorker.serving: () => boolean` — `true` while the worker serves a query (`servingQuery !== undefined` in `createPoolWorker`), documented on the type like its neighbours.

- [ ] **Step 1: Write the failing tests**
  - `terminates a statement it cannot stop, without asking it to close`, tags `['build:sync', 'excludes:interruptible']`: `poolSize: 1`, `debug: true`, default `drainTimeout`, `interceptWorkers()`. `longQuery(20_000_000)` running, then `close({ immediate: true })`.
    - the query rejects with `CLIENT_CLOSED`
    - `close()` resolves within `scaled(5_000)`
    - the trace contains `terminate` and does **not** contain `post:close` (Task 1's grace path posts `close`, then terminates: this is what fails before Step 3).
  - `leaves no trace of a cut write`, tags `['requires:shared-storage']`: `const shared = sharedDatabase()`, `db = shared.open({ poolSize: 1, debug: true })`, `CREATE TABLE t (a)`, `const write = db.run(<the recursive INSERT of close.test.ts's SLOW_INSERT, at 2_000_000 rows>)`, wait for `aRequestIsInFlight` (copy the predicate from `close.test.ts`), `await db.close({ immediate: true })`, `const outcome = await write.then(() => 'landed', (e) => e.code)`. Then `const again = shared.open({ poolSize: 1 })`, `const [{ n }] = await again.all('SELECT count(*) AS n FROM t')`, `await again.close()`.
    - `if (!(await exercised(outcome !== 'landed', 'the write was cut by close()'))) return;`
    - `expect(outcome).toBe('CLIENT_CLOSED')`; `expect(n).toBe(0)`.

- [ ] **Step 2: Run them** (`node scripts/test-plan.ts tests/browser/pairs/close-immediate.test.ts`; the tags place the first on the `sync` pairs without isolation, Chrome and Firefox). Expected: the first fails on `post:close`; the second may already pass (it pins the outcome).

- [ ] **Step 3: Implement** `serving` in `src/pool.ts`; in `close`, under `immediate`, for a worker that `serving()` on a non-interruptible client (`build === 'sync' && abortSlots === undefined`), `worker.terminate(closingError)` at once and skip its `close()`. Idle workers keep their clean close.

- [ ] **Step 4: Run Task 1's and Task 2's tests and `close.test.ts`.** Expected: PASS.

- [ ] **Step 5: `pnpm check`, then commit**

```bash
git add src/pool.ts src/client.ts tests/browser/pairs/close-immediate.test.ts
test "$(git branch --show-current)" = feat/close-immediate && git commit -m "feat(close): terminate at once a statement close() cannot stop"
```

### Task 3: Escalating a draining close

**Files:**
- Modify: `src/client.ts` (`close`)
- Test: `tests/browser/pairs/close-immediate.test.ts`

**Interfaces:**
- Consumes: `immediateAbort`, `CLOSE_IMMEDIATE_GRACE_MS`, `PoolWorker.serving` (Tasks 1-2).

- [ ] **Step 1: Write the failing test** `makes a draining close immediate`, no tag: `poolSize: 1`, `debug: true`, default `drainTimeout`. `longQuery(20_000_000)` running (no signal). `const draining = db.close()`; then `const t0 = performance.now(); const again = db.close({ immediate: true })`.
  - `expect(again).toBe(draining)`
  - the query rejects with `CLIENT_CLOSED`
  - `await again` within `scaled(5_000)` of `t0`.

  And `ignores a draining close() called during an immediate one`, no tag: `close({ immediate: true })` then `close()` — same promise, resolves within `scaled(5_000)`.

- [ ] **Step 2: Run, see the first fail** (the second may pass).

- [ ] **Step 3: Implement.** `close(options)` with `closing` already set and `options?.immediate`: escalate — abort `immediateAbort`, and cut short every wait the draining close is in. One way: the draining close races each `drainTimeout`-bounded wait against a promise the escalation resolves, then continues on the immediate path (grace, terminate a non-interruptible worker still `serving()`). Return `closing` in every case.

- [ ] **Step 4: Run the whole file and `close.test.ts`.** Expected: PASS.

- [ ] **Step 5: `pnpm check`, then commit**

```bash
git add src/client.ts tests/browser/pairs/close-immediate.test.ts
test "$(git branch --show-current)" = feat/close-immediate && git commit -m "feat(close): let close({ immediate: true }) cut a draining close short"
```

### Task 4: Documentation

**Files:**
- Modify: `API.md` (§ *client*.close, § Interrupting a call, the `CLIENT_CLOSED` row of the error table, § the transaction note "A statement in flight inside a transaction is abandoned; one outside is not")
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1: `API.md`, § *client*.close.** An option table with one row (`immediate`, `boolean`, `false`, one line, `[More info](#immediate)`), and a `#### immediate` subsection in consumer terms, following `mem:conventions` § Writing for the consumer (bold lead sentence then `<br>`, no counts, no measured figures, no mechanism):
  - what it does: interrupts the statements in flight, which reject with `CLIENT_CLOSED`, and does not wait `drainTimeout`;
  - where a statement cannot be stopped (the `sync` build without cross-origin isolation, link to § Interrupting a call), its worker is terminated: a write it was running is lost, and rolled back at the next open;
  - a write that completed just before may reject although it landed;
  - a `bulkWrite()`/`output()` load's `close()` rejects with `BULK_WRITE_FAILED`, whose `cause` is `CLIENT_CLOSED`;
  - Safari keeps a terminated worker's statement running: on that build, a write rejected this way may still land after `close()` resolved, and a client opened at once on the same database may fail;
  - calling it during a draining `close()` makes that close immediate.
  Adjust the section's lead line ("Drains in-flight work…") to say it drains unless `immediate`. In § Interrupting a call and the error table's `CLIENT_CLOSED` row, one clause each pointing to `close({ immediate: true })`. In the transaction note, the "one outside is not" sentence gains "unless `close({ immediate: true })`".

- [ ] **Step 2: `CHANGELOG.md`** through the `changelog-maintenance` skill: one `### Added` entry, e.g. **`close()` takes `{ immediate: true }`**, which interrupts the statements in flight instead of waiting for them; they reject with `CLIENT_CLOSED`.

- [ ] **Step 3: `pnpm check` and `pnpm docs:vfs` with `git diff --exit-code VFS.md README.md`.** Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add API.md CHANGELOG.md
test "$(git branch --show-current)" = feat/close-immediate && git commit -m "docs(close): document close({ immediate: true })"
```

### Delivery (not a task)

`node scripts/hook-gate.ts delivery --run`, its report read (the `Test Files` line included). The branch touches `src/pool.ts`: the Ubuntu matrix runs on GitHub before the merge (`mem:conventions` § What runs where) — ask the user to push the branch first. Then report to the user; merge only on their approval.
