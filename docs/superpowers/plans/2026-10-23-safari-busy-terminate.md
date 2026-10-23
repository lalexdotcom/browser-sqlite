# Interrupt before terminate, and a clear error for a file a killed statement holds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Safari up to 27.0.1 `terminate()` does not stop a worker inside a WASM loop (WebKit 328618), so a worker the library kills mid-statement keeps its OPFS files. Stop that statement through the interrupt slot where one exists, and where none exists let the replacement wait for the file up to the open timeout, then fail with an error that says why.

**Architecture:** Two independent changes on one branch. (1) `PoolWorker.terminate()` writes a "killed" sentinel into the worker's abort slot when a statement is running, the worker's progress handler stops on it, and the slot is zeroed when the replacement reports `ready` instead of when it is created. (2) A death reports whether a statement was running; the replacement's `open` carries `afterDeath: 'idle' | 'busy'` and, for `busy`, a deadline under the client's open timer; `openWithRetry` waits a held file until that deadline and, if it is still held, fails with a dedicated message.

**Tech Stack:** TypeScript, wa-sqlite, Vitest browser mode on WebdriverIO (Chrome, Firefox; Safari on macOS CI).

**Spec:** none written — a small change, designed and approved in chat with the user on 2026-10-23. Its decisions are restated under Global Constraints; the measurements behind it are SAFARI-TERMINATE-WASM and SAFARI-WASM-INSTANTIATE in `.serena/memories/measurements/test-browsers/library.md`.

## Global Constraints

- Code stays `WORKER_CRASHED` for the new failure; no new error code.
- The new message, exactly (`<file>` is the worker's database file name):
  `Could not reopen '<file>': the worker it replaces was terminated mid-statement and still holds the file. Some engines (Safari up to 27.0.1, WebKit #328618) cannot stop it. Use the async or jspi build, or cross-origin isolation, so the library can interrupt the statement.`
- Its `cause` is the VFS's error (`lastError`, the browser's `InvalidStateError` / `NoModificationAllowedError`); the message does not repeat it.
- No user-agent or version sniffing in `src/`: the library reacts to what it observes (a statement was running at the death, the file is held).
- The `idle` after-death retry keeps `OPEN_RETRY_BUDGET_MS` (2 500 ms) unchanged.
- `busy` waits until `openDeadline = Date.now() at spawn + openTimeout − 1 000 ms`, never less than `OPEN_RETRY_BUDGET_MS`. The 1 000 ms margin lets the worker's error reach the client before the client's own `TIMEOUT` timer.
- Every Serena rule of `AGENTS.md` applies to code edits (symbolic tools first, never `$1` in a replacement).
- Each commit is green: `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, and the browser tests the task names.

## Review Focus

1. **The replacement must not inherit the sentinel.** A slot left at the sentinel would abort every polled statement of the next worker in that slot: the zeroing at `ready` is the guard — `abort-slot.test.ts` › "does not carry a dead worker's abort into its replacement" must stay green, with its comment updated to the new place.
2. **A death with no statement running** (idle kill, `openTimeout` expiry, `failClient` on an idle pool) must stay `idle`: 2.5 s, the engine's own error, unchanged messages. Task 2's idle test pins it.
3. **A holder that is not ours** (another app on the origin) after a busy death now waits up to the open timeout before failing — accepted (the slot is being restarted anyway), but the error then still names a killed statement; acceptable because only a busy death selects it.
4. **`close()` and `failClient` terminating a busy worker** go through the same `terminate()` and now write the sentinel; nothing reads the slot afterwards. No test needed beyond Task 1's.
5. **The startup retry round** (`onFirstSettle` → `spawn(index, …)`) follows an open that failed, not a statement: it passes `'idle'`.

---

### Task 1: Interrupt a running statement before terminating its worker

**Files:**
- Modify: `src/pool.ts` — `createPoolWorker`: the slot zeroing (~l. 329-332) moves to the `'ready'` case of the message handler (~l. 535); the `terminate` override (~l. 975-993) writes the sentinel first.
- Modify: `src/worker/worker.ts` — `abortedHere` (~l. 769) also stops on the sentinel.
- Modify: `src/types/protocol.ts` (or the module that already shares constants between pool and worker; follow where `PROGRESS_OPS`-like shared values live) — export `KILLED_SLOT = -1`.
- Modify: `tests/browser/helpers/index.ts` — `killedStatementRuns()` skips only off cross-origin isolation.
- Test: `tests/browser/pairs/abort-slot.test.ts`

**Interfaces:**
- Produces: `KILLED_SLOT: -1` (exported constant). No signature changes.

- [ ] **Step 1: Write the failing test** in `abort-slot.test.ts`, inside `describe('the sync build, isolated', …)`, tagged additionally `vfs:AccessHandlePoolVFS` (an exclusive handle the killed worker keeps until its statement stops):

```ts
it("stops a killed worker's statement, so its replacement opens at once", async () => {
  const records = interceptWorkers();
  const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 1 });
  await db.write('CREATE TABLE t (a)');
  const running = db.read(longQuery(20_000_000));
  await waitUntil(theQueryIsRunning(db, longQuery(20_000_000)), 'the query to be running');
  const killedAt = performance.now();
  records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
  await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  await waitUntil(() => records[1]?.received.includes('ready') ?? false, 'the replacement to be ready', 10_000);
  // Chromium stops a terminated worker's WASM after ~2 s (HANDLE-CORPSE); the slot stops it at the next progress check.
  expect(performance.now() - killedAt).toBeLessThan(1_000);
  await db.close();
});
```

- [ ] **Step 2: Run it and see it fail** — `node scripts/test-plan.ts --browser chrome --modes isolated --pair AccessHandlePoolVFS/sync tests/browser/pairs/abort-slot.test.ts`. Expected: the new test fails on the `< 1000` assertion (≈ 2 000 ms or more). If it passes, the premise is wrong: stop and report the measured time.

- [ ] **Step 3: Implement.** In `terminate`, before `nativeTerminate()` / `quiesceThenTerminate()`: when `servingQuery !== undefined && abortSlots`, `Atomics.store(new Int32Array(abortSlots), index, KILLED_SLOT)`. In `abortedHere`: true when the slot value is `callId` or `KILLED_SLOT`. Move `new Int32Array(abortSlots)[index] = 0` from worker creation to the `'ready'` case, with its comment rewritten: the replacement runs no polled statement before `ready`, so zeroing there keeps both guards (the predecessor's last callId, and the sentinel the predecessor must still read).

- [ ] **Step 4: Run** the Step 2 command, then the whole file on `--modes isolated` for Chrome and Firefox (`--pair OPFSWriteAheadVFS/sync --pair AccessHandlePoolVFS/sync`). Expected: all green, the replacement test included.

- [ ] **Step 5: Re-enable the WebKit 328618 tests where the slot exists.** `killedStatementRuns()` returns the skip reason only when `!ENVIRONMENT.isolated` (keep its other conditions; update its JSDoc: the slot stops the statement under isolation). Run `pnpm test` (Chrome, Firefox): expected green, and the "Skipped with a reason" list unchanged on Chrome/Firefox (the helper only ever skips on Safari).

- [ ] **Step 6: Commit** — `feat(pool): interrupt a running statement before terminating its worker`, body: why (WebKit 328618 keeps a terminated worker's WASM running; under isolation the slot can stop it).

### Task 2: After a busy death, wait for the file up to the open timeout, then say why

**Files:**
- Modify: `src/types/protocol.ts` — the `open` message: `afterDeath?: 'idle' | 'busy'` (replaces `boolean`), new `openDeadline?: number` (epoch ms, `Date.now()` clock).
- Modify: `src/pool.ts` — `deps.onDeath?: (index: number, error: SQLiteError, busy: boolean) => void`; `die()` passes `busy = servingQuery !== undefined`, read before `poison()`; `deps.afterDeath` and `deps.openDeadline` typed and forwarded in the `open` message.
- Modify: `src/client.ts` — `handleDeath(index, error, busy = false)`; `spawn(index, afterDeath?: 'idle' | 'busy')`: the post-startup restart passes `busy ? 'busy' : 'idle'`, the startup retry round passes `'idle'`; for `'busy'` it sends `openDeadline: Date.now() + openTimeout - HELD_REPORT_MARGIN_MS` with `HELD_REPORT_MARGIN_MS = 1_000`.
- Modify: `src/worker/worker.ts` — `openWithRetry(sqlite, file, vfs, lastError, afterDeath: 'idle' | 'busy' | undefined, openDeadline: number | undefined)`; the open's `.catch` reports the new error's message as is, its cause the VFS error.
- Test: `tests/browser/pairs/open-retry.test.ts`, in `describe('reopening a database after its worker died', …)`.
- Docs: `CHANGELOG.md` `[Unreleased]` (through the `changelog-maintenance` skill), `README.md` § Known Limitations › Aborting a call.

**Interfaces:**
- Consumes: Task 1's `terminate()` (unchanged signature).
- Produces: `afterDeath: 'idle' | 'busy'` in the `open` message; `onDeath(index, error, busy)`.

- [ ] **Step 1: Write the failing tests**, both tagged `['vfs:OPFSAdaptiveVFS', 'browser:firefox']` like their neighbour, built on its `exclusiveHolder()`, `records`, `killSilently` + `dispatchEvent` sequence, but with a read running at the kill (`const running = db.read(longQuery(20_000_000)); await sleep(100);` before `killSilently`), `maxWorkerRestarts: 1`:
  - `'waits past the idle budget when the dead worker was mid-statement'`: holder `graceMs: 4_000` (over 2 500); expect `running` to reject `WORKER_CRASHED`, then `db.read('SELECT 1 AS n')` → `[{ n: 1 }]`, `records.length === 2`.
  - `'fails with the reason when a killed statement keeps the file'`: holder `graceMs: 60_000` (never within the test), client `openTimeout: 6_000`; expect `db.read('SELECT 1')` to reject with `{ code: 'WORKER_CRASHED', message: expect.stringContaining('WebKit #328618') }`, `message` containing `"Use the async or jspi build, or cross-origin isolation"`, `cause.name === 'NoModificationAllowedError'`, and not `code: 'TIMEOUT'`.
  - Review Focus 2, in the same describe: the existing `'waits out the file its predecessor still holds'` (idle kill, 200 ms grace) stays green unchanged.

- [ ] **Step 2: Run them and see them fail** — `node scripts/test-plan.ts --browser firefox --modes not-isolated --pair OPFSAdaptiveVFS/jspi tests/browser/pairs/open-retry.test.ts`. Expected: the first fails (the 2.5 s budget gives up before 4 s), the second fails on the message.

- [ ] **Step 3: Implement** as the Files block says. `openWithRetry`'s deadline: `afterDeath === 'busy' && openDeadline !== undefined ? Math.max(Date.now() + OPEN_RETRY_BUDGET_MS, openDeadline) : Date.now() + OPEN_RETRY_BUDGET_MS`. When it gives up with `afterDeath === 'busy'` and `isHeldElsewhere(lastError())`, it throws an error carrying the Global Constraints message (a small `HeldByKilledStatement extends Error` local to `worker.ts` is the expected shape), and the open's `.catch` sends that message without appending `detail`, with `cause` the VFS error. Update `openWithRetry`'s JSDoc ("Except after a death") for the two budgets.

- [ ] **Step 4: Run** the Step 2 command, then `pnpm test`. Expected: green; `pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Docs.** CHANGELOG `[Unreleased]` › `### Changed` (through the `changelog-maintenance` skill): a worker the library terminates mid-statement is interrupted first under cross-origin isolation; otherwise its replacement waits for the file up to `openTimeout` and fails with a `WORKER_CRASHED` that names the cause (Safari ≤ 27.0.1, WebKit 328618). README § Aborting a call: two sentences saying the same for the consumer, pointing to the same way out (non-`sync` build or isolation).

- [ ] **Step 6: Commit** — `feat(client): wait out a file a killed statement holds, then say why`.

### Task 3: Safari validation (main session, not a subagent)

- [ ] Push the branch (authorized for this work's runs) and dispatch `tests-macos-26.yaml` and `tests-macos-27.yaml` on it, unchanged: the isolated Safari cells must run the four WebKit 328618 tests green, the non-isolated ones keep them skipped; both runs green. Progress to the user every 2 minutes.
