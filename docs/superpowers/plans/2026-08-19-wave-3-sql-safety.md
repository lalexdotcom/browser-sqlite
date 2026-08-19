# Wave 3 — Safe generated SQL, atomic `output()`, live debug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close B4 (unescaped identifiers, unvalidated pragmas, read pragmas locked out of `read()`), B5 (`output()` is not atomic, `bulkWrite` drops batches silently) and B6 (the debug subsystem is unreachable dead code).

**Architecture:** `utils.ts` gains the quoting and validation primitives; `bulk.ts` is rewritten around a staging table swapped in by an atomic rename inside one short transaction, with a `navigator.locks`-guarded orphan sweep; the debug subsystem is wired through a single instrumented-lease wrapper rather than at seven acquisition sites. `scheduler.ts` stays pure — it gains one read-only `stats()` and learns nothing about debug.

**Tech Stack:** TypeScript 7.0.2 (ESM only), rslib 0.23.2, rstest 0.11.8 (two projects: `unit` in Node, `browser` in Chromium via Playwright), biome 2.5.8, pnpm 10.31.0.

**Spec:** `docs/superpowers/specs/2026-08-19-wave-3-sql-safety-design.md` — read it before Task 1. Every task argues from it.

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `insert_*_symbol` / `replace_content` to edit. Built-in Read/Edit are for `.md`, JSON and config only. This applies to every task.
- **Language:** French in chat with the user, **English** in code, comments, JSDoc, commit messages and documents.
- **`pnpm check` (biome) after every modification.** It is the project's formatter and linter in one.
- **rstest 0.11.8 has no `it.each`.** Parameterised tests use a plain `for` loop calling `it()` directly — see `tests/unit/routing.test.ts` for the established pattern.
- **Falsifiability rule (wave 1).** For every test written, be able to name the line whose deletion turns it red. Seven wave-1 tests passed identically with and without the behaviour they claimed to pin. If you cannot name that line, the test is decoration — rewrite it.
- **TS 7 trap.** `const x: (() => T) | undefined = undefined` narrows to `undefined`, and `x?.()` then fails with "Type 'never' has no call signatures". Write `undefined as (() => T) | undefined` to preserve the union.
- **Never weaken the wave-1 exclusivity invariant.** `PoolWorker` carries no availability flag; leases are the only way in and out of the pool. Do not add one, do not release a lease a helper did not acquire.
- **`bulk.ts` must keep calling the public `write`** — one lease per batch, worker released between batches. D3 depends on it. Do not consolidate the batches into one held lease.
- **Commit after every task.** Commit messages in English, imperative mood, following the existing log style (`fix(bulk): …`, `feat(debug): …`).
- **Verification at the end of the branch:** `pnpm check`, `pnpm exec tsc --noEmit`, `pnpm test`, **and `pnpm test:consumer`** — the last one is mandatory this wave because Task 5 changes the worker's open path.
- Line numbers below are from the 2026-08-19 snapshot (`d47f9e4`). Re-locate symbols with Serena before editing; do not trust the numbers blindly.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/locks.ts` | Thin `navigator.locks` wrapper: hold a named lock for a lifetime, list held names, run a function under an exclusive lock. Degrades to a no-op when the API is absent. |
| `src/logger.ts` | `createLogger(prefix, enabled)` → prefixed `console.debug/warn/error`. Lifecycle events only. |
| `tests/unit/quoting.test.ts` | `quoteIdent`, column type and generated-expression validation, `renderPragmas`. |
| `tests/unit/bulk.test.ts` | `createBulk` driven by fake `write` / `read` / `transaction` deps: the latch, the counters, the emitted DDL sequence, the sweep decision. |
| `tests/unit/locks.test.ts` | The pure sweep filter and the wrapper's degradation path, against a fake `LockManager`. |
| `tests/browser/debug.test.ts` | `db.debug` off/on, and the end-to-end chain (request + query fields populated). |

**Modified:**

| File | Change |
|---|---|
| `src/errors.ts` | Three new codes; `BulkWriteError` subclass. |
| `src/utils.ts` | `quoteIdent`, `assertColumnType`, `assertGeneratedExpression`, `renderPragmas`, read-pragma clause in `isReadQuery`, `assertReadable` JSDoc and message. |
| `src/bulk.ts` | Identifiers quoted; latch; staging + rename; sweep; `temp` removed; deps grow to `{ write, read, transaction }`. |
| `src/worker/worker.ts` | Pragmas executed once at open; per-query prefix deleted. |
| `src/client.ts` | Pragma validation at construction; `createBulk` deps; `createClientDebug` really called; `acquireInstrumented` wrapper; logger wiring; `debug` typed. |
| `src/scheduler.ts` | `stats()` added to the `Scheduler` type and the implementation. |
| `src/pool.ts` | The two frozen debug hooks receive the real functions; logger calls on lifecycle events. |
| `src/debug.ts` | Bounded `requests`, off-by-one, `status` initial value, `queue` reads from `stats()`. |
| `src/types.ts` | `debug?: string \| boolean` on the client options (if not already present in `client.ts`). |
| `tests/unit/routing.test.ts` | Read-pragma cases added; the "PRAGMA always routes to writer" case updated. |
| `tests/browser/routing.test.ts` | The pinned read-pragma rejection is replaced by its opposite. |
| `tests/browser/output.test.ts` | `temp` test deleted; observation-during-load rewritten; atomicity and sweep tests added. |
| `tests/browser/bulk-write.test.ts` | The silent-drop test becomes a latch test. |
| `README.md` | Error-handling section: read pragmas work through `read()`; `temp` removed from `output()`; `debug` option documented. |

---

## Task 1: Quoting and validation primitives

**Files:**
- Modify: `src/errors.ts`
- Modify: `src/utils.ts`
- Test: `tests/unit/quoting.test.ts` (create)

**Interfaces:**
- Consumes: `SQLiteError` from `src/errors.ts`.
- Produces:
  - `quoteIdent(name: string): string`
  - `assertColumnType(type: string, column: string): string` — returns the trimmed type
  - `assertGeneratedExpression(expr: string, column: string): string` — returns the trimmed expression
  - error codes `'INVALID_IDENTIFIER'`, `'INVALID_PRAGMA'`, `'BULK_WRITE_FAILED'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/quoting.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import {
  assertColumnType,
  assertGeneratedExpression,
  quoteIdent,
} from '../../src/utils';

describe('quoteIdent', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('doubles an internal double quote', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('preserves case', () => {
    expect(quoteIdent('MyTable')).toBe('"MyTable"');
  });

  it('neutralises a statement-breaking name', () => {
    // The whole point: this must become one identifier, not two statements.
    expect(quoteIdent('t"; DROP TABLE users; --')).toBe(
      '"t""; DROP TABLE users; --"',
    );
  });

  it('rejects a NUL character', () => {
    expect(() => quoteIdent('a\0b')).toThrow(SQLiteError);
    expect(() => quoteIdent('a\0b')).toThrow(/INVALID_IDENTIFIER|NUL/);
  });

  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(SQLiteError);
  });
});

describe('assertColumnType', () => {
  const accepted = ['INTEGER', 'TEXT', 'VARCHAR(255)', 'DECIMAL(10, 2)'];
  for (const type of accepted) {
    it(`accepts ${type}`, () => {
      expect(assertColumnType(type, 'col')).toBe(type);
    });
  }

  const rejected = [
    'INTEGER); DROP TABLE users; --',
    "TEXT DEFAULT 'x'",
    'INTEGER,',
    '',
  ];
  for (const type of rejected) {
    it(`rejects ${JSON.stringify(type)}`, () => {
      expect(() => assertColumnType(type, 'col')).toThrow(SQLiteError);
    });
  }

  it('names the offending column', () => {
    expect(() => assertColumnType('bad;', 'price')).toThrow(/price/);
  });
});

describe('assertGeneratedExpression', () => {
  it('accepts a parenthesised expression', () => {
    expect(assertGeneratedExpression('(base * 2)', 'doubled')).toBe(
      '(base * 2)',
    );
  });

  it('rejects an unparenthesised expression', () => {
    expect(() => assertGeneratedExpression('base * 2', 'doubled')).toThrow(
      SQLiteError,
    );
  });

  it('rejects a statement separator', () => {
    expect(() =>
      assertGeneratedExpression('(1); DROP TABLE users; --', 'doubled'),
    ).toThrow(SQLiteError);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/quoting.test.ts`
Expected: FAIL — `quoteIdent` is not exported from `src/utils`.

- [ ] **Step 3: Add the three error codes**

In `src/errors.ts`, extend the union (use Serena's `replace_symbol_body` on `SQLiteErrorCode`):

```ts
export type SQLiteErrorCode =
  | 'NOT_A_READ_QUERY'
  | 'CLIENT_CLOSED'
  | 'WORKER_CRASHED'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_PRAGMA'
  | 'BULK_WRITE_FAILED';
```

- [ ] **Step 4: Implement the three primitives**

Append to `src/utils.ts` (Serena `insert_after_symbol` on `assertReadable`):

```ts
/**
 * Quotes an SQL identifier so it can never be read as anything but a name.
 *
 * The library interpolates table, column and index names into generated SQL —
 * `bulkWrite`, `output` and their indexes. wa-sqlite's `statements()` executes
 * `;`-separated statements, so an unquoted name is a stacked-query injection
 * (B4). Quoting is what makes `t"; DROP TABLE users; --` one identifier.
 *
 * Note that quoting preserves case in `sqlite_master`; SQLite still resolves
 * names case-insensitively.
 */
export const quoteIdent = (name: string): string => {
  if (!name)
    throw new SQLiteError('INVALID_IDENTIFIER', 'Identifier cannot be empty');
  if (name.includes('\0'))
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Identifier contains a NUL character: ${JSON.stringify(name)}`,
    );
  return `"${name.replace(/"/g, '""')}"`;
};

/** `INTEGER`, `TEXT`, `VARCHAR(255)`, `DECIMAL(10, 2)` — nothing else. */
const COLUMN_TYPE = /^[A-Za-z][A-Za-z0-9 ]*(\([0-9, ]+\))?$/;

/**
 * A column type is not an identifier and cannot be quoted — it is an SQL
 * fragment the caller writes. It is validated by shape instead: this is the
 * narrowed, not closed, channel documented in the spec (§1.2).
 */
export const assertColumnType = (type: string, column: string): string => {
  const trimmed = type.trim();
  if (!COLUMN_TYPE.test(trimmed))
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Column "${column}" declares an unsupported type ${JSON.stringify(type)}. ` +
        `A type must be a word, optionally followed by numeric arguments, e.g. "INTEGER" or "VARCHAR(255)".`,
    );
  return trimmed;
};

/**
 * A GENERATED ALWAYS AS expression is caller-authored SQL. It must at least be
 * parenthesised and free of statement separators, so it cannot escape its slot.
 */
export const assertGeneratedExpression = (
  expr: string,
  column: string,
): string => {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')') || trimmed.includes(';'))
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Column "${column}" declares an invalid generated expression ${JSON.stringify(expr)}. ` +
        `It must be parenthesised and contain no ";", e.g. "(base * 2)".`,
    );
  return trimmed;
};
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/quoting.test.ts`
Expected: PASS.

- [ ] **Step 6: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/errors.ts src/utils.ts tests/unit/quoting.test.ts
git commit -m "feat(utils): quoteIdent and schema-fragment validation — B4"
```

---

## Task 2: Quote every identifier `bulk.ts` emits

**Files:**
- Modify: `src/bulk.ts` (the three interpolation sites: the INSERT, the CREATE TABLE, the CREATE INDEX)
- Test: `tests/unit/bulk.test.ts` (create)

**Interfaces:**
- Consumes: `quoteIdent`, `assertColumnType`, `assertGeneratedExpression` from Task 1.
- Produces: `createBulk` emits only quoted identifiers. Its `deps` shape is unchanged in this task (`{ write }`); Task 9 extends it.

**Context you need:** `createBulk({ write })` is dependency-injected, so its emitted SQL is observable in Node with a fake `write`. This is why most of B5 needs no browser.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bulk.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createBulk } from '../../src/bulk';

/** Records every statement the unit under test emits. */
const recorder = () => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 0 };
  };
  return { sql, write };
};

describe('bulkWrite quoting (B4)', () => {
  it('quotes the table and every column in the INSERT', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('my table', ['a b', 'c']);
    bulk.enqueue({ 'a b': 1, c: 2 });
    await bulk.close();

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('INSERT INTO "my table"');
    expect(sql[0]).toContain('("a b","c")');
  });

  it('neutralises an injection in the table name', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t"; DROP TABLE users; --', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close();

    expect(sql[0]).toContain('INSERT INTO "t""; DROP TABLE users; --"');
    // One statement, not two: the injected text never leaves the quotes.
    expect(sql[0].replace(/"[^"]*(""[^"]*)*"/g, '<ident>')).not.toContain(
      'DROP TABLE',
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/bulk.test.ts`
Expected: FAIL — the emitted SQL reads `INSERT INTO my table (a b,c)`.

- [ ] **Step 3: Quote the INSERT**

In `src/bulk.ts`, import the primitives and rewrite the INSERT (Serena `replace_content`):

```ts
import {
  assertColumnType,
  assertGeneratedExpression,
  quoteIdent,
} from './utils';
```

```ts
        return write(
          `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES ${toInsert.map(() => `(${keys.map(() => '?')})`)}`,
          toInsert.flatMap((data) => keys.map((k) => data[k])),
        ).then(({ affected: chunkAffected }) => {
          return currentAffected + chunkAffected;
        });
```

- [ ] **Step 4: Quote the CREATE TABLE and validate the schema fragments**

Replace the `normalizedSchema` mapping and the `CREATE TABLE` template so that the name is quoted, the type is validated, and the generated expression is validated:

```ts
    const normalizedSchema = Object.entries(schema).map(([k, v]) => {
      const type = assertColumnType(typeof v === 'string' ? v : v.type, k);
      const unique = typeof v === 'object' && !!v.unique;
      const notnull = typeof v === 'object' && !!v.required;
      const generated =
        typeof v === 'object' && v.generated
          ? assertGeneratedExpression(v.generated, k)
          : undefined;
      return { name: k, type, unique, notnull, generated };
    });
```

and, in the DDL builder:

```ts
              return `${quoteIdent(name)} ${type} ${unique ? 'UNIQUE' : ''} ${notnull ? 'NOT NULL' : ''} ${generated ? `GENERATED ALWAYS AS ${generated}` : ''}`;
```

- [ ] **Step 5: Quote the CREATE INDEX**

The index name is derived from the **raw** identifiers and quoted as a whole; the table and its columns are quoted individually:

```ts
                await write(
                  `CREATE ${unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${quoteIdent(`${table}_${columns.join('_')}_${unique ? 'U' : 'IDX'}`)} ON ${quoteIdent(table)}(${columns.map(String).map(quoteIdent).join(',')})`,
                );
```

- [ ] **Step 6: Run the whole suite**

Run: `timeout -k 60 600 pnpm test`
Expected: PASS, including the existing `tests/browser/output.test.ts` and `bulk-write.test.ts` — quoting is transparent to them.

- [ ] **Step 7: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/bulk.ts tests/unit/bulk.test.ts
git commit -m "fix(bulk): quote every generated identifier — B4"
```

---

## Task 3: Validate the `pragmas` option

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/client.ts` (near the existing `AccessHandlePoolVFS` guard, `:459-464`)
- Test: `tests/unit/quoting.test.ts` (extend)

**Interfaces:**
- Produces: `renderPragmas(pragmas: Record<string, string>): string[]` — one `PRAGMA k=v` statement per entry, validated. Throws `SQLiteError` code `INVALID_PRAGMA`. Used by `client.ts` at construction (fail fast) and by `worker/worker.ts` at open (Task 4).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/quoting.test.ts`, adding `renderPragmas` to the **existing**
import from `../../src/utils` rather than writing a second import statement:

```ts
describe('renderPragmas', () => {
  it('renders an integer value as-is', () => {
    expect(renderPragmas({ busy_timeout: '5000' })).toEqual([
      'PRAGMA busy_timeout=5000',
    ]);
  });

  it('renders a bare word as-is', () => {
    expect(renderPragmas({ journal_mode: 'WAL' })).toEqual([
      'PRAGMA journal_mode=WAL',
    ]);
  });

  it('re-escapes a quoted string literal', () => {
    expect(renderPragmas({ some_key: "'it''s fine'" })).toEqual([
      "PRAGMA some_key='it''s fine'",
    ]);
  });

  it('renders one statement per entry', () => {
    expect(
      renderPragmas({ journal_mode: 'WAL', synchronous: 'NORMAL' }),
    ).toEqual(['PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL']);
  });

  const badKeys = ['journal mode', 'journal_mode; DROP TABLE t', '1_mode', ''];
  for (const key of badKeys) {
    it(`rejects the key ${JSON.stringify(key)}`, () => {
      expect(() => renderPragmas({ [key]: 'WAL' })).toThrow(/INVALID_PRAGMA|pragma/i);
    });
  }

  const badValues = ['WAL; DROP TABLE t', 'WAL OFF', '(1)'];
  for (const value of badValues) {
    it(`rejects the value ${JSON.stringify(value)}`, () => {
      expect(() => renderPragmas({ journal_mode: value })).toThrow(
        /journal_mode/,
      );
    });
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/quoting.test.ts`
Expected: FAIL — `renderPragmas` is not exported.

- [ ] **Step 3: Implement `renderPragmas`**

Append to `src/utils.ts`:

```ts
const PRAGMA_NAME = /^[A-Za-z_]\w*$/;
const PRAGMA_INTEGER = /^-?\d+$/;
const PRAGMA_LITERAL = /^'([^']|'')*'$/;

/**
 * Renders the client's `pragmas` option into executable statements, rejecting
 * anything that is not provably a name and a scalar value (B4).
 *
 * Validation is syntactic rather than a closed list of the ~60 SQLite pragmas:
 * a fixed list makes every legitimate pragma outside it unreachable and drifts
 * with SQLite versions, for no additional protection — no ";", no parenthesis
 * and no comment marker survives these three shapes either.
 *
 * Called twice: by the client at construction, so a bad configuration fails at
 * `createSQLiteClient()` rather than inside an unrelated query, and by the
 * worker at open, which is the only place the statements actually run.
 */
export const renderPragmas = (pragmas: Record<string, string>): string[] =>
  Object.entries(pragmas).map(([key, value]) => {
    if (!PRAGMA_NAME.test(key))
      throw new SQLiteError(
        'INVALID_PRAGMA',
        `Invalid pragma name ${JSON.stringify(key)}: a pragma name must match ${PRAGMA_NAME}.`,
      );
    const raw = String(value).trim();
    if (PRAGMA_INTEGER.test(raw) || PRAGMA_NAME.test(raw))
      return `PRAGMA ${key}=${raw}`;
    if (PRAGMA_LITERAL.test(raw))
      return `PRAGMA ${key}=${raw.slice(1, -1).replace(/'/g, "''").replace(/^/, "'").concat("'")}`;
    throw new SQLiteError(
      'INVALID_PRAGMA',
      `Invalid value ${JSON.stringify(value)} for pragma "${key}": expected an integer, a bare word such as WAL, or a quoted literal.`,
    );
  });
```

Note on the literal branch: the inner text is unwrapped, its quotes re-doubled, and re-wrapped — so an already-escaped literal survives unchanged and a malformed one is normalised.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/quoting.test.ts`
Expected: PASS.

- [ ] **Step 5: Validate at client construction**

In `src/client.ts`, immediately after the existing `AccessHandlePoolVFS` guard, add:

```ts
  // Fail at construction, not inside the first unrelated query.
  if (clientOptions?.pragmas) renderPragmas(clientOptions.pragmas);
```

with `renderPragmas` added to the existing `./utils` import.

- [ ] **Step 6: Run the whole suite, format, type-check, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add src/utils.ts src/client.ts tests/unit/quoting.test.ts
git commit -m "feat(pragmas): validate the pragmas option at construction — B4"
```

---

## Task 4: Apply pragmas once, at open

**Files:**
- Modify: `src/worker/worker.ts` (`:110-114` builder, `:141-148` the ready `.then`, `:196` the query template)
- Test: `tests/browser/init.test.ts` (extend)

**Interfaces:**
- Consumes: `renderPragmas` from Task 3.
- Produces: the worker no longer prepends anything to a query; a failing pragma becomes an `open-error`.

**Context you need:** the wave-2 open path posts `ready` only on success and `open-error` on failure, and the supervisor re-opens on restart — so pragmas are re-applied to a replacement worker for free. `orchestrator.unlock()` must still run exactly once: put the pragma execution **before** the unlock, so a failure reaches the existing `.catch`, which unlocks and posts `open-error`.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/init.test.ts`:

```ts
  it('reports an invalid pragma as an open error, not as a query error', async () => {
    await expect(
      createTestClient({ pragmas: { 'bad name': 'WAL' } }),
    ).rejects.toThrow(/pragma/i);
  });

  it('applies configured pragmas once, at open', async () => {
    const db = await createTestClient({
      pragmas: { cache_size: '-4000' },
      poolSize: 1,
    });

    const [row] = await db.read<{ cache_size: number }>('PRAGMA cache_size');
    expect(row?.cache_size).toBe(-4000);

    await db.close();
  });
```

The second test also depends on Task 5 (read pragmas through `read()`). If Task 5 has not landed yet, write it with `db.write('PRAGMA cache_size')` and switch it to `read` in Task 5 — do not skip it.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 60 300 pnpm exec rstest run --project browser tests/browser/init.test.ts`
Expected: FAIL — an invalid pragma name currently reaches the database prepended to the first query.

- [ ] **Step 3: Execute the pragmas at open**

In `src/worker/worker.ts`, delete the `allQueryPragmas` builder (`:110-114`) and rewrite the success `.then` so the statements run before the unlock:

```ts
    .then(async (opened) => {
      const { sqlite, db } = opened;
      // Applied once, here — the JSDoc and the README have always said "on
      // open", while the code prepended them to every query (B4). A failure
      // falls through to the .catch below, which unlocks and posts open-error.
      for (const statement of renderPragmas(pragmas)) {
        for await (const stmt of sqlite.statements(db, statement)) {
          // Some pragmas return a row (PRAGMA journal_mode=WAL returns "wal");
          // stepping to completion is what actually applies them.
          while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
        }
      }
      orchestrator.unlock();
      // Transition: INITIALIZING → READY. Only on success — the previous
      // `.finally()` posted `ready` even for a database that never opened.
      orchestrator.setStatus(index, WorkerStatuses.READY);
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
```

Add `renderPragmas` to the worker's imports from `../utils`.

- [ ] **Step 4: Remove the per-query prefix**

At the `sqlite.statements` call in `query()`:

```ts
    for await (const stmt of sqlite.statements(db, sql)) {
```

- [ ] **Step 5: Run the browser suite and confirm it passes**

Run: `timeout -k 60 600 pnpm exec rstest run --project browser`
Expected: PASS.

- [ ] **Step 6: Consumer smoke — the open path changed**

Run: `timeout -k 120 900 pnpm test:consumer`
Expected: 11/11 stages pass across the four modes.

- [ ] **Step 7: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/worker/worker.ts tests/browser/init.test.ts
git commit -m "fix(worker): apply pragmas once at open, not before every query — B4"
```

---

## Task 5: Read pragmas return to `read()`

**Files:**
- Modify: `src/utils.ts` (`isReadQuery`, `assertReadable` JSDoc and message)
- Modify: `tests/unit/routing.test.ts`
- Modify: `tests/browser/routing.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `isReadQuery` accepts a whole-string single PRAGMA with no assignment.

- [ ] **Step 1: Write the failing test**

In `tests/unit/routing.test.ts`, move `'PRAGMA table_info(foo)'` out of the `writes` array into the reads, and add a `readPragmas` block plus the counter-cases:

```ts
  const readPragmas = [
    'PRAGMA journal_mode',
    'pragma  user_version ',
    'PRAGMA main.page_count',
    'PRAGMA journal_mode;',
  ];
  for (const sql of readPragmas) {
    it(`routes to the read pool: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }

  const writePragmas = [
    'PRAGMA journal_mode=WAL',
    'PRAGMA journal_mode = WAL',
    'PRAGMA journal_mode; DROP TABLE t',
    'PRAGMA table_info(foo); DROP TABLE t',
    'PRAGMA optimize; VACUUM',
  ];
  for (const sql of writePragmas) {
    it(`routes to the writer: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(false);
    });
  }
```

`PRAGMA table_info(foo)` takes an argument, so it stays a writer statement — the regex admits no parenthesis. Keep it in the `writes` list with a comment saying why.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/routing.test.ts`
Expected: FAIL — every PRAGMA currently routes to the writer.

- [ ] **Step 3: Add the read-pragma clause**

In `src/utils.ts`:

```ts
/**
 * A statement that is nothing but a single PRAGMA lookup: no assignment, no
 * argument, nothing after it. Anchoring at `$` is what makes this safe for
 * free — `PRAGMA journal_mode; DROP TABLE t` does not match, and neither does
 * `PRAGMA journal_mode=WAL`, whose `=` breaks the match.
 */
const READ_PRAGMA = /^\s*PRAGMA\s+(\w+\.)?\w+\s*;?\s*$/i;

export const isReadQuery = (sql: string) =>
  READ_PRAGMA.test(sql) ||
  (/^\s*(SELECT|EXPLAIN|VALUES|WITH)\b/i.test(sql) && !WRITE_KEYWORDS.test(sql));
```

`PRAGMA` stays in `WRITE_KEYWORDS` — the second clause must keep rejecting a pragma hidden after a semicolon.

- [ ] **Step 4: Update `assertReadable`'s message and JSDoc**

Delete the two obsolete sentences (`utils.ts:63-64` and the trailing note in the thrown message) and replace them with:

```ts
/**
 * Routing guard for the read-shaped methods (`read`, `chunk`, `stream`, `first`).
 * Throws before a lease is taken, so a rejected statement costs no pool capacity.
 *
 * A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns
 * (`PRAGMA journal_mode=WAL`), takes an argument, or is followed by anything
 * else must go through `write()`.
 */
```

and, in the error message, replace the final sentence with:

```ts
      `Note that a PRAGMA that assigns a value or takes an argument is a write.`
```

- [ ] **Step 5: Flip the pinned browser test**

`tests/browser/routing.test.ts` pins the current rejection with a plain `it` and a comment naming B4. Replace it with its opposite:

```ts
  it('accepts a bare read pragma through read()', async () => {
    const db = await createTestClient();
    const rows = await db.read<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode).toBeDefined();
    await db.close();
  });

  it('still rejects a pragma that assigns', async () => {
    const db = await createTestClient();
    await expect(db.read('PRAGMA journal_mode=WAL')).rejects.toThrow(
      /NOT_A_READ_QUERY/,
    );
    await db.close();
  });
```

- [ ] **Step 6: Update the README**

In the error-handling section, replace the sentence stating that every PRAGMA is classified as a write with the rule from Step 4.

- [ ] **Step 7: Run the whole suite, format, type-check, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add src/utils.ts tests/unit/routing.test.ts tests/browser/routing.test.ts README.md
git commit -m "feat(routing)!: bare read pragmas are reads again — B4"
```

---

## Task 6: `bulkWrite` fails loudly

**Files:**
- Modify: `src/errors.ts` (`BulkWriteError`)
- Modify: `src/bulk.ts` (`bulkWrite`)
- Modify: `src/index.ts` (export `BulkWriteError`)
- Test: `tests/unit/bulk.test.ts` (extend), `tests/browser/bulk-write.test.ts` (rewrite the pinned test)

**Interfaces:**
- Produces:
  - `class BulkWriteError extends SQLiteError` with `readonly rowsWritten: number` and `readonly rowsNotWritten: number`, code `'BULK_WRITE_FAILED'`.
  - `bulkWrite(table, keys)` — `enqueue` throws once the latch is set; `close()` rejects with `BulkWriteError`.

**Naming note:** the spec (§2.5) calls the second counter `rowsNotAttempted`. It is named `rowsNotWritten` here because a multi-row INSERT is statement-atomic: the failing batch's rows *were* attempted and wrote nothing, so "not attempted" would exclude exactly the rows the caller most needs counted. Same intent, accurate name.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/bulk.test.ts`:

```ts
import { BulkWriteError } from '../../src/errors';

/** Fails the nth write (0-based), records the rest. */
const failingRecorder = (failAt: number) => {
  const sql: string[] = [];
  let calls = 0;
  const write = async (statement: string) => {
    const call = calls++;
    sql.push(statement);
    if (call === failAt) throw new Error('UNIQUE constraint failed');
    return { result: [] as any[], affected: 1 };
  };
  return { sql, write };
};

describe('bulkWrite failure (B5)', () => {
  it('does not attempt later batches once one fails', async () => {
    const { sql, write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    // keys.length 1 → maxBufferSize is 32766; flush explicitly instead.
    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    const first = bulk.close();
    await expect(first).rejects.toBeInstanceOf(BulkWriteError);

    expect(sql).toHaveLength(1);
  });

  it('rejects close() with the original error as cause', async () => {
    const { write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });

    const error = await bulk.close().catch((e) => e);
    expect(error).toBeInstanceOf(BulkWriteError);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect((error.cause as Error).message).toMatch(/UNIQUE/);
  });

  it('throws from enqueue() once the latch is set', async () => {
    const { write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close().catch(() => {});

    expect(() => bulk.enqueue({ a: 2 })).toThrow(BulkWriteError);
  });

  it('counts rows written and rows not written', async () => {
    // Two batches of two rows: the second fails, the third is never attempted.
    const { write } = failingRecorder(1);
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t', ['a']);
    // Force three flushes of one row each by closing between enqueues is not
    // possible; drive the internal batching through the public surface instead.
    for (const a of [1, 2, 3]) bulk.enqueue({ a });
    const error = await bulk.close().catch((e) => e);

    expect(error).toBeInstanceOf(BulkWriteError);
    expect(error.rowsWritten + error.rowsNotWritten).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/bulk.test.ts`
Expected: FAIL — `BulkWriteError` does not exist; `close()` currently rejects with the raw error and later batches are silently dropped.

- [ ] **Step 3: Add `BulkWriteError`**

Append to `src/errors.ts`:

```ts
/**
 * A batch failed. Raised by `bulkWrite().close()` and by `output().close()`.
 *
 * The counters exist because the old behaviour was silent: batches were chained
 * on one shared promise, so after a rejection every later `.then` was skipped —
 * while their rows had already been spliced out of the buffer (B5). A caller now
 * learns how much of its data reached the database.
 */
export class BulkWriteError extends SQLiteError {
  readonly rowsWritten: number;
  readonly rowsNotWritten: number;

  constructor(
    message: string,
    counts: { rowsWritten: number; rowsNotWritten: number },
    options?: { cause?: unknown },
  ) {
    super('BULK_WRITE_FAILED', message, options);
    this.rowsWritten = counts.rowsWritten;
    this.rowsNotWritten = counts.rowsNotWritten;
  }
}
```

- [ ] **Step 4: Latch the failure in `bulkWrite`**

Rewrite the body of `bulkWrite` inside `createBulk` (Serena `replace_content`), keeping the batching and the one-lease-per-batch property intact:

```ts
  const bulkWrite = <KEYS extends string>(
    table: string,
    keys: KEYS[],
    /** Internal: awaited before the first batch. `output()` passes its staging DDL. */
    before?: Promise<unknown>,
  ) => {
    const SQLITE_MAX_VARS = 32766;
    const maxBufferSize = Math.floor(SQLITE_MAX_VARS / keys.length);

    const buffer: { [K in KEYS]: any }[] = [];

    let writePromise = Promise.resolve<number>(0);
    let failure: unknown;
    let rowsWritten = 0;
    let rowsNotWritten = 0;

    const fail = (): BulkWriteError =>
      new BulkWriteError(
        `bulkWrite into "${table}" failed after ${rowsWritten} row(s); ${rowsNotWritten} row(s) were not written.`,
        { rowsWritten, rowsNotWritten },
        { cause: failure },
      );

    const flush = () => {
      const toInsert = [...buffer];
      buffer.length = 0;
      // The chain never rejects: a rejection here is what used to skip every
      // later `.then()` and drop already-spliced rows without a word (B5).
      writePromise = writePromise.then(async (currentAffected) => {
        if (failure) {
          rowsNotWritten += toInsert.length;
          return currentAffected;
        }
        try {
          if (before) await before;
          const { affected } = await write(
            `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES ${toInsert.map(() => `(${keys.map(() => '?')})`)}`,
            toInsert.flatMap((data) => keys.map((k) => data[k])),
          );
          rowsWritten += toInsert.length;
          return currentAffected + affected;
        } catch (error) {
          failure = error;
          // A multi-row INSERT is statement-atomic: nothing of this batch landed.
          rowsNotWritten += toInsert.length;
          return currentAffected;
        }
      });
    };

    return {
      enqueue: (data: { [K in KEYS]: any }) => {
        if (failure) throw fail();
        buffer.push(data);
        if (buffer.length >= maxBufferSize) flush();
      },
      close: async () => {
        if (buffer.length) flush();
        const affected = await writePromise;
        if (failure) throw fail();
        return affected;
      },
    };
  };
```

- [ ] **Step 5: Export `BulkWriteError`**

`src/index.ts` already re-exports `./errors` wholesale — confirm with Serena that `export * from './errors'` is present and no change is needed.

- [ ] **Step 6: Rewrite the pinned browser test**

In `tests/browser/bulk-write.test.ts`, replace the `drops later batches once an earlier batch fails` test (and the KNOWN BUG comment block above it) with:

```ts
  it('stops at the first failed batch and reports it', async () => {
    const db = await createTestClient();

    await db.write(wideTableDDL('bulk_drop'));

    const bulk = db.bulkWrite('bulk_drop', WIDE_COLUMNS);

    // First batch: every row shares the same PRIMARY KEY → the whole
    // multi-row INSERT fails, inserting nothing.
    for (let i = 0; i < WIDE_FLUSH_AT; i++) {
      bulk.enqueue(wideRow(1));
    }
    // Second batch: perfectly valid rows, which must NOT be silently lost.
    for (let i = 0; i < 10; i++) {
      bulk.enqueue(wideRow(1000 + i));
    }

    const error = await bulk.close().catch((e) => e);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect(error.rowsWritten).toBe(0);
    expect(error.rowsNotWritten).toBe(WIDE_FLUSH_AT + 10);

    await db.close();
  });
```

- [ ] **Step 7: Run the whole suite, format, type-check, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add src/errors.ts src/bulk.ts tests/unit/bulk.test.ts tests/browser/bulk-write.test.ts
git commit -m "fix(bulk): latch the first batch failure instead of dropping rows — B5"
```

---

## Task 7: The locks primitive and the sweep decision

**Files:**
- Create: `src/locks.ts`
- Test: `tests/unit/locks.test.ts` (create)

**Interfaces:**
- Produces:
  - `type Locks = { available: boolean; hold(name): Promise<() => void>; withLock<T>(name, fn): Promise<T>; heldNames(): Promise<string[]> }`
  - `createLocks(manager?: LockManager): Locks` — defaults to `navigator.locks`, degrades to a no-op when absent
  - `stagingLockName(file: string, table: string): string`
  - `staleStagingTables(tables: string[], heldNames: string[], file: string): string[]` — **pure**

- [ ] **Step 1: Write the failing test**

Create `tests/unit/locks.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import {
  createLocks,
  stagingLockName,
  staleStagingTables,
} from '../../src/locks';

describe('staleStagingTables', () => {
  const file = 'app.db';

  it('keeps a staging table whose lock is held', () => {
    const held = [stagingLockName(file, '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([]);
  });

  it('collects a staging table nobody holds', () => {
    expect(staleStagingTables(['__bsq_staging_a'], [], file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('ignores locks held for another database file', () => {
    const held = [stagingLockName('other.db', '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('collects several at once and keeps the live one', () => {
    const held = [stagingLockName(file, '__bsq_staging_b')];
    expect(
      staleStagingTables(
        ['__bsq_staging_a', '__bsq_staging_b', '__bsq_staging_c'],
        held,
        file,
      ),
    ).toEqual(['__bsq_staging_a', '__bsq_staging_c']);
  });
});

describe('createLocks', () => {
  /** Minimal in-memory stand-in for navigator.locks. */
  const fakeManager = () => {
    const held = new Set<string>();
    return {
      held,
      request: (name: string, ...rest: any[]) => {
        const callback = rest.length === 1 ? rest[0] : rest[1];
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => {
          held.delete(name);
        });
      },
      query: async () => ({
        held: [...held].map((name) => ({ name })),
        pending: [],
      }),
    } as any;
  };

  it('holds a lock until the returned releaser is called', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const release = await locks.hold('bsq:staging:app.db:t');
    expect(await locks.heldNames()).toContain('bsq:staging:app.db:t');

    release();
    // The release resolves the callback's promise; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(await locks.heldNames()).not.toContain('bsq:staging:app.db:t');
  });

  it('runs a function under an exclusive lock', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const seen: string[] = [];
    const result = await locks.withLock('bsq:sweep:app.db', async () => {
      seen.push(...(await locks.heldNames()));
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toContain('bsq:sweep:app.db');
  });

  it('degrades to a no-op when the API is unavailable', async () => {
    const locks = createLocks(undefined);

    expect(locks.available).toBe(false);
    expect(await locks.heldNames()).toEqual([]);
    const release = await locks.hold('x');
    expect(() => release()).not.toThrow();
    expect(await locks.withLock('x', async () => 'ran')).toBe('ran');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/locks.test.ts`
Expected: FAIL — `src/locks.ts` does not exist.

- [ ] **Step 3: Implement `src/locks.ts`**

```ts
/**
 * A thin wrapper over `navigator.locks`, used by `output()` to make its staging
 * tables collectable across tabs (D3).
 *
 * The staging lock is NOT mutual exclusion — nothing contends for its name. It
 * is a liveness marker: a lock held for as long as a staging table exists is
 * what lets another tab's sweep tell an in-flight table from an orphan. A tab
 * that is killed has its locks released by the browser, so its orphans become
 * collectable immediately, with no timestamp and no grace period.
 */

/** The slice of the Web Locks API this module uses. */
type LockManager = {
  request: (
    name: string,
    optionsOrCallback: any,
    callback?: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};

export type Locks = {
  /** False when the Web Locks API is missing; every method then no-ops. */
  readonly available: boolean;
  /** Acquires `name` and resolves with the function that releases it. */
  hold: (name: string) => Promise<() => void>;
  /** Runs `fn` while holding `name` exclusively. */
  withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Names currently held anywhere in this origin — every tab included. */
  heldNames: () => Promise<string[]>;
};

const STAGING_PREFIX = '__bsq_staging_';

export const stagingTableName = (uuid: string) =>
  `${STAGING_PREFIX}${uuid.replace(/-/g, '_')}`;

export const isStagingTable = (table: string) =>
  table.startsWith(STAGING_PREFIX);

export const stagingLockName = (file: string, table: string) =>
  `bsq:staging:${file}:${table}`;

export const sweepLockName = (file: string) => `bsq:sweep:${file}`;

/**
 * Which staging tables no live `output()` is using — pure, so it is driven by
 * Node tests rather than by two browser tabs.
 */
export const staleStagingTables = (
  tables: string[],
  heldNames: string[],
  file: string,
): string[] => {
  const held = new Set(heldNames);
  return tables.filter((table) => !held.has(stagingLockName(file, table)));
};

export const createLocks = (
  manager: LockManager | undefined = globalThis.navigator?.locks as
    | LockManager
    | undefined,
): Locks => {
  if (!manager)
    return {
      available: false,
      hold: async () => () => {},
      withLock: async (_name, fn) => fn(),
      heldNames: async () => [],
    };

  return {
    available: true,
    hold: (name) =>
      new Promise<() => void>((resolveReleaser) => {
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        void manager.request(name, () => {
          resolveReleaser(release);
          return held;
        });
      }),
    withLock: <T>(name: string, fn: () => Promise<T>) =>
      manager.request(name, { mode: 'exclusive' }, () => fn()) as Promise<T>,
    heldNames: async () => {
      const snapshot = await manager.query();
      return (snapshot.held ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => typeof name === 'string');
    },
  };
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/locks.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/locks.ts tests/unit/locks.test.ts
git commit -m "feat(locks): navigator.locks wrapper and the staging sweep decision — B5"
```

---

## Task 8: `output()` builds a staging table and swaps it in

**Files:**
- Modify: `src/bulk.ts` (`OutputOptions`, `output`, `createBulk` deps)
- Modify: `src/client.ts` (`createBulk({ write })` → `createBulk({ write, read, transaction, file, locks })`, and the `temp` mention in the JSDoc at `:260`)
- Test: `tests/unit/bulk.test.ts` (extend)

**Interfaces:**
- Consumes: `stagingTableName`, `stagingLockName`, `sweepLockName`, `staleStagingTables`, `createLocks` (Task 7); `BulkWriteError` (Task 6).
- Produces: `createBulk(deps: { write: WriteFn; read: ReadFn; transaction: TransactionFn; file: string; locks: Locks })`. `OutputOptions` loses `temp`.

**Context you need:** the final swap runs through the existing public `transaction()`, which holds **one** lease for its whole lifetime — that is what makes the swap atomic against other writers. The population phase must keep using the public `write` (one lease per batch), so unrelated writes still interleave between batches.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/bulk.test.ts`:

```ts
import { createLocks } from '../../src/locks';

/** Records statements from both the plain writes and the swap transaction. */
const outputRecorder = () => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 1 };
  };
  const read = async () => [] as any[];
  const transaction = async <T>(callback: (db: any) => Promise<T>) => {
    sql.push('BEGIN');
    const result = await callback({
      write: async (statement: string) => {
        sql.push(statement);
        return { result: [], affected: 0 };
      },
      read: async (statement: string) => {
        sql.push(statement);
        return [];
      },
    });
    sql.push('COMMIT');
    return result;
  };
  return {
    sql,
    deps: {
      write,
      read,
      transaction,
      file: 'app.db',
      locks: createLocks(undefined),
    },
  };
};

describe('output() staging and swap (B5)', () => {
  it('creates a staging table, never the target, before close()', async () => {
    const { sql, deps } = outputRecorder();
    const { output } = createBulk(deps);

    const out = output('report', { id: 'INTEGER' });
    out.enqueue({ id: 1 });
    // Let the staging DDL settle without closing.
    await Promise.resolve();
    await Promise.resolve();

    expect(sql.some((s) => s.includes('CREATE TABLE "__bsq_staging_'))).toBe(
      true,
    );
    expect(sql.some((s) => s.includes('DROP TABLE IF EXISTS "report"'))).toBe(
      false,
    );

    await out.close();
  });

  it('drops, renames and indexes inside one transaction, in that order', async () => {
    const { sql, deps } = outputRecorder();
    const { output } = createBulk(deps);

    const out = output(
      'report',
      { id: 'INTEGER', label: 'TEXT' },
      { indexes: ['label'] },
    );
    out.enqueue({ id: 1, label: 'a' });
    await out.close();

    const begin = sql.indexOf('BEGIN');
    const drop = sql.findIndex((s) => s.includes('DROP TABLE IF EXISTS "report"'));
    const rename = sql.findIndex((s) => s.includes('RENAME TO "report"'));
    const index = sql.findIndex((s) => s.includes('CREATE INDEX'));
    const commit = sql.indexOf('COMMIT');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(begin);
    expect(rename).toBeGreaterThan(drop);
    // Indexes are built AFTER the rename, with final names: SQLite has no
    // ALTER INDEX ... RENAME, so indexes built on the staging table would keep
    // __bsq_staging_ names forever.
    expect(index).toBeGreaterThan(rename);
    expect(commit).toBeGreaterThan(index);
    expect(sql[index]).toContain('"report_label_IDX"');
  });

  it('drops the staging table and leaves the target alone when a batch fails', async () => {
    const sql: string[] = [];
    let calls = 0;
    const deps = {
      write: async (statement: string) => {
        sql.push(statement);
        if (statement.startsWith('INSERT')) throw new Error('constraint');
        calls++;
        return { result: [] as any[], affected: 0 };
      },
      read: async () => [] as any[],
      transaction: async <T>(cb: (db: any) => Promise<T>) => {
        sql.push('BEGIN');
        return cb({ write: async () => ({ result: [], affected: 0 }) });
      },
      file: 'app.db',
      locks: createLocks(undefined),
    };
    const { output } = createBulk(deps as any);

    const out = output('report', { id: 'INTEGER' });
    out.enqueue({ id: 1 });
    await expect(out.close()).rejects.toMatchObject({
      code: 'BULK_WRITE_FAILED',
    });

    expect(sql.some((s) => s.includes('DROP TABLE IF EXISTS "__bsq_staging_'))).toBe(
      true,
    );
    // The target was never touched.
    expect(sql.some((s) => s.includes('"report"'))).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/bulk.test.ts`
Expected: FAIL — `createBulk` takes only `{ write }`, and `output()` drops the target immediately.

- [ ] **Step 3: Widen `createBulk`'s dependencies and drop `temp`**

In `src/bulk.ts`, remove `temp?: boolean` from `OutputOptions` and add the structural dep types beside the existing `WriteFn`:

```ts
export type OutputOptions<SCHEMA extends Schema> = {
  indexes?: Index<SCHEMA>[];
};

// Structural mirrors of SQLiteDB methods. Kept inline to avoid a circular
// import: client.ts imports createBulk, so createBulk cannot import from it.
type ReadFn = (sql: string, params?: any[], options?: any) => Promise<any[]>;

type TransactionFn = <T>(
  callback: (db: {
    write: (
      sql: string,
      params?: any[],
      options?: any,
    ) => Promise<{ result: any[]; affected: number }>;
  }) => Promise<T>,
  options?: { readOnly?: boolean; autoCommit?: boolean },
) => Promise<T>;
```

Add the imports this task needs:

```ts
import {
  createLocks,
  type Locks,
  stagingLockName,
  stagingTableName,
  staleStagingTables,
  sweepLockName,
} from './locks';
```

(`createLocks` itself is called in `client.ts`, not here — `bulk.ts` only receives a
`Locks`. Import only what you use; biome will tell you.)

and change the factory signature:

```ts
export const createBulk = (deps: {
  write: WriteFn;
  read: ReadFn;
  transaction: TransactionFn;
  file: string;
  locks: Locks;
}) => {
  const { write, read, transaction, file, locks } = deps;
```

- [ ] **Step 4: Rewrite `output()`**

Replace the whole `output` body:

```ts
  /**
   * Builds a table from scratch and swaps it in atomically — MongoDB's `$out`.
   *
   * Rows are loaded into `__bsq_staging_<uuid>` (a normal table in `main`, never
   * TEMP: a TEMP table lives in the `temp` database and cannot be renamed across
   * databases, and is invisible to the other pool workers). The final swap is
   * one short transaction: DROP the target, RENAME the staging table onto it,
   * then build the indexes with their final names — SQLite has no
   * `ALTER INDEX ... RENAME`, so indexes built before the swap would keep the
   * staging name forever (D3).
   *
   * Until `close()` succeeds the previous table stays intact and fully
   * populated. That is the guarantee `output()` did not have (B5): it used to
   * DROP and CREATE eagerly, so a failure anywhere in the load left the caller
   * with no table at all.
   */
  const output = <SCHEMA extends Schema>(
    table: string,
    schema: SCHEMA,
    options?: OutputOptions<SCHEMA>,
  ) => {
    const staging = stagingTableName(crypto.randomUUID());

    const normalizedSchema = Object.entries(schema).map(([k, v]) => {
      const type = assertColumnType(typeof v === 'string' ? v : v.type, k);
      const unique = typeof v === 'object' && !!v.unique;
      const notnull = typeof v === 'object' && !!v.required;
      const generated =
        typeof v === 'object' && v.generated
          ? assertGeneratedExpression(v.generated, k)
          : undefined;
      return { name: k, type, unique, notnull, generated };
    });

    // Held for as long as the staging table exists: this is what tells another
    // tab's sweep that the table is in flight and must not be collected.
    const lockHeld = locks.hold(stagingLockName(file, staging));

    const createStaging = sweepOnce()
      .then(() =>
        write(`
			CREATE TABLE ${quoteIdent(staging)}(
				${normalizedSchema
          .map(({ name, type, unique, notnull, generated }) => {
            return `${quoteIdent(name)} ${type} ${unique ? 'UNIQUE' : ''} ${notnull ? 'NOT NULL' : ''} ${generated ? `GENERATED ALWAYS AS ${generated}` : ''}`;
          })
          .join(',')}
			)
		`),
      )
      .then(() => undefined);

    const { enqueue, close } = bulkWrite(
      staging,
      Object.keys(schema).filter(
        (col) => typeof schema[col] !== 'object' || !schema[col].generated,
      ),
      createStaging,
    );

    const releaseLock = async () => {
      (await lockHeld)();
    };

    const dropStaging = () =>
      write(`DROP TABLE IF EXISTS ${quoteIdent(staging)}`).catch(() => {
        // Net 2 (the sweep) collects what this could not.
      });

    return {
      enqueue: (
        data: {
          [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
            ? never
            : K]: any;
        },
      ) => enqueue(data as any),

      close: async () => {
        let affected: number;
        try {
          affected = await close();
        } catch (error) {
          await dropStaging();
          await releaseLock();
          throw error;
        }

        try {
          await transaction(async (tx) => {
            await tx.write(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
            await tx.write(
              `ALTER TABLE ${quoteIdent(staging)} RENAME TO ${quoteIdent(table)}`,
            );
            for (const statement of indexStatements(table, options)) {
              await tx.write(statement);
            }
          });
        } catch (error) {
          await dropStaging();
          throw error;
        } finally {
          await releaseLock();
        }

        return affected;
      },
    };
  };
```

- [ ] **Step 5: Extract the index statements**

Add, above `output`, a helper that turns the `indexes` option into statements — this is the four-level ternary from the old code, moved out and quoted:

```ts
  /** CREATE INDEX statements for the final table, built after the rename. */
  const indexStatements = <SCHEMA extends Schema>(
    table: string,
    options?: OutputOptions<SCHEMA>,
  ): string[] => {
    const statements: string[] = [];
    for (const index of options?.indexes ?? []) {
      const columns = Array.isArray(index)
        ? index
        : typeof index === 'object'
          ? 'column' in index
            ? [index.column]
            : index.columns
          : [index];
      const unique =
        !Array.isArray(index) && typeof index === 'object' && !!index.unique;
      if (!columns?.length) continue;
      const names = columns.map(String);
      statements.push(
        `CREATE ${unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${quoteIdent(`${table}_${names.join('_')}_${unique ? 'U' : 'IDX'}`)} ON ${quoteIdent(table)}(${names.map(quoteIdent).join(',')})`,
      );
    }
    return statements;
  };
```

- [ ] **Step 6: Add the sweep (net 2)**

Still inside `createBulk`, above `output`:

```ts
  // Net 2 of the three-net cleanup: orphans left by a closed tab or a crashed
  // session. Runs at the FIRST output() of this client, not at open() — the
  // writer is only designated lazily on the first write, and a sweep at open
  // would race the n workers.
  let swept: Promise<void> | undefined;

  const sweepOnce = () => {
    // MANDATORY guard: without the Web Locks API there is no way to tell an
    // in-flight staging table from an orphan, and `heldNames()` returns []. A
    // sweep in that state would drop another tab's live staging table — worse
    // than not sweeping. The sweep is opportunistic; skipping it is correct.
    if (!locks.available) return Promise.resolve();

    swept ??= locks
      .withLock(sweepLockName(file), async () => {
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
      .catch(() => {
        // A failed sweep must never fail the output() that triggered it.
      });
    return swept;
  };
```

- [ ] **Step 7: Update the call site in `client.ts`**

```ts
  const { bulkWrite, output } = createBulk({
    write,
    read,
    transaction,
    file,
    locks: createLocks(),
  });
```

Check with Serena that `transaction` is already defined above this line; if it is defined below, move the `createBulk` call after it. Remove the `temp` mention from the `output` JSDoc (`client.ts:260`).

- [ ] **Step 8: Delete the `temp` browser test**

Remove `tests/browser/output.test.ts:114-132` (`creates a TEMPORARY table when temp is set`) — the option no longer exists.

- [ ] **Step 9: Run the whole suite, format, type-check, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add src/bulk.ts src/client.ts tests/unit/bulk.test.ts tests/browser/output.test.ts
git commit -m "feat(output)!: staging table and atomic rename, temp removed — B5, D3"
```

---

## Task 9: `output()` atomicity and orphan collection, in a real browser

**Files:**
- Modify: `tests/browser/output.test.ts`

**Interfaces:**
- Consumes: everything from Task 8.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/output.test.ts`:

```ts
  it('leaves the previous table intact and complete until close()', async () => {
    const db = await createTestClient();

    const first = db.output('swap_target', { id: 'INTEGER' });
    first.enqueue({ id: 1 });
    first.enqueue({ id: 2 });
    await first.close();

    const second = db.output('swap_target', { id: 'INTEGER' });
    second.enqueue({ id: 99 });

    // Mid-load: the OLD rows are still there, whole.
    const during = await db.read<{ id: number }>(
      'SELECT id FROM swap_target ORDER BY id',
    );
    expect(during.map((r) => r.id)).toEqual([1, 2]);

    await second.close();

    const after = await db.read<{ id: number }>('SELECT id FROM swap_target');
    expect(after.map((r) => r.id)).toEqual([99]);

    await db.close();
  });

  it('leaves the target untouched and no staging table behind when the load fails', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE keep_me (id INTEGER PRIMARY KEY)');
    await db.write('INSERT INTO keep_me (id) VALUES (1), (2)');

    const out = db.output('keep_me', { id: 'INTEGER PRIMARY KEY' as string });
    out.enqueue({ id: 7 });
    out.enqueue({ id: 7 }); // duplicate primary key → the batch fails

    await expect(out.close()).rejects.toMatchObject({
      code: 'BULK_WRITE_FAILED',
    });

    const rows = await db.read<{ id: number }>(
      'SELECT id FROM keep_me ORDER BY id',
    );
    expect(rows.map((r) => r.id)).toEqual([1, 2]);

    const staging = await db.read(
      "SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'",
    );
    expect(staging).toHaveLength(0);

    await db.close();
  });

  it('collects an orphan staging table at the first output()', async () => {
    const db = await createTestClient();

    // An orphan exactly as a crashed tab would leave it: no lock is held for it.
    await db.write('CREATE TABLE __bsq_staging_deadbeef (id INTEGER)');

    const out = db.output('sweep_target', { id: 'INTEGER' });
    out.enqueue({ id: 1 });
    await out.close();

    const staging = await db.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'",
    );
    expect(staging).toHaveLength(0);

    await db.close();
  });

  it('does not collect a staging table that is still in flight', async () => {
    const db = await createTestClient();

    const inFlight = db.output('sweep_live_a', { id: 'INTEGER' });
    inFlight.enqueue({ id: 1 });

    // A second output() sweeps; the first one's staging table is locked.
    const other = db.output('sweep_live_b', { id: 'INTEGER' });
    other.enqueue({ id: 2 });
    await other.close();

    // The first still completes — its staging table survived the sweep.
    await expect(inFlight.close()).resolves.toBeGreaterThanOrEqual(0);

    const rows = await db.read<{ id: number }>('SELECT id FROM sweep_live_a');
    expect(rows.map((r) => r.id)).toEqual([1]);

    await db.close();
  });
```

- [ ] **Step 2: Run them and read the failures**

Run: `timeout -k 60 300 pnpm exec rstest run --project browser tests/browser/output.test.ts`
Expected: PASS if Task 8 is correct. **These tests exist to falsify Task 8, not to be made green by editing them** — if one fails, fix `bulk.ts`, not the test. The one legitimate adjustment is the sweep timing in the last test: the sweep runs once per `createBulk`, i.e. once per client, so the second `output()` reuses the first sweep and collects nothing. If that makes the test vacuous, drive it from two clients on the same file instead (`createTestClient` takes options; reuse the same `file`).

- [ ] **Step 3: Rewrite the observation-during-load test**

Find the existing test in `output.test.ts` that reads the target while rows are being enqueued and asserts it exists but is empty. Under the new design it must assert the opposite — the target does not exist yet on a first-ever load:

```ts
  it('does not create the target until close()', async () => {
    const db = await createTestClient();

    const out = db.output('late_target', { id: 'INTEGER' });
    out.enqueue({ id: 1 });

    const existing = await db.read(
      "SELECT name FROM sqlite_master WHERE name = 'late_target'",
    );
    expect(existing).toHaveLength(0);

    await out.close();

    const created = await db.read(
      "SELECT name FROM sqlite_master WHERE name = 'late_target'",
    );
    expect(created).toHaveLength(1);

    await db.close();
  });
```

- [ ] **Step 4: Run the whole suite, format, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add tests/browser/output.test.ts
git commit -m "test(output): atomicity, failure isolation and orphan collection — B5"
```

---

## Task 10: Fix `debug.ts` before wiring it

**Files:**
- Modify: `src/debug.ts`
- Test: `tests/unit/debug.test.ts` (extend — the file already exists)

**Interfaces:**
- Produces: `createClientDebug` with bounded histories and no leftover placeholder. Signature gains a `stats` callback: `createClientDebug(file, orchestrator, clientOptions, stats)` where `stats: () => { read: number; write: number }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/debug.test.ts` (reuse the file's existing imports and its stub orchestrator; if it has none, build one returning a fixed status):

```ts
describe('debug history bounds (D5)', () => {
  const stubOrchestrator = { getStatus: () => 0 } as any;
  const options = { vfs: 'OPFSCoopSyncVFS', pragmas: {}, name: 'test' } as any;

  it('bounds the per-worker request history', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    debug.createWorkerDebugState(0, 'w0');

    for (let i = 0; i < 200; i++) {
      debug.createRequestDebugState().assign(0);
    }

    expect(debug.state.workers[0]!.requests.length).toBeLessThanOrEqual(50);
  });

  it('bounds the per-request query history at exactly the maximum', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState().assign(0);

    for (let i = 0; i < 200; i++) {
      debug.createQueryDebugState(0, `SELECT ${i}`);
    }

    // Off-by-one: the old `> MAX` let it peak at 51 before trimming to 50.
    expect(debug.state.workers[0]!.currentRequest!.queries.length).toBe(50);
  });

  it('exposes queue depths from the scheduler, never a stale copy', () => {
    let depth = { read: 1, write: 2 };
    const debug = createClientDebug(
      'f.db',
      stubOrchestrator,
      options,
      () => depth,
    );

    expect(debug.state.queue.read).toBe(1);
    depth = { read: 7, write: 9 };
    expect(debug.state.queue.read).toBe(7);
    expect(debug.state.queue.write).toBe(9);
  });

  it('reports a real worker status, not a placeholder', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    const state = debug.createWorkerDebugState(0, 'w0');
    expect(state.status).not.toBe('HAHA');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/debug.test.ts`
Expected: FAIL — `createClientDebug` takes three parameters, `requests` is unbounded, `queries` peaks at 51.

- [ ] **Step 3: Apply the four fixes**

In `src/debug.ts`:

```ts
const MAX_QUERY_HISTORY_LENGTH = 50;
const MAX_REQUEST_HISTORY_LENGTH = 50;
```

`createClientDebug` gains the `stats` parameter and `queue` becomes a getter-backed object:

```ts
export const createClientDebug = (
  file: string,
  orchestrator: WorkerOrchestrator,
  clientOptions: Required<
    Pick<CreateSQLiteClientOptions, 'vfs' | 'pragmas' | 'name'>
  >,
  stats: () => { read: number; write: number },
) => {
  const { vfs, pragmas, name } = clientOptions;

  // Read through to the scheduler: the old counters were incremented by hand at
  // every acquire/release site and went stale the moment one was missed.
  const queue = {
    get read() {
      return stats().read;
    },
    get write() {
      return stats().write;
    },
  };
```

In `createWorkerDebugState`, replace `status: 'HAHA'` with `status: statusToLabel(orchestrator.getStatus(index))` (the Proxy still overrides it on every read; this only removes the leftover).

In `createRequestDebugState`'s `assign`:

```ts
      assign: (index: number) => {
        const worker = clientState.workers[index];
        if (worker) {
          state.acquireTime = Date.now();
          // Bounded: this array is pushed to on EVERY request and used to grow
          // with the client's total query count (D5 §1.3, the blocking fix).
          if (worker.requests.length >= MAX_REQUEST_HISTORY_LENGTH)
            worker.requests.shift();
          worker.requests.push(state);
          worker.currentRequest = state;
        }
      },
```

In `createQueryDebugState`, change `>` to `>=`:

```ts
      if (worker.currentRequest.queries.length >= MAX_QUERY_HISTORY_LENGTH) {
        worker.currentRequest.queries.shift();
      }
```

`ClientDebugState['queue']` becomes `{ readonly read: number; readonly write: number }`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/debug.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/debug.ts tests/unit/debug.test.ts
git commit -m "fix(debug): bound both histories, drop the placeholder status — D5"
```

---

## Task 11: Wire the debug subsystem

**Files:**
- Modify: `src/scheduler.ts` (add `stats()`)
- Modify: `src/pool.ts` (`:81-88`, `:247` — the two frozen hooks)
- Modify: `src/client.ts` (real `createClientDebug` call, `acquireInstrumented`, the seven acquisition sites, the `debug` option and its type)
- Test: `tests/unit/scheduler.test.ts` (extend), `tests/browser/debug.test.ts` (create)

**Interfaces:**
- Consumes: `createClientDebug(file, orchestrator, options, stats)` from Task 10.
- Produces:
  - `Scheduler.stats(): { read: number; write: number; available: number; leased: number }`
  - `CreateSQLiteClientOptions.debug?: string | boolean`
  - `SQLiteDB.debug?: ClientDebugState`

**Context you need — read spec §3.1 first.** Wave 1 kept the worker-level and query-level writes in `pool.ts` (`:163` `initializationTime`, `:187` `firstRowTime`, `:198-199` `affectedRows`, `:200`/`:213` `endTime`, `:212` `error`) but lost the request level entirely: `createRequestDebugState` has **no call site**. Without it `worker.currentRequest` is never set and every one of those surviving writes has nothing to write into.

- [ ] **Step 1: Write the failing scheduler test**

Append to `tests/unit/scheduler.test.ts`:

```ts
  it('reports queue depths and lease counts', async () => {
    const scheduler = createScheduler<{ index: number }>();
    scheduler.add({ index: 0 });

    expect(scheduler.stats()).toMatchObject({
      available: 1,
      leased: 0,
      read: 0,
      write: 0,
    });

    const lease = await scheduler.acquire('read');
    expect(scheduler.stats()).toMatchObject({ available: 0, leased: 1 });

    // Nothing free: this one queues.
    void scheduler.acquire('read');
    expect(scheduler.stats().read).toBe(1);

    lease.release();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/scheduler.test.ts`
Expected: FAIL — `scheduler.stats is not a function`.

- [ ] **Step 3: Add `stats()`**

Add to the `Scheduler<W>` type:

```ts
  /**
   * Read-only counters for the debug subsystem. The scheduler stays pure: it
   * exposes numbers and knows nothing about debug (spec §3.2).
   */
  stats: () => {
    read: number;
    write: number;
    available: number;
    leased: number;
  };
```

and to the returned object:

```ts
    stats: () => ({
      read: readerQueue.length,
      write: writerQueue.length,
      available: available.size,
      leased: leased.size,
    }),
```

- [ ] **Step 4: Write the failing browser test**

Create `tests/browser/debug.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

describe('debug subsystem (B6)', () => {
  it('is undefined when the option is absent', async () => {
    const db = await createTestClient();
    expect(db.debug).toBeUndefined();
    await db.close();
  });

  it('populates the whole chain after one read', async () => {
    const db = await createTestClient({ debug: true });

    await db.write('CREATE TABLE d (id INTEGER)');
    await db.write('INSERT INTO d (id) VALUES (1)');
    await db.read('SELECT id FROM d');

    const state = db.debug;
    expect(state).toBeDefined();

    const worker = state!.workers.find((w) => w?.requests.length);
    expect(worker).toBeDefined();

    const request = worker!.requests[0]!;
    // The request level is what wave 1 lost entirely — see spec §3.1.
    expect(request.acquireTime).toBeGreaterThan(0);
    expect(request.releaseTime).toBeGreaterThan(0);

    const query = request.queries[0]!;
    expect(query.sql).toContain('SELECT');
    expect(query.endTime).toBeGreaterThan(0);
    expect(query.firstRowTime).toBeGreaterThan(0);

    await db.close();
  });

  it('reads queue depths live from the scheduler', async () => {
    const db = await createTestClient({ debug: 'probe' });
    expect(db.debug!.queue.read).toBe(0);
    expect(db.debug!.queue.write).toBe(0);
    await db.close();
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `timeout -k 60 300 pnpm exec rstest run --project browser tests/browser/debug.test.ts`
Expected: FAIL — `db.debug` is `undefined` even with the option set.

- [ ] **Step 6: Call `createClientDebug` for real**

In `src/client.ts`, replace `const { state: debug } = {} as ReturnType<typeof createClientDebug>;` (`:365`) with a real conditional construction, placed **after** `scheduler` is created (it needs `scheduler.stats`):

```ts
  const debugOption = clientOptions?.debug;
  const debugPrefix =
    typeof debugOption === 'string' ? debugOption : clientPrefix;

  const clientDebug = debugOption
    ? createClientDebug(
        file,
        orchestrator,
        {
          vfs,
          pragmas: clientOptions?.pragmas ?? {},
          name: clientOptions?.name ?? 'SQLite',
        },
        () => scheduler.stats(),
      )
    : undefined;

  const debug = clientDebug?.state;
```

Change the `import type { createClientDebug }` at `client.ts:2` into a value import, and type the public field (`client.ts:292`) as `debug?: ClientDebugState` — export `ClientDebugState` from `debug.ts` if it is not already exported.

Add `debug?: string | boolean` to `CreateSQLiteClientOptions` with JSDoc:

```ts
  /**
   * Turns on the introspection subsystem exposed as `db.debug`, and the
   * lifecycle log. A string is used as the log prefix; `true` falls back to the
   * client prefix (`"<name> <index>"`), which already names the workers.
   *
   * @defaultValue undefined — no collection, no output, `db.debug` undefined.
   */
  debug?: string | boolean;
```

- [ ] **Step 7: Add the instrumented lease wrapper**

Still in `client.ts`, immediately after the scheduler:

```ts
  /**
   * The single owner of the request level of the debug tree.
   *
   * There are seven acquisition sites; instrumenting each is seven chances to
   * miss one. This wrapper stamps `acquireTime` (through `assign`) and
   * `releaseTime`, and is a pass-through when debug is off. Nothing outside it
   * calls `scheduler.acquire`.
   */
  const acquireInstrumented = async (kind: 'read' | 'write') => {
    if (!clientDebug) return scheduler.acquire(kind);

    const request = clientDebug.createRequestDebugState();
    const lease = await scheduler.acquire(kind);
    request.assign(lease.worker.index);

    return {
      worker: lease.worker,
      release: () => {
        request.state.releaseTime = Date.now();
        lease.release();
      },
    };
  };
```

`release()` stays idempotent because `lease.release()` is; a second call re-stamps a timestamp and hands nothing back.

- [ ] **Step 8: Route all seven sites through the wrapper**

Replace `await scheduler.acquire('read')` / `('write')` with `await acquireInstrumented('read')` / `('write')` at `client.ts:388`, `:414`, `:435`, `:460`, `:486`, and pass the wrapper into `createTransaction` so `transaction.ts:64` uses it too:

```ts
  const transaction = createTransaction({
    scheduler: { ...scheduler, acquire: acquireInstrumented },
  });
```

Verify with `grep -rn "scheduler.acquire" src/` that the only remaining occurrence is inside `acquireInstrumented`.

- [ ] **Step 9: Feed the hooks in `pool.ts`**

Replace the two frozen placeholders (`pool.ts:81-87`) with real dependencies taken from the pool's `deps` object, adding them to its type:

```ts
  const { createWorkerDebugState, createQueryDebugState } = deps;
```

Type them on the deps as:

```ts
  createWorkerDebugState?: (index: number, name: string) => any;
  createQueryDebugState?: (index: number, sql: string, params?: unknown[]) => any;
```

Pass them from `client.ts` where the pool worker is created:

```ts
      createWorkerDebugState: clientDebug?.createWorkerDebugState,
      createQueryDebugState: clientDebug?.createQueryDebugState,
```

Keep the `?.()` call sites exactly as they are — they are already correct.

- [ ] **Step 10: Run everything**

```bash
timeout -k 60 600 pnpm test
```

Expected: PASS, including the new `tests/browser/debug.test.ts`.

- [ ] **Step 11: Format, type-check, commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/scheduler.ts src/pool.ts src/client.ts src/debug.ts tests/unit/scheduler.test.ts tests/browser/debug.test.ts
git commit -m "feat(debug): wire the introspection tree behind the debug option — B6"
```

---

## Task 12: The lifecycle logger

**Files:**
- Create: `src/logger.ts`
- Modify: `src/pool.ts` (worker created, ready, open-error, crash, messageerror, close)
- Modify: `src/client.ts` (supervisor restart and eviction, client close, logger construction)
- Modify: `src/bulk.ts` (sweep skipped)
- Modify: `README.md` (document the `debug` option)
- Test: `tests/unit/logger.test.ts` (create)

**Interfaces:**
- Produces: `createLogger(prefix: string, enabled: boolean): Logger` where `Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/logger.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createLogger } from '../../src/logger';

const capture = () => {
  const lines: string[] = [];
  const sink = {
    debug: (m: string) => lines.push(`debug:${m}`),
    warn: (m: string) => lines.push(`warn:${m}`),
    error: (m: string) => lines.push(`error:${m}`),
  };
  return { lines, sink };
};

describe('createLogger', () => {
  it('prefixes every line', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.info('worker 1 ready');
    expect(lines).toEqual(['debug:[SQLite 1] worker 1 ready']);
  });

  it('routes warn and error to their own sinks', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.warn('restarting worker 2');
    log.error('worker 2 evicted');
    expect(lines).toEqual([
      'warn:[SQLite 1] restarting worker 2',
      'error:[SQLite 1] worker 2 evicted',
    ]);
  });

  it('writes nothing when disabled', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', false, sink);

    log.info('x');
    log.warn('y');
    log.error('z');
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/logger.test.ts`
Expected: FAIL — `src/logger.ts` does not exist.

- [ ] **Step 3: Implement `src/logger.ts`**

```ts
/**
 * The prefixed logger the `debug` option turns on.
 *
 * Lifecycle events only — worker created, ready, open-error, crash, restart,
 * eviction, close, skipped sweep. A line per query would be illegible under
 * real load and would put user values on the console; query throughput belongs
 * in `db.debug`, not here.
 */
export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type Sink = Pick<Console, 'debug' | 'warn' | 'error'>;

export const createLogger = (
  prefix: string,
  enabled: boolean,
  sink: Sink = console,
): Logger => {
  if (!enabled)
    return { info: () => {}, warn: () => {}, error: () => {} };

  const line = (message: string) => `[${prefix}] ${message}`;
  return {
    info: (message) => sink.debug(line(message)),
    warn: (message) => sink.warn(line(message)),
    error: (message) => sink.error(line(message)),
  };
};
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `timeout -k 30 120 pnpm exec rstest run --project unit tests/unit/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Construct the logger and thread it through**

In `client.ts`, after `debugPrefix` (Task 11 Step 6):

```ts
  const logger = createLogger(debugPrefix, !!debugOption);
```

Pass `logger` into the pool's `deps` and into `createBulk`'s deps (typed as `Logger`), and call it at these points and no others:

| File | Event | Call |
|---|---|---|
| `pool.ts` | worker created | `logger.info(\`worker ${index + 1} created\`)` |
| `pool.ts` | `ready` received | `logger.info(\`worker ${index + 1} ready\`)` |
| `pool.ts` | `open-error` received | `logger.error(\`worker ${index + 1} failed to open: ${message}\`)` |
| `pool.ts` | `onerror` | `logger.error(\`worker ${index + 1} crashed: ${detail}\`)` |
| `pool.ts` | `messageerror` | `logger.error(\`worker ${index + 1} sent an undeserializable message\`)` |
| `pool.ts` | worker terminated by `close()` | `logger.info(\`worker ${index + 1} closed\`)` |
| `client.ts` | supervisor restarts a slot | `logger.warn(\`restarting worker ${index + 1}\`)` |
| `client.ts` | supervisor evicts a slot | `logger.error(\`worker ${index + 1} evicted\`)` |
| `client.ts` | `close()` entered | `logger.info('client closing')` |
| `bulk.ts` | sweep skipped | `logger.warn('navigator.locks is unavailable; skipping the staging sweep')` |

In `bulk.ts` the guard already exists (Task 8, Step 6) — this task only makes it
audible:

```ts
    if (!locks.available) {
      logger.warn(
        'navigator.locks is unavailable; skipping the staging sweep',
      );
      return Promise.resolve();
    }
```

- [ ] **Step 6: Document the option in the README**

Add a short subsection under the client options documenting `debug?: string | boolean`: what `db.debug` exposes, that a string is the log prefix, that only lifecycle events are logged, and that it is off by default.

- [ ] **Step 7: Run everything, format, type-check, commit**

```bash
timeout -k 60 600 pnpm test
pnpm check && pnpm exec tsc --noEmit
git add src/logger.ts src/pool.ts src/client.ts src/bulk.ts tests/unit/logger.test.ts README.md
git commit -m "feat(debug): prefixed lifecycle logger behind the debug option — B6"
```

---

## Task 13: Close the wave

**Files:**
- Modify: `.serena/memories/follow-ups.md`, `.serena/memories/project-state.md`, `.serena/memories/resume-plan.md`

- [ ] **Step 1: Full verification, from a clean tree**

```bash
pnpm check
pnpm exec tsc --noEmit
timeout -k 60 900 pnpm test
timeout -k 120 900 pnpm test:consumer
```

All four must pass. `pnpm test:consumer` must report 11/11 stages. Do not proceed on a partial pass — report what failed instead.

- [ ] **Step 2: Confirm no pinned test was left behind**

```bash
grep -rn "it.fails" tests/ || echo "none — expected"
grep -rn "KNOWN BUG\|B4\|B5\|B6" tests/ src/
```

Every remaining mention must describe current behaviour, not a bug that has just been fixed.

- [ ] **Step 3: Update the memories**

- `follow-ups.md`: B4, B5, B6 → **done**, each with its evidence (which tests, which files). Remove the wave-3 obligations from W-route's entry (the pragma one is now satisfied). Note in W-multitab that `output()` is now multi-tab safe while the rest of the client is not.
- `project-state.md`: the new files (`locks.ts`, `logger.ts`), the new line counts, the new public surface (`BulkWriteError`, `debug` option, `db.debug`, `output()` without `temp`), the new test count, and the fact that pragmas are applied at open.
- `resume-plan.md`: a wave-3 entry in §4 stating what shipped and what was found; mark wave 3 closed; state that the next session starts on wave 4, whose first act is **BP-1's four-combination measurement**, not a design.

- [ ] **Step 4: Commit and report**

```bash
git add .serena/memories
git commit -m "docs(memory): wave 3 closed — B4, B5, B6"
```

Report to the user: the branch, the commit count, the test count, and anything the plan did not anticipate. Do **not** merge — merging is the user's call (`AGENTS.md`, phase workflow).

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.2 `quoteIdent`, type/generated validation | 1, 2 |
| §1.3 pragma syntactic validation | 3 |
| §1.4 pragmas at open | 4 |
| §1.5 read pragmas back to `read()` | 5 |
| §2.1 staging sequence, swap transaction, index order | 8 |
| §2.2 lifetime lock | 7, 8 |
| §2.3 sweep, pure decision, degradation | 7, 8, 9, 12 |
| §2.4 `temp` removed | 8 |
| §2.5 latch, `BULK_WRITE_FAILED` | 6 |
| §2.6 visible behaviour change | 9 |
| §3.1 lost call sites restored | 11 |
| §3.2 `stats()`, `acquireInstrumented` | 11 |
| §3.3 the option | 11 |
| §3.4 four fixes | 10 |
| §3.5 logger | 12 |
| §4.4 falsifiability | Global Constraints |
| §4.5 existing tests that change | 5, 6, 8, 9 |
| §5.1 closing verification | 13 |

**Deviations from the spec, deliberate:**

1. `rowsNotAttempted` → **`rowsNotWritten`** (Task 6). A multi-row INSERT is statement-atomic, so the failing batch was attempted and wrote nothing; the spec's name would exclude exactly the rows the caller most needs counted.
2. The staging lock is named by the **table name** rather than the raw uuid (Task 7). The uuid is already in the table name, and this makes the sweep's pure function a one-line set membership test.

Both are worth reflecting back into the spec when the wave closes.
