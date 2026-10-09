# The `sql` template tag — design

**Date:** 2026-10-08 · **Status:** approved in chat, spec under review · **Target:** `## [Unreleased]` · **Branch:** `feat/sql-tag`

**Amended 2026-10-09 (user), twice:** an object interpolated more than once is one param (D14). Before that: the tag numbers its placeholders `?1 … ?N` and keeps a fragment's structure (D11, D12), and it scans its template, refusing a hand-written placeholder and a value inside a literal or a comment (D13). Found after delivery: the worker binds the same params from the first value in every statement of a multi-statement string, so the tag's positional `?` gave every statement the first values.

Today a query and its parameters are two arguments kept in step by hand: `db.read('SELECT … WHERE a = ? AND b = ?', [a, b])`. A tagged template writes each value where it is used and builds both. Since the binary protocol (spec 2026-10-07), every parameter already goes through `toBindable` (`src/values.ts`), so an object or an array is bound as JSON text for every method: a plain tag only has to join the template with numbered placeholders and collect the values. What it cannot do alone is JSONB, which needs `jsonb(?)` in the SQL — hence a variant. This closes the "template queries" entry of `mem:follow-ups` and § 7 of spec 2026-10-06.

---

## 1. Decisions (user, 2026-10-08)

- **D1 — Two forms, one export.** `` sql`…` `` and `` sql.jsonb`…` ``; `jsonb` is a property of the tag, as `raw` is of `String`. `jsql` was rejected (it reads "JavaScript SQL" and says nothing of what it does), `jsonbSql` as too long.
- **D2 — The values follow the existing conversion, unchanged.** The tag does not convert anything: every value it collects reaches the method's params and goes through `prepareParams` → `toBindable` like a hand-written param, so an object or an array is JSON text, a `Date` is SQLite's date format, binary is a BLOB (spec 2026-10-06, § 2).
- **D3 — `sql.jsonb` wraps exactly the values the ordinary conversion turns into JSON.** A value gets `jsonb(?)` when `toBindable` would bind it through `JSON.stringify` as an ordinary column: an object that is not binary and not a `Date`, arrays included. Everything else keeps `?`. Strings and booleans in particular keep `?`, unlike a JSONB column of `bulkWrite()`: `` sql.jsonb`… WHERE name = ${name}` `` must compare text with text. Since the wrapped values are exactly those the ordinary conversion stringifies, the value itself needs no JSONB-specific conversion (§ 2).
- **D4 — The methods take the query object as an overload.** `read`, `write`, `chunk`, `stream` and `first` accept `(query: SQLQuery, options?)` beside `(sql, params?, options?)`. Declared once, in `SQLiteQueryAPI`, so the client and the transaction both get it. A spread tuple (`db.read(...sql`…`)`) was rejected: it keeps the signatures but makes the `...` mandatory at every call.
- **D5 — An interpolated `SQLQuery` is inlined as a fragment.** Its text replaces the placeholder, its params take the placeholder's place in order. This is the safe way to compose a dynamic query (an optional `WHERE` clause) without concatenating strings. A `sql.jsonb` fragment keeps its own `jsonb(?)` inside a plain `sql`, and a fragment inside `sql.jsonb` is inlined, never wrapped.
- **D6 — A fragment is recognised by `instanceof` on an internal class, never by its shape.** A user value shaped `{ sql, params }` stays a value (JSON text): treating any such object as a fragment would inline user data into the SQL. The class is not exported as a value; only its type `SQLQuery` is public, as `export type`, so the runtime exports change only by `sql`. A module-private symbol would be as safe; the class was preferred because `instanceof` reads directly and it carries the fields. Two copies of the package in one bundle do not recognise each other's fragments — such a fragment is bound as JSON text, wrong but not unsafe; `Symbol.for` would fix it and let any code forge a fragment, so it is not used.
- **D7 — `sql.raw(text)` is the escape hatch.** It returns a fragment whose SQL is `text` and whose params are empty: nothing is quoted, so it is documented as unsafe with untrusted input. It takes a string only; anything else, a `TemplateStringsArray` from `` sql.raw`…` `` included, is `INVALID_VALUE`.
- **D8 — `sql.id(...parts)` quotes an identifier and returns a fragment.** Each part goes through `quoteIdent` (`src/utils.ts`) and the parts are joined with `.`: `sql.id('main', 'users')` → `"main"."users"`. Variadic rather than `split('.')`: a name containing a dot stays reachable, and a dynamic name can never choose its own schema (`temp.x`) — only the code qualifies it. No part, or a part that is not a non-empty string free of NUL, is `INVALID_IDENTIFIER`. `sql.ident` was judged unclear and `sql.quote` misleading (SQLite's `quote()` quotes a value).
- **D9 — `sql.list(values)` is the list for `IN`, and an array alone never expands.** `` WHERE id IN ${sql.list(ids)} `` — the fragment carries its parentheses. An array interpolated directly stays a JSON value (D2), so `` IN (${ids}) `` cannot be told apart from `` json_each(${ids}) `` or an array stored as JSON; only the helper expands. `sql.in` was rejected (`IN ${sql.in(…)}` repeats itself).
- **D10 — `sql.list` emits `(SELECT value FROM json_each(?))` with one JSON text param, not `(?, ?, ?)`.** One SQL text whatever the list's length, so one statement cache entry and no parameter-count limit; an expansion would cache one statement per length and evict the others from the LRU — the property spec 2026-10-06 D5 protects for `bulkWrite`. An empty list matches nothing. The cost is that elements follow JSON, so the helper converts them itself (§ 2).
- **D11 — Placeholders are numbered, `?1 … ?N`, across the whole composed query (2026-10-09).** The worker binds a query's params to each statement of a multi-statement string from the first value (`run` → `bindBlock`, `src/worker/worker.ts`), so with positional `?` every statement gets the first values. Probed in Chromium the same day: `INSERT INTO a VALUES (?); INSERT INTO b VALUES (?)` with `x, y` stores `x` in both tables, and so did the tag; `?1` / `?2` stores `x` then `y`, and `?2` / `?1` the reverse. A numbered placeholder carries its index in the text, so each statement binds the right value with no change to the worker. Named placeholders were rejected: SQLite numbers them per statement in order of first appearance, so they would need the worker to bind by name — that is the separate "params as an object" follow-up (§ 8). A missing or extra param stays silent, as it is for the string form today (probed: a missing one is `NULL`, an extra one ignored).
- **D12 — A `SQLQuery` keeps its structure: `parts` (N + 1 texts) and `values` (N), internal.** `sql` and `params` are derived from them: `parts[0] ?1 parts[1] ?2 … parts[N]`. A `sql.jsonb` wrap is folded into the texts — the part before the value ends with `jsonb(`, the part after begins with `)` — so every value renders as a bare placeholder. Inlining a fragment joins its first part to the current one and appends the rest of its parts and its values, so the numbering is recomputed over the whole query; a fragment used twice gets new numbers the second time. The helpers fit the same shape: `sql.list` is `['(SELECT value FROM json_each(', '))']` with one value, `sql.raw(t)` is `[t]` with none, `sql.id(…)` one part with the quoted name. The generated text is stable per call site, so the statement cache still serves it.
- **D13 — Every template is scanned (2026-10-09).** A hand-written placeholder — `?`, `?NNN`, or `:`, `@`, `$`, `#` followed by an identifier character at the start of a token (SQLite 3.46 reads `#a` as a parameter too, checked 2026-10-09) — or a value interpolated inside a string literal, a quoted identifier or a comment, is `INVALID_VALUE` at construction. The scan carries its state across the template's parts and skips `'…'` (with `''`), `"…"`, `` `…` ``, `[…]`, `-- …` to the end of the line and `/* … */`, so `'what?'` and `'$.a'` pass and `a$b` is not a placeholder. Its result is cached per `TemplateStringsArray`: a call site hands the same object at every evaluation, so the scan runs once per call site and every later evaluation costs a `WeakMap` lookup. Measured 2026-10-09, Node 24 (V8), 2 M calls × 3 runs, a prototype: per call, plain tag / scan every call / scan cached — 32-character template 22-24 / 101-117 / 46-49 ns, 201 characters 100-103 / 448-465 / 94-98 ns, 2.7 KB 42-44 / 5 900-6 500 / 72-74 ns; a small write costs about 70 µs on Chromium (`mem:measurements`). `sql.raw` text is never scanned, and a fragment was scanned when it was built. A template that ends inside a string, a quoted name or a block comment is refused too, and one that ends inside a line comment gets a newline after it: inlined, either would swallow the text that follows (final review, 2026-10-09). Where two texts are joined as `-` `-` or `/` `*`, a space keeps them from opening a comment, and a placeholder followed by a digit is followed by a space, so `?1` never reads as `?10`.
- **D14 — An object interpolated more than once is one param; a primitive never is (user, 2026-10-09).** While a query is built, a `Map` from object to param index — local to that build, dropped at its end — gives every later occurrence of the same reference the index of its first; `typeof v === 'object'` and not `null`, so arrays, binary and `Date`s included. A large object is then converted (`JSON.stringify`) and sent once, a large `Uint8Array` copied once. Primitives are not grouped: grouping by value would make the text depend on runtime values — `LIMIT ${limit} OFFSET ${offset}` would render `?1 … ?2` or `?1 … ?1` as the two happen to differ or not, one statement cache entry each. By reference, the text stays stable per call site in the usual case, `${doc}` written twice being the same variable twice; it changes only where two different expressions hold the same object, and then costs one more cache entry. One object wrapped in `jsonb(…)` at one place and bare at another is one param: the wrap is in the text. Structure (amends D12): a `SQLQuery` also keeps `slots`, internal — per placeholder, the index of its param — and renders `?{slots[k] + 1}`, so `params` holds each object once, in order of first appearance. Inlining a fragment passes each of its placeholders' values through the parent's `Map`, so an object shared by a fragment and its parent, or by two inlined fragments, is one param too.

## 2. Building a query

`sql(strings, ...values)` walks the template once:

| Interpolated value | Text emitted | Params added |
|---|---|---|
| a `SQLQuery` (fragment) | its parts, renumbered | its values, in order, an object already present reusing its index (D14) |
| under `sql.jsonb`, a value `takesJson(v)` | `jsonb(?N)` | `v` |
| anything else | `?N` | `v` |

`N` is the value's param index in the composed query, from 1 (D11): its position, except for an object already present, which reuses its first index (D14).

`takesJson(v)` lives in `src/values.ts` beside `convert`, and `convert` uses it for its own `JSON.stringify` branch, so the two cannot drift apart: `typeof v === 'object'`, not `null`, not a `Uint8Array` / `ArrayBuffer` / `ArrayBuffer` view / `SharedArrayBuffer`, not a `Date`.

The params are the raw values. Conversion stays where it is today, in `prepareParams` at the method's entry, so an error names the param's final position in the composed query (`param 3`), not its position in one template.

The template's own text is scanned (D13). A template whose part is `undefined` — an invalid escape sequence such as `\x` — is `INVALID_VALUE`, since skipping it would drop part of the SQL.

An array interpolated directly is one JSON text, as `[1, 2]` is as a param today: `` IN (${[1, 2]}) `` silently matches nothing. `API.md` points to `sql.list` where it describes arrays.

### `sql.list(values)`

`values` must be an array, else `INVALID_VALUE`. The helper serialises it to JSON text itself, element by element, so that each element reaches `json_each` as the value it would be as a param:

| Element | Written as | `json_each`'s `value` |
|---|---|---|
| finite `number` | JSON number | integer or real |
| `bigint` in SQLite's 64-bit range | its decimal digits, unquoted | integer, exact |
| `string` | JSON string | text |
| `boolean` | `true` / `false` | `1` / `0` |
| `null`, `undefined` | `null` | `NULL` (matches nothing, as in `IN (NULL)`) |
| `Date` | JSON string of `toSQLiteDate(d)` | text, SQLite's date format, as a `Date` param |
| non-finite `number`, out-of-range `bigint`, invalid `Date`, binary, any other object (a `SQLQuery` included) | — | `INVALID_VALUE`, naming the element's index |

The fragment is `(SELECT value FROM json_each(?N))`. `toSQLiteDate` and the 64-bit bounds are the ones `src/values.ts` already holds, exported for `src/sql.ts`. The fragment's single param is that JSON text, a string, so `prepareParams` binds it as text.

## 3. The public API

```ts
// src/sql.ts
export class SQLQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  // parts and values (D12) are internal, not part of the public type.
}
export const sql: {
  (strings: TemplateStringsArray, ...values: unknown[]): SQLQuery;
  jsonb(strings: TemplateStringsArray, ...values: unknown[]): SQLQuery;
  raw(text: string): SQLQuery;
  id(...parts: [string, ...string[]]): SQLQuery;
  list(values: readonly unknown[]): SQLQuery;
};
```

`src/index.ts` adds `export { sql } from './sql'` and `export type { SQLQuery } from './sql'`; `tests/unit/exports.test.ts` pins `sql` among the values and `SQLQuery` among the types.

In `src/api.ts`, each of the five methods becomes an overloaded call signature:

```ts
read: {
  <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteChunkOptions): Promise<T[]>;
  <T extends Record<string, unknown>>(query: SQLQuery, options?: SQLiteChunkOptions): Promise<T[]>;
};
```

`bulkWrite()` and `output()` are not concerned.

## 4. Dispatch

One internal helper, `queryArgs(first, second, third)`, returns `{ sql, params, options }`: a `SQLQuery` first gives its fields and takes `second` as the options; a string first keeps today's reading. The ten entry points — five in `client.ts`, five in `transaction.ts` — call it first, before `assertReadable` / `checksql`, so routing, the read guard and the transaction's checks see the composed SQL exactly as they see a string today.

A `SQLQuery` followed by an array (untyped code passing params anyway) is refused with `INVALID_VALUE`, rather than taking the array as options; so is a first argument that is neither a string nor a `SQLQuery`.

## 5. Errors

No new code. A value `toBindable` refuses throws as today, from the method, naming its final position. A misuse of the overload or of `sql.raw` is `INVALID_VALUE` (§ 4, D7); a bad `sql.id` part is `INVALID_IDENTIFIER` (D8); a non-array or a refused element of `sql.list` is `INVALID_VALUE` (§ 2). `sql.raw`, `sql.id` and `sql.list` throw when called, not when the query runs; so does the tag on a refused template (§ 2, D13).

## 6. Testing

- **Unit (`tests/unit/sql.test.ts`, Node):** text and params for each row of § 2; nesting both ways (`sql` in `sql.jsonb`, `sql.jsonb` in `sql`) and an empty fragment; a `{ sql, params }` plain object stays a value; `sql.raw` inlined with no params and refusing a non-string (a template included); `sql.id` with one and several parts, a `"` doubled, a dotted name kept whole, and each refused part; `sql.list`'s JSON text for each row of its table and each refused element; `takesJson` against `convert` for each kind of value in spec 2026-10-06 § 2; `queryArgs` for both forms and the refused ones; the numbering across nested fragments and a fragment used twice; an object used twice (one param, the same index), the same object bare and under `sql.jsonb`, an object shared by a fragment and its parent, and two equal primitives (two params); the scanner on each placeholder form, on each literal and comment form it skips, on a value inside a literal or a comment, and its cache (one scan per `TemplateStringsArray`).
- **Browser (shared suite, both engines):** each of the five methods with a `SQLQuery`, on the client and inside a transaction; a `sql.jsonb` insert reads back as JSONB (`typeof(col) = 'blob'`, `json(col)` equal to the object's JSON); an object through plain `sql` reads back as its JSON text; `sql.list` matching integers, a `bigint` above 2⁵³, strings, a `Date` against a column written by `strftime('%Y-%m-%d %H:%M:%f', …)` (`datetime()` drops the milliseconds, so it would not compare equal), and an empty list matching nothing; a two-statement string built with the tag storing each value in its own statement; one object interpolated into two columns and into two statements, reading back as the same JSON.
- **Exports:** `tests/unit/exports.test.ts` as § 3.

## 7. Documentation and changelog

`API.md` gets a section on the tag: both forms, composition, `sql.id`, `sql.raw` and its danger, `sql.list`, the no-placeholder rule and what the scan refuses. `README.md`'s quick-start `INSERT` (`db.write('INSERT INTO users (name) VALUES (?)', ['Alice'])`) is rewritten with the tag, and `sql` joins its API link line. `CHANGELOG.md`: one `Added` entry under `[Unreleased]`.

## 8. Out of scope

- A `sql.json` variant: `json(?)` matters only to nest a JSON value inside `json_object()` and the like, where `jsonb(?)` serves as well. Added later if asked.
- Params passed as an object, bound by name in the worker (`:name`, `@name`, `$name`): it would fix multi-statement strings and missing params for the string form too. Its own spec and branch, to be recorded in `mem:follow-ups`.
- Joining an array of fragments (`sql.join(conds, ' AND ')`): nesting already does it, `` conds.reduce((a, c) => sql`${a} AND ${c}`) ``.
