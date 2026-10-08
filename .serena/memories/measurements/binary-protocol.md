# Measurements — the binary protocol between page and worker

Part of `mem:measurements`, which indexes every entry; its rules apply here. Moved out of `mem:measurements/footprint` on 2026-10-08 to keep it under 40 000 characters; the harness and the memory layers are FOOTPRINT-METHOD there, and the "direct" harness (no Playwright) is described under BINARY-PROTOCOL below.

## BULK-BINARY — a transferred binary batch cuts the peak by up to 70 %, 2026-10-06

**The spike** (throwaway branch, not merged): `bulkWrite` still sends a `query` message with its INSERT through `write()`; only `params` changes. The page encodes the batch's values into 1 MiB `ArrayBuffer` chunks — tag byte then payload: null, int32, float64, int64, text (u32 length + UTF-8 through `TextEncoder.encodeInto`), blob — a value never straddling two chunks; `params` becomes one object holding the chunks, passed to `postMessage` as transferables (pool.ts). The worker copies the chunks into one `sqlite3_malloc` block and binds every value from it with `SQLITE_STATIC` through `module._sqlite3_bind_*`, freeing the block after `settle()` has cleared the bindings. Same binding semantics as wa-sqlite's `bind` (an integer outside int32 goes as a double, a boolean as an int). Two placements: **`flush`** encodes when the batch is sent, **`enqueue`** encodes each row as it arrives, so the rows die young. **Correctness**: 40 000 rows × 11 columns (int, float, bigint, null, undefined, Unicode text, empty text, JSON, Date, blob, boolean) read back with `typeof()` and `hex()`: the same SHA-256 for the three modes, on three VFS, on both engines.

Page-process PSS peak, MB, median of 3, 500 MiB, normal configuration (no forced GC, no heap cap), 0 errors in 54 runs:

| VFS | Chromium clone / flush / enqueue | Firefox clone / flush / enqueue |
|---|---|---|
| `OPFSAdaptiveVFS` | 401 / 131 / **121** | 301 / 247 / **173** |
| `OPFSWriteAheadVFS` | 515 / 349 / **331** | 284 / 206 / **175** |
| `OPFSCoopSyncVFS` | 401 / 171 / **164** | 294 / 255 / **172** |

Load time unchanged or shorter (Chromium Adaptive and CoopSync 3 → 2 s, WriteAhead 5 → 4 s; Firefox 32-54 s in every mode). **On Chromium the transfer does the work and `enqueue` adds 2-8 %; on Firefox encoding at `enqueue()` is what counts** (−13 to −27 % at `flush`, −38 to −43 % at `enqueue`). Both beat the forced GC of BULK-GC (210 on Adaptive). What stays on `OPFSWriteAheadVFS` under Chromium is its own: CDP saw up to 156 MB of ArrayBuffers in its worker. Wasm heap 24.3 MiB per worker, as before; `close()` + 31 s back to baseline in every mode.

**What generalising it to every query would have to handle**, read from the code: `readWithRetry`/`streamWithRetry` re-post the same `params` once on a SQLite `BUSY` (`OPFSCoopSyncVFS`'s handle transfer), so a query must be encoded at each send, not ahead; a write is never retried, so `bulkWrite` may encode at `enqueue()`. `debugSQLQuery` reads `params` to inline values in the debug log. A transferred buffer comes back usable only if the worker transfers it back (ownership round trip), which is how chunks could be recycled — not measured. A `SharedArrayBuffer` would need COOP/COEP, which the library deliberately does not require.

**Generalised to every query, small payloads cost a little and gain nothing (2026-10-06).** Spike extended: when asked, `pool.ts` encodes any query's `params` at send time into one buffer sized for the worst case and transfers it (retry-safe). Measured per query, the mode alternating at every query, isolated page for a fine clock, 8 rounds, `jspi`; ratio binary / clone of the summed per-query times (per-round range):

| workload | Chromium Memory | Chromium Adaptive | Firefox Memory | Firefox Adaptive |
|---|---|---|---|---|
| 2000 point reads, 1 int param | 1.03 (1.01-1.07) | 0.98 (0.97-1.03) | 1.01 (0.99-1.07) | 0.98 (0.95-1.06) |
| 2000 small writes in a tx, 3 short values | **1.05 (1.02-1.10)** | **1.09 (1.04-1.14)** | 1.07 (1.00-1.20) | 1.02 (0.92-1.09) |
| 500 writes of 10 KB text | 1.11 (0.99-1.25) | 1.00 (0.88-1.07) | 0.93 (0.73-1.20) | 1.05 (0.99-1.16) |
| 50 writes of a 1 MiB blob | 0.94 (0.88-1.16) | 0.96 (0.90-1.04) | 1.02 (0.93-1.12) | 1.02 (0.99-1.04) |

So: reads neutral; small writes 2-9 % slower — a few µs per query (Chromium 0.07 ms per small write); large params neutral in time, their memory gain not measured. A first attempt timing whole workloads per mode was useless on Firefox (the same workload spread 680-5 590 ms between rounds); interleaving per query removed it. (Under Playwright; BINARY-PROTOCOL re-measured it direct: neutral.)

**Memory of large params on an ordinary query** (same day, separate browser per run, n=3, `OPFSAdaptiveVFS`): 200 writes of a 1 MiB text in one transaction, page-process PSS peak over the phase start — Chromium **100 MB cloned (87-116) against 27 binary (26-28)**; Firefox 59 (57-60) against 53 (50-84).

## BINARY-PROTOCOL — page → worker entirely binary, measured direct on both engines, 2026-10-07

**Method.** Throwaway branch `spike/binary-protocol` (deleted 2026-10-08) off `main` (after the STREAM-FF fixes), every behaviour behind a `globalThis.__bsq*` switch. **Both browsers launched by hand, no Playwright**: Playwright's `chromium-1234` binary (`--headless --no-sandbox --user-data-dir`, no other flag; no branded Chrome exists for Linux arm64) and `firefox-1538` (`--headless --no-remote --profile`), page served with COOP/COEP, `jspi` build, PSS of the content processes (Chromium `--type=renderer`, Firefox `contentproc`, descendants of the launched pid) sampled every 250 ms, peak over the phase start. Agent variables stripped. The two engines ran as two parallel chains; the per-query micro of the first campaign ran one browser at a time.

**What the spike does.** Any query's params, encoded at send time into a block (tag byte + payload, as BULK-BINARY), transferred; the worker copies the block into one wasm allocation and binds from it with `SQLITE_STATIC`, never building a JS array. `bulkWrite` encodes each row at `enqueue()` and sends `sql` = `INSERT … VALUES ` plus a `pattern` (the row template) in the block; the row count travels in the block's header (counted by the writer, never derived from the values), and the worker rebuilds `sql + pattern × rows`. The worker does not know it serves a `bulkWrite`. **Correctness**: every arm gives the same SHA-256 as the clone on both engines — 40 000 rows × 12 columns including a `jsonb(?)` column in the pattern, bigint, Unicode, empty text and blobs, booleans, Dates; params arms on 4 000 rows written by `tx.write` plus a read re-posted twice.

**(a) Small queries: no threshold needed.** Per-query interleaving over the arms, 8 rounds × 2 runs, ratio to clone of the summed time, median (range). The spike's shape (fresh buffer, transferred, `malloc` per query) is neutral: pointRead 1.00-1.02, smallWrite 1.01-1.02 (Chromium 0.91-1.16), text10k 0.95-1.01, blob1M 0.92-1.01, on `MemoryVFS` and `OPFSAdaptiveVFS`, both engines. The 2-9 % of 2026-10-06 was measured under Playwright. Copying instead of transferring, a persistent wasm scratch, a buffer recycled through `done`: none improves on it for small queries (recycling up to 1.10 on Chromium small writes). An exact UTF-8 size (a JS scan of each string) costs 1.18-1.23 on 10 KB texts on Chromium.

**(b) `bulkWrite`, 500 MiB of 1 KiB rows, n=3**, page PSS peak MB / load s, median (range), clone → binary (`enqueue` + `pattern` + row mark):

| VFS | Chromium | Firefox |
|---|---|---|
| `OPFSAdaptiveVFS` | 477 → **264** MB, 3.25 → 2.66 s | 233 → **143** MB, 41 (35-47) → 36 s |
| `OPFSCoopSyncVFS` | 527 → **297** MB, 3.07 → 2.39 s | 261 → **132** MB, 35 → 38 (34-40) s |
| `OPFSWriteAheadVFS` | 684 → 593 (452-656) MB, 5.12 → 4.27 s | 243 → **147** MB, 56 → 56 s |

What stays on `OPFSWriteAheadVFS` under Chromium is its worker's (BULK-GC). Chromium direct peaks run higher than under Playwright (clone 477-684 against 401-515), so compare within this table only.

**(c) `pattern` and (d) row safety — 4 000 000 rows of two integers, `OPFSAdaptiveVFS`, n=3** (the case where the SQL text weighs most against the values): peak MB, Chromium / Firefox — clone 149 / 110; binary with the SQL built on the page 50 / 79; **`pattern` 44 / 38**; `pattern` with the cache keyed on `(sql, pattern, rows)`, so a cached statement never rebuilds the text, 38 / 32. Times within noise (Chromium 1.9-2.2 s, Firefox 7.3-8.3 s; clone 2.18 / 8.28). **On Firefox the page-built SQL strings alone are ~40 MB of the peak.** Row safety end to end: unprotected, a mark per row, or converting and checking the whole row before encoding — no measurable difference. Encoder alone (2 000 000 small rows, 12 interleaved rounds): mark +6-8 %, convert +12-22 % (~1-2 and ~3-4 ns per row); 1 KiB rows: none. **Unprotected is not an option**: a value that fails mid-row leaves its first columns in the block, and the batch fails at bind (`bind failed at parameter 32761`); mark and convert refuse exactly the faulty rows (40 of 40 000), digest equal to a load without them.

**Large params on ordinary queries — 200 writes of a 1 MiB text in one transaction, `OPFSAdaptiveVFS`, n=3**, peak MB / s: Chromium clone 101-114 / 0.78-0.84, fresh buffer (B0) 29-40 / 0.62-0.66, **recycled buffer 16 / 0.64**; Firefox clone 129-132 / 9.4-10, B0 50-77 / 9.3-10, **recycled 25 / 9.2**. Decomposed: the recycled page buffer (the worker hands the transferred buffer back in `done`) gives the whole gain, the persistent wasm scratch none (Chromium 37, Firefox 76 alone); exact sizing gains nothing in memory. So the gain is fewer page allocations per query, not the worst-case size.

**Re-measured on the implementation (`feat/binary-protocol` at `b41e924` against `main` at `f796fb8`), 2026-10-07 evening**, same direct harness, each build on its defaults (no switches), n=3, the two builds alternating within each repetition, 0 errors in 84 runs. Another session's Firefox was running on the machine throughout, so absolute times carry its load; the comparison does not, being interleaved. Page PSS peak MB / time, median (range), `main` → branch:

| case | Chromium | Firefox |
|---|---|---|
| 500 MiB `OPFSAdaptiveVFS` | 496 → **269**, 3.48 → 2.61 s | 267 → **146**, 35 → 37 s |
| 500 MiB `OPFSCoopSyncVFS` | 531 → **286**, 3.02 → 2.43 s | 281 → **148**, 36 → 35 s |
| 500 MiB `OPFSWriteAheadVFS` | 759 → **499**, 4.98 → 4.06 s | 254 → **148**, 59 (58-63) → 63 (62-66) s |
| 4 000 000 rows of two ints | 132 → **34**, 2.37 → 2.22 s | 167 → **30**, 8.24 → 8.10 s |
| 200 writes of a 1 MiB text | 57 (36-114) → **25**, 0.80 → 0.63 s | 130 → **64** (55-68), ~10 s both |

**Per query, both builds in ONE page, alternating at every query** (`page-ab.html`: the two `dist` imported side by side, one client each, 8 rounds × 2 runs), ratio branch / `main`: Chromium 1.00-1.03 (no params 1.00-1.01, point read 1.02-1.03, small write 1.01-1.03, 10 KB text 1.00-1.03; per-round 0.89-1.22), Firefox 1.00-1.03 (per-round 0.82-1.20), `MemoryVFS` and `OPFSAdaptiveVFS`. **A first comparison of whole runs read +11 to +26 % on Chromium small queries and was noise**: its ranges overlapped wholly, and alternating within the page removed it — compare per-query costs inside one page or not at all.

**Seen on `main` on the way**: a value `postMessage` cannot clone (a `Symbol`) is not refused by `bulkWrite`'s `enqueue()` — `toBindable` passes it through and the whole batch fails at `postMessage`, 5 460 rows lost in the check (12 columns, two batches). The binary path with a row mark refuses only that row.

## RESULT-BINARY — rows encoded in the worker: faster on both engines past one row, much less memory on Firefox, 2026-10-08

**Spike `spike/result-binary`** (off `main` after the page → worker protocol; throwaway, deleted 2026-10-08): with `binaryRows` in the query options the worker encodes each chunk from SQLite's column API (`_sqlite3_column_type/int64/double/text/blob/bytes`, an integer as its two 32-bit halves via `getTempRet0`) into ONE growable `ArrayBuffer` per chunk (starts at 4 KiB or at the size the query's previous chunk needed, doubles — the spike with `ArrayBuffer.prototype.transfer`, the implementation by copy, `transfer` being newer than the library's Firefox floor), transferred; no JS value is built in the worker. `pool.ts` decodes it into the same objects (`slice()` for blobs, wa-sqlite's `cvt32x2AsSafe` rule; text: see TEXT-EXTERNAL). Asked per query by a trailing `/*bin*/` in the SQL (so one client alternates arms) or `globalThis.__bsqResultMode = 'binary'`. **Correctness**: `read`, `stream` (333), `chunk` (1 000), `first`, `tx.read` give the same SHA-256 both ways on `MemoryVFS` and `OPFSAdaptiveVFS`, both engines — integers at ±2^53 and ±2^63, `-0.0`, 1e308, Unicode and empty text, empty and NULL blobs, 100 KiB blobs, a 300 000-character text, a duplicated column name; a decode counter confirmed the binary path ran.

**Method**: the direct harness (BINARY-PROTOCOL), harness kept outside the repo. **The 2026-10-06 version of this entry was taken under Playwright and is superseded**: its "Firefox 20-55 % slower, no memory gain" was Juggler (FF-JUGGLER, `mem:measurements/footprint`), not the protocol.

**Per query, both arms in one client, alternating at every query** (8 columns: int, real, short text, Unicode text, NULL, 16-byte blob, an int64 every 10th row; 12 rounds × 3 runs), ratio binary / clone of the summed times, median (per-round range):

| workload | Chromium Memory | Chromium Adaptive | Firefox Memory | Firefox Adaptive |
|---|---|---|---|---|
| `first()` of one row | 1.02 (0.92-1.06) | 1.01 (0.91-1.06) | 1.00 (0.94-1.09) | 1.00 (0.95-1.03) |
| `read()` of one row | 1.02 (0.90-1.12) | 1.00 (0.92-1.07) | 1.00 (0.90-1.04) | 1.00 (0.94-1.09) |
| `read()` of 100 rows | **0.75** (0.65-0.86) | 0.93 (0.79-1.02) | **0.82** (0.79-0.89) | 0.89 (0.85-0.97) |
| `read()` of 10 000 rows | **0.50** (0.43-0.62) | **0.54** (0.47-0.62) | **0.77** (0.74-0.83) | **0.77** (0.73-0.85) |
| 10 000 rows of two integers | 0.81 (0.72-0.89) | 0.84 (0.76-0.94) | 0.94 (0.86-1.02) | 0.94 (0.90-1.00) |
| 1 000 rows of 1 KiB text | 0.75 (0.58-0.90) | 0.88 (0.72-1.09) | 0.93 (0.81-1.06) | 0.93 (0.80-1.19) |
| 20 rows of a 100 KiB blob | 0.93 (0.75-1.11) | 0.94 (0.73-1.29) | 1.03 (0.85-1.16) | 1.05 (0.78-1.16) |

No size threshold is needed: one row is neutral. The spike's ASCII fast path for short strings changed nothing in TIME on either engine (within ±0.04) — but it is what hid TEXT-EXTERNAL's memory cost from the spike's `read()` figure below.

**Large results, `OPFSAdaptiveVFS`, one run per browser, arms alternating within each repetition, n=3** (the two engines as parallel chains): page PSS peak MB / time s, median (range), clone → binary:

| case | Chromium | Firefox |
|---|---|---|
| `stream()` 500 MiB of 1 KiB rows, `chunkSize` 50 | 163 → **106**, 1.97 → **1.46** | 556 (360-563) → **84** (83-140), 21.1 → 20.4 |
| same, `chunkSize` 500 (default) | 171 → 149 (141-193), 1.68 → **1.20** | 539 → **193**, 19.5 → 18.5 |
| same, `chunkSize` 5000 | 338 → 301 (229-339), 1.92 → **1.06** | 234 → 187, 19.1 → 17.3 |
| `chunk()` 500 MiB, `chunkSize` 500 | 196 → **96**, 1.81 → **1.15** | 1 034 → **449** (358-518), 16.5 → 15.9 |
| `read()` of 500 000 mixed rows | 376 → 359, 1.60 → **0.75** | 248 → 190, 8.1 → **6.0** |
| `stream()` 4 000 000 rows of two integers, 500 | 192 → **108**, 3.56 → 2.82 | 168 → 132, 74 → 73 |

So on Firefox the whole gain is memory — the clone path leaves hundreds of MB of uncollected garbage per streamed 500 MiB, the binary path almost none — and on Chromium it is mostly time.

**Firefox reads narrow rows ~15× slower than Chromium, whatever the transport** (4 000 000 rows of two integers, n=2): `chunk()` 500 → 42.8 / 39.1 s clone / binary (Chromium 3.47 / 2.80), `chunk()` 5000 → 40.0 / 38.6, `stream()` 5000 → 78.4 / 77.3, `read()` of 1 000 000 → 10.3 / 10.2 (Chromium 0.93 / 0.78). `stream()`'s per-row `for await` in the page costs ~35 s of the 75 (~9 µs per row); the other ~40 s are the worker (~10 µs per row, Chromium ~0.7). Not traced; the per-statement progress handler relayed through a `Suspending` import on Firefox `jspi` (JSPI-SYNC-RELAYS) is the first suspect. In `mem:follow-ups`.

## TEXT-EXTERNAL — on Chromium a string TextDecoder returns on the page holds ~150-190 bytes more than a cloned one, 2026-10-08

Found by the delivery measurement of `feat/binary-results` (decoding every text with `TextDecoder`): Chromium `read()` of 500 000 mixed rows peaked 456 against 361 MB on `main`. With `--js-flags=--expose-gc` and three `gc()` after the read, the result itself — not garbage — retained **429-431 MB against 351-368**. By column type, retained after GC, `main` → branch: `id` + two texts 161 → **317**, `id` + 16-byte blob 278 → 182, numbers only 106 → 100. Presumably Blink's external strings (a `TextDecoder` result crosses from Blink as an external string with its own backing store and cache entry); the structured clone's deserializer builds ordinary V8 strings. Firefox is not affected (`read()` peak 249 → 187).

**Pure-JS probe** (1 000 000 strings decoded from one buffer, retained PSS after GC, direct harness), `TextDecoder` → JS decoder (UTF-16 units into a scratch `Uint16Array`, then one `String.fromCharCode.apply`), time / retained:

| length | Chromium | Firefox (time only; no forced GC) |
|---|---|---|
| 8 bytes, 1 000 000 | 339 → **102 ms**, +181 → **~0 MB** | 232 → 277 ms |
| 16 bytes, 750 000 | 248 → **92 ms**, +144 → **~0** | 159 → 200 ms |
| 32 bytes, 375 000 | 114 → **73 ms**, +71 → **~0** | 112 → 138 ms |
| 64 bytes, 187 500 | 59 → 61 ms, 32 → 21 | 62 → 72 ms |
| 128 bytes, 93 750 | 26 → 54 ms, equal | 23 → 45 ms |

A JS decoder that concatenates (`s += char`) builds cons strings and is far worse than `TextDecoder` from 64 bytes on both engines. Lengths alternating 24-40 bytes around a 32-byte threshold (500 000): Chromium 160-167 → 127-137 ms and +93 → +40 MB; Firefox 140 → 160-168 ms — branch misprediction does not cancel the gain. "~0" means V8 reused pages already committed, not that strings are free.

**Adopted as spec D6** (texts ≤ 32 bytes of valid UTF-8 in JS, everything else through `TextDecoder`, so replacement characters stay the decoder's). Its validation was checked exhaustively by the task reviewer against `TextDecoder('utf-8', { ignoreBOM: true })`: every 1-3-byte sequence, every code point, a 4-byte boundary alphabet and 2 M random mixes — 21 992 832 inputs, 0 differences. Digests of edge-case texts (invalid sequences, BOM, surrogates, overlongs, 1-40 characters ASCII/accented/emoji) identical between `main`, the branch and the variant on both engines.

## RESULT-BINARY-DELIVERY — `feat/binary-results` against `main`, 2026-10-08

Direct harness; `main` = `9c56f50` (its own build), branch at `978376f` (TextDecoder for all texts) and at `30f1991` (final, D6). Per-query micro: both builds in ONE page, alternating at every query, 12 rounds × 3 runs, both engines, `MemoryVFS` and `OPFSAdaptiveVFS`; ratio final / `main` (first ratio: `978376f`, second: the D6 variant, built from the same code as the final):

| workload | Chromium | Firefox |
|---|---|---|
| `first()` / `read()` of one row, `write()` without rows | 1.00-1.02 / 0.99-1.02 | 1.00-1.01 / 0.99-1.02 |
| `read()` of 100 rows | 0.78-0.91 / **0.72-0.90** | 0.86-0.87 / 0.86-0.88 |
| `read()` of 10 000 mixed rows | 0.51-0.55 / **0.48-0.53** | 0.79 / 0.80-0.81 |
| 10 000 rows of two integers | 0.80-0.81 / 0.78-0.81 | 0.95 / 0.95-0.96 |
| 1 000 rows of 1 KiB text | 0.82-0.92 / 0.84-0.92 | 0.94-0.95 / 0.95 |
| 20 rows of 100 KiB blobs | 0.94-0.95 / 0.94-0.95 | 1.01-1.02 / 1.00-1.02 |

Large results, `OPFSAdaptiveVFS`, n=3, page PSS peak MB / time s, `main` → `978376f` (texts in these cases are 1 KiB, so D6 does not apply):

| case | Chromium | Firefox |
|---|---|---|
| `stream()` 500 MiB, `chunkSize` 50 | 169 → **103**, 1.94 → **1.37** | 384 → **80**, 20.0 → 20.7 |
| same, 500 | 175 → **110**, 1.62 → **1.12** | 431 → **186**, 18.8 → 18.1 |
| same, 5000 | 336 → **182**, 1.79 → **1.03** | 240 → 195, 17.8 → 16.8 |
| `chunk()` 500 MiB, 500 | 184 → **99**, 1.66 → **1.09** | 1 039 → **512**, 15.8 → 15.2 |
| `chunk()` 4 000 000 narrow rows, 500 | 115 → 86, 3.57 → 2.88 | 200 → 101, 37.9 → 37.4 |

`read()` of 500 000 mixed rows on the final code (`30f1991`), n=3: Chromium peak 368-418 → **236-237 MB**, retained after GC 357-368 → **236-237**, 1.51-1.56 → **0.68-0.70 s**; Firefox peak 232-251 → **186-193**, 7.0-7.7 → **5.8-6.2 s**. The D6 variant alone on Firefox read 4 % slower than `978376f` (5.58 → 5.78 s).

Harness trap paid for here: a copied driver that ignored its `PAGE` variable served the wrong page, and the browser sat at 0 % CPU with no mark posted — a run with no mark after a minute is a harness fault, not a slow query.
