# Objects, dates and JSONB in `bulkWrite()` and `output()` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bulkWrite()` and `output()` convert every cell to something wa-sqlite binds faithfully — objects and arrays to JSON text, a top-level `Date` to SQLite's date format — and store declared JSONB columns through `jsonb(?)`.

**Architecture:** A pure module `src/values.ts` holds the conversion (`toBindable`), the date format (`toSQLiteDate`) and the validation of `types` (`jsonbColumns`). `bulkWrite()` in `src/bulk.ts` validates `types` at the call, builds its row template once, and converts each row in `enqueue()` into an array of bindable values. `output()` derives `types` from its schema and passes it to its internal `bulkWrite()`.

**Tech Stack:** TypeScript 7 (`NoInfer`), rstest (unit project in Node, browser projects on Chromium and Firefox through Playwright), wa-sqlite 1.1.2 (SQLite 3.53.0).

**Spec:** `docs/superpowers/specs/2026-10-06-bulk-object-values-design.md` — read it before any task.

## Global Constraints

- Scope: `bulkWrite()` and `output()` only; `query()`, `write()` and the other parameterised methods are not touched (spec D1).
- A top-level `Date` in an ordinary column is bound as `YYYY-MM-DD HH:MM:SS.SSS`, UTC, milliseconds always present (spec D4).
- `types` is `Partial<Record<KEYS, 'JSONB'>>`; the only accepted value is `'JSONB'` (spec D7). A key absent from `keys` or another value is `SQLiteError('INVALID_OPTION')`, thrown at the `bulkWrite()` call.
- `output()` treats a column as JSONB when its type, trimmed, equals `JSONB` case-insensitively; `'JSONB(10)'` does not.
- No new error code (spec D8). Native `TypeError`/`RangeError` from `JSON.stringify` or `toISOString` propagate from `enqueue()` unchanged.
- With no `types`, the generated SQL must be byte-identical to today's (`(?,?,?),(?,?,?)…`): the statement cache keys on it.
- Serena symbolic tools are PRIMARY for code (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`); built-in Read/Edit on code files only when Serena fails. Read/Edit are fine for `.md`.
- After every modification: `pnpm check`. Before every commit: `pnpm exec tsc --noEmit`.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. If a hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- Check `git branch --show-current` is `feat/bulk-object-values` before every commit: other sessions switch the shared checkout.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Comments state the fact in one or two lines; no debate, no history.
- English in code, comments, docs and commits.

## Review Focus

- A `toJSON()` that returns `undefined` — `JSON.stringify` returns `undefined`, the cell must bind as `NULL`, not the string `"undefined"` (Task 1 test).
- An invalid `Date` in a JSONB column — `JSON.stringify` gives `'null'`, the cell becomes JSON `null`, no throw; in an ordinary column it throws `RangeError` (Task 1 tests).
- A misspelt key in `types` from TypeScript — `KEYS` must be inferred from `keys` alone, so the typo is a compile error, not a widened `KEYS` (Task 2, `@ts-expect-error`).
- A row whose conversion throws — the row is not buffered, earlier rows still land, the writer stays usable (Task 2 test).
- A number in a JSONB column — `jsonb(5)` is a JSONB number, readable through `json()` as `5` (Task 2 browser test).

---

### Task 1: The conversion module

**Files:**
- Create: `src/values.ts`
- Test: `tests/unit/values.test.ts`

**Interfaces:**
- Produces:
  - `toSQLiteDate(date: Date): string`
  - `toBindable(value: unknown, jsonb: boolean): unknown`
  - `jsonbColumns(keys: readonly string[], types: Readonly<Record<string, unknown>> | undefined): boolean[]` — one flag per key, in `keys` order; throws `SQLiteError('INVALID_OPTION')`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/values.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/types/errors';
import { jsonbColumns, toBindable, toSQLiteDate } from '../../src/values';

const instant = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));

describe('toSQLiteDate', () => {
  it('formats in UTC with milliseconds, as strftime %f does', () => {
    expect(toSQLiteDate(instant)).toBe('2026-10-06 12:34:56.789');
    expect(toSQLiteDate(new Date(Date.UTC(2026, 0, 1)))).toBe(
      '2026-01-01 00:00:00.000',
    );
  });

  it('throws RangeError on an invalid Date', () => {
    expect(() => toSQLiteDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('toBindable, ordinary column', () => {
  it('passes primitives and Uint8Array through', () => {
    const bytes = Uint8Array.of(1, 2, 44);
    for (const v of ['s', 1, 1.5, 10n, true, false, null, undefined, bytes]) {
      expect(toBindable(v, false)).toBe(v);
    }
  });

  it('stringifies objects and arrays', () => {
    expect(toBindable({ a: 1, b: [true, null] }, false)).toBe(
      '{"a":1,"b":[true,null]}',
    );
    expect(toBindable([1, 2, 300], false)).toBe('[1,2,300]');
    expect(toBindable(new Map([['a', 1]]), false)).toBe('{}');
    expect(toBindable({ toJSON: () => 'x' }, false)).toBe('"x"');
  });

  it('binds a Date in SQLite format, and a nested Date as JSON does', () => {
    expect(toBindable(instant, false)).toBe('2026-10-06 12:34:56.789');
    expect(toBindable({ at: instant }, false)).toBe(
      '{"at":"2026-10-06T12:34:56.789Z"}',
    );
  });

  it('binds undefined when toJSON returns undefined', () => {
    expect(toBindable({ toJSON: () => undefined }, false)).toBeUndefined();
  });

  it('lets JSON.stringify and toISOString throw', () => {
    expect(() => toBindable({ n: 1n }, false)).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => toBindable(cycle, false)).toThrow(TypeError);
    expect(() => toBindable(new Date(Number.NaN), false)).toThrow(RangeError);
  });
});

describe('toBindable, JSONB column', () => {
  it('passes strings, numbers, bigint, null, undefined and Uint8Array through', () => {
    const bytes = Uint8Array.of(1);
    for (const v of ['{"a":1}', 5, 10n, null, undefined, bytes]) {
      expect(toBindable(v, true)).toBe(v);
    }
  });

  it('stringifies booleans, Dates, objects and arrays', () => {
    expect(toBindable(true, true)).toBe('true');
    expect(toBindable(false, true)).toBe('false');
    expect(toBindable(instant, true)).toBe('"2026-10-06T12:34:56.789Z"');
    expect(toBindable(new Date(Number.NaN), true)).toBe('null');
    expect(toBindable({ a: [1] }, true)).toBe('{"a":[1]}');
  });
});

describe('jsonbColumns', () => {
  it('flags the JSONB columns in keys order', () => {
    expect(jsonbColumns(['a', 'b', 'c'], { c: 'JSONB', a: 'JSONB' })).toEqual([
      true,
      false,
      true,
    ]);
    expect(jsonbColumns(['a'], undefined)).toEqual([false]);
    expect(jsonbColumns(['a'], { a: undefined })).toEqual([false]);
  });

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof SQLiteError ? e.code : e;
    }
    return 'no throw';
  };

  it('refuses a key that is not a column', () => {
    expect(codeOf(() => jsonbColumns(['a'], { b: 'JSONB' }))).toBe(
      'INVALID_OPTION',
    );
  });

  it('refuses a type other than JSONB', () => {
    expect(codeOf(() => jsonbColumns(['a'], { a: 'jsonb' }))).toBe(
      'INVALID_OPTION',
    );
    expect(codeOf(() => jsonbColumns(['a'], { a: 'TEXT' }))).toBe(
      'INVALID_OPTION',
    );
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec rstest --project unit tests/unit/values.test.ts`
Expected: FAIL — cannot resolve `../../src/values`.

- [ ] **Step 3: Implement** — `src/values.ts`:

```ts
import { SQLiteError } from './types/errors';

/**
 * How `bulkWrite()` and `output()` turn a cell into a value wa-sqlite binds
 * faithfully: its `bind` stores any other object as NULL and an Array as bytes.
 */

/** `YYYY-MM-DD HH:MM:SS.SSS` in UTC, what `strftime('%Y-%m-%d %H:%M:%f')` gives. */
export const toSQLiteDate = (date: Date): string =>
  date.toISOString().replace('T', ' ').slice(0, -1);

/**
 * A primitive or a Uint8Array is bound as given; a JSONB column takes JSON
 * text, so its booleans and Dates go through `JSON.stringify` too.
 */
export const toBindable = (value: unknown, jsonb: boolean): unknown => {
  if (typeof value === 'boolean') return jsonb ? JSON.stringify(value) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date && !jsonb) return toSQLiteDate(value);
  return JSON.stringify(value);
};

/** One flag per key, in `keys` order: whether the column takes `jsonb(?)`. */
export const jsonbColumns = (
  keys: readonly string[],
  types: Readonly<Record<string, unknown>> | undefined,
): boolean[] => {
  for (const [key, type] of Object.entries(types ?? {})) {
    if (type === undefined) continue;
    if (!keys.includes(key))
      throw new SQLiteError(
        'INVALID_OPTION',
        `types names "${key}", which is not one of the columns: ${keys.map((k) => `"${k}"`).join(', ')}.`,
      );
    if (type !== 'JSONB')
      throw new SQLiteError(
        'INVALID_OPTION',
        `types gives "${key}" the type ${JSON.stringify(type)}; the only type supported is 'JSONB'.`,
      );
  }
  return keys.map((key) => types?.[key] === 'JSONB');
};
```

Check the `SQLiteError` constructor signature with `find_symbol SQLiteError/constructor` in `src/types/errors.ts` before relying on `(code, message)`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec rstest --project unit tests/unit/values.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git branch --show-current   # feat/bulk-object-values
git add src/values.ts tests/unit/values.test.ts
git commit -m "feat(bulk): conversion of cells to bindable values" -m "wa-sqlite binds an unknown object as NULL and an Array as bytes; this is the rule bulkWrite and output will apply before it does." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `bulkWrite()` converts its rows and takes `types`

**Files:**
- Modify: `src/api.ts` — `SQLiteBulkWriteOptions` (~line 158), `SQLiteQueryAPI.bulkWrite` (~line 343) and its JSDoc
- Modify: `src/bulk.ts` — `createBulk/<function>/bulkWrite` (lines 137-310, 1-based)
- Test: `tests/unit/bulk.test.ts`, `tests/browser/bulk-write.test.ts`

**Interfaces:**
- Consumes: `toBindable`, `jsonbColumns` from Task 1.
- Produces: `SQLiteBulkWriteOptions<KEYS extends string = string>` with `types?: Partial<Record<NoInfer<KEYS>, 'JSONB'>> | undefined`; the internal `bulkWrite(table, keys, options, before)` accepts `types` in `options` (Task 3 passes it).

- [ ] **Step 1: Write the failing unit tests** — append to `tests/unit/bulk.test.ts`. The existing `recorder` drops params, so this block has its own:

```ts
describe('bulkWrite values and types', () => {
  const capture = () => {
    const calls: { sql: string; params: unknown[] | undefined }[] = [];
    const write = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { result: [] as unknown[], affected: params?.length ?? 0 };
    };
    const read = async () => [] as unknown[];
    const transaction = async <T>(cb: (db: any) => Promise<T>) =>
      cb({ write, read });
    const target = createBulk({
      file: 'app.db',
      vfs: 'OPFSAdaptiveVFS',
      locks: noOpLocks,
      logger: noopLogger,
    })({ read, write, transaction });
    return { calls, target };
  };

  it('keeps the SQL of a load without types byte-identical', async () => {
    const { calls, target } = capture();
    const bulk = target.bulkWrite('t', ['a', 'b']);
    bulk.enqueue({ a: 1, b: 'x' });
    bulk.enqueue({ a: 2, b: 'y' });
    await bulk.close();
    expect(calls[0].sql).toBe('INSERT INTO "t" ("a","b") VALUES (?,?),(?,?)');
    expect(calls[0].params).toEqual([1, 'x', 2, 'y']);
  });

  it('converts objects, arrays and Dates in enqueue order', async () => {
    const { calls, target } = capture();
    const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));
    const bulk = target.bulkWrite('t', ['o', 'l', 'd']);
    bulk.enqueue({ o: { a: 1 }, l: [1, 2, 300], d: at });
    await bulk.close();
    expect(calls[0].params).toEqual([
      '{"a":1}',
      '[1,2,300]',
      '2026-10-06 12:34:56.789',
    ]);
  });

  it('wraps a JSONB column in jsonb(?) on every row', async () => {
    const { calls, target } = capture();
    const bulk = target.bulkWrite('t', ['id', 'doc'], {
      types: { doc: 'JSONB' },
    });
    bulk.enqueue({ id: 1, doc: { a: 1 } });
    bulk.enqueue({ id: 2, doc: null });
    await bulk.close();
    expect(calls[0].sql).toBe(
      'INSERT INTO "t" ("id","doc") VALUES (?,jsonb(?)),(?,jsonb(?))',
    );
    expect(calls[0].params).toEqual([1, '{"a":1}', 2, null]);
  });

  it('refuses a bad types at the call, before any write', () => {
    const { calls, target } = capture();
    let error: unknown;
    try {
      target.bulkWrite('t', ['a'], { types: { b: 'JSONB' } as any });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'INVALID_OPTION' });
    expect(calls).toHaveLength(0);
  });

  it('does not buffer a row whose conversion throws', async () => {
    const { calls, target } = capture();
    const bulk = target.bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    expect(() => bulk.enqueue({ a: { n: 1n } })).toThrow(TypeError);
    bulk.enqueue({ a: 2 });
    expect(await bulk.close()).toBe(2);
    expect(calls[0].params).toEqual([1, 2]);
  });

  it('does not mutate the row it is given', async () => {
    const { target } = capture();
    const row = { a: { x: 1 } };
    const bulk = target.bulkWrite('t', ['a']);
    bulk.enqueue(row);
    await bulk.close();
    expect(row).toEqual({ a: { x: 1 } });
  });

  it('infers KEYS from keys alone, so a misspelt types key does not compile', () => {
    const { target } = capture();
    const make = () =>
      // @ts-expect-error 'dco' is not one of the keys
      target.bulkWrite('t', ['id', 'doc'], { types: { dco: 'JSONB' } });
    expect(make).toThrow();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec rstest --project unit tests/unit/bulk.test.ts`
Expected: the conversion and `types` tests FAIL (objects reach params unconverted; `jsonb(?)` absent; no `INVALID_OPTION`). The byte-identical test passes already — it pins the cache key.

- [ ] **Step 3: Implement the type** — in `src/api.ts`, replace `SQLiteBulkWriteOptions` and the `bulkWrite` member's options parameter:

```ts
export type SQLiteBulkWriteOptions<KEYS extends string = string> =
  Interruptible<{
    /** Rows queued for writing above which `enqueue()` defers. */
    queueSize?: number | undefined;
    /** Columns stored as JSONB: each receives `jsonb(?)` on every row. */
    types?: Partial<Record<NoInfer<KEYS>, 'JSONB'>> | undefined;
  }>;
```

```ts
  bulkWrite: <KEYS extends string>(
    table: string,
    keys: KEYS[],
    options?: SQLiteBulkWriteOptions<KEYS>,
  ) => SQLiteBulkWriter<KEYS>;
```

In the `bulkWrite` JSDoc, extend `@param options` with one sentence: `` `types` declares JSONB columns. `` and add to `@remarks`: `` An object or an array is stored as `JSON.stringify` text, a `Date` as `YYYY-MM-DD HH:MM:SS.SSS` in UTC, a `Uint8Array` as a BLOB. ``

- [ ] **Step 4: Implement the conversion** — in `src/bulk.ts`, import `{ jsonbColumns, toBindable } from './values'`, then in `bulkWrite`:
  1. Change the options parameter type to `SQLiteBulkWriteOptions<KEYS>`.
  2. As the FIRST statement of the body, before `withDeadline` (a throw after it would leave the deadline timer armed):
     ```ts
     const jsonb = jsonbColumns(keys, options?.types);
     const rowTemplate = `(${keys.map((_, i) => (jsonb[i] ? 'jsonb(?)' : '?')).join(',')})`;
     ```
  3. `const buffer: { [K in KEYS]: any }[] = [];` becomes `const buffer: unknown[][] = [];`.
  4. In `runBatch`, the `write` call becomes:
     ```ts
     const { affected } = await write(
       `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES ${toInsert.map(() => rowTemplate).join(',')}`,
       toInsert.flat(),
       { signal },
     );
     ```
  5. In `enqueue`, replace `buffer.push(data);` with:
     ```ts
     // Converted before it is buffered: a value that cannot be leaves the buffer as it was.
     buffer.push(keys.map((k, i) => toBindable(data[k], jsonb[i])));
     ```
  Use `replace_content` for steps 3-5 (a few lines inside a large symbol).

- [ ] **Step 5: Run the unit project**

Run: `pnpm test:unit`
Expected: PASS, every file.

- [ ] **Step 6: Write the browser tests** — append to `tests/browser/bulk-write.test.ts`:

```ts
describe('bulkWrite() values', () => {
  const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));

  it('stores objects and arrays as JSON text and a Uint8Array as a BLOB', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE bulk_json (doc TEXT, list TEXT, bytes BLOB)');
    const bulk = db.bulkWrite('bulk_json', ['doc', 'list', 'bytes']);
    bulk.enqueue({
      doc: { a: 1, b: [true, null] },
      list: [1, 2, 300],
      bytes: Uint8Array.of(1, 2, 44),
    });
    await bulk.close();
    const [row] = await db.read<Record<string, unknown>>(
      'SELECT doc, list, typeof(list) AS lt, typeof(bytes) AS bt, hex(bytes) AS bh FROM bulk_json',
    );
    expect(row).toEqual({
      doc: '{"a":1,"b":[true,null]}',
      list: '[1,2,300]',
      lt: 'text',
      bt: 'blob',
      bh: '01022C',
    });
    db.close();
  });

  it('stores a Date in the format SQLite produces', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE bulk_date (at TEXT)');
    const bulk = db.bulkWrite('bulk_date', ['at']);
    bulk.enqueue({ at });
    await bulk.close();
    const [row] = await db.read<{ at: string; same: number }>(
      "SELECT at, at = strftime('%Y-%m-%d %H:%M:%f', '2026-10-06T12:34:56.789Z') AS same FROM bulk_date",
    );
    expect(row).toEqual({ at: '2026-10-06 12:34:56.789', same: 1 });
    db.close();
  });

  it('stores a JSONB column through jsonb()', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE bulk_jsonb (id INTEGER, doc BLOB)');
    const bulk = db.bulkWrite('bulk_jsonb', ['id', 'doc'], {
      types: { doc: 'JSONB' },
    });
    bulk.enqueue({ id: 1, doc: { a: 1 } });
    bulk.enqueue({ id: 2, doc: '{"b":2}' });
    bulk.enqueue({ id: 3, doc: null });
    bulk.enqueue({ id: 4, doc: true });
    bulk.enqueue({ id: 5, doc: at });
    bulk.enqueue({ id: 6, doc: 5 });
    await bulk.close();
    const rows = await db.read<{ t: string; j: string | null }>(
      'SELECT typeof(doc) AS t, json(doc) AS j FROM bulk_jsonb ORDER BY id',
    );
    expect(rows).toEqual([
      { t: 'blob', j: '{"a":1}' },
      { t: 'blob', j: '{"b":2}' },
      { t: 'null', j: null },
      { t: 'blob', j: 'true' },
      { t: 'blob', j: '"2026-10-06T12:34:56.789Z"' },
      { t: 'blob', j: '5' },
    ]);
    db.close();
  });

  it('fails the batch on a string that is not JSON in a JSONB column', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE bulk_jsonb_bad (doc BLOB)');
    const bulk = db.bulkWrite('bulk_jsonb_bad', ['doc'], {
      types: { doc: 'JSONB' },
    });
    bulk.enqueue({ doc: 'abc' });
    await expect(bulk.close()).rejects.toMatchObject({
      code: 'BULK_WRITE_FAILED',
      rowsNotWritten: 1,
    });
    db.close();
  });
});
```

If `typeof(5)` stored through `jsonb(5)` reads back as something other than `blob`, stop and report: the spec's § 2 row for numbers rests on it.

- [ ] **Step 7: Run the browser file**

Run: `node scripts/bounded.ts 900 rstest --project 'chromium*' tests/browser/bulk-write.test.ts && node scripts/bounded.ts 900 rstest --config rstest.firefox.config.ts tests/browser/bulk-write.test.ts`
Expected: PASS on both engines.

- [ ] **Step 8: Check and commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git branch --show-current   # feat/bulk-object-values
git add src/api.ts src/bulk.ts tests/unit/bulk.test.ts tests/browser/bulk-write.test.ts
git commit -m "feat(bulk)!: bulkWrite stores objects as JSON and takes JSONB columns" -m "An object reached wa-sqlite's bind and was stored as NULL, an array as truncated bytes, both without an error. Rows are now converted in enqueue(), so a value that cannot be is refused by the call that passed it, and types declares JSONB columns so the SQL stays fixed and the statement cache keeps working." -m "BREAKING CHANGE: an array is stored as JSON text, no longer as a BLOB; pass a Uint8Array for bytes." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `output()` reads JSONB columns from its schema

**Files:**
- Modify: `src/bulk.ts` — `createBulk/<function>/output` (lines 402-513, 1-based)
- Modify: `src/api.ts` — `output` member JSDoc (~line 351)
- Test: `tests/unit/bulk.test.ts`, `tests/browser/output.test.ts`

**Interfaces:**
- Consumes: the internal `bulkWrite(table, keys, { signal, queueSize, types }, before)` from Task 2.

- [ ] **Step 1: Write the failing unit test** — inside the `describe('bulkWrite values and types')` block of Task 2 (it reuses `capture`):

```ts
  it('output() wraps a schema JSONB column, any case, and skips generated ones', async () => {
    const { calls, target } = capture();
    const out = target.output('t', {
      id: 'INTEGER',
      doc: ' jsonb ',
      sized: 'JSONB(10)',
      g: { type: 'JSONB', generated: '(json_object())' },
    });
    out.enqueue({ id: 1, doc: { a: 1 }, sized: { b: 2 } });
    await out.close();
    const insert = calls.find((c) => c.sql.startsWith('INSERT'));
    expect(insert?.sql).toMatch(/\("id","doc","sized"\) VALUES \(\?,jsonb\(\?\),\?\)$/);
    expect(insert?.params).toEqual([1, '{"a":1}', '{"b":2}']);
  });
```

`' jsonb '` must pass `assertColumnType` (it trims); if it does not, use `'jsonb'` and keep `' jsonb '` out of the test.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec rstest --project unit tests/unit/bulk.test.ts`
Expected: FAIL — `doc` gets `?`.

- [ ] **Step 3: Implement** — in `output`, after `normalizedSchema`:

```ts
      const types = Object.fromEntries(
        normalizedSchema
          .filter(({ type, generated }) => !generated && type.toUpperCase() === 'JSONB')
          .map(({ name }) => [name, 'JSONB' as const]),
      );
```

and pass it: `{ signal, queueSize: options?.queueSize, types }` in the internal `bulkWrite(...)` call. `assertColumnType` already returns the trimmed type.

In the `output` JSDoc `@param schema`, add: `` A column typed `JSONB` (any case) is stored through `jsonb(?)`. ``

- [ ] **Step 4: Write the browser test** — append to `tests/browser/output.test.ts`:

```ts
describe('output() values', () => {
  it('stores a JSONB schema column through jsonb() and an object elsewhere as JSON text', async () => {
    const db = await createTestClient();
    const out = db.output('out_json', { id: 'INTEGER', doc: 'JSONB', raw: 'TEXT' });
    out.enqueue({ id: 1, doc: { a: [1] }, raw: { b: 2 } });
    await out.close();
    const [row] = await db.read<Record<string, unknown>>(
      'SELECT typeof(doc) AS t, json(doc) AS j, raw FROM out_json',
    );
    expect(row).toEqual({ t: 'blob', j: '{"a":[1]}', raw: '{"b":2}' });
    db.close();
  });
});
```

- [ ] **Step 5: Run unit and browser**

Run: `pnpm test:unit && node scripts/bounded.ts 900 rstest --project 'chromium*' tests/browser/output.test.ts && node scripts/bounded.ts 900 rstest --config rstest.firefox.config.ts tests/browser/output.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git branch --show-current   # feat/bulk-object-values
git add src/api.ts src/bulk.ts tests/unit/bulk.test.ts tests/browser/output.test.ts
git commit -m "feat(output): a JSONB schema column is stored through jsonb()" -m "The schema already declares each column's type, so output() needs no option of its own to store JSONB." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation and changelog

**Files:**
- Modify: `API.md` — `## *client*.bulkWrite` (~line 287), `## *client*.output` (~line 316), the error table's `INVALID_OPTION` row (~line 552)
- Modify: `CHANGELOG.md` — `## [Unreleased]`, through the `changelog-maintenance` skill

Consumer documentation rules (`mem:conventions`, "Writing for the consumer"): a bold lead that is a whole sentence then `<br>` on the same line; one table line per option with a `[More info](#…)` link to a `####` subsection; no measured figures; no mechanism the consumer cannot act on; long lines, no hard wrap.

- [ ] **Step 1: `bulkWrite` option row** — add to its option table:

```markdown
| `types` | `{ [column]: 'JSONB' }` | — | Columns stored as JSONB. [More info](#how-values-are-stored) |
```

- [ ] **Step 2: `#### How values are stored`** — insert under `## *client*.bulkWrite`, after its last paragraph:

```markdown
#### How values are stored

| Value | Column | `JSONB` column |
|---|---|---|
| string, number, bigint, `null` | as given | as given; a string is read as JSON text |
| boolean | `1` / `0` | `true` / `false` |
| `Uint8Array` | BLOB | read as JSONB already encoded |
| `Date` | `YYYY-MM-DD HH:MM:SS.SSS`, UTC | JSON string, `"YYYY-MM-DDTHH:MM:SS.SSSZ"` |
| any other object, arrays included | `JSON.stringify` text | `JSON.stringify` |

**Objects follow `JSON.stringify`'s rules, at every depth.**<br>A `Map` or a `Set` gives `{}`, a class instance its own properties or its `toJSON()`, and a nested `Date` its ISO string. A value it refuses — a nested `bigint`, a cycle — makes `enqueue()` throw, and that row is not queued.

**An array is stored as JSON.**<br>Pass a `Uint8Array` to store bytes.

**A `Date` is stored in SQLite's own format, so it compares as text with SQLite's dates.**<br>`datetime('now', 'subsec')` gives the same shape. `CURRENT_TIMESTAMP` has no milliseconds: `'2026-10-06 12:34:56.000'` sorts after `'2026-10-06 12:34:56'`, the same instant.

**A `JSONB` column takes valid JSON.**<br>Declare it with `types: { doc: 'JSONB' }`; each value is stored through `jsonb()`. A string is read as JSON text, so one that is not valid JSON fails its batch.
```

- [ ] **Step 3: `output` section** — add one paragraph after its first paragraph block (before "The target is replaced atomically"):

```markdown
**Values are stored as in [`bulkWrite()`](#how-values-are-stored).**<br>A column whose type is `JSONB` is a JSONB column; no option is needed.
```

- [ ] **Step 4: Error table** — in the `INVALID_OPTION` row, add before "or `inspectDatabase` on a memory VFS": `` a `bulkWrite()` `types` naming a column it does not write or a type other than `'JSONB'`, ``.

- [ ] **Step 5: Changelog** — invoke the `changelog-maintenance` skill with these three entries for `## [Unreleased]`:
  - `Changed`, first: `**Breaking:** \`bulkWrite()\` and \`output()\` store an array as JSON text instead of a BLOB of its elements; pass a \`Uint8Array\` to store bytes.`
  - `Added`: `` `bulkWrite()` takes `types` to store columns as JSONB, and `output()` stores a column typed `JSONB` the same way. ``
  - `Fixed`: `` `bulkWrite()` and `output()` no longer store an object as `NULL`: an object is stored as JSON text and a `Date` as `YYYY-MM-DD HH:MM:SS.SSS`. ``

- [ ] **Step 6: Commit** (the user edits consumer docs iteratively; show the diff first and commit once they accept)

```bash
git branch --show-current   # feat/bulk-object-values
git add API.md CHANGELOG.md
git commit -m "docs: how bulkWrite and output store values" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Measure the overhead (at delivery, by the controller)

The user asked for it. Before/after on the same machine, same session, both engines; progress reported every two minutes while it runs.

- [ ] **Step 1: Baseline tree** — `git worktree add .work/bulk-baseline main && ln -s /workspaces/wsqlite/node_modules .work/bulk-baseline/node_modules`.

- [ ] **Step 2: The probe** — one browser test file, `.scratchpad/bulk-overhead-2026-10-06/bulk-overhead.test.ts`, copied into `tests/browser/` of each tree for the run and removed after (never committed). Workloads, each 7 runs after 1 warm-up, median and spread reported:
  - **W1** `bulkWrite` 100 000 rows × 5 scalar columns (`id`, `label`, `n`, `x`, `flag`), outside a transaction — the WL2 shape of `mem:measurements/statement-cache-and-perf`;
  - **W2** the same inside `db.transaction()` — commit noise removed, the clearest reading of the per-row cost;
  - **W3** (branch only) W2 with one object column (`{ id, tags: [..3], meta: { score, active } }`) — what serialising costs;
  - **W4** (branch only) W3 with that column declared `types: { meta: 'JSONB' }`.

- [ ] **Step 3: Run** — in each tree: `node scripts/bounded.ts 900 rstest --project 'chromium*' tests/browser/bulk-overhead.test.ts` and the Firefox config, output to `.scratchpad/bulk-overhead-2026-10-06/<tree>-<engine>.log`.

- [ ] **Step 4: Report and record** — the table to the user; the figures to `mem:measurements` (Serena `edit_memory`) with the workload definitions. Remove the worktree: `git worktree remove .work/bulk-baseline`.

---

### Closing (the user's call)

Format, lint, typecheck and `pnpm test` green — all three reports read; Serena memories updated (`mem:state`, `mem:history/2026-10`, `mem:measurements`); then `git merge --no-ff` into `main` and the branch deleted, when the user says so.
