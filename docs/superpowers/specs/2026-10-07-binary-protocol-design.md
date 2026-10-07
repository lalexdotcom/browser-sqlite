# Page → worker binary protocol — design

**Date:** 2026-10-07 · **Status:** approved in chat section by section, spec under review · **Target:** `## [Unreleased]` · **Branch:** `feat/binary-protocol`

Today every query's params cross to the worker as a structured clone of a JS array, and the worker hands them to wa-sqlite's `sqlite3.bind`. `bulkWrite()` builds each batch as an array per row, flattens it into one array of up to 32 766 values, builds an SQL text of up to ~100 KB, and clones all of it. This design sends params as an encoded binary block, transferred rather than cloned, bound in the worker straight from wasm memory; gives every parameterised method the value conversion `bulkWrite()` already has; and lets the worker rebuild a multi-row `INSERT` from a row pattern.

Measured on a throwaway spike before this design (BINARY-PROTOCOL, `mem:measurements/footprint`, both engines launched directly, no Playwright): a 500 MiB `bulkWrite` peaks 40-50 % lower on the page in most cells and is as fast or faster; small queries cost the same as the clone; large params peak 2.5-3× lower. The worker → page direction (result rows) is out of scope: it waits for RESULT-BINARY to be re-measured directly on Firefox.

---

## 1. Decisions (user, 2026-10-07)

- **D1 — Page → worker only, and entirely binary.** Every query that has params sends them as a binary block; there is no size threshold. Measured: a block costs a small query 1.00-1.02× the clone's time on both engines, so a threshold would only add a second format.
- **D2 — Every parameterised method converts its params as `bulkWrite()` does.** `query()`, `read()`, `write()`, `first()`, `chunk()`, `stream()` and their `tx.*` counterparts apply `toBindable` (spec 2026-10-06, § 2, ordinary column) to each param: an object or an array becomes `JSON.stringify` text, a `Date` becomes SQLite's date text (`YYYY-MM-DD HH:MM:SS.SSS`, UTC), `null` and `undefined` become `NULL`, a `Uint8Array` stays a BLOB, numbers, bigints, strings and booleans are unchanged. A JSONB column is the query's own business: it writes `jsonb(?)`. **Breaking:** an array param was bound as bytes, it becomes JSON text; bytes are passed as a `Uint8Array`, as `bulkWrite()` already requires.
- **D3 — A value no rule can bind throws `INVALID_VALUE`**, a new `SQLiteErrorCode`: a `Symbol`, a function, a `bigint` outside SQLite's 64-bit range, and a value whose conversion throws (`JSON.stringify` on a cycle or a nested `bigint`, an invalid `Date`), the latter with the engine's error as `cause`. The message names the param's index, or the column for `bulkWrite()`. **This supersedes D8 of the 2026-10-06 spec**, under which those conversion failures left `enqueue()` as the engine's own `TypeError`/`RangeError`.
- **D4 — Conversion at the call, encoding at the send.** The entry point converts and checks the params next to `assertReadable`, so `INVALID_VALUE` arrives exactly when `NOT_A_READ_QUERY` does: rejecting the call for `read`/`write`/`first`, on the first `next()` for `chunk`/`stream`. The converted array travels to `pool.ts`, which encodes it at each send — a read retried after `BUSY` re-encodes from it, since a transferred buffer is gone from the page. Chosen over encoding at the send alone (the error would wait for a free worker) and over encoding once at the call (a retry would need a kept copy, doubling large params).
- **D5 — `bulkWrite()` encodes each row at `enqueue()`.** Measured: on Firefox that is what makes the gain (−38 to −43 % against −13 to −27 % when encoding the whole batch at flush). Each row is written under a mark and rolled back if one of its values fails, so `enqueue()` throws `INVALID_VALUE` synchronously and the batch keeps only whole rows. The mark costs ~1-2 ns per row; converting the whole row first cost about twice that and was not kept.
- **D6 — A row pattern, internal.** A `query` message may carry `pattern`; the worker then runs `sql + pattern × rows`, comma-joined, with `rows` read from the block. Only `bulkWrite()` sends one; the public API does not expose it. The worker keeps a patterned statement in its cache under `(sql, pattern, rows)` and builds the text only to prepare it. Measured on 4 000 000 small rows: the page-built SQL strings alone are ~40 MB of Firefox's peak; the cache key saves ~6 MB more on each engine.
- **D7 — The worker never builds a JS array of params.** It copies the block into one `sqlite3_malloc` allocation and binds every value from there with `SQLITE_STATIC`. One allocation per bound statement, freed once its bindings are cleared. A persistent scratch allocation was measured and gains nothing.
- **D8 — No recycling of the params buffer** through `done`. It halves large params' peak again but keeps each worker's largest buffer for life; kept as an idea in `mem:follow-ups`.

## 2. The block

```ts
type ParamsBlock = {
  chunks: ArrayBuffer[]; // transferred with the message
  used: number[];        // bytes written in each chunk
  count: number;         // values in the block
  rows: number;          // rows, when the message carries a pattern; 0 otherwise
};
```

Values follow one another, each a tag byte then its payload, little-endian:

| tag | value | payload |
|---|---|---|
| 0 | `NULL` | none |
| 1 | integer in int32 | 4 bytes |
| 2 | float64 | 8 bytes |
| 3 | text | u32 byte length, UTF-8 (`TextEncoder.encodeInto`) |
| 4 | BLOB | u32 byte length, bytes |
| 5 | integer in int64 | 8 bytes |

A number is an int32 when `v === (v | 0)`, a float64 otherwise — wa-sqlite's rule, so `-0` binds as `0` and `NaN` as SQLite's `NULL`, as today. A boolean is the int32 `1` or `0`. Chunks are 1 MiB; a value never straddles two, so a value larger than a chunk gets a chunk of its own size. A chunk is sized for the worst case of the value it receives next (3 UTF-8 bytes per UTF-16 unit); an exact size was measured and only costs time. The worker concatenates the chunks' used bytes, so the block it binds from is contiguous.

The `query` message: `params?: ParamsBlock` replaces `params?: unknown[]`; `pattern?: string` is new. A query without params sends no block.

## 3. Components

**Page side**

- **`src/values.ts`** — `toBindable` throws `INVALID_VALUE` for what it cannot bind (D3), wrapping a conversion's own error as `cause`. New `convertParams(params)` returns the converted array or throws `INVALID_VALUE` naming the index.
- **Entry points** (`src/client.ts`, `src/transaction.ts`) — `convertParams` next to `assertReadable` (D4); the converted array goes down instead of the caller's.
- **`src/encode.ts`, new** — `ParamsWriter`: the tag format, the chunks, `mark()`/`rollback()` for one row, the row counter; `encodeParams(values)` for an ordinary query.
- **`src/pool.ts`** — encodes the converted array at each send, or takes a block already encoded, and passes its chunks as transferables.
- **`src/bulk.ts`** — one `ParamsWriter` per batch, rows encoded at `enqueue()` under a mark (D5); the flush sends `INSERT INTO … (…) VALUES ` with the block and the row template as `pattern`, through an internal write that accepts an encoded block.

**Protocol** — `src/types/protocol.ts`: `ParamsBlock`, the `query` message's `params` and `pattern`.

**Worker side**

- **`src/worker/bind.ts`, new** — `bindBlock(module, stmt, block)`: copies the chunks into one wasm allocation, binds from it with `SQLITE_STATIC`, returns the allocation for the caller to free.
- **`src/worker/worker.ts`** — with a `pattern`, the cache key is `(sql, pattern, rows)` and the text is built only to prepare (D6); binds through `bindBlock`; frees every allocation of the query once `settle()` has cleared the bindings, on every exit path. The worker does not know which method sent a query.

**Errors** — `INVALID_VALUE` joins `SQLiteErrorCode` in `src/types/errors.ts`.

## 4. Data flow

**An ordinary query.** `convertParams` at the entry → the query waits for a worker → `pool.ts` encodes and transfers → the worker copies the block into wasm, binds, steps, `settle()` resets and clears the bindings → the allocation is freed. A retry after `BUSY` re-encodes from the converted array.

**`bulkWrite()`.** `enqueue()` converts each column with `toBindable` (the column's JSONB flag included) and writes the row under a mark; a failing value rolls the row back and `enqueue()` throws `INVALID_VALUE`, leaving the batch and the writer as they were. At `maxBufferSize` rows, or at `close()`, the batch's block is transferred with its pattern and a fresh writer starts. Back-pressure, abort, the latched failure and the counts are unchanged.

## 5. Parity with today's binding

wa-sqlite's `bind_collection`, which every query goes through today, is reproduced where it is observable:

- **Values bound: `min(values given, sqlite3_bind_parameter_count)`.** An extra param is ignored, a missing one stays `NULL`.
- **A multi-statement string binds the same params, from the first, to each statement.** The block is bound once per statement, each allocation freed at the end.
- **`undefined` binds `NULL`** — today it leaves the binding unset, which is `NULL` once bindings are cleared after every query.

Two differences, both decided above or accepted here:

- **A `bigint` outside int64 throws `INVALID_VALUE`.** Today `bind_int64` returns `SQLITE_RANGE` without throwing and `bind_collection` ignores it, so the param is silently `NULL`.
- **A lone surrogate in a string becomes U+FFFD** (`TextEncoder`), where Emscripten's `stringToUTF8` writes the surrogate's own three bytes, which is not valid UTF-8. Pinned by a test.

## 6. Errors

- `INVALID_VALUE` is raised on the page, before any round trip (D3, D4, D5).
- A bind failure in the worker (out of wasm memory, a `SQLITE_TOOBIG`) is the usual SQLite error — `STATEMENT_FAILED` with its `sqliteCode` — and the allocation is freed on that path too.
- A malformed `query` message is still `PROTOCOL_ERROR`.

## 7. Tests

**Unit** (`unit` project):
- `ParamsWriter`: a round trip of every type through a test-only decoder; no value straddles two chunks; a string larger than a chunk gets its own; `rollback()` after the row moved to a new chunk; the row counter.
- `convertParams`/`toBindable`: each conversion rule; `INVALID_VALUE` naming the index or the column, with `cause` for a cycle, a nested `bigint`, an invalid `Date`; a `bigint` outside int64.

**Browser** (the chromium and firefox targets):
- Every type written with `write`/`tx.write` and with `bulkWrite`, read back with `typeof()` and `hex()`: int32 and int64 bounds, floats, `bigint`, Unicode, empty text, empty and non-empty blobs, booleans, `Date`, objects, arrays (now JSON), `null`, `undefined`, a `jsonb(?)` column in the pattern, a lone surrogate.
- `INVALID_VALUE` at the right moment for each method — rejecting the call, on the first `next()`, synchronously from `enqueue()` — and a bulk load around refused rows identical to one without them.
- Parity (§ 5): extra and missing params, a multi-statement string.
- The statement cache: a bulk's full batches reuse one prepared statement (`prepared` through `db.debug`).
- A read retried after `BUSY` still binds its params — an existing test if one covers it with params, else a new one.

**Delivery:** `tsc`, `biome ci`, `pnpm test` (three reports), conformance on both engines, and the full matrix, since `src/pool.ts` and `src/worker/` change. Then BINARY-PROTOCOL re-run on the final branch with the same direct harness, to confirm the spike's peaks and per-query costs; no automated test pins a footprint, since a PSS peak is not reliable under rstest.

## 8. Documentation

- **`API.md`** — how params are bound: what each value becomes, `jsonb(?)` for a JSONB column, `INVALID_VALUE` among the error codes.
- **`CHANGELOG.md`**, `## [Unreleased]`:
  - `Changed`, first: **Breaking:** an array param is bound as JSON text, no longer as bytes — pass a `Uint8Array` for bytes.
  - `Fixed`: object and `Date` params are no longer bound as `NULL`.
  - `Fixed`: a value `bulkWrite()` cannot bind fails its own row at `enqueue()`, no longer the whole batch.
  - `Added`: the `INVALID_VALUE` error code.
  - `Changed`: lower memory for `bulkWrite()` and for large params.

## 9. Out of scope

- Result rows (worker → page): after RESULT-BINARY is re-measured directly on Firefox.
- Recycling the params buffer (D8).
- A public form of the row pattern (D6).
- The tagged template (`mem:follow-ups`): with D2 its plain form is `strings.join('?')` with the values as params; its JSONB form stays open.
