# `tx.savepoint()` and the transaction-control guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a transaction a nested, separately undoable block — `tx.savepoint(name?)` resolving to `{ name, release(), rollback({ release? }) }` — and refuse every transaction-control statement a consumer sends as SQL, through SQLite's authorizer in the worker.

**Architecture:** A pure module (`src/savepoints.ts`) keeps the library's copy of SQLite's savepoint stack and decides, at the call, what each operation must send or refuse. `src/transaction.ts` runs the operations as library control statements through its existing statement queue and `via` facade. The worker installs a synchronous authorizer that denies `SQLITE_TRANSACTION`/`SQLITE_SAVEPOINT` unless the message carries a new `control` protocol flag, remembers the control statements it allowed so a statement-cache hit cannot bypass it, and runs savepoint operations uncached (new `uncached` flag).

**Tech Stack:** TypeScript (native `tsc`), wa-sqlite (vendored, `patches/`), rstest (unit project in Node; browser projects on Playwright Chromium and Firefox), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-04-tx-savepoint-design.md` — read it before any task. Two corrections found while writing this plan are applied by Task 5 and assumed throughout: `sqliteCode` is numeric (`SQLITE_CODES.AUTH`, 23), not `'AUTH'`; and E19 is timing-dependent (see Task 3, Step 9).

## Global Constraints

- **Serena first for code** (`AGENTS.md`): read code with `get_symbols_overview` / `find_symbol`, edit with `replace_symbol_body` / `insert_*_symbol` / `replace_content`. Built-in Read/Edit only for non-code files (`.md`, JSON). Every subagent prompt that touches code carries this rule.
- **One query per worker at a time** is what makes plain variables in the worker safe (`mem:architecture`); nothing in this plan may lend a worker to two callers.
- **Every message a transaction sends goes through `via`, except the teardown `ROLLBACK`** (`mem:architecture`). The savepoint operations go through `via(false)`.
- **The authorizer callback must be a plain (non-`async`) function** — an `async` one makes wa-sqlite take the `_async` relay.
- **Generated names:** `__bsq_sp_<n>`, `n` from 1 per transaction. **Reserved prefix:** `__bsq_`, compared case-insensitively.
- **Error codes:** one new public code, `SAVEPOINT_CLOSED`. Refused control is `STATEMENT_FAILED` with `sqliteCode` `SQLITE_CODES.AUTH` (23).
- **No `signal` / `timeout`** on `tx.savepoint()`, `release()`, `rollback()`.
- **Prose in Markdown: long lines, no hard wrapping** (`mem:conventions`). Comments state the fact in one or two lines, not the debate.
- **Commits:** Conventional Commits, on `feat/tx-savepoint`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check `git branch --show-current` before every commit — other sessions switch the shared checkout. Never push.
- **After every modification:** `pnpm exec biome check --write <files>`; before every commit `pnpm exec tsc --noEmit`.
- **Test commands:** unit — `pnpm exec rstest run --project unit <file-filter>`; Chromium — `pnpm exec rstest run --project 'chromium*' <file-filter>`; Firefox — `pnpm exec rstest run --config rstest.firefox.config.ts <file-filter>`. Read `status` and `failedFiles` in each report, not only the counts. Strip the agent markers when a result will be compared with CI: `env -u AI_AGENT -u CLAUDECODE`.

## Review Focus

1. **A given name containing a double quote, spaces or non-ASCII** (`a"b`, `my point`, `étape`) — a reasonable person expects it to work like any other name. Pinned in Task 3 (B8).
2. **A handle kept after `transaction()` has resolved** (stored in an outer variable) — expects `TRANSACTION_CLOSED`, never SQL on a pooled connection. Pinned in Task 3 (U3, E1 case).
3. **`tx.savepoint()` issued without `await`, then `tx.write()`** — expects the savepoint to open first (call order). Pinned in Task 3 (U3, order case).
4. **`autoCommit: false` and a callback that returns with savepoints open and no `commit()`** — expects a full rollback and closed handles, no `RELEASE`. Pinned in Task 3 (U5).
5. **A consumer's name equal to a generated one in another case** (`__BSQ_SP_1`) — expects `INVALID_IDENTIFIER`, never a collision with the library's own. Pinned in Task 1.

---

### Task 1: The savepoint stack, and `SAVEPOINT_CLOSED`

**Files:**
- Create: `src/savepoints.ts`
- Modify: `src/types/errors.ts` (the `SQLiteErrorCode` union)
- Test: `tests/unit/savepoints.test.ts`

**Interfaces:**
- Produces:
  - `createSavepointStack(): SavepointStack`
  - `type SavepointStack = { open(name?: unknown): SavepointEntry; release(entry: SavepointEntry): SavepointStep; rollback(entry: SavepointEntry, release: boolean): SavepointStep }`
  - `type SavepointEntry = { readonly name: string; state: 'open' | 'released' | 'rolled-back'; closedBy?: SavepointClosure }`
  - `type SavepointClosure = { readonly by: 'release' | 'rollback'; readonly savepoint: string }`
  - `type SavepointStep = 'send' | 'noop'`
  - `'SAVEPOINT_CLOSED'` in `SQLiteErrorCode`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/savepoints.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createSavepointStack } from '../../src/savepoints';

describe('savepoint stack — names (spec 2026-10-04, D3)', () => {
  it('generates __bsq_sp_<n>, counting from 1 per stack', () => {
    const stack = createSavepointStack();
    expect(stack.open().name).toBe('__bsq_sp_1');
    expect(stack.open().name).toBe('__bsq_sp_2');
    expect(createSavepointStack().open().name).toBe('__bsq_sp_1');
  });

  for (const [label, name] of [
    ['empty', ''],
    ['not a string', 42],
    ['NUL', 'a\0b'],
    ['reserved prefix', '__bsq_mine'],
    ['reserved prefix, other case', '__BSQ_SP_1'],
  ] as const) {
    it(`refuses a name that is ${label} with INVALID_IDENTIFIER`, () => {
      expect(() => createSavepointStack().open(name)).toThrow(
        expect.objectContaining({ code: 'INVALID_IDENTIFIER' }),
      );
    });
  }

  // Falsifiable: compare names case-sensitively in open().
  it('refuses a name already open, ignoring case as SQLite does', () => {
    const stack = createSavepointStack();
    stack.open('Step');
    expect(() => stack.open('STEP')).toThrow(
      expect.objectContaining({ code: 'INVALID_IDENTIFIER' }),
    );
  });

  it('accepts a name again once it has closed', () => {
    const stack = createSavepointStack();
    stack.release(stack.open('step'));
    expect(stack.open('step').name).toBe('step');
  });
});

describe('savepoint stack — what each operation sends (spec 2026-10-04, § 3)', () => {
  it('releases an open savepoint, then does nothing on a second release', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.release(sp)).toBe('send');
    expect(sp.state).toBe('released');
    expect(stack.release(sp)).toBe('noop');
  });

  it('rolls back and closes by default, then does nothing on a second rollback', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.rollback(sp, true)).toBe('send');
    expect(sp.state).toBe('rolled-back');
    expect(stack.rollback(sp, true)).toBe('noop');
  });

  // Falsifiable: close the entry itself whatever `release` says.
  it('keeps the savepoint open after rollback without release', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.rollback(sp, false)).toBe('send');
    expect(sp.state).toBe('open');
    expect(stack.rollback(sp, false)).toBe('send');
    expect(stack.release(sp)).toBe('send');
  });

  it('refuses to roll back a released savepoint with SAVEPOINT_CLOSED', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    stack.release(sp);
    expect(() => stack.rollback(sp, true)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'a' },
      }),
    );
  });

  it('refuses to release a rolled-back savepoint with SAVEPOINT_CLOSED', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    stack.rollback(sp, true);
    expect(() => stack.release(sp)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'rollback', savepoint: 'a' },
      }),
    );
  });
});

describe('savepoint stack — a parent closes its children (spec 2026-10-04, E5-E7)', () => {
  // Falsifiable: in release(), mark only the entry itself.
  it("releases the children with the parent's release", () => {
    const stack = createSavepointStack();
    const parent = stack.open('p');
    const child = stack.open('c');
    stack.release(parent);
    expect(child.state).toBe('released');
    expect(stack.release(child)).toBe('noop');
    expect(() => stack.rollback(child, true)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'p' },
      }),
    );
  });

  // Falsifiable: in rollback(), leave the entries above the target open.
  it("rolls the children back with the parent's rollback, even when the parent stays open", () => {
    const stack = createSavepointStack();
    const parent = stack.open('p');
    const child = stack.open('c');
    stack.rollback(parent, false);
    expect(parent.state).toBe('open');
    expect(child.state).toBe('rolled-back');
    expect(stack.rollback(child, true)).toBe('noop');
    expect(() => stack.release(child)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'rollback', savepoint: 'p' },
      }),
    );
  });

  it('frees a closed child name for reuse under the open parent', () => {
    const stack = createSavepointStack();
    stack.open('p');
    stack.release(stack.open('c'));
    expect(stack.open('c').state).toBe('open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec rstest run --project unit savepoints`
Expected: FAIL — cannot resolve `../../src/savepoints`.

- [ ] **Step 3: Write minimal implementation**

In `src/types/errors.ts`, add `| 'SAVEPOINT_CLOSED'` to the `SQLiteErrorCode` union, right after `'TRANSACTION_CLOSED'` (Serena `replace_content`, literal `  | 'TRANSACTION_CLOSED';` → `  | 'TRANSACTION_CLOSED'\n  | 'SAVEPOINT_CLOSED';`).

Create `src/savepoints.ts`:

```ts
import { SQLiteError } from './types/errors';

/**
 * What closed a savepoint, carried as the `cause` of `SAVEPOINT_CLOSED`: the
 * operation, and the savepoint it addressed — this one, or one it was nested in.
 */
export type SavepointClosure = {
  readonly by: 'release' | 'rollback';
  readonly savepoint: string;
};

/** One savepoint of a transaction, as the library's copy of SQLite's stack sees it. */
export type SavepointEntry = {
  readonly name: string;
  state: 'open' | 'released' | 'rolled-back';
  closedBy?: SavepointClosure;
};

/** `send`: the operation has SQL to run. `noop`: what it promises is already true. */
export type SavepointStep = 'send' | 'noop';

/** Prefix of every name the library generates, refused in a consumer's. */
const RESERVED_PREFIX = '__bsq_';

/**
 * SQLite compares savepoint names ignoring ASCII case. `toLowerCase()` folds
 * more than ASCII, so it can only refuse a name SQLite would accept, never
 * accept one SQLite would confuse with an open savepoint.
 */
const keyOf = (name: string) => name.toLowerCase();

const invalid = (message: string) =>
  new SQLiteError('INVALID_IDENTIFIER', message);

/**
 * The library's copy of one transaction's savepoint stack (spec 2026-10-04,
 * § 5). Updated at the call, in the order the transaction's queue will run
 * the statements, so it is the order SQLite sees.
 */
export const createSavepointStack = () => {
  /** Open savepoints, outermost first. */
  const stack: SavepointEntry[] = [];
  let generated = 0;

  const open = (name?: unknown): SavepointEntry => {
    let chosen: string;
    if (name === undefined) {
      generated += 1;
      chosen = `${RESERVED_PREFIX}sp_${generated}`;
    } else {
      if (typeof name !== 'string' || name === '')
        throw invalid('A savepoint name must be a non-empty string.');
      if (name.includes('\0'))
        throw invalid(
          `A savepoint name cannot contain a NUL character: ${JSON.stringify(name)}`,
        );
      if (keyOf(name).startsWith(RESERVED_PREFIX))
        throw invalid(
          `Savepoint names starting with "${RESERVED_PREFIX}" are reserved for the library: ${JSON.stringify(name)}`,
        );
      const clash = stack.find((entry) => keyOf(entry.name) === keyOf(name));
      if (clash)
        throw invalid(
          `A savepoint named ${JSON.stringify(clash.name)} is already open; SQLite would address the newer one.`,
        );
      chosen = name;
    }
    const entry: SavepointEntry = { name: chosen, state: 'open' };
    stack.push(entry);
    return entry;
  };

  /** Pops `stack[index]` and everything above it, recording what closed them. */
  const close = (
    index: number,
    state: 'released' | 'rolled-back',
    closure: SavepointClosure,
  ) => {
    for (const entry of stack.splice(index)) {
      entry.state = state;
      entry.closedBy = closure;
    }
  };

  const closedError = (
    entry: SavepointEntry,
    attempted: 'released' | 'rolled back',
  ) => {
    const how = entry.state === 'released' ? 'released' : 'rolled back';
    const by =
      entry.closedBy && entry.closedBy.savepoint !== entry.name
        ? ` along with ${JSON.stringify(entry.closedBy.savepoint)}`
        : '';
    return new SQLiteError(
      'SAVEPOINT_CLOSED',
      `Savepoint ${JSON.stringify(entry.name)} was already ${how}${by}; it cannot be ${attempted}.`,
      { cause: entry.closedBy },
    );
  };

  const release = (entry: SavepointEntry): SavepointStep => {
    if (entry.state === 'released') return 'noop';
    if (entry.state === 'rolled-back') throw closedError(entry, 'released');
    close(stack.indexOf(entry), 'released', {
      by: 'release',
      savepoint: entry.name,
    });
    return 'send';
  };

  const rollback = (entry: SavepointEntry, release: boolean): SavepointStep => {
    if (entry.state === 'rolled-back') return 'noop';
    if (entry.state === 'released') throw closedError(entry, 'rolled back');
    const index = stack.indexOf(entry);
    const closure: SavepointClosure = {
      by: 'rollback',
      savepoint: entry.name,
    };
    // ROLLBACK TO pops what was opened after this savepoint and keeps it.
    close(index + 1, 'rolled-back', closure);
    if (release) close(index, 'rolled-back', closure);
    return 'send';
  };

  return { open, release, rollback };
};

export type SavepointStack = ReturnType<typeof createSavepointStack>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec rstest run --project unit savepoints`
Expected: PASS, every test. Then `pnpm exec tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/savepoints.ts src/types/errors.ts tests/unit/savepoints.test.ts
git branch --show-current   # feat/tx-savepoint
git add src/savepoints.ts src/types/errors.ts tests/unit/savepoints.test.ts
git commit -m "feat(transaction): the library's copy of the savepoint stack

A pure decision table for tx.savepoint(): what each operation sends,
what it refuses, and what a parent's release or rollback does to its
children, so transaction.ts only runs SQL.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `control` and `uncached` protocol flags

**Files:**
- Modify: `src/types/protocol.ts` (`SQLOptions`)
- Modify: `src/pool.ts` (`PoolWorkerQueryOptions`, the `query` posting at the `worker.postMessage({ type: 'query', … })` call)
- Modify: `src/transaction.ts` (`exec`)
- Test: `tests/unit/transaction.test.ts` (`fakeWorker`, a new `describe`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - protocol `SQLOptions.control?: true` and `SQLOptions.uncached?: true`
  - `PoolWorkerQueryOptions.control?: boolean` and `PoolWorkerQueryOptions.uncached?: boolean`, forwarded into the posted `options`
  - `exec(worker: PoolWorker, sql: string, extra?: { uncached?: boolean }): Promise<void>` in `src/transaction.ts`, which always sends `control: true` and `internal: true`
  - `fakeWorker(...).flags: { sql: string; control: boolean; uncached: boolean }[]` in the unit test file

- [ ] **Step 1: Write the failing test**

In `tests/unit/transaction.test.ts`, extend `fakeWorker`: add `const flags: { sql: string; control: boolean; uncached: boolean }[] = [];` beside `executed`, expose it as `flags` on the returned object, widen the `options` parameter type to also carry `control?: boolean; uncached?: boolean`, and push one record per statement right after `executed.push(sql);`:

```ts
      flags.push({
        sql,
        control: options?.control === true,
        uncached: options?.uncached === true,
      });
```

Then add, after the `'transaction — BEGIN announces write intent (spec 2026-09-15, A4)'` describe:

```ts
describe('transaction — the control flag (spec 2026-10-04, § 4)', () => {
  // Falsifiable: drop `control: true` from exec() in src/transaction.ts.
  it('marks BEGIN and COMMIT as control, and nothing the callback runs', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
    });
    expect(worker.flags).toEqual([
      { sql: 'BEGIN IMMEDIATE', control: true, uncached: false },
      { sql: 'INSERT INTO t VALUES (1)', control: false, uncached: false },
      { sql: 'COMMIT', control: true, uncached: false },
    ]);
  });

  // Falsifiable: send rollbackNow()'s ROLLBACK through a path that skips exec().
  it('marks the teardown ROLLBACK as control', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async () => {
      throw new Error('roll it back');
    }).catch(() => {});
    expect(worker.flags.at(-1)).toEqual({
      sql: 'ROLLBACK',
      control: true,
      uncached: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec rstest run --project unit transaction`
Expected: FAIL in the two new tests — `control` is `false` on `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK`.

- [ ] **Step 3: Write minimal implementation**

`src/types/protocol.ts`, in `SQLOptions`, after `savepoint?: SavepointOp;`:

```ts
  /**
   * The library's own transaction control — BEGIN, COMMIT, ROLLBACK, a
   * consumer's savepoint operation. The worker's authorizer refuses
   * transaction control on any message without it (spec 2026-10-04, § 4).
   */
  control?: true;
  /** Prepared afresh and never cached (spec 2026-10-04, D9). */
  uncached?: true;
```

`src/pool.ts`, in `PoolWorkerQueryOptions`, after `savepoint?: …`:

```ts
  /** Forwarded as the protocol's `control`: see `SQLOptions` in `types/protocol.ts`. */
  control?: boolean;
  /** Forwarded as the protocol's `uncached`: see `SQLOptions` in `types/protocol.ts`. */
  uncached?: boolean;
```

`src/pool.ts`, in the `query` generator: add `control = false,` and `uncached = false,` to the `const { chunkSize = 500, … } = options ?? {};` destructuring, and in the posted message's `options` object add, after `...(op ? { savepoint: op } : {}),`:

```ts
          ...(control ? { control: true as const } : {}),
          ...(uncached ? { uncached: true as const } : {}),
```

`src/transaction.ts`, replace `exec` (Serena `replace_symbol_body` on `exec`):

```ts
// Drains a statement that returns no rows (BEGIN, COMMIT, ROLLBACK, a
// savepoint operation) without the chunkSize-1 + break overhead of
// firstWorker. Every one is the library's own transaction control: the facade
// marks it `internal` for db.debug and `control` for the worker's authorizer
// (spec 2026-10-04, § 4) — `readWorker`'s options are the public
// `SQLiteChunkOptions` and cannot carry either flag themselves.
const exec = async (
  worker: PoolWorker,
  sql: string,
  extra: { uncached?: boolean } = {},
): Promise<void> => {
  const facade: PoolWorker = Object.create(worker);
  facade.query = ((
    sql: string,
    params?: unknown[],
    options?: PoolWorkerQueryOptions,
  ) =>
    worker.query(sql, params, {
      ...options,
      internal: true,
      control: true,
      ...(extra.uncached ? { uncached: true } : {}),
    })) as PoolWorker['query'];
  await readWorker(facade, sql);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec rstest run --project unit transaction`
Expected: PASS, the whole file. `pnpm exec tsc --noEmit` — clean. The pool half has no unit test here: Task 4's guard refuses every `BEGIN` that arrives without the flag, so every browser transaction test falsifies it.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/types/protocol.ts src/pool.ts src/transaction.ts tests/unit/transaction.test.ts
git branch --show-current   # feat/tx-savepoint
git add src/types/protocol.ts src/pool.ts src/transaction.ts tests/unit/transaction.test.ts
git commit -m "feat(protocol): flag the library's own transaction control

The worker's authorizer will refuse transaction control from anything
else, so BEGIN, COMMIT and ROLLBACK now say they are the library's, and a
query can ask not to be cached.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `tx.savepoint()`

**Files:**
- Modify: `src/api.ts` (`SQLiteTransactionDB`, a new exported `SQLiteSavepoint`)
- Modify: `src/transaction.ts` (imports; inside `createTransaction`: the stack, `runControl`, the `savepoint` member of `db`)
- Test: `tests/unit/transaction.test.ts` (the fake worker's `inTransaction` rule; T7 list and new cases; new describes)
- Test: `tests/browser/savepoint-api.test.ts` (new)

**Interfaces:**
- Consumes: `createSavepointStack`, `SavepointEntry` (Task 1); `exec(worker, sql, { uncached: true })` (Task 2); `quoteIdent` from `src/utils.ts`.
- Produces:
  - `SQLiteTransactionDB.savepoint: (name?: string) => Promise<SQLiteSavepoint>`
  - `type SQLiteSavepoint = { readonly name: string; release: () => Promise<void>; rollback: (options?: { release?: boolean }) => Promise<void> }`, exported from `src/api.ts` (so from the package entry, which re-exports `api` wholesale)
  - SQL sent: `SAVEPOINT "x"`, `RELEASE "x"`, `ROLLBACK TO "x"; RELEASE "x"`, `ROLLBACK TO "x"` — each through `via(false)` with `control` and `uncached`

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/transaction.test.ts`:

1. In `fakeWorker`'s `finally`, a `ROLLBACK TO` must not mark the connection as out of its transaction. Replace `/^(COMMIT|ROLLBACK)/.test(sql)` with `/^(COMMIT|ROLLBACK(?!\s+TO\b))/.test(sql)`.

2. In the T7 `entries` list, add `['savepoint', (tx) => tx.savepoint('u'), 'SAVEPOINT "u"'],` (the F3 test fails without it once `savepoint` exists, by design).

3. After the `for (const [name, entry, sql] of entries)` loop, add the handle's own T7 cases:

```ts
  // T7 for the handle (spec 2026-10-04, U1). Falsifiable, each: run that
  // operation through exec(worker, …) instead of exec(via(false), …).
  for (const [name, end, sql] of [
    ['release', (sp: SQLiteSavepoint) => sp.release(), 'RELEASE "u"'],
    [
      'rollback',
      (sp: SQLiteSavepoint) => sp.rollback(),
      'ROLLBACK TO "u"; RELEASE "u"',
    ],
  ] as const) {
    it(`a savepoint's ${name}() concludes the abandoned write's savepoint first`, async () => {
      const reached = deferred();
      const gate = deferred();
      const worker = fakeWorker([], {
        'INSERT INTO t VALUES (1)': async () => {
          reached.resolve();
          await gate.promise;
        },
      });
      const { transaction } = harness(worker);
      const own = new AbortController();
      await transaction(async (tx) => {
        const sp = await tx.savepoint('u');
        const write = tx.write('INSERT INTO t VALUES (1)', [], {
          signal: own.signal,
        });
        await reached.promise;
        own.abort(new Error('this write only'));
        await write.catch(() => {});
        gate.resolve();
        await end(sp);
      });
      expect(worker.executed).toEqual([
        'BEGIN IMMEDIATE',
        'SAVEPOINT "u"',
        'SAVEPOINT __bsq_sp',
        'INSERT INTO t VALUES (1)',
        'ROLLBACK TO __bsq_sp',
        'RELEASE __bsq_sp',
        sql,
        'COMMIT',
      ]);
    });
  }
```

Add `import type { SQLiteSavepoint, SQLiteTransactionDB } from '../../src/api';` in place of the current `SQLiteTransactionDB` import.

4. Add these describes at the end of the file:

```ts
describe('tx.savepoint() — what reaches the worker (spec 2026-10-04, U2, U6)', () => {
  // Falsifiable: call exec() without `{ uncached: true }` in runControl().
  it('sends each operation as uncached control', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const sp = await tx.savepoint('u');
      await sp.rollback({ release: false });
      await sp.release();
    });
    expect(worker.flags.slice(1, -1)).toEqual([
      { sql: 'SAVEPOINT "u"', control: true, uncached: true },
      { sql: 'ROLLBACK TO "u"', control: true, uncached: true },
      { sql: 'RELEASE "u"', control: true, uncached: true },
    ]);
  });

  it('names unnamed savepoints __bsq_sp_<n>, from 1 in every transaction', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const names: string[] = [];
    await transaction(async (tx) => {
      names.push((await tx.savepoint()).name, (await tx.savepoint()).name);
    });
    await transaction(async (tx) => {
      names.push((await tx.savepoint()).name);
    });
    expect(names).toEqual(['__bsq_sp_1', '__bsq_sp_2', '__bsq_sp_1']);
    expect(worker.executed).toContain('SAVEPOINT "__bsq_sp_2"');
  });
});

describe('tx.savepoint() — refusals at the call (spec 2026-10-04, E1-E8, U3)', () => {
  it('refuses on a transaction that is over, and so does a handle kept after it (E1)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let kept: SQLiteTransactionDB | undefined;
    let sp: SQLiteSavepoint | undefined;
    await transaction(async (tx) => {
      kept = tx;
      sp = await tx.savepoint('u');
    });
    const sent = worker.executed.length;
    await expect(kept?.savepoint()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    await expect(sp?.release()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    await expect(sp?.rollback()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    expect(worker.executed.length).toBe(sent);
  });

  it('refuses in a read-only transaction (E2)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(
      async (tx) => {
        await expect(tx.savepoint()).rejects.toMatchObject({
          code: 'READ_ONLY_TRANSACTION',
        });
      },
      { readOnly: true },
    );
    expect(worker.executed).toEqual(['BEGIN', 'COMMIT']);
  });

  it('refuses a name already open and sends nothing (E4)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.savepoint('u');
      await expect(tx.savepoint('U')).rejects.toMatchObject({
        code: 'INVALID_IDENTIFIER',
      });
    });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'SAVEPOINT "u"', 'COMMIT']);
  });

  it("refuses a child's rollback after the parent's release, and sends nothing for it (E5, E7)", async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const parent = await tx.savepoint('p');
      const child = await tx.savepoint('c');
      await parent.release();
      await child.release();
      await expect(child.rollback()).rejects.toMatchObject({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'p' },
      });
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "p"',
      'SAVEPOINT "c"',
      'RELEASE "p"',
      'COMMIT',
    ]);
  });

  // Falsifiable: in waitFor() (src/transaction.ts), drop `if (ending) throw closedError(ending);`.
  it('never sends an operation queued behind commit() (E8)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let late: Promise<unknown> | undefined;
    await transaction(
      async (tx) => {
        const commit = tx.commit();
        late = tx.savepoint('late').catch((e) => e);
        await commit;
      },
      { autoCommit: false },
    );
    expect(await late).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  // Falsifiable: update the stack copy after runControl() resolves instead of at the call.
  it('opens a savepoint issued without await before the write that follows it', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const sp = tx.savepoint('u');
      const write = tx.write('INSERT INTO t VALUES (1)');
      await Promise.all([sp, write]);
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });
});

describe('tx.savepoint() — failures and endings (spec 2026-10-04, E12, D5, U4, U5)', () => {
  // Falsifiable: drop die(e) from runControl().
  it('kills the transaction when an operation fails, and the teardown concludes nothing (E12)', async () => {
    const worker = fakeWorker(['RELEASE "u"']);
    const { transaction } = harness(worker);
    let caught: unknown;
    const outcome = await transaction(async (tx) => {
      const sp = await tx.savepoint('u');
      caught = await sp.release().catch((e) => e);
      await tx.write('INSERT INTO t VALUES (1)');
    }).catch((e) => e);
    expect(outcome).toBe(caught);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'RELEASE "u"',
      'ROLLBACK',
    ]);
  });

  it('commits open savepoints with the transaction, without a RELEASE, and closes their handles (D5)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let sp: SQLiteSavepoint | undefined;
    await transaction(async (tx) => {
      sp = await tx.savepoint('a');
      await tx.savepoint('b');
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "a"',
      'SAVEPOINT "b"',
      'COMMIT',
    ]);
    await expect(sp?.release()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
  });

  it('rolls everything back under autoCommit: false with no commit()', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let sp: SQLiteSavepoint | undefined;
    await transaction(
      async (tx) => {
        sp = await tx.savepoint('a');
      },
      { autoCommit: false },
    );
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'SAVEPOINT "a"', 'ROLLBACK']);
    await expect(sp?.rollback()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm exec rstest run --project unit transaction`
Expected: FAIL — `tx.savepoint is not a function` in every new test, and `tsc` reports `savepoint` missing from `SQLiteTransactionDB`.

- [ ] **Step 3: Implement**

`src/api.ts` — in `SQLiteTransactionDB`, after `rollback: () => Promise<void>;`:

```ts
  /**
   * Opens a savepoint: a point inside this transaction you can roll back to
   * without abandoning the transaction. Savepoints nest, in the order they
   * are opened; rolling back or releasing one closes those opened after it.
   * `name` is optional — a name already open, empty, or starting with
   * `__bsq_` is refused with `INVALID_IDENTIFIER`. Refused with
   * `READ_ONLY_TRANSACTION` in a read-only transaction. Takes no signal, like
   * `commit()` and `rollback()`. A savepoint still open when the transaction
   * commits is committed with it.
   */
  savepoint: (name?: string) => Promise<SQLiteSavepoint>;
```

and, right after the `SQLiteTransactionDB` type:

```ts
/** A savepoint opened by `tx.savepoint()`. */
export type SQLiteSavepoint = {
  /** The name given, or the one generated (`__bsq_sp_<n>`) — what `db.debug` shows. */
  readonly name: string;
  /**
   * Keeps what was written since the savepoint and closes it. Resolves
   * without sending anything when it is already released; rejects with
   * `SAVEPOINT_CLOSED` when it was rolled back.
   */
  release: () => Promise<void>;
  /**
   * Undoes what was written since the savepoint. Closes it unless
   * `release: false`, which keeps it open to roll back to again. Resolves
   * without sending anything when it is already rolled back; rejects with
   * `SAVEPOINT_CLOSED` when it was released.
   */
  rollback: (options?: { release?: boolean }) => Promise<void>;
};
```

`src/transaction.ts`:

- Imports: add `SQLiteSavepoint` to the `./api` type import; add `import { createSavepointStack, type SavepointEntry } from './savepoints';`; add `quoteIdent` to the `./utils` import.
- Inside `createTransaction`, right after the `let tail: Promise<void> | undefined;` declaration and its comment, add:

```ts
      /** The library's copy of this transaction's savepoint stack (spec 2026-10-04, § 5). */
      const savepoints = createSavepointStack();

      /**
       * Runs one savepoint operation as the library's own control statement:
       * in its place in the queue, after an abandoned write has been judged,
       * through `via` so it concludes a pending `__bsq_sp` first, and uncached
       * (spec 2026-10-04, D9). A failure leaves the stack copy unprovable, so
       * it kills the transaction, whose teardown rolls everything back (E12).
       */
      const runControl = async (sql: string): Promise<void> => {
        const prior = tail;
        const mine = Promise.withResolvers<void>();
        tail = mine.promise;
        try {
          if (prior) await queueWait(prior, signal);
          if (abandoned) await entryWait(signal);
          try {
            await exec(via(false), sql, { uncached: true });
          } catch (e) {
            die(e);
            throw e;
          }
        } finally {
          if (tail === mine.promise) tail = undefined;
          mine.resolve(prior);
        }
      };
```

- In the `db` object literal, after `rollback: async () => { … },` and before `signal,`, add:

```ts
        savepoint: (name?: string) => {
          if (ending) return Promise.reject(closedError(ending));
          if (readOnly)
            return Promise.reject(
              new SQLiteError(
                'READ_ONLY_TRANSACTION',
                'Cannot open a savepoint in a read-only transaction: nothing in it can be written.',
              ),
            );
          let entry: SavepointEntry;
          try {
            entry = savepoints.open(name);
          } catch (e) {
            return Promise.reject(e);
          }
          const quoted = quoteIdent(entry.name);
          const handle: SQLiteSavepoint = {
            name: entry.name,
            release: () => {
              if (ending) return Promise.reject(closedError(ending));
              try {
                return savepoints.release(entry) === 'send'
                  ? runControl(`RELEASE ${quoted}`)
                  : Promise.resolve();
              } catch (e) {
                return Promise.reject(e);
              }
            },
            rollback: (options) => {
              if (ending) return Promise.reject(closedError(ending));
              const release = options?.release ?? true;
              try {
                return savepoints.rollback(entry, release) === 'send'
                  ? runControl(
                      release
                        ? `ROLLBACK TO ${quoted}; RELEASE ${quoted}`
                        : `ROLLBACK TO ${quoted}`,
                    )
                  : Promise.resolve();
              } catch (e) {
                return Promise.reject(e);
              }
            },
          };
          return runControl(`SAVEPOINT ${quoted}`).then(() => handle);
        },
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec rstest run --project unit` (the whole unit project — the F3 list test and `exports.test.ts` must stay green).
Expected: PASS. `pnpm exec tsc --noEmit` — clean.

- [ ] **Step 5: Write the browser tests**

Create `tests/browser/savepoint-api.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import type { SQLiteSavepoint } from '../../src/api';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-10-04-tx-savepoint-design.md: tx.savepoint()
 * against a real connection, on whatever (vfs, build) the run targets.
 */

const setUp = async () => {
  const db = await createTestClient({ poolSize: 1 });
  await db.write('CREATE TABLE t (a INTEGER UNIQUE)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

/** One INSERT whose single step() runs long enough for a 30 ms timeout to land inside it. */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

describe('tx.savepoint() (spec 2026-10-04)', () => {
  // Falsifiable: in src/savepoints.ts rollback(), skip close(index + 1, …) — the
  // child stays open and its release() resolves instead of rejecting.
  it('rolls a parent back with everything nested in it (B1)', async () => {
    const db = await setUp();
    try {
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        const parent = await tx.savepoint();
        await tx.write('INSERT INTO t VALUES (2)');
        const child = await tx.savepoint();
        await tx.write('INSERT INTO t VALUES (3)');
        await parent.rollback();
        await tx.write('INSERT INTO t VALUES (4)');
        await expect(child.release()).rejects.toMatchObject({
          code: 'SAVEPOINT_CLOSED',
        });
      });
      expect(await rowsOf(db)).toEqual([1, 4]);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: ignore `release` in the handle's rollback() — the second
  // rollback becomes a no-op and the final release() rejects.
  it('keeps the savepoint open after rollback({ release: false }) (B2)', async () => {
    const db = await setUp();
    try {
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint('retry');
        await tx.write('INSERT INTO t VALUES (1)');
        await sp.rollback({ release: false });
        await tx.write('INSERT INTO t VALUES (2)');
        await sp.rollback({ release: false });
        await tx.write('INSERT INTO t VALUES (3)');
        await sp.release();
      });
      expect(await rowsOf(db)).toEqual([3]);
    } finally {
      await db.close();
    }
  });

  it('keeps the items whose savepoint was released and none of the others (B3)', async () => {
    const db = await setUp();
    try {
      await db.write('INSERT INTO t VALUES (20)');
      await db.transaction(async (tx) => {
        for (const a of [1, 2, 3]) {
          const sp = await tx.savepoint();
          try {
            await tx.write('INSERT INTO t VALUES (?)', [a]);
            await tx.write('INSERT INTO t VALUES (?)', [a * 10]);
            await sp.release();
          } catch {
            await sp.rollback();
          }
        }
      });
      // Item 2's second row collides with 20, so its first row goes too.
      expect(await rowsOf(db)).toEqual([1, 3, 10, 20, 30]);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: send the consumer's ROLLBACK TO before the pending __bsq_sp
  // conclusion — it pops __bsq_sp, the conclusion fails and the transaction dies.
  it('rolls back right after a caught abandoned write (B4, E15)', async () => {
    const db = await setUp();
    try {
      await db.write('CREATE TABLE big (x INTEGER)');
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint('u');
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        await sp.rollback();
        await tx.write('INSERT INTO t VALUES (3)');
      });
      expect(await rowsOf(db)).toEqual([3]);
      expect(
        (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n,
      ).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);

  // Falsifiable: drop the `if (ending)` check from the handle's release() —
  // a RELEASE reaches a connection that left its transaction and fails with
  // "no such savepoint" instead.
  it('closes every handle when the connection leaves the transaction (B5, E16)', async () => {
    const db = await setUp();
    try {
      await db.write('INSERT INTO t VALUES (1)');
      let inner: Promise<unknown> | undefined;
      let releaseError: unknown;
      const outcome = await db
        .transaction((tx) => {
          inner = (async () => {
            const sp = await tx.savepoint();
            await tx.write('INSERT OR ROLLBACK INTO t VALUES (1)').catch(() => {});
            releaseError = await sp.release().catch((e) => e);
          })();
          return inner;
        })
        .catch((e) => e);
      await inner?.catch(() => {});
      expect(outcome).toBeInstanceOf(Error);
      expect(releaseError).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect(await rowsOf(db)).toEqual([1]);
    } finally {
      await db.close();
    }
  });

  // E19, the supported shape: a load closed inside its savepoint is undone
  // with it. Falsifiable: send `RELEASE` for rollback() in src/transaction.ts.
  it('undoes an output() closed inside the savepoint it rolls back (B6)', async () => {
    const db = await setUp();
    try {
      await db.write('CREATE TABLE report (id INTEGER)');
      await db.write('INSERT INTO report VALUES (1)');
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint();
        const out = tx.output('report', { id: 'INTEGER' });
        out.enqueue({ id: 2 });
        await out.close();
        await sp.rollback();
      });
      expect(await db.read('SELECT id FROM report')).toEqual([{ id: 1 }]);
      expect(
        await db.read(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'",
        ),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  // Review Focus 1. Falsifiable: interpolate the name without quoteIdent().
  it('accepts names with quotes, spaces and non-ASCII (B8)', async () => {
    const db = await setUp();
    try {
      const names: string[] = [];
      await db.transaction(async (tx) => {
        for (const name of ['a"b', 'my point', 'étape']) {
          const sp: SQLiteSavepoint = await tx.savepoint(name);
          await tx.write('INSERT INTO t VALUES (?)', [names.length]);
          await sp.rollback();
          names.push(sp.name);
        }
      });
      expect(names).toEqual(['a"b', 'my point', 'étape']);
      expect(await rowsOf(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 6: Run the browser tests on both engines**

Run: `pnpm exec rstest run --project 'chromium*' savepoint-api` then `pnpm exec rstest run --config rstest.firefox.config.ts savepoint-api`.
Expected: PASS on both, `failedFiles: 0`.

- [ ] **Step 7: Check each falsifier once**

Apply each mutation named in a test comment above, alone, rerun that test on Chromium, see it go red, revert with `git checkout -- <file>`. Record which ones were checked in the commit body.

- [ ] **Step 8: Run the whole unit project and Chromium suite**

Run: `pnpm exec rstest run --project unit` and `pnpm exec rstest run --project 'chromium*'`.
Expected: PASS. The existing `tx-savepoint.test.ts` tests that send `SAVEPOINT u` as SQL still pass — the guard arrives in Task 4.

- [ ] **Step 9: Note on E19 for the reviewer**

`output()` creates its staging table only after `sweepOnce()` resolves (`src/bulk.ts`, `createStaging`), which may wait on a Web Lock. A `sp.rollback()` issued while an `output()` is still open therefore lands either before or after the `CREATE`: in the first case the rollback drops the staging table and the load fails visibly, in the second the whole load lands in the parent scope. That is not deterministic, so B6 pins the supported shape — close the load before ending its savepoint — and Task 5 documents the rule. No code change.

- [ ] **Step 10: Commit**

```bash
pnpm exec biome check --write src/api.ts src/transaction.ts tests/unit/transaction.test.ts tests/browser/savepoint-api.test.ts
pnpm exec tsc --noEmit
git branch --show-current   # feat/tx-savepoint
git add src/api.ts src/transaction.ts tests/unit/transaction.test.ts tests/browser/savepoint-api.test.ts
git commit -m "feat(transaction): tx.savepoint()

A nested block a transaction can roll back on its own: a handle with
release() and rollback({ release }), run as the library's own control
statements through the transaction's queue and via facade.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The worker refuses transaction control

**Files:**
- Modify: `src/worker/worker.ts` (constants import; local `SQLOptions`; inside `open`: guard state, `authorize`, `set_authorizer` after the pragmas, `query()`'s cache branches, the `query` message case; a module-level `controlRefusedMessage`)
- Modify: `src/utils.ts` (delete `isTransactionControl`)
- Modify: `src/transaction.ts` (imports; `opensSavepoint`)
- Test: `tests/browser/transaction-control.test.ts` (new)
- Test: `tests/browser/tx-savepoint.test.ts` (replace the describe *a consumer's own savepoints (spec 2026-09-11, D7, D8)*)
- Test: `tests/unit/utils.test.ts` (delete the `isTransactionControl` block and import), `tests/unit/transaction.test.ts` (delete the D8 test)

**Interfaces:**
- Consumes: protocol `control` / `uncached` (Task 2); `tx.savepoint()` (Task 3).
- Produces: a refused statement rejects with `SQLiteError` `STATEMENT_FAILED`, `sqliteCode === SQLITE_CODES.AUTH` (23), and a message naming the keyword and pointing to `db.transaction()` (outside a transaction) or `tx.savepoint()` (inside one).

- [ ] **Step 1: Write the failing browser tests**

Create `tests/browser/transaction-control.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLITE_CODES } from '../../src/const/sqlite';
import type { ClientDebugState } from '../../src/debug';
import { createTestClient, interceptWorkers } from './helpers';

/**
 * docs/superpowers/specs/2026-10-04-tx-savepoint-design.md § 4: SQLite's
 * authorizer refuses transaction control the library did not send.
 */

const REFUSED = `STATEMENT_FAILED:${SQLITE_CODES.AUTH}`;

/** 'ran', or the error's code and SQLite result code. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ran',
    (e: { code?: string; sqliteCode?: number }) =>
      `${e.code}:${e.sqliteCode ?? ''}`,
  );

const CONTROL = [
  'BEGIN',
  'BEGIN IMMEDIATE',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT x',
  'RELEASE x',
  'ROLLBACK TO x',
];

describe('transaction control through the client (spec 2026-10-04, B7)', () => {
  // Falsifiable: delete the set_authorizer call in src/worker/worker.ts — every
  // row reads 'ran' or a code other than AUTH. And: delete the controlSql check
  // on a cache hit — 'BEGIN IMMEDIATE', cached by the transaction before it, runs.
  it('refuses every form of it, cached or not', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (0)');
      });
      const results: [string, string][] = [];
      for (const sql of CONTROL) results.push([sql, await outcome(db.write(sql))]);
      expect(results).toEqual(CONTROL.map((sql) => [sql, REFUSED]));
      await expect(db.write('BEGIN')).rejects.toThrow(/db\.transaction\(\)/);
    } finally {
      await db.close();
    }
  });

  it('refuses it inside a compound string, after running what precedes it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      expect(await outcome(db.write('INSERT INTO t VALUES (5); BEGIN'))).toBe(
        REFUSED,
      );
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 5 }]);
    } finally {
      await db.close();
    }
  });

  it('lets through what only looks like control', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      expect(
        await outcome(db.read("SELECT CASE WHEN 1 THEN 'BEGIN' ELSE 0 END AS c")),
      ).toBe('ran');
      expect(await outcome(db.write('INSERT OR ROLLBACK INTO t VALUES (6)'))).toBe(
        'ran',
      );
      expect(
        await outcome(
          db.write('CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END'),
        ),
      ).toBe('ran');
    } finally {
      await db.close();
    }
  });
});

describe('transaction control inside a transaction (spec 2026-10-04, B7)', () => {
  it('refuses it, and the transaction goes on', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const inside = ['SAVEPOINT u', 'RELEASE u', 'ROLLBACK TO u', 'COMMIT', 'BEGIN'];
      const results: [string, string][] = [];
      let message = '';
      await db.transaction(async (tx) => {
        for (const sql of inside) results.push([sql, await outcome(tx.write(sql))]);
        message = await tx.write('SAVEPOINT u').catch((e: Error) => e.message);
        await tx.write('INSERT INTO t VALUES (1)');
      });
      expect(results).toEqual(inside.map((sql) => [sql, REFUSED]));
      expect(message).toMatch(/tx\.savepoint\(\)/);
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  });
});

describe('what the guard lets through (spec 2026-10-04, D9)', () => {
  // Falsifiable: drop the `uncached` forwarding in src/pool.ts, or the
  // `options?.uncached` branch in worker.ts query() — the second SAVEPOINT reads 0.
  it('prepares every savepoint operation afresh, and caches BEGIN IMMEDIATE', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      for (let i = 0; i < 2; i++)
        await db.transaction(async (tx) => {
          const sp = await tx.savepoint('x');
          await sp.release();
        });
      const queries = (db.debug as ClientDebugState).requests.flatMap(
        (r) => r.queries,
      );
      const prepared = (sql: string) =>
        queries.filter((q) => q.sql === sql).map((q) => q.prepared);
      expect(prepared('SAVEPOINT "x"')).toEqual([1, 1]);
      expect(prepared('RELEASE "x"')).toEqual([1, 1]);
      expect(prepared('BEGIN IMMEDIATE').at(-1)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('a failed __bsq_sp conclusion (spec 2026-09-11 amendment, kept by spec 2026-10-04 § 7)', () => {
  // The scenario a consumer could reach is gone with the guard, so the test
  // injects a conclusion with no savepoint open, at the protocol level.
  // Falsifiable: remove `await control('ROLLBACK')` from the conclude/open catch
  // in src/worker/worker.ts — the transaction then goes on and commits row 1.
  it('rolls the whole transaction back, and the transaction dies', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const worker = records[0]?.worker;
      if (!worker) throw new Error('no worker was intercepted');
      const post = worker.postMessage.bind(worker);
      let armed = false;
      worker.postMessage = (message: unknown, ...rest: unknown[]) => {
        const m = message as {
          type?: string;
          sql?: string;
          options?: Record<string, unknown>;
        };
        if (armed && m.type === 'query' && m.sql === 'INSERT INTO t VALUES (2)') {
          armed = false;
          m.options = { ...m.options, savepoint: { conclude: 'release' } };
        }
        return (post as (m: unknown, ...r: unknown[]) => void)(message, ...rest);
      };
      let caught: unknown;
      const result = await db
        .transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          armed = true;
          caught = await tx.write('INSERT INTO t VALUES (2)').catch((e) => e);
        })
        .catch((e) => e);
      expect((caught as Error).message).toMatch(/no such savepoint/);
      expect(result).toBeInstanceOf(Error);
      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
```

In `tests/browser/tx-savepoint.test.ts`, replace the whole describe `"a consumer's own savepoints (spec 2026-09-11, D7, D8)"` (both tests, T8 and F2) with:

```ts
describe('a consumer savepoint and an abandoned write (spec 2026-10-04)', () => {
  // The former F2, after the guard: a RELEASE riding on an abandoned write is
  // refused at its prepare, so it cannot pop __bsq_sp, and the write is undone.
  // Falsifiable: delete the set_authorizer call in src/worker/worker.ts — the
  // RELEASE pops __bsq_sp with u, the next conclusion fails and the
  // transaction dies.
  it('refuses a RELEASE riding on an abandoned write, and undoes the write', async () => {
    const db = await setUp();
    try {
      const before = workerIdentity(db);
      let first: unknown;
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint('u');
        await tx.write('INSERT INTO t VALUES (1)');
        first = await tx
          .write(`${BIG_INSERT}; RELEASE u`, [], { timeout: 30 })
          .catch((e) => e);
        await tx.write('INSERT INTO t VALUES (2)');
        await sp.release();
      });
      expect(first).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 30 });
      expect(await rowsOf(db)).toEqual([0, 1, 2]);
      expect(await bigCount(db)).toBe(0);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec rstest run --project 'chromium*' transaction-control tx-savepoint`
Expected: FAIL — the refused statements read `ran` or `STATEMENT_FAILED:1`, the inside-transaction ones read `ran`, the uncached test reads `[1, 0]`, and the rewritten F2 dies. The conclusion test already passes (it pins existing behaviour).

- [ ] **Step 3: Implement the guard**

`src/worker/worker.ts`:

1. Constants import — add `SQLITE_AUTH`, `SQLITE_DENY`, `SQLITE_OK`, `SQLITE_SAVEPOINT`, `SQLITE_TRANSACTION` to the import from `'wa-sqlite/src/sqlite-constants.js'`.

2. The local `SQLOptions` type — add `uncached?: boolean;`.

3. A module-level function, right after the local `SQLOptions` type:

```ts
/** The message of a refused transaction-control statement (spec 2026-10-04, § 4). */
const controlRefusedMessage = (
  keyword: string,
  inTransaction: boolean | undefined,
) =>
  inTransaction
    ? `${keyword} is not allowed inside a transaction: the library manages it. Use tx.savepoint() for a block you can roll back on its own.`
    : `${keyword} is not allowed: the library manages transactions. Use db.transaction().`;
```

4. Inside `open`, right before `openedDB = (proceedGate?.promise ?? Promise.resolve())`:

```ts
  // Spec 2026-10-04, § 4: SQLite's authorizer refuses transaction control
  // unless the message carries the library's `control` flag. One query runs
  // at a time per worker, so plain variables cannot interleave.
  let allowControl = false;
  /** The SQL being prepared, so an allowed control statement is remembered. */
  let preparing: string | undefined;
  /**
   * Control statements the library ran, with their keyword. A cache hit
   * prepares nothing, so the authorizer never sees it: without this a
   * consumer's `BEGIN IMMEDIATE` would reuse the library's cached one.
   */
  const controlSql = new Map<string, string>();
  /** The keyword the authorizer last refused, for the message. */
  let denied: string | undefined;
  const authorize = (
    _: unknown,
    action: number,
    operation: string | null,
  ): number => {
    if (action !== SQLITE_TRANSACTION && action !== SQLITE_SAVEPOINT)
      return SQLITE_OK;
    const keyword =
      action === SQLITE_TRANSACTION
        ? (operation ?? 'BEGIN')
        : operation === 'BEGIN'
          ? 'SAVEPOINT'
          : operation === 'ROLLBACK'
            ? 'ROLLBACK TO'
            : 'RELEASE';
    if (allowControl) {
      if (preparing !== undefined) controlSql.set(preparing, keyword);
      return SQLITE_OK;
    }
    denied = keyword;
    return SQLITE_DENY;
  };
```

5. In the `locks.withLock(initLockName(vfs, file), async () => { … })` callback, after the pragmas loop and before `return { sqlite, module, db };`:

```ts
            // After the pragmas, which are not control. A plain function: an
            // async one would take wa-sqlite's `_async` relay.
            sqlite.set_authorizer(db, authorize, null);
```

6. In `query()`: set `preparing = options?.uncached ? undefined : sql;` on the line before `try {` (an uncached statement can never be a cache hit, and remembering it would grow the map with every savepoint name) (the one whose body starts with `const cached = cache.get(sql);`), add `preparing = undefined;` as the first statement of that `try`'s `finally`, and change the cache lookup and the cache-hit branch:

```ts
      const cached = options?.uncached ? 'uncacheable' : cache.get(sql);

      if (typeof cached === 'number') {
        const keyword = controlSql.get(sql);
        if (keyword !== undefined && !allowControl) {
          denied = keyword;
          throw new SQLite.SQLiteError('not authorized', SQLITE_AUTH);
        }
        let failed = false;
```

(the rest of the branch unchanged).

7. In `self.onmessage`'s `'query'` case: right after `const { callId, sql, params, options } = data;` add

```ts
        denied = undefined;
        allowControl = options?.control === true;
```

In the `control` helper of the savepoint block, raise the flag for the library's own statements only:

```ts
            const control = async (statement: string) => {
              const own = allowControl;
              allowControl = true;
              try {
                for await (const _ of query(callId, statement, [])) {
                  // Savepoint statements return no rows.
                }
              } finally {
                allowControl = own;
              }
            };
```

At the top of the case's `catch (e) {`, before `const sqliteCode = sqliteCodeOf(e);`:

```ts
          if (denied !== undefined && sqliteCodeOf(e) === SQLITE_AUTH) {
            (e as Error).message = controlRefusedMessage(
              denied,
              await connectionInTransaction(),
            );
          }
```

and in the case's `finally`, add `allowControl = false;` before `queryRunning?.resolve();`.

`src/transaction.ts`: remove `isTransactionControl` from the `./utils` import; in `opensSavepoint`, delete `&& !isTransactionControl(sql)` and replace the doc comment's last sentence `Never a transaction-control statement (D8).` with `A consumer's transaction control is refused by the worker's authorizer (spec 2026-10-04, § 4).`

`src/utils.ts`: delete `isTransactionControl` and its doc comment (Serena `safe_delete_symbol` will report the two test references; delete those first).

`tests/unit/utils.test.ts`: delete the `describe('isTransactionControl', …)` block and `isTransactionControl` from the import. `tests/unit/transaction.test.ts`: delete the test `'never wraps a transaction-control statement, even with its own timeout'`.

- [ ] **Step 4: Run them to verify they pass, on both engines**

Run: `pnpm exec rstest run --project 'chromium*' transaction-control tx-savepoint savepoint-api` and `pnpm exec rstest run --config rstest.firefox.config.ts transaction-control tx-savepoint savepoint-api`.
Expected: PASS. Then `pnpm exec rstest run --project unit` and `pnpm exec tsc --noEmit` — clean.

- [ ] **Step 5: Check each falsifier once**

Apply each mutation named in the new test comments, alone, rerun on Chromium, see red, revert. Record them in the commit body.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test` (three reports — read `status`, `failedFiles` and the counts of each) and `pnpm test:conformance` (two reports).
Expected: green everywhere, skip counts as in `mem:state`'s baseline. Any test that sent transaction control as SQL and now fails is a finding — report it, do not loosen the guard.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/worker/worker.ts src/utils.ts src/transaction.ts tests/browser/transaction-control.test.ts tests/browser/tx-savepoint.test.ts tests/unit/utils.test.ts tests/unit/transaction.test.ts
pnpm exec tsc --noEmit
git branch --show-current   # feat/tx-savepoint
git add -A src tests
git commit -m "feat(worker)!: refuse transaction control the library did not send

SQLite's authorizer now refuses BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT,
RELEASE and ROLLBACK TO unless the message carries the library's control
flag. Through the client they never worked: BEGIN and COMMIT could land
on different workers, and a connection left inside a transaction blocked
every writer. Inside a transaction they falsified the savepoint stack
tx.savepoint() keeps. Savepoint operations run uncached.

BREAKING CHANGE: SAVEPOINT, RELEASE and ROLLBACK TO sent as SQL inside a
transaction are refused; use tx.savepoint().

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation, changelog, spec corrections

**Files:**
- Modify: `API.md`
- Modify: `CHANGELOG.md` (through the `changelog-maintenance` skill)
- Modify: `docs/superpowers/specs/2026-10-04-tx-savepoint-design.md`, `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md`

**Interfaces:** none.

- [ ] **Step 1: `API.md` — `## *client*.transaction`**

In the paragraph starting `**One worker serves the whole callback**`, change `plus `commit`, `rollback`, and `signal`` to `plus `commit`, `rollback`, `savepoint` and `signal``. Then insert, right before the `> [!WARNING]` block of that section:

````markdown
**`tx.savepoint(name?)` opens a block you can undo without abandoning the transaction.** It resolves to a handle with `name`, `release()` and `rollback({ release = true })`:

```typescript
await db.transaction(async (tx) => {
  for (const order of orders) {
    const sp = await tx.savepoint();
    try {
      await tx.write('INSERT INTO orders (id, total) VALUES (?, ?)', [order.id, order.total]);
      await tx.write('UPDATE stock SET qty = qty - 1 WHERE id = ?', [order.item]);
      await sp.release();
    } catch {
      await sp.rollback(); // this order only
    }
  }
});
```

- `rollback()` undoes everything written since the savepoint and closes it; `rollback({ release: false })` undoes it and keeps the savepoint open, to roll back to again. `release()` keeps what was written and closes it — nothing is durable before the transaction commits.
- Savepoints nest in the order they are opened. Releasing or rolling back one closes every savepoint opened after it; a method on a closed handle resolves when what it promises is already true and rejects with `SAVEPOINT_CLOSED` otherwise.
- `name` is optional; one is generated otherwise (`__bsq_sp_1`, `__bsq_sp_2`…). A name already open, empty, or starting with `__bsq_` is refused with `INVALID_IDENTIFIER`.
- A savepoint still open when the transaction commits is committed with it. Once the transaction is over, the handle rejects with `TRANSACTION_CLOSED`.
- `tx.savepoint()`, `release()` and `rollback()` take no `signal`, like `commit()` and `rollback()`. A read-only transaction refuses `tx.savepoint()` with `READ_ONLY_TRANSACTION`.
- Close every savepoint you open in a loop: an open savepoint makes every later write in the transaction slower, and thousands of them add up.
````

- [ ] **Step 2: `API.md` — `### Inside a transaction`**

Right after the paragraph starting `**Statements share one connection and run one at a time, in the order you issue them.**`, insert:

```markdown
**Savepoints follow the same order.** They form a stack in the order `tx.savepoint()`, `release()` and `rollback()` are called, not in the shape of your code. Two async branches that open savepoints in the same transaction undo each other's writes: a branch rolling back its savepoint also undoes what the other branch wrote after that savepoint opened. A `bulkWrite()` still open when its savepoint closes sends its later batches to the enclosing scope, and an `output()` must be closed before the savepoint that contains it ends — its staging table is created asynchronously, so a rollback issued while it is open may or may not undo it. Close a load before you end its savepoint.
```

- [ ] **Step 3: `API.md` — `## *client*.write`**

After the options table of that section, add:

```markdown
**Transaction control is refused.** `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` reject with `STATEMENT_FAILED` and `sqliteCode` `23` (`SQLITE_CODES.AUTH`), on the client and inside a transaction alike: each call may run on a different connection, so a transaction opened this way could never be closed. Use [`transaction()`](#clienttransaction), and `tx.savepoint()` inside it. In a string of several statements, the ones before the refused statement have run — outside a transaction, they are committed.
```

- [ ] **Step 4: `API.md` — `## Error handling`**

In the error table: in the `STATEMENT_FAILED` row, append ` Transaction control sent as SQL is refused with `sqliteCode` `23` (`SQLITE_AUTH`); see [*client*.write](#clientwrite).`; in the `INVALID_IDENTIFIER` row, change `A name or type handed to `output()` or `bulkWrite()`` to `A name or type handed to `output()`, `bulkWrite()` or `tx.savepoint()``, and append ` For `tx.savepoint()`: a name starting with `__bsq_`, or one already open.`; in the `READ_ONLY_TRANSACTION` row, change ``bulkWrite()` or `output()`` to ``bulkWrite()`, `output()` or `tx.savepoint()``. After the `TRANSACTION_CLOSED` row, add:

```markdown
| `SAVEPOINT_CLOSED` | `release()` on a savepoint already rolled back, or `rollback()` on one already released — by itself or along with a savepoint it was nested in. `error.cause` is `{ by, savepoint }`: the operation that closed it and the savepoint it addressed. |
```

- [ ] **Step 5: `CHANGELOG.md`**

Invoke the `changelog-maintenance` skill and add under `## [Unreleased]`:
- *Added*: `tx.savepoint(name?)`, a block a transaction can roll back on its own, with the `SQLiteSavepoint` type and the `SAVEPOINT_CLOSED` error code.
- *Breaking*: `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` sent as SQL inside a transaction are refused with `STATEMENT_FAILED` (`sqliteCode` 23); use `tx.savepoint()`.
- *Fixed*: `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` sent through `db.write()` and its siblings are refused. They used to leave a transaction open on a pooled connection, blocking every other writer.

- [ ] **Step 6: Specs**

In `docs/superpowers/specs/2026-10-04-tx-savepoint-design.md`, add right under the header line:

```markdown
**Amended 2026-10-04 (plan):** `sqliteCode` is numeric — `SQLITE_CODES.AUTH`, 23 — wherever this spec writes `'AUTH'`. E19 is timing-dependent: `output()` creates its staging table after `sweepOnce()`, which may wait on a Web Lock, so a rollback issued while a load is open lands before or after the `CREATE`; the load either fails visibly or lands in the parent scope. The documented rule is to close a load before ending its savepoint, and B6 pins that shape.
```

and in its body replace every `sqliteCode: 'AUTH'` by `sqliteCode: 23`.

In `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md`, add right under its header block:

```markdown
**Amended 2026-10-04:** D8 is superseded by `docs/superpowers/specs/2026-10-04-tx-savepoint-design.md` § 4 — a consumer's transaction-control statement is now refused by the worker's authorizer, so it never reaches `__bsq_sp`.
```

- [ ] **Step 7: Grep for the old behaviour**

Run: `grep -rn -E "isTransactionControl|\bD8\b|consumer's own savepoints|SAVEPOINT u" src tests API.md README.md VFS.md CHANGELOG.md`
Expected: nothing in `src/`, `tests/` or the consumer docs that still describes raw savepoints as allowed. Fix any hit; the 2026-09-11 spec keeps its own D8 text under the amendment.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # feat/tx-savepoint
git add API.md CHANGELOG.md docs/superpowers/specs/2026-10-04-tx-savepoint-design.md docs/superpowers/specs/2026-09-11-tx-savepoint-design.md
git commit -m "docs: tx.savepoint() and the refused transaction control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Memories and the closing verification

**Files:**
- Modify: `.serena/memories/architecture.md`, `.serena/memories/follow-ups.md`, `.serena/memories/history/2026-10.md`, `.serena/memories/state.md` (baseline only if re-measured)

**Interfaces:** none.

- [ ] **Step 1: `mem:architecture`**

In the `Layout` table, add a row for `savepoints.ts` (pure, the savepoint-stack copy and its decision table, unit-tested in Node). In *Load-bearing invariants*:
- replace the paragraph `**Transaction-control statements are never wrapped in a savepoint** (`isTransactionControl`, spec D8) …` with: `**The worker's authorizer is the only guard against transaction control (spec 2026-10-04, § 4).** It denies \`SQLITE_TRANSACTION\` and \`SQLITE_SAVEPOINT\` unless the message carries \`control\`, which only \`transaction.ts\`'s \`exec\` and the worker's own \`__bsq_sp\` \`control()\` set; \`controlSql\` remembers the control statements it allowed so a cache hit cannot bypass it; savepoint operations run \`uncached\`. A new library path that sends transaction control without \`exec\` is refused with \`AUTH\`.`
- in the paragraph `**Every message a transaction sends goes through \`via\`, except the teardown ROLLBACK.**`, add: `\`tx.savepoint()\`, \`release()\` and \`rollback()\` go through \`via(false)\` in \`runControl\`, and T7 covers them.`

- [ ] **Step 2: `mem:follow-ups`**

Delete the entry `## \`tx.savepoint()\` returning a rollback callback — for rc.6 (user, 2026-09-11)`.

- [ ] **Step 3: Closing verification**

Run, in order, and read every report in full:
- `pnpm exec tsc --noEmit` — clean
- `pnpm exec biome ci .` — exit 0; `pnpm lint` — the warning count unchanged from `mem:state`'s baseline (4)
- `pnpm build` — clean
- `pnpm test` — three reports, `status: pass`, `failedFiles: 0`
- `pnpm test:conformance` — two reports, counts as in the baseline
- `pnpm docs:vfs && git diff --exit-code VFS.md` — no diff
- `pnpm test:consumer` — every stage green
- `pnpm test:matrix` — about 40 minutes; arm a progress report every 2 minutes at launch (`mem` feedback, progress-every-two-minutes); expected 66 of 66 cells green

- [ ] **Step 4: `mem:history`**

Add a row to `.serena/memories/history/2026-10.md` for `feat/tx-savepoint`: what shipped (`tx.savepoint()`, the authorizer guard, the `control`/`uncached` flags, `SAVEPOINT_CLOSED`), the breaking change, and the verification numbers read off Step 3.

- [ ] **Step 5: Commit, then stop**

```bash
git branch --show-current   # feat/tx-savepoint
git add .serena/memories
git commit -m "docs(memory): tx.savepoint() and the transaction-control guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Report the verification results to the user. The `--no-ff` merge into `main` and the branch deletion wait for the user's go (`AGENTS.md`, closing a piece of work).
