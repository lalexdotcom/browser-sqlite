# Objects, dates and JSONB in `bulkWrite()` and `output()` — design

**Date:** 2026-10-06 · **Status:** approved in chat section by section, spec under review · **Target:** `## [Unreleased]` · **Branch:** `feat/bulk-object-values`

Today `bulkWrite()` and `output()` hand every cell to wa-sqlite's `sqlite3.bind` untouched. That function binds a plain object, a `Date`, a `Map` or any other non-`Uint8Array` object as `NULL` with a `console.warn` in the worker, and binds an `Array` as a BLOB whose bytes are each element coerced to a `uint8` (`[1, 2, 300]` → `01 02 2C`). An object is lost without an error; an array is corrupted without one. This design gives both methods a defined conversion for every value, and a way to store JSONB.

---

## 1. Decisions (user, 2026-10-06)

- **D1 — Scope: `bulkWrite()` and `output()` only.** `query()`, `write()` and the other methods that take parameters keep binding as they do. Their counterpart is a separate future feature, template queries (§ 7).
- **D2 — Objects are serialised with `JSON.stringify` by default, with no option.** Every object that is not a `Uint8Array` or a `Date` is bound as `JSON.stringify(value)`, at the top level as at any depth. No check is made on the prototype: a `Map` or a `Set` gives `{}`, a class instance gives its own enumerable properties or its `toJSON()`. A top-level check was measured at ~10 ns per object and a check at every depth (a `replacer`) at 3.3× the cost of the serialisation; neither was kept, so the top level follows the same rules as the nested values.
- **D3 — Arrays follow objects.** An array is bound as JSON text, not as a BLOB. **This is breaking**: a `number[]` meant as bytes must become a `Uint8Array`. No `arrayMode` option: with JSONB columns it would have needed its own `'jsonb'` value, and the BLOB path only preserved a truncation hazard nothing in this library relies on or documents.
- **D4 — A top-level `Date` is bound in SQLite's own format**, `YYYY-MM-DD HH:MM:SS.SSS` in UTC — what `datetime('now', 'subsec')` and `strftime('%Y-%m-%d %H:%M:%f')` produce. The milliseconds are always present, so every such date has the same length and sorts as text. Chosen over `toISOString()` so that a text comparison with SQLite's own dates is right: `'2026-10-06T01:00:00.000Z' > '2026-10-06 23:00:00'` is true. Inside a JSON value a `Date` stays what `JSON.stringify` makes of it (`toJSON()`, ISO with `Z`): there it is known to be JSON.
- **D5 — JSONB is a column declaration, never a value inspection.** `bulkWrite()` takes `types: Partial<Record<KEYS, 'JSONB'>>`; `output()` reads it from the schema, a column whose type is `JSONB` once trimmed and compared case-insensitively. A JSONB column gets `jsonb(?)` on every row, so the generated SQL depends only on the row count, as today, and the statement cache — sized for `bulkWrite` (`client.ts`, 8 MB for three concurrent writers) — keeps working. Inspecting each batch to decide was designed and dropped: a nullable JSON column with a batch of only `NULL`s, or a column mixing objects and strings, would vary the SQL and cancel the cache.
- **D6 — A JSONB column takes valid JSON.** Its values are converted by JSON's rules, not by the ordinary column's (§ 2): a string is read as JSON text, and one that is not valid JSON fails the batch.
- **D7 — `types` accepts only `'JSONB'` for now.** `'JSON'` would change nothing against the default. Other values — conversions such as `string → number` — are a later evolution (§ 7).
- **D8 — No new error code.** A value `JSON.stringify` refuses (a nested `bigint`, a cycle) or an invalid `Date` in an ordinary column (in a JSONB column `JSON.stringify` stores it as JSON `null`, as § 2 says) throws the engine's own `TypeError` or `RangeError` from `enqueue()`. A malformed `types` is `INVALID_OPTION`.
- **D9 — The changelog carries three entries:** `Fixed` (an object is no longer stored as `NULL`), `Added` (`types` and JSONB columns), `Changed` with `**Breaking:**` first (arrays are stored as JSON, migration to `Uint8Array`).

## 2. How a value is bound

| Value | Ordinary column (`?`) | JSONB column (`jsonb(?)`) |
|---|---|---|
| `string` | unchanged | unchanged, read by SQLite as JSON text |
| `number`, `bigint` | unchanged | unchanged, SQLite makes a JSONB number |
| `boolean` | unchanged (`1` / `0`) | `JSON.stringify` → `true` / `false` |
| `null`, `undefined` | unchanged (`NULL`) | unchanged (`jsonb(NULL)` is `NULL`) |
| `Uint8Array` | unchanged (BLOB) | unchanged, read by SQLite as JSONB already encoded |
| `Date` | `YYYY-MM-DD HH:MM:SS.SSS` (UTC) | `JSON.stringify` → `"YYYY-MM-DDTHH:MM:SS.SSSZ"` |
| any other object, arrays included | `JSON.stringify` | `JSON.stringify` |

"Unchanged" means the value reaches wa-sqlite's `bind` as it does today. A boolean in a JSONB column is stringified because `jsonb(1)` is the number `1`, not `true`. A `Date` in a JSONB column is stringified because its SQLite format is not valid JSON. The SQLite date format is derived from `toISOString()` (`T` → space, `Z` dropped), so an invalid `Date` throws `toISOString`'s `RangeError`.

## 3. The public API

```ts
// src/api.ts
export type SQLiteBulkWriteOptions<KEYS extends string = string> = Interruptible<{
  queueSize?: number | undefined;
  /** Columns stored as JSONB: each receives `jsonb(?)`. */
  types?: Partial<Record<KEYS, 'JSONB'>> | undefined;
}>;

bulkWrite: <KEYS extends string>(
  table: string,
  keys: KEYS[],
  options?: SQLiteBulkWriteOptions<KEYS>,
) => …;
```

`output()`'s signature does not change: its `Schema` already carries the type. `SQLiteOutputOptions` gains nothing.

`types` is validated when `bulkWrite()` is called, before any row: a key absent from `keys`, or a value other than `'JSONB'`, throws `SQLiteError('INVALID_OPTION')`. TypeScript already refuses both; the check is for JavaScript callers.

## 4. Implementation

- **A pure conversion module**, `src/values.ts`: `toBindable(value, jsonb: boolean)` applies § 2, and `toSQLiteDate(date)` produces D4's format. No dependency on the client, so it is unit-tested alone.
- **`bulkWrite()` converts in `enqueue()`, not at flush.** An error belongs to the row that caused it, raised synchronously from the call that passed it, rather than to a later batch or to `close()`. The row does not enter the buffer, and the rows already buffered are untouched. The buffer holds arrays of converted values in `keys` order; the caller's object is never mutated, and the flush's `flatMap` becomes a plain flatten.
- **The row template is built once**, when `bulkWrite()` is called: `(?,?,jsonb(?))` from `keys` and `types`. The flush repeats it per row, as it repeats `(?,?,?)` today.
- **`output()` derives `types` from its schema** and passes it to the internal `bulkWrite()`. A generated column is not in `keys`, so it is excluded without a case of its own.

## 5. Tests

- **Unit** (`tests/unit/`): `toBindable` for every row of § 2 in both columns, `toSQLiteDate` on a known instant, an invalid `Date`, a nested `bigint`.
- **Browser** (`tests/browser/bulk-write.test.ts` and `output()`'s tests): an object and an array read back as JSON text; a `Uint8Array` still read as a BLOB; a top-level `Date` read back in D4's format; a `types` JSONB column with `typeof(col) = 'blob'` and `json(col)` equal to the input; a string that is not valid JSON failing the batch with `SQLiteBulkWriteError`; `INVALID_OPTION` for an unknown key; a schema `JSONB` column in `output()`.
- `pnpm test` covers it: the change touches neither the pool nor the worker, so the full matrix is not due (`mem:conventions`).
- **Measurement:** the existing `bulkWrite` bench, before and after, on rows of scalars only, to confirm in a browser that the per-cell check in `enqueue()` costs nothing (in Node the difference is within noise: 37.6 ms vs 32.7 ms for 1 M rows of 5 scalars).

## 6. Documentation

- **`API.md`**, under `bulkWrite()` and `output()`: the table of § 2; the `Date` format and its one limit against `CURRENT_TIMESTAMP`, which has no milliseconds (`'… 12:34:56.000'` sorts after `'… 12:34:56'`, the same instant); `types` and the `JSONB` schema type; nested values follow `JSON.stringify`'s rules (a `Map` gives `{}`).
- **`CHANGELOG.md`**, through the `changelog-maintenance` skill: D9's three entries, the array migration in the `Changed` entry.

## 7. Out of scope

- **Template queries** for the other methods: `` sql`SELECT … WHERE id = ${o}` `` with JSON text, and a JSONB variant whose form is open (`` sql('jsonb')`…` ``, `` jsonb`…` ``). Recorded in `mem:follow-ups`.
- **Other `types` values**, such as a cast from `string` to `number`. Recorded in `mem:follow-ups`.
