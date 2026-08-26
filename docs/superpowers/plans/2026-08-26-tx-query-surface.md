# Transaction Query Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `SQLiteTransactionDB` the client's whole querying surface — `bulkWrite` and `output` included — by factoring both surfaces onto one base type and instantiating the bulk module twice.

**Architecture:** `createBulk` already takes `read` / `write` / `transaction` by injection, so this is a second call site rather than a second implementation. It is cut into two stages so the sweep memo stays shared: `createBulk(shared)` returns `forTarget(target)`. Inside a transaction the injected `transaction` is a pass-through — `(fn) => fn(tx)` — which is what stops `output()`'s swap opening a `BEGIN` SQLite does not allow. The public type layer moves to a new `src/api.ts` that `index.ts` re-exports wholesale.

**Tech Stack:** TypeScript 7 (tsgo), rslib, rstest 0.11.8 (`unit` in Node, `browser` in Playwright/Chromium), biome 2.5.8, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-26-tx-query-surface-design.md`

**Branch:** `feat/tx-query-surface` (already created, already carries the spec and the dead-options removal).

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` / `replace_in_files` to edit. Built-in Read/Edit only for `.md`, JSON and config.
- **Run `pnpm check` after every modification.** It is `biome check --write`.
- **Everything is unreleased.** Do not bump `package.json`. Every breaking change gets a line in `CHANGELOG.md` under `## Unreleased — 1.0.0-rc.4`, in the task that makes it.
- **No runtime dependencies.** `dependencies` in `package.json` stays empty.
- **Falsifiability is verified, not claimed.** For every test written here, delete the named line, watch the test go red, restore it, watch it go green — and report both. A reasoned claim of falsifiability is worth nothing in this repository; it has cost seven fix rounds before.
- **English in code, comments, commits and docs.**
- **The default pool size is 2** (`DEFAULT_POOL_SIZE`, `client.ts:47`). Browser tests use `createTestClient()` from `tests/browser/helpers.ts`, which gives a unique OPFS name and an `afterEach` cleanup.
- **`browserLogs: false`** in `rstest.config.ts` — `console.log` from a browser test is invisible. Surface anything you need through an assertion message.
- **Do not touch** the existing `tests/browser/output.test.ts`. It is the non-transactional path's safety net and its value comes from not having been written for this work.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/locks.ts` | **Modify.** `Locks` gains `tryWithLock` — acquire or skip, never wait | 1 |
| `tests/unit/locks.test.ts` | **Modify.** Pin `tryWithLock`'s two outcomes and the `ifAvailable` request | 1 |
| `src/bulk.ts` | **Modify.** `sweepOnce` uses `tryWithLock` (2); `createBulk` splits into two stages (4) | 2, 4 |
| `tests/unit/bulk.test.ts` | **Modify.** Refusal is memoized (2); sweep runs once across two targets (4) | 2, 4 |
| `src/api.ts` | **Create.** The public type layer: `SQLiteQueryAPI` and the two surfaces deriving from it, plus every named option / result / writer type | 3 |
| `src/types.ts` | **Modify.** Loses `SQLiteQueryOptions` | 3 |
| `src/errors.ts` | **Modify.** `BulkWriteError` → `SQLiteBulkWriteError` (3); `READ_ONLY_TRANSACTION` added (6) | 3, 6 |
| `src/client.ts` | **Modify.** `SQLiteDB` moves out; `params: unknown[]`; the `Omit`s go; wires `forTarget` (4) and passes it to `createTransaction` (5) | 3, 4, 5 |
| `src/transaction.ts` | **Modify.** `TransactionDB` moves out and is renamed (3); gains `bulkWrite` / `output` (5); the `readOnly` guard (6) | 3, 5, 6 |
| `src/index.ts` | **Modify.** `export * from './api'` | 3 |
| `tests/unit/exports.test.ts` | **Modify.** The compile-time pin that both surfaces derive from one base | 3 |
| `tests/browser/tx-write.test.ts` | **Create.** `tx.bulkWrite` / `tx.output` behaviour (5), `readOnly` (6), the sweep non-regression (7) | 5, 6, 7 |
| `README.md` | **Modify.** Transaction / output / bulkWrite entries (5); Error handling row and the stale `vfs` default (6) | 5, 6 |

---

## Task 1: `tryWithLock` — a lock request that never waits

**Files:**
- Modify: `src/locks.ts`
- Test: `tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Locks.tryWithLock(name: string, fn: () => Promise<unknown>): Promise<boolean>` — resolves `true` if `fn` ran, `false` if the lock was held elsewhere and `fn` was skipped. Present on both `createLocks(...)` and `noOpLocks`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/locks.test.ts`:

```ts
describe('tryWithLock', () => {
  /**
   * A LockManager stand-in. `ifAvailable: true` makes the real API invoke the
   * callback with `null` when the lock is held elsewhere; `granted` chooses
   * which of the two the fake plays.
   */
  const manager = (granted: boolean, seen?: unknown[]) => ({
    request: async (_name: string, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof options !== 'function') seen?.push(options);
      return cb(granted ? {} : null);
    },
    query: async () => ({ held: [] as { name?: string }[] }),
  });

  it('does not run the callback when the lock is held elsewhere', async () => {
    let ran = false;
    const locks = createLocks(manager(false));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(acquired).toBe(false);
  });

  it('runs the callback when the lock is free', async () => {
    let ran = false;
    const locks = createLocks(manager(true));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });

  // Falsifiable: drop `ifAvailable` from the request options. Without it the
  // real API waits, which is the whole thing this method exists not to do —
  // and no behavioural assertion above can see the difference against a fake.
  it('asks for ifAvailable, which is what makes it never wait', async () => {
    const seen: unknown[] = [];
    const locks = createLocks(manager(true, seen));

    await locks.tryWithLock('n', async () => {});

    expect(seen[0]).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  it('runs the callback when the Web Locks API is absent', async () => {
    let ran = false;

    const acquired = await noOpLocks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test:unit locks`
Expected: FAIL — `locks.tryWithLock is not a function`.

- [ ] **Step 3: Implement `tryWithLock`**

In `src/locks.ts`, add to the `Locks` type, after `withLock`:

```ts
  /**
   * Runs `fn` while holding `name`, or skips it entirely when the lock is held
   * elsewhere. Never waits — which is the point: the staging sweep is
   * opportunistic, and awaiting this lock inside an open transaction would
   * hold SQLite's write lock while waiting on a holder that may itself be
   * waiting for that write lock.
   *
   * Resolves `true` if `fn` ran, `false` if it was skipped.
   */
  tryWithLock: (name: string, fn: () => Promise<unknown>) => Promise<boolean>;
```

In `noOpLocks`, beside `withLock`:

```ts
  tryWithLock: async (_name, fn) => {
    await fn();
    return true;
  },
```

In `createLocks`'s returned object, after `withLock`:

```ts
    tryWithLock: async (name, fn) => {
      let ran = false;
      await manager.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          // `ifAvailable` hands the callback null instead of waiting.
          if (!lock) return;
          ran = true;
          await fn();
        },
      );
      return ran;
    },
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test:unit locks`
Expected: PASS, all four new tests.

- [ ] **Step 5: Verify falsifiability by hand**

Change the request options to `{ mode: 'exclusive' }` and re-run: the third test must go red. Restore it. Then implement `tryWithLock` as `withLock` (always run `fn`, always return `true`) and re-run: the first test must go red. Restore it. Report both observations.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add src/locks.ts tests/unit/locks.test.ts
git commit -m "feat(locks): a lock request that skips instead of waiting"
```

---

## Task 2: The sweep never waits, and a skipped sweep is memoized

**Files:**
- Modify: `src/bulk.ts` — `sweepOnce`
- Test: `tests/unit/bulk.test.ts`

**Interfaces:**
- Consumes: `Locks.tryWithLock` from Task 1.
- Produces: no signature change. `sweepOnce()` still returns `Promise<void>` and is still memoized in `swept`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/bulk.test.ts`:

```ts
describe('the staging sweep', () => {
  /** Locks that are available but always refuse the sweep lock. */
  const refusing = () => {
    let attempts = 0;
    return {
      attempts: () => attempts,
      locks: {
        available: true,
        hold: async () => () => {},
        withLock: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        tryWithLock: async () => {
          attempts += 1;
          return false;
        },
        heldNames: async () => [],
      },
    };
  };

  // Falsifiable: memoize `swept` only when the sweep actually ran. If the lock
  // was held, another client was doing the work — retrying on every output()
  // would put a lock request in front of every single call.
  it('attempts the sweep once even when the lock is refused', async () => {
    const { attempts, locks } = refusing();
    const { sql, deps } = recorder();
    const { output } = createBulk({ ...deps, locks });

    await output('t', { a: 'INTEGER' }).close();
    await output('t', { a: 'INTEGER' }).close();

    expect(attempts()).toBe(1);
    expect(sql.some((s) => s.includes('sqlite_master'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test:unit bulk`
Expected: FAIL — `locks.tryWithLock is not a function` is never reached because `sweepOnce` still calls `withLock`, so `attempts()` is `0`.

- [ ] **Step 3: Switch the sweep to `tryWithLock`**

In `src/bulk.ts`, in `sweepOnce`, replace the `swept ??= locks.withLock(...)` expression with:

```ts
    // tryWithLock, not withLock: awaiting this lock inside an open transaction
    // would hold SQLite's write lock while waiting on a holder that may itself
    // be waiting for that write lock — reachable with two clients in one tab.
    //
    // A refused attempt is memoized deliberately. If the lock was held, another
    // client was sweeping; retrying would put a lock request in front of every
    // output() for nothing.
    swept ??= locks
      .tryWithLock(sweepLockName(file), async () => {
        const rows = await read(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'`,
        );
        const tables = rows
          .map((row: any) => row.name)
          .filter((name: unknown): name is string => typeof name === 'string');
        if (!tables.length) return;
        const stale = staleStagingTables(tables, await locks.heldNames(), file);
        for (const orphan of stale) {
          await write(`DROP TABLE IF EXISTS ${quoteIdent(orphan)}`);
        }
      })
      .then(() => undefined)
      .catch(() => {
        // A failed sweep must never fail the output() that triggered it.
      });
    return swept;
```

Leave the `if (!locks.available)` guard above it **exactly as it is**. It is not made redundant: without the Web Locks API `heldNames()` returns `[]`, so a sweep would judge every staging table an orphan and drop one another tab is filling. Not sweeping is correct; sweeping blind is not.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test:unit bulk`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Verify falsifiability by hand**

Change `swept ??=` to assign only inside a `.then` that checks the boolean result, so a refusal is not memoized. Re-run: `attempts()` becomes `2` and the test goes red. Restore. Report.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add src/bulk.ts tests/unit/bulk.test.ts
git commit -m "fix(bulk): the staging sweep skips a held lock instead of waiting for it"
```

---

## Task 3: `src/api.ts` — one base type, two surfaces

**Files:**
- Create: `src/api.ts`
- Modify: `src/types.ts`, `src/errors.ts`, `src/client.ts`, `src/transaction.ts`, `src/bulk.ts`, `src/index.ts`
- Test: `tests/unit/exports.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SQLiteQueryAPI`, `SQLiteDB`, `SQLiteTransactionDB`, `SQLiteQueryOptions`, `SQLiteChunkOptions`, `SQLiteWriteResult<T>`, `SQLiteTransactionOptions`, `SQLiteBulkWriter<KEYS>`, `SQLiteOutputWriter<SCHEMA>`, `SQLiteOutputRow<SCHEMA>`, `SQLiteOutputOptions<SCHEMA>`, `Schema`, `Index<SCHEMA>` — all from `src/api.ts`, all re-exported by `src/index.ts`. `SQLiteBulkWriteError` from `src/errors.ts`.

**`bulkWrite` and `output` stay on `SQLiteDB` in this task, not on `SQLiteQueryAPI`.** Task 5 moves them into the base once `transaction.ts` actually provides them. Putting them in the base now would fail to compile, and every commit here must be green.

- [ ] **Step 1: Create `src/api.ts`**

```ts
/**
 * The public type layer. Everything here is part of the package's API, which is
 * why `index.ts` re-exports this module wholesale: a name list is what let
 * `SQLiteQueryOptions` and `TransactionDB` end up in the shipped `.d.ts`
 * without a consumer being able to name either.
 *
 * `types.ts` keeps the wire protocol and the VFS capability table.
 * `CreateSQLiteClientOptions` stays in `client.ts`, beside the constructor that
 * validates it: this module is the querying surface and its satellites — what a
 * caller passes to a query, and what comes back.
 */
import type { ClientDebugState } from './debug';

/** Options every query method accepts. */
export type SQLiteQueryOptions = {
  /** Aborts the query. Rejects with `signal.reason`. */
  signal?: AbortSignal;
};

/**
 * Options for the methods that cross the worker boundary in chunks.
 *
 * `chunkSize` is not only a transport detail: back-pressure grants credits per
 * chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows
 * ahead of the consumer. On `stream()` that is the only lever on how many rows
 * are in flight.
 */
export type SQLiteChunkOptions = SQLiteQueryOptions & {
  /** Rows per chunk. Defaults to 500. */
  chunkSize?: number;
};

/** What a write resolves with: any returned rows, and SQLite's `changes()`. */
export type SQLiteWriteResult<T extends Record<string, unknown>> = {
  result: T[];
  affected: number;
};

export type SQLiteTransactionOptions = {
  /** Rejects write statements with `READ_ONLY_TRANSACTION`. Defaults to false. */
  readOnly?: boolean;
  /** Commits when the callback resolves. Defaults to true. */
  autoCommit?: boolean;
};

/** Column definitions for `output()`. */
export type Schema = Record<
  string,
  | string
  | { type: string; generated?: string; required?: boolean; unique?: boolean }
>;

export type Index<SCHEMA extends Schema> =
  | keyof SCHEMA
  | (keyof SCHEMA)[]
  | ({ unique?: boolean } & (
      | { column: keyof SCHEMA }
      | { columns: (keyof SCHEMA)[] }
    ));

export type SQLiteOutputOptions<SCHEMA extends Schema> = {
  indexes?: Index<SCHEMA>[];
};

/** A row for `output()`: generated columns are computed, never supplied. */
export type SQLiteOutputRow<SCHEMA extends Schema> = {
  [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
    ? never
    : K]: any;
};

export type SQLiteBulkWriter<KEYS extends string> = {
  /** Buffers a row, flushing automatically when the buffer fills. */
  enqueue: (data: Record<KEYS, any>) => void;
  /** Flushes what remains and resolves with the total affected row count. */
  close: () => Promise<number>;
};

export type SQLiteOutputWriter<SCHEMA extends Schema> = {
  enqueue: (data: SQLiteOutputRow<SCHEMA>) => void;
  close: () => Promise<number>;
};

/**
 * The querying surface, shared by the client and by a transaction.
 *
 * It exists so the two cannot drift: they had already done so, one taking
 * `any[]` where the other took `unknown[]`, and two different option types on
 * `chunk`. A method added to one is now added to both by construction.
 */
export type SQLiteQueryAPI = {
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteChunkOptions,
  ) => Promise<T[]>;

  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions,
  ) => Promise<SQLiteWriteResult<T>>;

  chunk: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteChunkOptions,
  ) => AsyncGenerator<T[]>;

  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteChunkOptions,
  ) => AsyncGenerator<T>;

  first: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions,
  ) => Promise<T | undefined>;
};

export type SQLiteDB = SQLiteQueryAPI & {
  bulkWrite: <KEYS extends string>(
    table: string,
    keys: KEYS[],
  ) => SQLiteBulkWriter<KEYS>;

  output: <SCHEMA extends Schema>(
    table: string,
    schema: SCHEMA,
    options?: SQLiteOutputOptions<SCHEMA>,
  ) => SQLiteOutputWriter<SCHEMA>;

  transaction: <T = void>(
    callback: (db: SQLiteTransactionDB) => Promise<T>,
    options?: SQLiteTransactionOptions,
  ) => Promise<T>;

  close: () => Promise<void>;

  /**
   * Internal diagnostic handle. Not part of the stable public API.
   * Shape is subject to change without notice.
   * @internal
   */
  debug?: ClientDebugState;
};

export type SQLiteTransactionDB = SQLiteQueryAPI & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};
```

Carry the existing JSDoc from `SQLiteDB`'s members in `client.ts` and from `TransactionDB` in `transaction.ts` onto the corresponding members here — do not drop it, and do not rewrite it beyond the `id` references already removed. Where a `@param options` line says `chunkSize`, keep it only on the three methods that now take `SQLiteChunkOptions`.

- [ ] **Step 2: Remove the moved declarations**

`src/types.ts`: delete the `SQLiteQueryOptions` type and the JSDoc block above it.

`src/bulk.ts`: delete `Schema`, `Index` and `OutputOptions`; import `Schema`, `Index` and `SQLiteOutputOptions` from `./api` instead, renaming the local uses of `OutputOptions<SCHEMA>` to `SQLiteOutputOptions<SCHEMA>`.

**Keep `WriteFn`, `ReadFn` and `TransactionFn` in `bulk.ts`, and correct their comment.** The circular-import reason is gone — `api.ts` imports nothing from `bulk.ts` — but a second reason stands: `bulk` needs only `write` from the transaction it is handed, and widening these to the real surfaces would force every unit test in `tests/unit/bulk.test.ts` to build a complete transaction stub. Replace the two comments with:

```ts
// Structural, and deliberately narrower than SQLiteQueryAPI: bulk needs only
// these three calls, and requiring the full surface would make every unit test
// build a complete stub to exercise a single INSERT.
```

`src/client.ts`: delete the `SQLiteDB` type declaration and import it from `./api`, along with `SQLiteBulkWriter`, `SQLiteChunkOptions`, `SQLiteOutputOptions`, `SQLiteOutputWriter`, `SQLiteQueryOptions`, `SQLiteTransactionDB`, `SQLiteTransactionOptions`, `SQLiteWriteResult` and `Schema` as its implementation signatures need them.

`src/transaction.ts`: delete the `TransactionDB` type declaration and import `SQLiteTransactionDB` from `./api`.

- [ ] **Step 3: Apply the renames and the signature changes**

Rename across `src/` and `tests/`:

```bash
# TransactionDB -> SQLiteTransactionDB
# BulkWriteError -> SQLiteBulkWriteError
```

Use Serena's `rename_symbol` for each — it is reference-aware and updates every import and usage atomically. `BulkWriteError` is a class, so `src/errors.ts`, `src/bulk.ts` and `tests/unit/bulk.test.ts` all move together.

Then, in the **implementation** signatures (not the types, which `api.ts` now owns):

- `src/client.ts`: every `params?: any[]` becomes `params?: unknown[]`.
- Every `Omit<SQLiteQueryOptions, 'chunkSize'>` disappears — the method takes plain `SQLiteQueryOptions`, which no longer has `chunkSize`. There are nine today, but **six of them are inside the two type declarations you delete in Step 2** (three in `client.ts`'s `SQLiteDB`, three in `transaction.ts`'s `TransactionDB`) and vanish with them. Do not hunt for nine edits: delete the declarations first, then fix whatever `npx tsc --noEmit` still reports — three sites, all in `createTransaction`'s `db` literal.
- `read`, `chunk` and `stream` take `SQLiteChunkOptions`.
- `client.ts`'s `stream` must forward the caller's `chunkSize` to `streamRows`, which already accepts it (`queries.ts:72-83`). Confirm the options object reaches it unfiltered.
- **`output`'s implementation signature loses its `any`s.** In `client.ts` the
  implementation still mirrors the old `options?: any` and `enqueue: (data: any)`.
  Type it `SQLiteOutputOptions<SCHEMA>` and `SQLiteOutputRow<SCHEMA>`: the
  declared type alone is not enough, because the shipped `.d.ts` is generated
  from the implementation.

- [ ] **Step 4: Re-export from `src/index.ts`**

Add, keeping the file's existing comment about `types.ts` being exported by name:

```ts
export * from './api';
```

and remove nothing else. `types.ts`'s named export list loses no entry — `SQLiteQueryOptions` was never in it, which is the defect being fixed.

- [ ] **Step 5: Write the compile-time pin**

Append to `tests/unit/exports.test.ts`, after the imports:

```ts
import type {
  SQLiteDB,
  SQLiteQueryAPI,
  SQLiteTransactionDB,
} from '../../src/api';

/**
 * Compile-time pin. Types are erased, so no runtime assertion can check that
 * both surfaces derive from one base — `tsc --noEmit` is the only thing that
 * can, and `tsconfig.json` already type-checks `tests/`.
 *
 * Falsifiable: remove a member from SQLiteQueryAPI's contribution to either
 * surface, or add one to a surface without adding it to the base.
 */
const asQueryAPI = (surface: SQLiteQueryAPI) => surface;
declare const pinnedClient: SQLiteDB;
declare const pinnedTransaction: SQLiteTransactionDB;
void asQueryAPI(pinnedClient);
void asQueryAPI(pinnedTransaction);
```

And add a runtime assertion for the error rename inside the existing `'still exposes the client and the error type'` test:

```ts
    expect(typeof api.SQLiteBulkWriteError).toBe('function');
    expect('BulkWriteError' in api).toBe(false);
```

- [ ] **Step 6: Run the full check**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: PASS, 339 tests — 334 before this branch, plus four from Task 1 and one
from Task 2. Task 3 adds no runtime test: its pin is the type check.

- [ ] **Step 7: Verify falsifiability by hand**

Delete `first` from `SQLiteQueryAPI` and add it back to `SQLiteDB` alone. Run `npx tsc --noEmit`: it must fail on `asQueryAPI(pinnedTransaction)`. Restore. Report.

- [ ] **Step 8: Update the CHANGELOG**

Under `### Breaking`, add:

```markdown
- **`TransactionDB` is now `SQLiteTransactionDB`, and it is exported.** It
  appeared in `transaction()`'s signature without a consumer being able to name
  it.
- **`BulkWriteError` is now `SQLiteBulkWriteError`.**
- **`SQLiteQueryOptions` no longer carries `chunkSize`.** The methods that
  stream take `SQLiteChunkOptions`; the others take `SQLiteQueryOptions`.
- **`output()` is typed.** Its options and the rows passed to `enqueue` were
  `any`; a call that passed a mistyped row now stops compiling.
```

Under `### Added`:

```markdown
- The public type layer is exported: `SQLiteQueryAPI`, the two surfaces deriving
  from it, and every option, result and writer type they use. `stream()` now
  accepts `chunkSize`, which bounds how far the worker may run ahead.
```

- [ ] **Step 9: Check and commit**

```bash
pnpm check
git add src tests/unit/exports.test.ts CHANGELOG.md
git commit -m "refactor(api)!: one querying surface, and the types a consumer can name"
```

---

## Task 4: `createBulk` in two stages

**Files:**
- Modify: `src/bulk.ts`, `src/client.ts`
- Test: `tests/unit/bulk.test.ts`

**Interfaces:**
- Consumes: `tryWithLock` (Task 2), the types from `api.ts` (Task 3).
- Produces: `createBulk(shared: { file: string; locks: Locks; logger: Logger; maxVariables?: number })` returns `forTarget`. `forTarget(target: { read: ReadFn; write: WriteFn; transaction: TransactionFn })` returns `{ bulkWrite, output }`. Task 5 passes `forTarget` into `createTransaction`.

This task changes no behaviour. Its whole point is that `swept` stays in the outer closure.

- [ ] **Step 1: Write the failing test**

In `tests/unit/bulk.test.ts`, change `recorder()` to expose the two stages, keeping every existing call site working:

```ts
/** Records every statement the unit under test emits. */
const recorder = (locks: Locks = noOpLocks) => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 0 };
  };
  const read = async () => [] as any[];
  const transaction = async <T>(callback: (db: any) => Promise<T>) =>
    callback({
      write: async (s: string) => {
        sql.push(s);
        return { result: [], affected: 0 };
      },
      read: async () => [],
    });

  const forTarget = createBulk({ file: 'app.db', locks, logger: noopLogger });

  return {
    sql,
    forTarget,
    /** A target bound to this recorder — what most tests want. */
    target: () => forTarget({ read, write, transaction }),
    deps: { read, write, transaction },
  };
};
```

Then update every existing test in the file to the new shape. Most read
`const { bulkWrite } = createBulk(deps)` and become `const { bulkWrite } = target()`.

**One does not match that pattern and is easy to miss.** Task 2 added
`'attempts the sweep once even when the lock is refused'`, which reads
`const { output } = createBulk({ ...deps, locks })` — it had to, because
`createBulk` was still one-stage when it was written. It becomes:

```ts
    const { attempts, locks } = refusing();
    const { sql, forTarget, deps } = recorder(locks);
    const { output } = forTarget(deps);
```

Add after the migration:

```ts
  // Falsifiable: move `swept` inside forTarget. Two targets from one client
  // would then each sweep, and a transaction — which builds its own target —
  // would sweep on every single call.
  it('sweeps once across two targets built from one client', async () => {
    let sweeps = 0;
    const locks: Locks = {
      available: true,
      hold: async () => () => {},
      withLock: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      tryWithLock: async (_n, fn) => {
        sweeps += 1;
        await fn();
        return true;
      },
      heldNames: async () => [],
    };
    const { forTarget, deps } = recorder(locks);

    await forTarget(deps).output('a', { x: 'INTEGER' }).close();
    await forTarget(deps).output('b', { x: 'INTEGER' }).close();

    expect(sweeps).toBe(1);
  });
```

Import `Locks` as a type from `../../src/locks`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test:unit bulk`
Expected: FAIL — `createBulk is not a function` at the new call shape, or `forTarget is not a function`.

- [ ] **Step 3: Split `createBulk`**

In `src/bulk.ts`, change the signature to take only the shared dependencies, and wrap everything that needs `read` / `write` / `transaction` in the inner factory. The outer closure keeps `file`, `locks`, `logger`, `maxVariables` **and `swept`**:

```ts
export const createBulk = (shared: {
  file: string;
  locks: Locks;
  logger: Logger;
  maxVariables?: number;
}) => {
  const { file, locks, maxVariables = 32766, logger } = shared;

  // Net 2 of the three-net cleanup, and it lives HERE rather than in forTarget
  // on purpose: a transaction builds its own target, so a per-target memo would
  // sweep on every tx.output() instead of once per client.
  let swept: Promise<void> | undefined;

  return (target: {
    read: ReadFn;
    write: WriteFn;
    transaction: TransactionFn;
  }) => {
    const { read, write, transaction } = target;

    // bulkWrite, sweepOnce, indexStatements and output move in here VERBATIM.
    // Not one character of their bodies changes: they already read `read`,
    // `write`, `transaction`, `file`, `locks`, `logger` and `maxVariables` as
    // free variables, and all seven are still in scope. This task is a
    // relocation; any behavioural edit smuggled into it is a defect.

    return { bulkWrite, output };
  };
};
```

Move `bulkWrite`, `sweepOnce`, `indexStatements` and `output` inside the returned function, changing nothing in their bodies. `indexStatements` uses neither stage's values and could stay outside; leaving it inside is fine and keeps the diff smaller.

- [ ] **Step 4: Rewire `client.ts`**

Find the `createBulk(...)` call and split it:

```ts
  const bulkFor = createBulk({ file: dbFile, locks, logger });
  const { bulkWrite, output } = bulkFor({ read, write, transaction });
```

Keep `bulkFor` in scope — Task 5 passes it to `createTransaction`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test:unit bulk`
Expected: PASS, including the new sweep test and every pre-existing test.

Run: `pnpm test`
Expected: PASS, 340 tests.

- [ ] **Step 6: Verify falsifiability by hand**

Move `let swept` inside the returned function. Re-run: the new test must report `2` and go red. Restore. Report.

- [ ] **Step 7: Check and commit**

```bash
pnpm check
git add src/bulk.ts src/client.ts tests/unit/bulk.test.ts
git commit -m "refactor(bulk): the shared state stays outside, the target is the argument"
```

---

## Task 5: `tx.bulkWrite` and `tx.output`

**Files:**
- Modify: `src/api.ts`, `src/transaction.ts`, `src/client.ts`, `README.md`, `CHANGELOG.md`
- Test: `tests/browser/tx-write.test.ts` (create)

**Interfaces:**
- Consumes: `bulkFor` from Task 4, `SQLiteQueryAPI` from Task 3.
- Produces: `SQLiteTransactionDB.bulkWrite` and `.output`, with the same signatures the client has. `createTransaction`'s deps gain `bulkFor: ReturnType<typeof createBulk>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/browser/tx-write.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

describe('bulkWrite inside a transaction', () => {
  it('writes nothing when the transaction rolls back', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await expect(
      db.transaction(async (tx) => {
        const bulk = tx.bulkWrite('t', ['a']);
        bulk.enqueue({ a: 1 });
        bulk.enqueue({ a: 2 });
        await bulk.close();
        throw new Error('caller gave up');
      }),
    ).rejects.toThrow('caller gave up');

    const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(rows[0].n).toBe(0);
  });

  it('writes every row when the transaction commits', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await db.transaction(async (tx) => {
      const bulk = tx.bulkWrite('t', ['a']);
      bulk.enqueue({ a: 1 });
      bulk.enqueue({ a: 2 });
      await bulk.close();
    });

    const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(rows[0].n).toBe(2);
  });
});

describe('output inside a transaction', () => {
  it('leaves the previous target and no staging table when it rolls back', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE target (a INTEGER)');
    await db.write('INSERT INTO target VALUES (42)');

    await expect(
      db.transaction(async (tx) => {
        const out = tx.output('target', { a: 'INTEGER' });
        out.enqueue({ a: 7 });
        await out.close();
        throw new Error('caller gave up');
      }),
    ).rejects.toThrow('caller gave up');

    const rows = await db.read<{ a: number }>('SELECT a FROM target');
    expect(rows).toEqual([{ a: 42 }]);

    const staging = await db.read<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'`,
    );
    expect(staging).toEqual([]);
  });

  it('replaces the target when it commits', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE target (a INTEGER)');
    await db.write('INSERT INTO target VALUES (42)');

    await db.transaction(async (tx) => {
      const out = tx.output('target', { a: 'INTEGER' });
      out.enqueue({ a: 7 });
      await out.close();
    });

    const rows = await db.read<{ a: number }>('SELECT a FROM target');
    expect(rows).toEqual([{ a: 7 }]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test:browser tx-write`
Expected: FAIL — `tx.bulkWrite is not a function`.

- [ ] **Step 3: Move `bulkWrite` and `output` into the base type**

In `src/api.ts`, cut the `bulkWrite` and `output` members from `SQLiteDB` and paste them into `SQLiteQueryAPI`, after `first`. `SQLiteDB` keeps only `transaction`, `close` and `debug`.

- [ ] **Step 4: Build them in `createTransaction`**

In `src/transaction.ts`, add `bulkFor` to the deps object:

```ts
    /**
     * The client's bulk factory. Called per transaction with the transaction's
     * own read/write and a pass-through `transaction`, so output()'s swap runs
     * on the caller's transaction instead of opening a BEGIN SQLite does not
     * allow.
     */
    bulkFor: (target: {
      read: ReadFn;
      write: WriteFn;
      transaction: TransactionFn;
    }) => { bulkWrite: SQLiteQueryAPI['bulkWrite']; output: SQLiteQueryAPI['output'] };
```

Export `ReadFn`, `WriteFn` and `TransactionFn` from `src/bulk.ts` so `transaction.ts` can name them.

Inside the transaction body, before `const db`:

```ts
    const bulk = deps.bulkFor({
      read: (sql, params, options) =>
        readWorker(worker, checksql(sql), params, options),
      write: (sql, params, options) =>
        writeWorker(worker, checksql(sql), params, options),
      // The caller's transaction is already open. No BEGIN, no COMMIT.
      transaction: (fn) => fn(db),
    });
```

and add to the `db` object literal, after `first`:

```ts
      bulkWrite: bulk.bulkWrite,
      output: bulk.output,
```

`db` is referenced inside an arrow that runs only after `db` is assigned, which is why the ordering works.

- [ ] **Step 5: Pass `bulkFor` from `client.ts`**

Add `bulkFor` to the `createTransaction({ ... })` deps object, using the `bulkFor` Task 4 left in scope. `createBulk` must be called before `createTransaction`; reorder if it is not.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm test:browser tx-write`
Expected: PASS, four tests.

Run: `pnpm test`
Expected: PASS, 344 tests.

- [ ] **Step 7: Document it**

`README.md`, `### Transaction` — add after the existing prose:

> `tx` carries the same querying surface as the client — `read`, `write`, `chunk`, `stream`, `first`, `bulkWrite`, `output` — plus `commit` and `rollback`.

`README.md`, `### bulkWrite` — add:

> `bulkWrite()` is not atomic: batches are committed as they flush, so a failure leaves the rows already written in place. Call it on a `tx` if you need all-or-nothing.

`README.md`, `### output` — add:

> **Inside a transaction, `output()` costs more than it looks.** On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

Put the same two warnings in the JSDoc of `SQLiteQueryAPI.bulkWrite` and `SQLiteQueryAPI.output` in `src/api.ts`, phrased as a cost to the caller and not as a mechanism.

- [ ] **Step 8: Update the CHANGELOG**

Under `### Added`:

```markdown
- **`bulkWrite()` and `output()` are available on a transaction.** A bulk load
  inside `transaction()` is atomic: it rolls back with everything else. Outside
  one, `bulkWrite()` stays streaming and commits per batch.
```

- [ ] **Step 9: Check and commit**

```bash
pnpm check
git add src README.md CHANGELOG.md tests/browser/tx-write.test.ts
git commit -m "feat(transaction): a transaction gets bulkWrite and output"
```

---

## Task 6: The `readOnly` guard and `READ_ONLY_TRANSACTION`

**Files:**
- Modify: `src/errors.ts`, `src/transaction.ts`, `README.md`, `CHANGELOG.md`
- Test: `tests/browser/tx-write.test.ts`

**Interfaces:**
- Consumes: `tx.bulkWrite` / `tx.output` from Task 5.
- Produces: `SQLiteErrorCode` gains `'READ_ONLY_TRANSACTION'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/tx-write.test.ts`:

```ts
describe('a read-only transaction', () => {
  // Falsifiable: build the stub lazily, so the throw moves to close(). The
  // `expect(() => …).toThrow` form is what pins the timing — a caller must not
  // be handed a writer that fails only after it has enqueued a million rows.
  it('refuses bulkWrite at the call, not at the first flush', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await db.transaction(
      async (tx) => {
        expect(() => tx.bulkWrite('t', ['a'])).toThrow(
          expect.objectContaining({ code: 'READ_ONLY_TRANSACTION' }),
        );
      },
      { readOnly: true },
    );
  });

  it('refuses output at the call', async () => {
    const db = await createTestClient();

    await db.transaction(
      async (tx) => {
        expect(() => tx.output('t', { a: 'INTEGER' })).toThrow(
          expect.objectContaining({ code: 'READ_ONLY_TRANSACTION' }),
        );
      },
      { readOnly: true },
    );
  });

  it('rejects a write statement with a SQLiteError, not a bare Error', async () => {
    const db = await createTestClient();

    await expect(
      db.transaction(
        async (tx) => {
          await tx.write('CREATE TABLE nope (a INTEGER)');
        },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: 'READ_ONLY_TRANSACTION' });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test:browser tx-write`
Expected: FAIL — the first two because no throw happens at the call, the third because `checksql` throws a bare `Error` with no `code`.

- [ ] **Step 3: Add the error code**

In `src/errors.ts`, add `| 'READ_ONLY_TRANSACTION'` to `SQLiteErrorCode`, after `'BUSY'`.

- [ ] **Step 4: Throw a typed error and guard at the call**

In `src/transaction.ts`, change `checksql`:

```ts
    const checksql = (sql: string): string => {
      if (readOnly && isWriteQuery(sql))
        throw new SQLiteError(
          'READ_ONLY_TRANSACTION',
          'Cannot write in a read-only transaction.',
        );
      return sql;
    };
```

and replace the `bulk` construction with a `readOnly` branch:

```ts
    // Guarded at the call, not at the first flush. bulkWrite buffers, so the
    // failure would otherwise surface once the buffer overflows — and for
    // output() later still, trapped inside the createStaging promise.
    const refuse = (method: string) => (): never => {
      throw new SQLiteError(
        'READ_ONLY_TRANSACTION',
        `${method}() writes, and this transaction is read-only.`,
      );
    };

    const bulk = readOnly
      ? {
          bulkWrite: refuse('bulkWrite') as SQLiteQueryAPI['bulkWrite'],
          output: refuse('output') as SQLiteQueryAPI['output'],
        }
      : deps.bulkFor({
          read: (sql, params, options) =>
            readWorker(worker, checksql(sql), params, options),
          write: (sql, params, options) =>
            writeWorker(worker, checksql(sql), params, options),
          transaction: (fn) => fn(db),
        });
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test:browser tx-write`
Expected: PASS, seven tests.

Run: `pnpm test`
Expected: PASS, 347 tests.

- [ ] **Step 6: Verify falsifiability by hand**

Make `refuse` return a writer whose `close()` throws instead of throwing at the call. Re-run: the first two tests must go red. Restore. Report.

- [ ] **Step 7: Document it**

`README.md`, `## Error handling` — add a `READ_ONLY_TRANSACTION` row: *raised when a write statement, `bulkWrite()` or `output()` is used inside a transaction opened with `readOnly: true`.*

`README.md`, `### Options` — **correct a stale row.** The `vfs` line reads `Default 'OPFSAdaptiveVFS'`. There is no default since `vfs` became required; that is the point of the breaking change. Replace the Default cell with `— (required)` and keep the description.

- [ ] **Step 8: Update the CHANGELOG**

Under `### Added`:

```markdown
- `SQLiteError` code `READ_ONLY_TRANSACTION`, raised when a write, `bulkWrite()`
  or `output()` is attempted in a `readOnly` transaction. `bulkWrite()` and
  `output()` refuse at the call rather than at the first flush.
```

Under `### Fixed`:

```markdown
- A write in a read-only transaction threw a bare `Error`, the only guard in the
  library that escaped the `code` discriminant.
```

- [ ] **Step 9: Check and commit**

```bash
pnpm check
git add src README.md CHANGELOG.md tests/browser/tx-write.test.ts
git commit -m "feat(transaction): a read-only transaction refuses at the call, with a code"
```

---

## Task 7: The sweep does not stall a transaction

**Files:**
- Test: `tests/browser/tx-write.test.ts`

**Interfaces:**
- Consumes: everything above. Adds no source change — this task exists to pin, in the browser, the property Tasks 1 and 2 built.

**Read this before writing the test.** Two things make the difference between a real pin and a green that proves nothing:

- **The preceding write is mandatory.** `transaction()` issues a plain `BEGIN` (`transaction.ts`), which is *deferred*: SQLite takes the write lock at the first write statement, not at `BEGIN`. A `tx.output()` placed first in the transaction holds no lock and cannot stall, so the test would pass with `tryWithLock` reverted.
- **The orphan is the control.** Asserting only that the transaction completes does not prove the lock name matched — a typo would skip the sweep for the wrong reason and still pass. A pre-planted orphan staging table that *survives* proves the sweep was reached, found the lock held, and skipped.

- [ ] **Step 1: Write the test**

Append to `tests/browser/tx-write.test.ts`:

```ts
describe('the staging sweep under a transaction', () => {
  // Falsifiable: change tryWithLock back to withLock in bulk.ts's sweepOnce.
  // The transaction then waits on a lock this test never releases and the race
  // below rejects.
  it('does not stall while another holder has the sweep lock', async () => {
    // debug: true is how the test learns the NORMALIZED database name --
    // ClientDebugState.file is set from client.ts's `dbFile`, so the lock name
    // is exact rather than assumed. createTestClient does not return the name
    // it generates, and changing that would touch fifteen browser test files.
    const db = await createTestClient({ debug: true });
    const lockName = sweepLockName(db.debug!.file);

    await db.write('CREATE TABLE target (a INTEGER)');
    // A staging table nobody holds a lock for: the sweep would drop it.
    await db.write('CREATE TABLE __bsq_staging_orphan (a INTEGER)');

    let releaseSweepLock!: () => void;
    const lockTaken = new Promise<void>((taken) => {
      navigator.locks.request(lockName, () => {
        taken();
        return new Promise<void>((release) => {
          releaseSweepLock = release;
        });
      });
    });
    await lockTaken;

    try {
      const finished = db.transaction(async (tx) => {
        // Mandatory: takes SQLite's write lock, which BEGIN alone does not.
        await tx.write('INSERT INTO target VALUES (1)');
        const out = tx.output('target', { a: 'INTEGER' });
        out.enqueue({ a: 2 });
        await out.close();
      });

      await Promise.race([
        finished,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'the transaction stalled: the sweep waited for a lock it should have skipped',
                ),
              ),
            5000,
          ),
        ),
      ]);

      // The control. If this orphan is gone the sweep ran, which means the lock
      // name did not match and the test proved nothing about skipping.
      const staging = await db.read<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = '__bsq_staging_orphan'`,
      );
      expect(staging).toHaveLength(1);
    } finally {
      releaseSweepLock();
    }
  });
});
```

Add `import { sweepLockName } from '../../src/locks';` at the top of the file.

- [ ] **Step 2: Run the test and verify it passes**

Run: `pnpm test:browser tx-write`
Expected: PASS, eight tests.

- [ ] **Step 3: Verify falsifiability by hand — both directions**

Revert `sweepOnce` to `locks.withLock(...)`. Re-run: the test must fail with the stall message, not with a bare timeout. Restore.

Then change the lock name in the test to something no one holds. Re-run: the orphan assertion must fail, because the sweep now runs and drops it. Restore. Report both.

- [ ] **Step 4: Commit**

```bash
pnpm check
git add tests/browser/tx-write.test.ts
git commit -m "test(transaction): the sweep skips a held lock instead of stalling a transaction"
```

---

## Final verification

Before the branch is offered for review:

- [ ] `npx tsc --noEmit` — clean
- [ ] `pnpm check` — clean
- [ ] `pnpm build` — succeeds
- [ ] `pnpm test` — 348 tests, 0 failures
- [ ] `pnpm test:conformance` — unchanged
- [ ] `pnpm test:consumer` — 11/11 stages
- [ ] `node scripts/bench/check.mjs` — the benchmark page is a package consumer with no compile-time guard, and this branch changes public exports. Removing `DEFAULT_VFS` broke it silently once already; do not skip this.
- [ ] `CHANGELOG.md` carries every breaking change made here
- [ ] Update `mem:state`, and remove from `mem:follow-ups` the half of `W-types` this closes — `SQLiteQueryOptions` and `TransactionDB` are nameable now
