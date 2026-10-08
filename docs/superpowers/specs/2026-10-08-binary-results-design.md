# Worker → page binary results — design

**Date:** 2026-10-08 · **Status:** approved in chat section by section, spec under review · **Target:** `## [Unreleased]` · **Branch:** `feat/binary-results`

Today every chunk of result rows crosses from the worker to the page as a structured clone of an array of objects, which the worker builds from wa-sqlite's `sqlite.row()`. This design has the worker encode each chunk straight from SQLite's column API into one transferred buffer, and the page decode it into the same objects. It is the reverse direction of the page → worker protocol (spec 2026-10-07), with the same value tags.

Measured on a throwaway spike before this design (RESULT-BINARY, `mem:measurements/footprint`, both engines launched directly, no Playwright): one row costs the same as the clone (1.00-1.02); 100 rows are 7-25 % faster, 10 000 mixed rows 46-50 % faster on Chromium and 23 % on Firefox; a 500 MiB `stream()` peaks up to 6× lower on Firefox (539 → 193 MB at the default `chunkSize`) and runs 25-45 % faster on Chromium. Nothing changes for the consumer: the rows are the same objects.

---

## 1. Decisions (user, 2026-10-08)

- **D1 — Every result is binary, with no threshold and no option.** `read()`, `first()`, `chunk()`, `stream()`, a `write()` that returns rows (`RETURNING`) and their `tx.*` counterparts. One row measured 1.00-1.02× the clone, so a threshold would only add a second format.
- **D2 — One buffer per chunk, encoded in the worker, decoded in `pool.ts`.** Chosen over fixed 1 MiB segments as in the params block (a chunk is already bounded by `chunkSize`; segments add bookkeeping and were not measured) and over lazy or columnar decoding (changes the objects the consumer receives; not measured).
- **D3 — Decoding happens when `pool.ts` hands the chunk over, not when the message arrives.** The inbox keeps the compact form, and a chunk a stop leaves in the inbox is never decoded.
- **D4 — A blob is a copy (`slice()`), not a view on the received buffer.** A view would keep the whole chunk alive for one kept blob, and would break a consumer reading `blob.buffer` whole, which wa-sqlite's copy guarantees today.
- **D5 — Encoding and decoding share one module per side.** `src/encode.ts` becomes `src/binary.ts` and takes the decoder; `src/worker/bind.ts` becomes `src/worker/binary.ts` and takes the row writer. The tag table stays documented in one place, `src/types/protocol.ts`.
- **D6 — A text of 32 bytes or less is decoded in JS when its UTF-8 is valid; anything else goes through `TextDecoder` (user, 2026-10-08, amendment after the delivery measurement).** On Chromium, a string `TextDecoder` returns on the page is an external string that holds ~150-190 bytes more than the same string from a structured clone: a `read()` of 500 000 mixed rows retained 430 MB after GC against 354 on `main`. Decoding short texts in JS (UTF-16 units into a scratch `Uint16Array`, then one `String.fromCharCode`) took it to 237 MB at the same speed. Measured direct, both engines (RESULT-BINARY, `mem:measurements/footprint`): Chromium decodes short strings 1.5-3× faster in JS, and still 20 % faster with lengths alternating around the threshold; Firefox decodes them 15-25 % slower in JS, which costs a 500 000-row `read()` 4 % (5.58 → 5.78 s, against 7.0 on `main`) at equal memory. Above 32 bytes `TextDecoder` is faster on both engines. Only valid UTF-8 takes the JS path: an invalid lead byte, a missing or wrong continuation byte, an overlong form, an encoded surrogate or a code point above U+10FFFF falls back to `TextDecoder`, so replacement characters stay exactly the decoder's.

## 2. The block

```ts
type RowsBlock = {
  columns: string[];   // column names, in order
  rows: number;        // rows in the chunk
  buffer: ArrayBuffer; // transferred with the message
  used: number;        // bytes written
};
```

The `chunk` message becomes `{ type: 'chunk'; callId: number; data: RowsBlock }`, its buffer passed as a transferable. `done` is unchanged; a query that returns no row sends no chunk, as today.

Values follow one another, row after row, column after column, each a tag byte then its payload, little-endian — **the params block's table**:

| tag | value | payload |
|---|---|---|
| 0 | `NULL` | none |
| 1 | integer in int32 | 4 bytes |
| 2 | float64 | 8 bytes |
| 3 | text | u32 byte length, the UTF-8 bytes as SQLite gives them |
| 4 | BLOB | u32 byte length, bytes |
| 5 | integer in int64 | 8 bytes, as two 32-bit halves (low first) |

The worker writes an integer as tag 1 when its high half is only the sign extension of the low half, as tag 5 otherwise.

**One buffer per chunk.** It starts at 4 KiB, or at the size the same query's previous chunk needed, and doubles by copying into a new buffer when a value does not fit, as many times as that value needs. Not `ArrayBuffer.prototype.transfer`: it is newer than the library's Firefox floor (`LIB_REQUIRES` in `scripts/render-vfs-matrix.ts`). Nothing is kept from one query to the next.

**Column names travel in every chunk.** They are read after the first `SQLITE_ROW`, as today (v2 re-preparation happens during `step()`). A few dozen bytes per chunk, and no state shared between messages.

**Text stays raw UTF-8.** The bytes of `sqlite3_column_text` over `sqlite3_column_bytes`, read in that order — SQLite's recommended order, which wa-sqlite follows. The page decodes a text of 32 bytes or less in JS when its UTF-8 is valid (D6), and anything else with `new TextDecoder('utf-8', { ignoreBOM: true })`, exactly as wa-sqlite's `readUTF8` does today: invalid sequences are replaced the same way, an inner `NUL` is kept, and so is a leading byte-order mark — a default `TextDecoder` would strip it; the JS path keeps both too.

## 3. Components

**Worker side**

- **`src/worker/binary.ts`** — `src/worker/bind.ts` renamed, keeping `bindBlock`, plus `RowWriter`: reads each column through `_sqlite3_column_type/int64/double/text/blob/bytes` (`getTempRet0` for an integer's high half) and writes it into the chunk's buffer; `finish(columns)` returns the `RowsBlock`.
- **`src/worker/worker.ts`** — in `run()`, the `RowWriter` replaces `sqlite.row()`, the object built per row and the `buffer` array cut by `splice`. The generator yields `RowsBlock | number` instead of rows or a number. The `query` case sends the chunk with `[block.buffer]` as transferable; `reply` takes an optional list of transferables. The internal path that runs control statements and discards their rows is unchanged.

**Page side**

- **`src/binary.ts`** — `src/encode.ts` renamed, keeping `ParamsWriter`, `EncodedParams` and `encodeParams`, plus `decodeRows(block)`: the objects in column order (a duplicated column name keeps the last value, as the current loop does); tag 1 as is, tag 5 through wa-sqlite's `cvt32x2AsSafe` rule (a `number` within the safe range, a `bigint` beyond); text in JS up to 32 bytes of valid UTF-8, else through `TextDecoder('utf-8', { ignoreBOM: true })` (D6); a blob through `slice()`. The loop keeps the direct assignment and the comment that forbids `Object.fromEntries` (measured 2026-08-31), moved from the worker.
- **`src/pool.ts`** — the `chunk` handler queues the block as it is; `debugQuery?.chunk` counts `block.rows`. The loop decodes as it hands the chunk over (`yield decodeRows(chunk)` for anything but the `affected` number). Imports follow the rename; so does `src/bulk.ts`.

**Protocol** — `src/types/protocol.ts`: `RowsBlock`, the `chunk` message's `data`.

Nothing changes above `pool.ts` (`queries.ts`, `transaction.ts`, `client.ts`, `inspect.ts`): they receive the same arrays of objects.

## 4. Parity with today's rows

Each value must come out exactly as `sqlite.row()` gives it today:

- integers — a `number` within ±(2^53 − 1), a `bigint` beyond, the ±2^63 bounds; an integer within int32 identical whether it crossed as tag 1 or tag 5;
- floats, including `-0.0` and 1e308;
- text — empty, Unicode outside the BMP, invalid UTF-8 (`CAST(x'ff' AS TEXT)`), an inner `NUL` (`char(0)`), a leading byte-order mark (`char(65279)`); texts of 1 to 40 characters — ASCII, two-byte, four-byte — on both sides of the 32-byte threshold, and invalid UTF-8 of each kind D6 lists, short and long;
- blobs — empty, `NULL`, 100 KiB; each a `Uint8Array` owning its own buffer;
- duplicated column names, with today's winning value;
- a value larger than the initial buffer.

## 5. Errors

None new. The format is internal and produced by our own worker: a malformed block is our bug, not an input to validate, so the decoder checks no more than the current loop does. A SQLite error during `step()` takes the current path; a chunk produced before it arrives as today.

## 6. Tests

**Unit** (`unit` project) — `tests/unit/binary.test.ts`, taking over `tests/unit/encode.test.ts`: a round trip of every tag through `decodeRows` from a block built in the test; the int32/int64 rule at its bounds; a blob copied (`buffer.byteLength === length`); a duplicated column; an empty block; the short-text decoder against `TextDecoder` on valid texts at 31, 32 and 33 bytes and on every invalid form D6 lists.

**Browser** (the chromium and firefox targets) — one parity file writing every case of § 4 and reading it back through `read`, `first`, `chunk` (with a value spanning several chunks), `stream` and `tx.read`, checked against `typeof()`/`hex()` on the SQL side and against the expected JS values.

The existing stream, back-pressure, stop and abandonment tests cover the transport as it is; they must pass unchanged. `backpressure.test.ts` counts `chunk` messages, whose number does not change.

**Delivery:** `tsc`, `biome ci`, `pnpm test` (three reports), conformance on both engines, and the full matrix, since `src/pool.ts` and `src/worker/` change. Then RESULT-BINARY re-run on the final branch with the same direct harness, `main` against the branch, to confirm the spike; no automated test pins a footprint.

## 7. Documentation

- **`CHANGELOG.md`**, `## [Unreleased]`, `Changed`: query results cross from the worker to the page in binary form — faster reads and lower memory for large results.
- Nothing in `API.md`: nothing visible changes.

## 8. Out of scope

- Firefox reading narrow rows ~15× slower than Chromium whatever the transport (`mem:follow-ups`).
- Recycling the result buffers.
- Lazy or columnar decoding.
