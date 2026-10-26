# Follow-up (idea) — Buffer strategy of the binary blocks, both directions — a measurement to take if the choice is questioned (user, 2026-10-08)

**Status: IDEA** — not planned.

Part of `mem:follow-ups`; moved out of it on 2026-10-26. One of the designs owed: **an idea, not planned for the short or medium term** — keep it, do not present it as pending scope or as "the next thing".

The two sides grow their buffers differently, on purpose: `ParamsWriter` knows the size before writing (`encodeParams` sizes for the worst case; `bulkWrite` batches are large), so it uses 1 MiB segments and never copies; the result `RowWriter` (spec 2026-10-08) learns the size row by row, so it keeps one buffer per chunk that doubles by copy, sized from the query's previous chunk. Growable `ArrayBuffer`s (`resize`, `transfer`) were refused on 2026-10-07 for raising the browser floor (Firefox → 122-128). Unmeasured alternative for rows: segments of doubling size capped at 1 MiB (no copy, a test per value at decoding). Should either choice be questioned, measure both arms on each side with the direct harness (RESULT-BINARY / BINARY-PROTOCOL).
