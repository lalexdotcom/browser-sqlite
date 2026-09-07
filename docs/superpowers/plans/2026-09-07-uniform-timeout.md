# Uniform `timeout` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `timeout` a wall-clock budget counted from the call, on every one of the seven methods that accept a `signal`.

**Architecture:** `timeout` stops being enforced in the worker and becomes an `AbortController` this library owns, aborted by a `setTimeout` whose abort *reason* is the `SQLiteError` itself. `mergeSignals` relays a reason verbatim and every abort path in the library already rejects with `signal.reason`, so the typed error reaches the caller with no translation layer anywhere. The worker's execution-budget machinery is deleted.

**Tech Stack:** TypeScript, rstest (three configs: `unit`, `chromium`, `firefox`, plus an isolated project), biome, pnpm.

**Spec:** [`docs/superpowers/specs/2026-09-07-uniform-timeout-design.md`](../specs/2026-09-07-uniform-timeout-design.md) — read it before Task 1. This plan argues from it and does not restate its reasoning.

## Global Constraints

- **Never commit on a RED tree.** The pre-commit hook runs all three rstest configs and refuses a red tree, so the usual "write the failing test / commit / implement / commit" shape cannot be executed here. Every task below writes the test AND the implementation before its single commit. Run the test in between and observe the failure — just do not commit there.
- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` / `replace_in_files` to edit. Built-in Read/Edit only for `.md` files or when Serena fails.
- **Do not rename through the LSP after replacing a symbol body in the same file.** `rename_symbol` computes ranges against a stale view and has corrupted comments and destructuring patterns in this repo. Rename textually with `replace_in_files`, then run `pnpm exec tsc --noEmit` immediately.
- **Run `pnpm check` after every modification** (biome, `--write`). Baseline is 13 warnings and 1 info; that number must not grow.
- **Read four fields from a test report, not three:** `status`, `failedFiles`, `tests`, `failedTests`. An unhandled rejection outside any test shows in the first two only.
- **Name the falsifier for every test you write, then run it** — delete or neutralise the line the test depends on, observe RED, restore, observe GREEN. A reasoned claim of falsifiability is worth nothing here; four were wrong in one wave.
- **Push back.** This plan was written by the same head that wrote the spec and therefore inherits its blind spots. If a step asserts something the code contradicts, stop and say so rather than implementing around it.
- Language: English in code, comments, commits and documentation.
- Commit style: conventional commits, lowercase descriptive subject, prose body, trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: `OPERATION_TIMEOUT`, `Interruptible`, and the error's `timeout`

Pure renaming plus one new error property. **No behaviour changes in this task** — the worker still enforces an execution budget when this task lands, and that is intentional: the type surface moves first so every later task edits one thing.

**Files:**
- Modify: `src/errors.ts` — rename the code, add the property
- Modify: `src/api.ts` — rename `OptionsWithSignal` → `Interruptible` (still carrying `signal` only)
- Modify: `src/worker/worker.ts:66` — `WorkerQueryTimeout.errorCode`
- Modify: `tests/browser/query-timeout.test.ts`, `tests/browser/interrupt.test.ts:160` — the assertions
- Test: `tests/unit/errors.test.ts` (create if absent)

**Interfaces:**
- Produces: `SQLiteErrorCode` gains `'OPERATION_TIMEOUT'` and loses `'QUERY_TIMEOUT'`; `SQLiteError` gains `readonly timeout?: number` and its constructor options bag gains `timeout?: number`; the exported type `Interruptible<T = unknown>` replaces `OptionsWithSignal<T = unknown>` with an identical body.

- [ ] **Step 1: Write the failing test**

Create or extend `tests/unit/errors.test.ts`:

```typescript
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';

describe('SQLiteError', () => {
  it('carries the timeout that was exceeded', () => {
    const err = new SQLiteError('OPERATION_TIMEOUT', 'read() exceeded its timeout of 200 ms.', {
      timeout: 200,
    });
    expect(err.code).toBe('OPERATION_TIMEOUT');
    expect(err.name).toBe('OPERATION_TIMEOUT');
    expect(err.timeout).toBe(200);
  });

  it('leaves timeout undefined when none was given', () => {
    expect(new SQLiteError('BUSY', 'busy').timeout).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec rstest --project unit run tests/unit/errors.test.ts`
Expected: FAIL — `'OPERATION_TIMEOUT'` is not assignable to `SQLiteErrorCode`, and `timeout` does not exist on `SQLiteError`. Do **not** commit here.

- [ ] **Step 3: Rename the code and add the property**

In `src/errors.ts`, replace `| 'QUERY_TIMEOUT'` with `| 'OPERATION_TIMEOUT'` in the `SQLiteErrorCode` union, and rewrite the doc paragraph that describes it:

```typescript
 * `OPERATION_TIMEOUT` is the `timeout` a caller set on a call being spent. It is
 * deliberately not `TIMEOUT`, which means a deadline this library imposed on
 * itself — a worker that never became ready, a deletion that did not complete.
```

Then add the property to `SQLiteError`, beside `sqliteCode` and in the same style:

```typescript
  /**
   * The `timeout` that was exceeded, in milliseconds. Present only on
   * `OPERATION_TIMEOUT`, so a log need not parse the message for it.
   */
  readonly timeout?: number;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: { cause?: unknown; sqliteCode?: number; timeout?: number },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
    if (options?.sqliteCode !== undefined) this.sqliteCode = options.sqliteCode;
    if (options?.timeout !== undefined) this.timeout = options.timeout;
  }
```

- [ ] **Step 4: Rename the type and sweep every citation**

Rename **textually**, not through the LSP:

```bash
grep -rn "OptionsWithSignal\|QUERY_TIMEOUT" src/ tests/ API.md
```

- `src/api.ts` — `export type OptionsWithSignal<T = unknown>` becomes `export type Interruptible<T = unknown>`, body unchanged (`signal` only; `timeout` is hoisted in Task 5). Update the five `OptionsWithSignal<{...}>` call sites in the same file.
- `src/worker/worker.ts:66` — `readonly errorCode = 'OPERATION_TIMEOUT' as const;`
- `tests/browser/query-timeout.test.ts` — three occurrences of `code: 'QUERY_TIMEOUT'`.
- `tests/browser/interrupt.test.ts:160` — one occurrence.
- Leave `API.md` alone: documentation lands in Task 5, and rewriting it now would describe behaviour that does not exist yet.

- [ ] **Step 5: Typecheck immediately after the rename**

Run: `pnpm exec tsc --noEmit`
Expected: clean. A parse error here means the rename landed at stale offsets — revert it and redo it with `replace_in_files`.

- [ ] **Step 6: Run the falsifier**

Delete `if (options?.timeout !== undefined) this.timeout = options.timeout;` from the constructor.
Run: `pnpm exec rstest --project unit run tests/unit/errors.test.ts`
Expected: RED on "carries the timeout that was exceeded". Restore the line and confirm GREEN.

- [ ] **Step 7: Run the suites and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: three reports, `status: pass` and `failedFiles: 0` on each.

```bash
git add -A
git commit -F - <<'EOF'
refactor(errors)!: OPERATION_TIMEOUT, and an error that carries its budget

`timeout` is about to apply to seven methods, of which five run a query, so
`QUERY_TIMEOUT` stops being true of its own subject. `TIMEOUT` is not reusable:
it is published and it means a deadline the library imposed on its own lifecycle
work. `SQLiteError` gains an optional `timeout` beside `sqliteCode`, so a log
reads the budget without parsing a message. `OptionsWithSignal` becomes
`Interruptible`, which is a break in the rc.4 surface; it still carries `signal`
alone until the behaviour it will document exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The deadline moves from the worker to the client

The atomic task. It cannot be split: a state where the client holds a wall-clock deadline *and* the worker holds an execution budget runs two clocks with different meanings under one option name.

**Files:**
- Modify: `src/utils.ts` — add `withDeadline`, beside `mergeSignals`
- Modify: `src/client.ts` — `read`, `chunk`, `stream`, `write`, `first`
- Modify: `src/queries.ts` — stop forwarding `timeout` to the worker (`chunk`, `writeWorker`)
- Modify: `src/types.ts` — drop `timeout` from `SQLOptions`
- Modify: `src/worker/worker.ts` — delete `WorkerQueryTimeout`, `spent`, `stepStart`, `overBudget()`
- Test: `tests/browser/query-timeout.test.ts`, `tests/browser/interrupt.test.ts`

**Interfaces:**
- Consumes: `SQLiteError` with `timeout` (Task 1); `mergeSignals(a, b) => { signal, release }` from `src/utils.ts`.
- Produces: `withDeadline(options, method) => { signal: AbortSignal | undefined; release: () => void }`, used by Tasks 3 and 4 with the same signature.

- [ ] **Step 1: Delete the test that this task makes vacuous**

`tests/browser/interrupt.test.ts`, in `leaves a sync build degraded, and says so by behaving so`: the second half asserts that a `timeout` interrupts a running statement on the non-isolated `sync` build, with the comment *"A timeout DOES interrupt the same build — the asymmetry the design turns on."* Spec D6 removes that asymmetry deliberately.

**Delete those five lines and the comment. Do not merely rename the error code in them.** After this task the assertion would still pass — the client-side timer rejects the promise on time whether or not the statement stopped — so a renamed assertion would be a permanently vacuous test claiming to pin a capability that no longer exists. The first half of the test, which pins that a `signal` stops the wait and not the work, is unaffected and stays.

- [ ] **Step 2: Invert the consumer-slowness test and add the queued test**

In `tests/browser/query-timeout.test.ts`, replace the third test (`does not charge the consumer for its own slowness`) with:

```typescript
  it('charges the consumer for its own slowness', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (x INTEGER)');
      await db.write(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ` +
          `INSERT INTO t SELECT x FROM c`,
      );
      // The budget is wall clock from the call, so the consumer's own pauses
      // spend it. Falsifier: count the budget inside step() again and the
      // 100 ms is never reached, because MemoryVFS steps 1001 rows in
      // microseconds — the sleeping is the only thing that can exceed it.
      const iterate = async () => {
        for await (const rows of db.chunk<{ x: number }>('SELECT x FROM t', [], {
          timeout: 100,
        })) {
          void rows;
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      await expect(iterate()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 100,
      });
    } finally {
      await db.close();
    }
  });

  it('lets the caller signal win, with its own reason', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const controller = new AbortController();
      const mine = new Error('mine');
      // Both are live and the caller's fires first. This pins D3 against a
      // future edit that "unifies" the two errors. Falsifier: make withDeadline
      // return its own controller's signal instead of the merged one and the
      // rejection becomes OPERATION_TIMEOUT, or never arrives at all.
      const promise = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
        timeout: 30_000,
      });
      promise.catch(() => {});
      controller.abort(mine);
      await expect(promise).rejects.toBe(mine);
    } finally {
      await db.close();
    }
  });

  it('spends the budget while the call is still queued', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      // The only worker is busy for seconds; the second call never reaches a
      // step() and must still time out. Falsifier: create the controller below
      // the lease acquisition and this goes green for the wrong reason — the
      // clock must run during the wait, which is what the assertion pins.
      const long = db.read(longQuery(20_000_000));
      long.catch(() => {});
      const started = performance.now();
      await expect(
        db.read('SELECT 1 AS one', [], { timeout: 150 }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await db.close();
    }
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm exec rstest --project chromium run tests/browser/query-timeout.test.ts`
Expected: FAIL — `charges the consumer for its own slowness` resolves instead of rejecting (the old budget never runs during a pause), and `spends the budget while the call is still queued` hangs until the long query ends and then resolves. Do **not** commit here.

- [ ] **Step 4: Add `withDeadline` to `src/utils.ts`**

Place it directly after `mergeSignals`, which it uses:

```typescript
/**
 * The `timeout` option: a wall-clock budget in milliseconds, counted from the
 * call. Returns the signal the call should actually use — the caller's own,
 * merged with one this library owns and aborts when the budget is spent.
 *
 * The abort reason IS the error the caller receives. Every abort path in this
 * library rejects with `signal.reason`, and `mergeSignals` relays a reason
 * verbatim, so nothing downstream has to ask which signal fired. That is why
 * this is an AbortController and a setTimeout rather than
 * `AbortSignal.timeout()`, which offers no way to set the reason.
 *
 * `release()` is owed exactly once, however the call ends.
 */
export const withDeadline = (
  options:
    | { signal?: AbortSignal | undefined; timeout?: number | undefined }
    | undefined,
  method: string,
): { signal: AbortSignal | undefined; release: () => void } => {
  const budget = options?.timeout;
  if (budget === undefined) return { signal: options?.signal, release: () => {} };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new SQLiteError(
        'OPERATION_TIMEOUT',
        `${method}() exceeded its timeout of ${budget} ms.`,
        { timeout: budget },
      ),
    );
  }, budget);
  const { signal, release } = mergeSignals(options?.signal, controller.signal);
  return {
    signal,
    release: () => {
      clearTimeout(timer);
      release();
    },
  };
};
```

`timeout` is **not** validated. It is not validated today either, and adding an `INVALID_OPTION` for a negative or non-finite value is a new public behaviour this design did not specify. Leave it.

- [ ] **Step 5: Apply it at the five entry points in `src/client.ts`**

The composed signal replaces both `options?.signal` at the acquisition and the `signal` the worker call reads, so pass `{ ...options, signal }` down. `read` and `first`:

```typescript
    assertReadable(sql, 'read');
    const { signal, release } = withDeadline(options, 'read');
    try {
      return await readWithRetry(signal, (worker) =>
        readWorker<T>(worker, sql, params, { ...options, signal }),
      );
    } finally {
      release();
    }
```

`chunk` and `stream` are generators, so the `finally` must wrap the `yield*` — that is what releases when the consumer stops reading early:

```typescript
    assertReadable(sql, 'chunk');
    const { signal, release } = withDeadline(options, 'chunk');
    try {
      yield* streamWithRetry(signal, (worker) =>
        chunkWorker<T>(worker, sql, params, { ...options, signal }),
      );
    } finally {
      release();
    }
```

`write` already has a `finally`; add `release()` as its first statement, before the `afterWrite` await, and use `signal` at `acquireInstrumented('write', signal)` and in `writeWorker(lease.worker, sql, params, { ...options, signal })`.

- [ ] **Step 6: Stop sending `timeout` to the worker**

- `src/queries.ts`, in `chunk`: `const { signal, chunkSize, credits } = options ?? {};` and drop `timeout,` from the `worker.query` options bag.
- `src/queries.ts`, in `writeWorker`: `const { signal } = options ?? {};` and drop `timeout,` likewise.
- `src/types.ts`: delete `timeout?: number;` from `SQLOptions`.

Leave `abortable: signal !== undefined` exactly as it is. It now becomes true whenever a `timeout` is set, which is deliberate: it is what makes the deadline stop the running statement wherever a signal can, and it is the cost the spec's §6.2 promises.

- [ ] **Step 7: Delete the budget from the worker**

In `src/worker/worker.ts`:

- Delete the `WorkerQueryTimeout` class (the `errorCode` / `budget` one, around `:60-70`).
- Delete `let spent = 0;` and `let stepStart = 0;`.
- In `run`, delete `stepStart = performance.now();` and both `spent += performance.now() - stepStart;` lines.
- Collapse the `SQLITE_INTERRUPT` catch to its two surviving triggers:

```typescript
        } catch (e) {
          if ((e as { code?: number })?.code === SQLITE_INTERRUPT) {
            // Two triggers, and both mean the client has already rejected:
            // a `stop` message processed by gate.stop(), or the shared slot
            // written by interrupt() on the sync build, which never yields so
            // the message cannot reach it. Break, so settle() sees a clean
            // exit and keeps the statement cached.
            break;
          }
          throw e;
        }
```

- Replace `const { timeout, abortable } = options ?? {};` with `const { abortable } = options ?? {};`, delete `overBudget`, and simplify both the install condition and the `finally` teardown condition to `if (wantsSignal && (canYield || slot !== undefined))`. The handler becomes:

```typescript
        wantsSignal && canYield
          ? async () => {
              // The task turn is what lets a queued `stop` be delivered.
              await gate.tick();
              return gate.isStopped() ? 1 : 0;
            }
          : () => (abortedHere() ? 1 : 0),
```

- [ ] **Step 8: Run the falsifiers**

For `charges the consumer for its own slowness`: change `withDeadline`'s `setTimeout` to `setTimeout(..., budget * 100)`. Expected RED. Restore.
For `spends the budget while the call is still queued`: move the `withDeadline` call in `read` below the `readWithRetry` line so the clock starts after the lease. Expected RED (the call resolves once the long query frees the worker). Restore.

- [ ] **Step 9: Run everything and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm build && pnpm test`
Expected: three reports, `status: pass`, `failedFiles: 0`.

```bash
git add -A
git commit -F - <<'EOF'
feat(timeout)!: a wall-clock deadline from the call, not a budget of engine time

`timeout` was a budget of SQLite execution time accumulated in the worker, so
everything outside step() was free: the wait for a lease, the cross-tab write
lock, the barrier, and the caller's own pauses between chunks. A consumer who
wrote `timeout: 5000` had bounded nothing they could predict. It is now what the
word says — milliseconds from the call.

The mechanism is an AbortController this library owns, aborted by a setTimeout
whose reason IS the SQLiteError. mergeSignals relays a reason verbatim and every
abort path already rejects with `signal.reason`, so the typed error arrives with
no translation layer. The worker stops knowing about budgets: `spent`,
`overBudget()` and WorkerQueryTimeout are gone, `timeout` leaves the wire
protocol, and the SQLITE_INTERRUPT catch collapses to two triggers that both
mean the client has already rejected.

The interrupt suite loses the half that asserted a timeout interrupts a running
statement on the non-isolated sync build. That asymmetry is gone by decision: a
timeout there now stops the wait and not the work, exactly as a signal does. The
assertion would have kept passing on the client-side rejection alone, which is
why it is deleted rather than renamed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: `transaction()`

**Files:**
- Modify: `src/api.ts` — `SQLiteTransactionOptions` gains `timeout?: number`
- Modify: `src/transaction.ts` — compose the deadline at entry
- Test: `tests/browser/query-timeout.test.ts`

**Interfaces:**
- Consumes: `withDeadline(options, method)` from Task 2.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/query-timeout.test.ts`:

```typescript
  it('bounds a transaction, including the callback between its statements', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      // The callback runs no long statement: it sleeps. Only a wall-clock
      // deadline can end this, which is what the test pins. Falsifier: remove
      // the withDeadline composition in transaction.ts and the promise
      // resolves after the sleep instead of rejecting.
      await expect(
        db.transaction(
          async (tx) => {
            await tx.write('INSERT INTO t VALUES (1)');
            await new Promise((r) => setTimeout(r, 600));
            await tx.write('INSERT INTO t VALUES (2)');
          },
          { timeout: 200 },
        ),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });
      // It rolled back: neither row survived.
      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec rstest --project chromium run tests/browser/query-timeout.test.ts`
Expected: FAIL — `timeout` is not assignable to `SQLiteTransactionOptions`. Do **not** commit here.

- [ ] **Step 3: Declare the option**

In `src/api.ts`:

```typescript
export type SQLiteTransactionOptions = Interruptible<{
  /** Rejects write statements with `READ_ONLY_TRANSACTION`. Defaults to false. */
  readOnly?: boolean;
  /** Commits when the callback resolves. Defaults to true. */
  autoCommit?: boolean;
  /**
   * Milliseconds from the call within which the transaction must finish. The
   * callback's own time counts. On expiry it rolls back and rejects with
   * `OPERATION_TIMEOUT`.
   */
  timeout?: number;
}>;
```

- [ ] **Step 4: Compose the deadline**

In `src/transaction.ts`, replace the destructuring at the top of the returned function:

```typescript
    const { readOnly = false, autoCommit = true } = options ?? {};
    // The deadline is the transaction's own signal from here on: it reaches
    // the lease acquisition, every inner statement through withSignal, and the
    // race against the callback itself.
    const { signal, release: releaseDeadline } = withDeadline(
      options,
      'transaction',
    );
```

Everything downstream already reads `signal` and needs no change. Add `releaseDeadline()` to the outer `finally` that already runs `teardown()`, so it is owed exactly once whether the transaction commits, rolls back or throws.

- [ ] **Step 5: Run the falsifier**

Replace `withDeadline(options, 'transaction')` with `{ signal: options?.signal, release: () => {} }`.
Expected: RED — the transaction resolves after the sleep and the two rows are present. Restore, confirm GREEN.

- [ ] **Step 6: Run everything and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`

```bash
git add -A
git commit -F - <<'EOF'
feat(transaction): accept a timeout, and let it cover the callback

A transaction spans caller code between its statements, so the only budget that
can bound one is wall clock. It composes as the transaction's own signal, which
already reaches the lease acquisition, every inner statement and the race
against the callback — so the rollback path needs nothing new.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `bulkWrite()` and `output()`

**Files:**
- Modify: `src/api.ts` — `SQLiteBulkWriteOptions` and `SQLiteOutputOptions` gain `timeout?: number`
- Modify: `src/bulk.ts` — compose at both entries
- Test: `tests/browser/query-timeout.test.ts` — every test this plan adds lives in that one file, so the whole option has one home

**Interfaces:**
- Consumes: `withDeadline(options, method)` from Task 2.

- [ ] **Step 1: Write the failing tests**

```typescript
  it('bounds a bulkWrite from the call, not from close()', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const { enqueue, close } = db.bulkWrite('t', ['a'], { timeout: 200 });
      await enqueue({ a: 1 });
      // The producer is slow, which is the whole case: nothing is executing in
      // SQLite while it sleeps. Falsifier: remove the withDeadline composition
      // in bulk.ts and close() resolves.
      await new Promise((r) => setTimeout(r, 600));
      await expect(close()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 200,
      });
    } finally {
      await db.close();
    }
  });

  it('bounds an output() the same way, leaving the target untouched', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const { enqueue, close } = db.output(
        'dest',
        { a: 'INTEGER' },
        { timeout: 200 },
      );
      await enqueue({ a: 1 });
      await new Promise((r) => setTimeout(r, 600));
      await expect(close()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      // Observationally a no-op: the target was never created.
      await expect(db.read('SELECT a FROM dest')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
```

Check the exact `output()` signature in `src/api.ts` before writing the second test and match it; if it differs from `(name, schema, options)` use what the type says, not what this plan guessed.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec rstest --project chromium run tests/browser/query-timeout.test.ts`
Expected: FAIL — `timeout` is not assignable to `SQLiteBulkWriteOptions` or `SQLiteOutputOptions`. Do **not** commit here.

- [ ] **Step 3: Declare the options**

In `src/api.ts`, add to both types, with the wording matching what each does:

```typescript
  /**
   * Milliseconds from the call — not from `close()` — within which the load
   * must finish. Your producer's own time counts. On expiry the load stops
   * between batches and `close()` rejects with `OPERATION_TIMEOUT`.
   */
  timeout?: number;
```

- [ ] **Step 4: Compose at both entries**

In `src/bulk.ts`, in `bulkWrite`, replace `const signal = options?.signal;` with:

```typescript
      const { signal, release: releaseDeadline } = withDeadline(
        options,
        'bulkWrite',
      );
```

`releaseDeadline()` is owed when the writer settles — call it where `signal?.removeEventListener('abort', releaseRoom)` already runs, which is the one place that runs however the writer ends.

In `output`, compose its own deadline and pass the composed signal into the inner `bulkWrite` call, replacing `{ signal: options?.signal, queueSize: options?.queueSize }` with `{ signal, queueSize: options?.queueSize }`. Do **not** pass `timeout` down: `output` owns one deadline for the whole operation, and handing the same number to the inner writer would start a second clock.

- [ ] **Step 5: Run the falsifiers**

For each test, replace that entry's `withDeadline(...)` with `{ signal: options?.signal, release: () => {} }`. Expected RED on that test only. Restore, confirm GREEN.

- [ ] **Step 6: Run everything and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`

```bash
git add -A
git commit -F - <<'EOF'
feat(bulk): a timeout on bulkWrite() and output(), counted from the call

Both span many batches with the producer's own time in between, so the clock
starts at the call rather than at close(), and the producer's slowness spends
it. The abort still lands between batches, never inside one, so what the
existing TSDoc promises about an aborted load holds unchanged: batches already
written stay written, and an aborted output() remains observationally a no-op.
output() owns one deadline for the whole operation and does not hand its budget
to the writer it wraps, which would start a second clock.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Hoist `timeout` into `Interruptible`, and the documentation

The consolidation. Four option types now declare `timeout` with four comments; one declaration replaces them, and the prose catches up in the same commit so no reader sees a half-migrated story.

**Files:**
- Modify: `src/api.ts` — hoist into `Interruptible`, delete the four per-type declarations
- Modify: `API.md` — five rewritten `timeout` rows, three new ones, the *Interrupting a query* section, the error table row
- Modify: `CHANGELOG.md` — rewrite in place, do not append

- [ ] **Step 1: Hoist the declaration**

```typescript
export type Interruptible<T = unknown> = T & {
  /**
   * Aborts the work. Rejects with `signal.reason` — your reason, not an error
   * of this library's making.
   *
   * On `bulkWrite()` and `output()` the abort lands **between** batches, never
   * inside one: a multi-row INSERT is statement-atomic, so stopping inside a
   * batch would either waste it whole or let it commit whole. An aborted
   * `bulkWrite()` leaves the batches already written in place; an aborted
   * `output()` is observationally a no-op, dropping its staging table and
   * touching nothing else.
   *
   * Whether it also stops the statement SQLite is already executing depends on
   * your build and your page: see the Interrupting a call section of API.md.
   */
  signal?: AbortSignal | undefined;
  /**
   * Milliseconds from the call within which it must finish, after which it is
   * aborted and rejected with `OPERATION_TIMEOUT`. It is wall clock: time your
   * own code spends — between two chunks of a `stream()`, inside a
   * `transaction()` callback, between two `enqueue()` calls — counts against
   * it, as does time spent waiting for a pool worker or for another tab's
   * write lock.
   *
   * It aborts through the same path a `signal` does, so the same limit applies:
   * see the Interrupting a call section of API.md.
   */
  timeout?: number | undefined;
};
```

Delete the `timeout` member and its comment from `SQLiteQueryOptions`, `SQLiteChunkOptions`, `SQLiteTransactionOptions`, `SQLiteBulkWriteOptions` and `SQLiteOutputOptions`. `SQLiteQueryOptions` may become `Interruptible` with an empty body — if so, keep the alias rather than collapsing the name, since it is the published name of the option bag.

Run `pnpm exec tsc --noEmit`: it must stay clean, and nothing else should need editing.

- [ ] **Step 2: Rewrite `API.md`**

- The five existing `timeout` rows (under `read`, `write`, `stream`, `chunk`, `first`) become one sentence each, worded for that method: *"Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. Wall clock — your own pauses between chunks count. See [Interrupting a call](#interrupting-a-call)."*
- `transaction`, `bulkWrite` and `output` gain a `timeout` row each, in the same per-method voice their existing `signal` rows already use.
- Rename the section `## Interrupting a query` to `## Interrupting a call` and rewrite it. **Before renaming, run `grep -rn "Interrupting a query" .`** — an error message in `src/` quotes a heading elsewhere in this repo and a browser test asserts that message at the character level. The section keeps its one table, which now covers both options, and loses the paragraph beginning "`timeout` needs none of that. It works on every build". The two code samples become one that shows the two spellings and says what differs: the error type.
- The section gains the sentence spec §6.6 owes: the deadline is a browser timer, so a background tab that throttles `setTimeout` may fire it late. Say that `AbortSignal.timeout()` behaves identically, so it is not a cost of the option — it is documented only because "wall clock from the call" invites the assumption that it is exact.
- The error table's `QUERY_TIMEOUT` row becomes `OPERATION_TIMEOUT`: *"The `timeout` set on a call was spent. The error carries it as `error.timeout`. Deliberately not `TIMEOUT`, which means a deadline this library imposed on itself — a worker that never became ready, a deletion that did not complete."*

- [ ] **Step 3: Rewrite the `CHANGELOG.md` entries in place**

The `timeout` and `QUERY_TIMEOUT` entries under `## Unreleased` describe a behaviour no release ever carried. **Rewrite them; do not add a second entry beside them** — leaving both readings in one section would publish a contradiction. Add under Breaking: `OptionsWithSignal` is renamed `Interruptible` and carries `timeout` as well as `signal`, which is a break for a consumer who names the type (it is in rc.4).

- [ ] **Step 4: Verify the documentation against the code**

Read each claim you just wrote and find the line that makes it true. This is the review that found the Critical of the last lot; it is worth doing on your own prose. In particular: no sentence anywhere may still say `timeout` works on every build, and no option table may still describe a budget of execution time.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm build && pnpm test`

```bash
git add -A
git commit -F - <<'EOF'
feat(api)!: signal and timeout travel together on Interruptible

Four option types declared `timeout` with four comments; one declaration on
`Interruptible` replaces them, so the pairing is structural and a future option
type cannot take one without the other. That was the point of the rename.

The documentation catches up in the same commit. API.md gains a `timeout` row
on transaction(), bulkWrite() and output(), rewrites the five it had, and its
interruption section collapses to one table covering both options — the
paragraph claiming `timeout` works on every build is gone, because it no longer
does. The CHANGELOG's `timeout` and QUERY_TIMEOUT entries are rewritten in
place: they described a behaviour no release carried, and two readings in one
section would ship a contradiction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Retire the wire protocol's `errorCode`, or keep it deliberately

`WorkerQueryTimeout` was the only producer of `errorCode` on the worker→client protocol. Task 2 deleted it, so `src/types.ts:107`, `src/pool.ts:100-103` and `src/worker/worker.ts:585-586` now carry a path nothing reaches.

**This task is separable on purpose: a reviewer could accept Tasks 1-5 and reject this one.** Confirm the decision with the user before doing it.

**Files:**
- Modify: `src/types.ts` — the `errorCode?: SQLiteErrorCode` field on the error message
- Modify: `src/pool.ts:100-103` — the branch that reads it
- Modify: `src/worker/worker.ts:585-586` — the branch that writes it

- [ ] **Step 1: Confirm no producer remains**

Run: `grep -rn "errorCode" src/ tests/`
Expected: only the three sites above. If anything else produces one, stop — this task's premise is false and it should be dropped.

- [ ] **Step 2: Delete the three sites**

`pool.ts` keeps whatever its `else` branch already builds; the ternary collapses to that branch.

- [ ] **Step 3: Run everything and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`

```bash
git add -A
git commit -F - <<'EOF'
refactor(protocol): drop errorCode, which lost its only producer

The worker→client error message could carry a SQLiteErrorCode so a worker-side
failure kept its code across the boundary. WorkerQueryTimeout was the only thing
that ever set one, and the timeout no longer travels to the worker at all. The
path is unreachable, so it goes rather than waiting for a second producer that
may never arrive.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Closing the branch

Not a task — the phase's closure conditions, from `mem:conventions`. All three must hold before the merge: CI green (types, format, lint), memories updated, git clean. Then merge into `main` with `--no-ff` and a body explaining the change, verify the baseline table of `mem:state` **on the merged result**, and delete the branch locally and remotely after proving containment with `git merge-base --is-ancestor feat/uniform-timeout main`.

`mem:follow-ups` loses its `Interruptible` entry entirely — that file's rule is to delete, never annotate. `mem:state` loses the second of the two rc.5 gates.
