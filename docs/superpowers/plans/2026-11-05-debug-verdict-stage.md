# The verdict in the debug tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verdict appears in `db.debug`: as a request of `kind: 'verdict'` when it takes its own lease, as an `internal` query of the transaction's request when a transaction asks it on its own worker; its query carries run stages like any query's.

**Architecture:** The worker gives verdicts a run-stage tracker of their own (a verdict can run while a query of the same worker is paused) and adds `elapsed`/`prepared` to a debug worker's verdict replies. The pool keeps a debug handle per pending verdict, by `callId`. The client instruments the verdict's lease as it does a read's or a write's; the debug tree restores the slot's previous active request at the end of a borrowed lease.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), wa-sqlite in Web Workers, Vitest (unit; browser through WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-11-05-debug-run-stage-design.md`, § Addendum — the verdict in the debug tree (the rest of the spec is built: `docs/superpowers/plans/2026-11-05-debug-run-stage.md`).

## Global Constraints

- Branch `feat/debug-run-stage`, main checkout, no worktree; check the branch in the same command as each commit.
- Code is read and edited with Serena's symbolic tools; no Python/sed scripts on code files; built-in Read/Edit/Grep on code only when Serena fails. Never `$1` in a `replace_content` replacement.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. `pnpm exec tsc --noEmit` and `pnpm check` before each commit; a failing hook is reported verbatim. After committing: `git log --oneline -1`, `git show --stat HEAD`.
- Conventional Commits, body says why, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every commit green.
- A non-debug client pays at most one boolean or optional-chaining test per site: no message, no clock read, no allocation, no new field in a reply. Nothing is added inside `rows()` in `src/worker/worker.ts`.
- `RequestDebugState.kind` is exactly `'read' | 'write' | 'verdict'`.
- A verdict's `run` messages never set `db.debug.workers[i].run` (that field is the query in flight's).

## Review Focus

- **A verdict served while a query of the same worker is paused for credit:** the query's tracker, `debugQuery` and `workers[i].run` are untouched by the verdict (Task 2: the separate tracker and the per-`callId` handle).
- **A borrowed lease** (`offer()`): at its release the transaction's request is the slot's active request again; the transaction's next query is recorded in it (Task 1 unit test).
- **A verdict whose worker dies:** its debug query ends failed through `poison`, like the query's (Task 2).
- **A verdict served from the worker's statement cache** (`verdictOf`'s cache hit): no `preparing`, `prepared: 0` (Task 2).
- **`askVerdict`'s retry loop:** each lease is its own request; a lease that failed records its error (Task 2, through the same wrapper as `acquireInstrumented`).

---

### Task 1: The debug tree knows verdict requests and borrowed leases

**Files:**
- Modify: `src/debug.ts`
- Test: `tests/unit/lib/debug.test.ts`

**Interfaces:**
- Produces:
  - `RequestDebugState.kind: 'read' | 'write' | 'verdict'`; `createRequestDebugState(kind: RequestDebugState['kind'])`.
  - `RequestDebugHandle.acquired: (index: number, borrowed?: boolean) => void` — when `borrowed`, the slot's current active request is remembered and `released()` makes it active again (only if the slot's active request is still this one); unborrowed, unchanged behaviour.

- [ ] **Step 1: Write the failing tests** in `debug.test.ts`, on the file's fixtures:
  - `records a verdict request`: `createRequestDebugState('verdict')` → `state.requests[0]?.kind === 'verdict'`.
  - `gives the slot back to the request a borrowed lease interrupted`: `tx = createRequestDebugState('write'); tx.acquired(0)`; `v = createRequestDebugState('verdict'); v.acquired(0, true)`; a query from the slot's worker handle attaches to `v` (`v`'s record has it in `queries`); `v.released()`; a second query attaches to `tx`; `tx`'s record has `endTime` undefined.
  - `clears the slot at the release of an unborrowed lease, as before`: `r.acquired(0); r.released()` → a query from the worker handle returns `undefined`.
- [ ] **Step 2: Run** `pnpm test:unit -- tests/unit/lib/debug.test.ts` — the new tests fail.
- [ ] **Step 3: Implement** in `src/debug.ts`.
- [ ] **Step 4: Run** the same command and `pnpm exec tsc --noEmit` — green.
- [ ] **Step 5: Commit** — `feat(debug): verdict requests, and a borrowed lease gives its slot back`.

---

### Task 2: The verdict reports its stages, and the client records its lease

**Files:**
- Modify: `src/types/protocol.ts` (the `verdict` reply gains `elapsed?: number` and `prepared?: number`; `verdict-error` gains `elapsed?: number`)
- Modify: `src/worker/worker.ts`
- Modify: `src/pool.ts`
- Modify: `src/client.ts` (`verdictDeps.acquire`)
- Modify: `tests/browser/pairs/run-stages.test.ts`
- Modify: `API.md` § Debugging; `CHANGELOG.md` `[Unreleased]` (through `changelog-maintenance`)

**Interfaces:**
- Consumes: Task 1's `createRequestDebugState('verdict')` and `acquired(index, borrowed)`; `createRunStageTracker` (`src/worker/run-stages.ts`); `QueryDebugHandle.stage/done/failed` (`src/debug.ts`).

**The sites:**
- **Worker** (`open()`): `const verdictStages = debug ? createRunStageTracker((m) => self.postMessage(m)) : undefined` beside the query's `stages`. `case 'verdict'`: `verdictStages?.start(callId)`; `if (held) { verdictStages?.enter('awaiting-turn'); await held; }`. In `verdictOf`, on a cache miss only, `verdictStages?.enter('preparing')` before `statements.next()`. Replies: `const elapsed = verdictStages?.end()`; a debug worker adds `elapsed` when defined, and on `verdict` `prepared` (1 when `verdictOf` compiled, 0 on a cache hit) — assigned on the reply object only when `verdictStages` exists, no spread.
- **Pool** (`createPoolWorker`): `const verdictDebug = new Map<number, QueryDebugHandle>()`. In `verdict(sql)`: `const handle = debugWorker?.query(sql, undefined, true); if (handle) verdictDebug.set(callId, handle);`. `case 'run'`: after the query's guarded branch, `else verdictDebug.get(data.callId)?.stage(data.stage, data.elapsed)` — never `debugWorker.run`. `case 'verdict'`: `verdictDebug.get(callId)?.done(0, data.prepared ?? 0, data.elapsed)`, delete. `case 'verdict-error'`: `…failed(error, data.elapsed)`, delete. `poison`: every handle in `verdictDebug` `failed(error)`, then clear.
- **Client** (`verdictDeps.acquire`): `const request = clientDebug?.createRequestDebugState('verdict')`; without it, unchanged; with it, on the lease `request.acquired(lease.worker.index, lease.borrowed === true)` and a `release` wrapper calling `request.released()` first (the shape `acquireLease` uses); on rejection `request.failed(error)` and rethrow.

- [ ] **Step 1: Write the failing browser tests** in `run-stages.test.ts` (`debug: true`, `poolSize: 1`):
  - `a first read is classified in a verdict request of its own`: `const SQL = 'SELECT 41 + 1 AS v'`; `await db.all(SQL)`; the requests are, in order, a `kind: 'verdict'` request whose only query has `sql === SQL`, `internal: true` and a `preparing` key in `stages`, then a `kind: 'read'` request whose query with `sql === SQL` has no `preparing`; the verdict request's `endTime` is set and `<=` the read request's `acquireTime`.
  - `a statement given its own signal in a transaction is classified in the transaction's request`: `const SQL = 'INSERT INTO t VALUES (7)'` after `CREATE TABLE t (a)`; `await db.transaction(async (tx) => { await tx.write(SQL, [], { signal: new AbortController().signal }); })` (use the transaction method that runs a write with options — check `API.md`'s transaction section for its name and signature); the transaction's request has, before the statement's own query, an `internal` query with `sql === SQL` and a `preparing` key; no `kind: 'verdict'` request holds `SQL`.
- [ ] **Step 2: Run** `node scripts/test-plan.ts --browser chrome tests/browser/pairs/run-stages.test.ts` (background) — the new tests fail.
- [ ] **Step 3: Implement** the protocol, worker, pool and client sites.
- [ ] **Step 4: Run** the file on chrome and firefox, then `tests/browser/pairs/lifecycle.test.ts` and `tests/browser/pairs/tx-savepoint.test.ts` on chrome as regression checks of the verdict and borrowed paths, and `pnpm test:unit`; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Docs** — `API.md`: the request's `kind` is `'read'`, `'write'` or `'verdict'`, with one line on what a verdict request is (the classification of a SQL text the client sees for the first time, with its wait and compile); the sentence saying a first-seen SQL text is compiled outside the debug tree is replaced by what is now true. `CHANGELOG.md`: the `Added` entry of the run stages gains one sentence on verdict requests.
- [ ] **Step 6: Commit** — `feat(debug): a verdict shows its wait and compile`.
