# Debug run stages, and boot stages as codes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A debug client's workers report boot stages as codes and the stage of the query they run, live (`db.debug.workers[i].run`) and as per-stage durations on each query record (`stages`); four tests use them to prove the step they cut was running.

**Architecture:** The `open` message tells the worker it serves a debug client. A small tracker in the worker (`src/worker/run-stages.ts`) posts a `run` message at each stage change with the duration of the stage it ends, measured on the worker's clock; the query's terminal reply carries the last one. The pool relays them to `src/debug.ts`, which sets the worker's `run` and cumulates the query's `stages`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), wa-sqlite in Web Workers, Vitest (unit project; browser projects through WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-11-05-debug-run-stage-design.md` — read it whole before Task 1.

## Global Constraints

- Branch `feat/debug-run-stage`, in the main checkout (`/workspaces/wsqlite`), no worktree. Every commit command checks the branch first: `test "$(git branch --show-current)" = feat/debug-run-stage && git commit …`.
- Code is read and edited with Serena's symbolic tools (`get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `replace_symbol_body`, `insert_*_symbol`, `replace_content`); built-in Read/Edit/Grep on code files only when Serena fails. `.md`/JSON/YAML may use Read/Edit. Never `$1` in a `replace_content` replacement.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. Run `pnpm exec tsc --noEmit` and `pnpm check` before each commit; if the hook fails, stop and report its output verbatim. After committing: `git log --oneline -1` and `git show --stat HEAD`.
- Every commit lands green (its own tests pass); Conventional Commits; body says why; ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Boot codes, exactly: `awaiting-client`, `loading-build`, `instantiating-wasm`, `loading-vfs-module`, `creating-vfs`, `awaiting-open-lock`, `opening-database`, `awaiting-held-file`, `applying-pragmas` (replacing, in that order, `waiting for the client`, `loading the build`, `instantiating wasm`, `loading the VFS module`, `creating the VFS`, `waiting for the open lock`, `opening the database`, `waiting for a held file`, `applying pragmas`).
- Run codes, exactly: `RunStage = 'awaiting-turn' | 'preparing' | 'stepping' | 'computing' | 'awaiting-credit'`.
- A non-debug client pays one boolean (or optional-chaining) test per transition site and per progress-handler call: no message, no `performance.now()`, no allocation. **Nothing is added inside the per-row path of `rows()` in `src/worker/worker.ts`** (code in that generator, executed or not, cost Firefox 6-16 % of stream throughput: `mem:measurements/routing`, ROUTING-DELTAS).
- Comments state the fact in one or two lines; no hard wrapping in Markdown prose.
- A test whose precondition is missed calls `exercised(reached, 'what was missed')` (`tests/browser/helpers/exercised.ts`) after its own cleanup and returns — never an `expect` on the precondition. A bound a test writes goes through `scaled()`.

## Review Focus

- **A paused stream on a non-debug client:** no `run` message, no extra cost; a stream's throughput on Firefox Memory `async` stays with `main` (Task 6 measures it).
- **A `computing` from outside the step:** a verdict prepared while the query waits for credit runs the progress handler with the worker's `stepping` flag false; no `computing` may be posted then (Task 4, guarded by the flag).
- **A worker that dies mid-query:** its query's `stages` closes the current stage on the page's clock and `workers[i].run` is cleared (Task 3 unit test, Task 4 wiring in `poison`).
- **A cached statement:** no `preparing`; a statement re-prepared by SQLite inside `step()` (schema change) counts as `stepping` (Task 4 browser test for the first half).
- **A `run` message for a query the pool no longer serves** (late, after `done`): ignored, as `chunk` is, by the `callId === currentCallId` guard (Task 4).

---

### Task 1: Boot stages are codes, and posted only by a debug worker

**Files:**
- Modify: `src/types/protocol.ts` (`BootStage`; `ClientMessageData`'s `open` gains `debug?: true`)
- Modify: `src/worker/worker.ts` (`OpenOptions` gains `debug?: true | undefined`; the top-level `onmessage` relays it to `open()`; `boot` in `open` posts nothing unless `debug`; every `boot('…')` call uses its code)
- Modify: `src/pool.ts` (`createPoolWorker`'s `open` message: `...(createWorkerDebugState ? { debug: true as const } : {})`)
- Modify: `tests/browser/pairs/abort-slot.test.ts`, `tests/browser/pairs/lifecycle.test.ts`, `tests/browser/pairs/open-retry.test.ts` (every old phrase → its code; find them with a search for each of the nine phrases under `tests/`)
- Modify: `API.md` § Debugging, the `workers` row: `boot` lists the codes
- Modify: `CHANGELOG.md` `[Unreleased]` → `Breaking` entry, through the `changelog-maintenance` skill
- Test: `tests/browser/pairs/lifecycle.test.ts`

**Interfaces:**
- Produces: `BootStage` (codes above); `ClientMessageData` `open` with `debug?: true`; `OpenOptions.debug`. Task 4 reads `debug` inside `open()`.

- [ ] **Step 1: Write the failing tests** in `lifecycle.test.ts`, with `interceptWorkers()` (`tests/browser/helpers/index.ts`) set up before the client:
  - `it('a debug client\'s worker reports its boot stages as codes')`: `createTestClient({ poolSize: 1, debug: true })`, `await db.all('SELECT 1')`; `expect(records[0]?.stages).toEqual(expect.arrayContaining(['loading-build', 'instantiating-wasm', 'loading-vfs-module', 'creating-vfs', 'opening-database', 'applying-pragmas']))` and `expect(db.debug?.workers[0]?.boot).toBe('applying-pragmas')`.
  - `it('a client without debug receives no boot stage')`: `createTestClient({ poolSize: 1 })`, `await db.all('SELECT 1')`; `expect(records[0]?.received).toContain('ready')` and `expect(records[0]?.received).not.toContain('boot')`.
- [ ] **Step 2: Run them, see them fail** — `node scripts/test-plan.ts --browser chrome tests/browser/pairs/lifecycle.test.ts`; expected: the first fails on the phrases, the second on a received `boot`.
- [ ] **Step 3: Implement** the protocol, worker and pool changes listed under Files; update the three test files' phrases to codes.
- [ ] **Step 4: Run** the three test files on chrome and firefox (`--browser firefox`) — all pass; `pnpm exec tsc --noEmit`, `pnpm test:unit` green.
- [ ] **Step 5: Docs** — `API.md` workers row; `CHANGELOG.md` `Breaking`: the boot stages of `db.debug.workers[i].boot` are codes (list them), and a worker reports them only for a client created with `debug`.
- [ ] **Step 6: Commit** — `feat(debug)!: boot stages are codes, posted only for a debug client`, body: why; then a paragraph of its own `BREAKING CHANGE: BootStage's values are codes (awaiting-client, …) instead of English phrases.`; then `Co-Authored-By`.

---

### Task 2: The worker's run-stage tracker

**Files:**
- Modify: `src/types/protocol.ts` (`RunStage`; `WorkerMessageData` gains `{ type: 'run'; callId: number; stage: RunStage; elapsed?: number }`; the query replies `done` and `error` gain `elapsed?: number`)
- Create: `src/worker/run-stages.ts`
- Test: `tests/unit/lib/run-stages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RunStageTracker = {
    /** A query begins: no stage yet. */
    start(callId: number): void;
    /** Posts a `run` message when `stage` differs from the current one. */
    enter(stage: RunStage): void;
    /** The query ends: the current stage's duration, undefined when none was entered. */
    end(): number | undefined;
  };
  export const createRunStageTracker: (
    post: (message: Extract<WorkerMessageData, { type: 'run' }>) => void,
    now?: () => number, // default () => performance.now()
  ) => RunStageTracker;
  ```
- Rules the tests pin: the first `enter` after `start` posts no `elapsed`; each later change posts `elapsed = now() - (instant the current stage began)`; `enter(s)` with `s` equal to the current stage posts nothing; **`enter('stepping')` while the current stage is `computing` posts nothing** (spec, § When the worker announces each stage: `stepping` follows the first step of a statement or a wait, never `computing`; the worker calls `enter('stepping')` after each chunk handed over, waited or not, and this rule is what keeps a long statement in `computing`); `end()` returns the current stage's duration and leaves no current stage.

- [ ] **Step 1: Write the failing tests** (fake clock `let t = 0; const now = () => t;`, `post` collecting into an array):
  - `posts the first stage without elapsed`: `start(7); enter('preparing')` → `[{ type: 'run', callId: 7, stage: 'preparing' }]` (no `elapsed` key).
  - `posts each change with the duration of the stage it ends`: `start(1); t=10; enter('preparing'); t=13; enter('stepping'); t=20; enter('awaiting-credit')` → elapsed `3`, then `7`.
  - `posts nothing for the stage already current`: two `enter('stepping')` → one message.
  - `treats stepping during computing as no change`: `enter('stepping'); enter('computing'); enter('stepping')` → two messages; then `enter('awaiting-credit')` posts with the duration since `computing` began.
  - `end returns the current stage's duration, undefined when none`: `start(1); expect(end()).toBeUndefined()`; `start(2); t=5; enter('stepping'); t=9; expect(end()).toBe(4)`.
  - `start forgets the previous query`: `start(1); enter('stepping'); start(2); enter('stepping')` → second message has `callId: 2` and no `elapsed`.
- [ ] **Step 2: Run** `pnpm test:unit -- tests/unit/lib/run-stages.test.ts` — fails (module missing).
- [ ] **Step 3: Implement** the protocol types and `src/worker/run-stages.ts`.
- [ ] **Step 4: Run** the same command — passes; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(worker): a run-stage tracker for debug workers`.

---

### Task 3: The debug tree records `run` and `stages`

**Files:**
- Modify: `src/debug.ts`
- Modify: `src/index.ts` (export type `RunStage` beside `BootStage`)
- Test: `tests/unit/lib/debug.test.ts`, `tests/unit/lib/exports.test.ts` (add `RunStage`)

**Interfaces:**
- Consumes: `RunStage` (Task 2).
- Produces (all in `src/debug.ts`):
  - `export type { BootStage, RunStage }`.
  - `WorkerDebugState.run?: RunStage` — readonly; absent when idle.
  - `QueryDebugState.stages: Readonly<Partial<Record<RunStage, number>>>` — `{}` at creation.
  - `WorkerDebugHandle.run: (stage: RunStage | undefined) => void` — sets `run`, or deletes it on `undefined`.
  - `QueryDebugHandle.stage: (stage: RunStage, elapsed: number | undefined) => void`
  - `QueryDebugHandle.done: (affected: number, prepared: number, elapsed?: number | undefined) => void`
  - `QueryDebugHandle.failed: (error: unknown, elapsed?: number | undefined) => void`
- Cumulation rule: the query handle keeps its current stage and the page instant (`performance.now()`) it began. `stage(s, e)`: if a stage is current, add `e` to it — or, when `e` is undefined, the page time since it began; then `s` is current. `done`/`failed`: same closing of the current stage with the `elapsed` given, else page time; then no stage is current. Once `endTime` is set, `stage` does nothing (as `chunk` already does).

- [ ] **Step 1: Write the failing tests** in `debug.test.ts`, on the existing fixtures of the file:
  - `cumulates each stage's duration as the next one begins`: `stage('preparing', undefined); stage('stepping', 2); stage('awaiting-credit', 5); stage('stepping', 1); done(0, 1, 3)` → `stages` equals `{ preparing: 2, stepping: 8, 'awaiting-credit': 1 }`.
  - `leaves stages empty for a query that announced none`: `done(0, 0, undefined)` → `{}`.
  - `closes the current stage on the page's clock when the end brings no duration`: `vi.spyOn(performance, 'now')` returning 100 then 130; `stage('computing', undefined); failed(new Error('x'))` → `stages.computing === 30`.
  - `ignores a stage after the end`: `done(0, 0, undefined); stage('stepping', 4)` → `{}`.
  - `sets and clears the worker's run stage`: `handle.run('stepping')` → `state.workers[0]?.run === 'stepping'`; `handle.run(undefined)` → `'run' in state.workers[0]` is false.
  - In `exports.test.ts`, `RunStage` joins the exported types as `BootStage` is listed.
- [ ] **Step 2: Run** `pnpm test:unit -- tests/unit/lib/debug.test.ts tests/unit/lib/exports.test.ts` — fails.
- [ ] **Step 3: Implement** in `src/debug.ts` and `src/index.ts`. Existing callers of `done`/`failed` in `src/pool.ts` still compile (the new parameter is optional).
- [ ] **Step 4: Run** the same command and `pnpm exec tsc --noEmit` — green.
- [ ] **Step 5: Commit** — `feat(debug): a worker's run stage and a query's time per stage`.

---

### Task 4: Wire the stages through the worker and the pool

**Files:**
- Modify: `src/credits.ts` (`CreditGate.wouldWait: () => boolean` — `credits <= 0 && !stopped`)
- Modify: `src/worker/worker.ts`
- Modify: `src/pool.ts`
- Modify: `tests/browser/helpers/index.ts` (`theQueryIsComputing`)
- Create: `tests/browser/pairs/run-stages.test.ts`
- Modify: `API.md` § Debugging (the `workers` row gains `run`; the query fields gain `stages`, one line on what `stepping` and `computing` mean and that `computing` needs the progress handler — `async`/`jspi`, or `sync` under cross-origin isolation)
- Modify: `CHANGELOG.md` `[Unreleased]` → `Added` entry (`run`, `stages`, `RunStage`), through `changelog-maintenance`
- Test: `tests/unit/lib/credits.test.ts`, `tests/browser/pairs/run-stages.test.ts`

**Interfaces:**
- Consumes: `createRunStageTracker` (Task 2), the handles of Task 3, `OpenOptions.debug` (Task 1).
- Produces: `theQueryIsComputing(db, sql): () => boolean` in `tests/browser/helpers/index.ts` — the model of `theQueryIsRunning`, with the condition `db.debug?.workers[request.worker]?.run === 'computing'` in place of the `status === 'RUNNING'` one. Task 5 uses it.

**The worker's sites** (`open()` holds `const stages = debug ? createRunStageTracker((m) => self.postMessage(m)) : undefined`):
- `case 'query'`: `stages?.start(callId)` after `gate.reset`; `if (held) { stages?.enter('awaiting-turn'); await held; }`.
- Credit wait: `if (gate.wouldWait()) stages?.enter('awaiting-credit')` just before `gate.take(callId)`; the mutex taken back after it: `if (back) { stages?.enter('awaiting-turn'); await back; }`.
- Terminal replies (`done`, the `closing` `error`, the catch's `error`): `const elapsed = stages?.end()` first, then `...(elapsed !== undefined ? { elapsed } : {})`.
- `query()`, single-statement branch: `stages?.enter('preparing')` before `statements.next()`. Multi branch: before the `for await`, and as the last statement of each iteration body (wa-sqlite's next compile follows). Cache-hit branch: nothing.
- `rows()`: `stages?.enter('stepping')` once before `while (true)` and once right after `yield block` — **not** around `step_asap()`.
- Progress handler, both variants: first statement `if (stepping) stages?.enter('computing')`, before the tick / slot test.
- The pool (`createPoolWorker`'s `onmessage`): `case 'run'`: if `data.callId === currentCallId`, `debugWorker?.run(data.stage)` and `debugQuery?.stage(data.stage, data.elapsed)`. In `done` and `error` (inside their existing guards): `debugWorker?.run(undefined)` and pass `data.elapsed` to `done`/`failed`. In `poison`: `debugWorker?.run(undefined)` beside the existing `debugQuery?.failed(error)`.

- [ ] **Step 1: Write the failing unit test** in `credits.test.ts`: `wouldWait is true only with no credit left and no stop` — `reset(1, 1)` → false; after one `take(1)` → true; after `grant(1, 1)` → false; after `take`, then `stop()` → false.
- [ ] **Step 2: Write the failing browser tests** in `run-stages.test.ts` (`debug: true`, `poolSize: 1` unless said):
  - `a first statement is prepared then stepped; the same one again is only stepped`: `await db.all(SQL)` twice with `SQL = 'SELECT 1 AS a'`; the two query records whose `sql === SQL`: the first has `preparing` and `stepping` keys, the second `stepping` and no `preparing`; every value is a number `>= 0`; `db.debug?.workers[0]?.run` is undefined after.
  - `a long step is computing, live and in its record` (tag `requires:interruptible`): `const sql = longQuery(20_000_000)`; start `db.all(sql, [], { signal })`; `await waitUntil(theQueryIsComputing(db, sql), 'the query to be computing')`; abort, await the rejection; its record has `stages.computing` defined; `workers[0].run` undefined.
  - `a stream with no credit left is awaiting credit`: `db.chunk` over `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x FROM c` with `chunkSize: 1`; on the first chunk, `await waitUntil(() => db.debug?.workers[0]?.run === 'awaiting-credit', 'the worker to wait for credit')`, then `break`; its record has an `'awaiting-credit'` key.
  - `a client without debug receives no run stage`: `interceptWorkers()`, `createTestClient({ poolSize: 1 })`, `await db.all('SELECT 1')` and the chunk query above; `records[0]?.received` does not contain `'run'`.
- [ ] **Step 3: Run** `pnpm test:unit -- tests/unit/lib/credits.test.ts` and `node scripts/test-plan.ts --browser chrome tests/browser/pairs/run-stages.test.ts` — they fail.
- [ ] **Step 4: Implement** `wouldWait`, the worker sites, the pool wiring and `theQueryIsComputing`.
- [ ] **Step 5: Run** both commands again, then `--browser firefox` for the browser file — green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 6: Docs** — `API.md` and the `CHANGELOG.md` `Added` entry.
- [ ] **Step 7: Commit** — `feat(debug): report where a running query is, and where its time went`.

---

### Task 5: The four false greens prove their case

**Files:**
- Modify: `tests/browser/helpers/index.ts` (`reachedWithin`)
- Modify: `tests/browser/pairs/early-exit.test.ts`, `tests/browser/pairs/abort-slot.test.ts`

**Interfaces:**
- Consumes: `theQueryIsComputing` (Task 4), `exercised`.
- Produces: `reachedWithin(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean>` — `waitUntil`'s polling, `scaled(timeoutMs)` bound, resolves `false` at the bound instead of throwing (and rejects if the test itself ends, as `waitUntil` does).

- [ ] **Step 1: Rewrite the two `chunk()` tests** — `early-exit` "a break out of chunk() cuts the step it left running" and `abort-slot` "stops a running statement when the consumer leaves a chunk early": `debug: true` on the client; replace `await sleep(100)` by `const computing = await reachedWithin(theQueryIsComputing(db, sql), 5_000)`; `break`; keep the `SELECT 1` assertion; then, after it, `if (!(await exercised(computing, 'the count was not computing before the break'))) return;`.
- [ ] **Step 2: Rewrite the two `first()` tests** — `early-exit` "first() cuts the step it left running" and `abort-slot` "stops a running statement when first() leaves it, with no signal": `debug: true`; after the `SELECT 1` assertion, find the record of `sql` (the last query with that `sql` in `db.debug.requests`) and `if (!(await exercised(record?.stages.computing !== undefined, 'the count was not computing when first() left it'))) return;`.
- [ ] **Step 3: Falsify one** — temporarily make the progress handler return `0` always (no cut) in `src/worker/worker.ts`, build, run `early-exit.test.ts` on chrome: the `chunk()` test must time out red, not pass and not report `not-exercised`; revert, and `git diff src/` is empty.
- [ ] **Step 4: Run** both files on chrome and firefox — green, none listed under "Not exercised".
- [ ] **Step 5: Commit** — `test: the early-exit and abort-slot cuts prove the step was running`.

---

### Task 6: Delivery verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Stream throughput** — measure Firefox Memory `async` and WriteAhead `sync` `stream()` of 1 000 000 rows, `main` against the branch, with the method of ROUTING-DELTAS (`mem:measurements/routing`: arms from `git archive`, interleaved, n ≥ 8, median and quartiles). A delta outside the quartiles is reported to the user with its numbers before going further.
- [ ] **Step 2: Delivery gate** — `node scripts/hook-gate.ts delivery --run` in the background; report read, the `Test Files` line included, and the "Not exercised" list empty.
- [ ] **Step 3: Report** to the user; the GitHub matrix run (the branch touches `src/pool.ts` and `src/worker/`) needs the user to push the branch — ask.
