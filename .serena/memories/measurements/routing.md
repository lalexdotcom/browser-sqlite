# Measurements — routing by SQLite's verdict (`feat/sqlite-routing`)

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## ROUTING-VS-MAIN — the verdict and the memo against `main`, 2026-10-27, this container

**Method.** FAST-STEP's direct harness (`mem:measurements/step`), rebuilt for three arms: `main` = `374f4d6` (the commit the branch left, exported with `git archive`, built beside the checkout), `branch` = `e2bb9f7`, `nomemo` = `e2bb9f7` with `VERDICT_MEMO_ENTRIES = 0`. Stock Chrome for Testing 153 and Firefox 155.0.1 (user agent checked on every run), one fresh process and profile per run, Chrome's chain then Firefox's, arms rotating. Each operation timed twice, **second pass** reported, ms, median (range). `poolSize` default, capped by the VFS (1 on `MemoryVFS`, 1 on Firefox OPFS). A foreign orphan `vitest` held one core until 16:31:10Z, when it was killed; only smoke runs predate it. **Stopped by the user in the Firefox `OPFSAdaptiveVFS` cell.** n = 6 per arm per cell; Chrome `OPFSAdaptiveVFS` n = 3 (W5 n = 4); Firefox `OPFSAdaptiveVFS` one run each of `main` and `branch`, no W5 — single observations. 259 runs, 0 errors, 0 wrong counts.

**Corrected 2026-10-28:** the table first written here (computed by hand from the campaign log) did not match the harness's own analysis, which a recomputation from the same log reproduces (Chrome Memory `sync`: W1 167 → 213, W2 268 → 374, W5 168 → 177). The table below is the harness's.

Workloads: W1 = 1 000 distinct reads once each (values inlined, so every text is new); W2 = 1 000 distinct writes once each; W3 = 10 000 × one parameterised read (`all()`/`read()`); W4 = 10 000 × one parameterised `INSERT`, no transaction; W5 = `stream()` of 1 000 000 rows.

| cell | W1 main → branch | W2 main → branch | W3 main → branch (nomemo) | W4 main → branch (nomemo) | W5 main → branch |
|---|---|---|---|---|---|
| Chrome Memory `sync` | 167 → 213 | 268 → 374 | 1 827 → 1 851 (2 319) | 2 685 → 2 737 (3 522) | 168 → 177 |
| Chrome Memory `async` | 171 → 223 | 300 → 396 | 1 879 → 1 853 (2 474) | 2 858 → 2 772 (3 696) | 282 → 278 |
| Chrome Memory `jspi` | 182 → 225 | 336 → 445 | 2 020 → 1 843 (2 592) | 3 086 → 2 838 (3 852) | 572 → 603 |
| Firefox Memory `sync` | 230 → 279 | 293 → 454 | 1 961 → 1 990 (3 170) | 2 694 → 2 755 (4 063) | 410 → 415 |
| Firefox Memory `async` | 225 → 312 | 319 → 503 | 2 146 → 2 382 (3 626) | 3 033 → 3 420 (4 980) | **695 (684-709) → 747 (724-753)** |
| Firefox Memory `jspi` | 237 → 319 | 314 → 497 | 2 126 → 2 072 (3 242) | 2 857 → 2 901 (4 149) | 1 220 → 1 159 |
| Chrome WriteAhead `sync` | 173 → 229 | 666 → 676 | 1 958 → 1 883 (2 409) | 6 536 → 6 469 (6 851) | 193 → 186 |
| Firefox WriteAhead `sync` | 237 → 317 | 1 252 → 1 417 | 2 086 → 2 101 (3 262) | 13 331 → 12 933 (14 493) | **388 (349-472) → 453 (424-487)** |
| Chrome Adaptive `jspi`, n=3 | 1 355 → 1 445 | 5 627 → 6 169 | 13 937 → 13 870 (13 793) | **56 046 (52 687-56 188) → 60 334 (58 911-66 897)** (63 557) | 534 → 532 |
| Firefox Adaptive `jspi`, n=1 | 1 035 → 1 155 | 21 275 → 17 547 | 11 394 → 10 020 | 275 740 → 290 870 | — |

**Reading.** The first call of a statement costs 0.05-0.09 ms for a read and 0.1-0.19 ms for a write on `MemoryVFS` (one verdict), once per statement per client; on OPFS the commit dominates W2. In steady state, with the memo, every cell is within noise of `main`. Without the memo, repeated reads cost 23-69 % more and repeated writes 25-64 % more on `MemoryVFS`, 5-9 % on `OPFSWriteAheadVFS`. The two deltas this campaign left open (bold) are settled by ROUTING-DELTAS below.

## ROUTING-DELTAS — the two deltas of ROUTING-VS-MAIN, 2026-10-28, this container

**Method.** Same harness, browsers and machine as ROUTING-VS-MAIN; arms built from `git archive` exports, experimental arms patched in the export (the checkout untouched); every arm of a campaign interleaved in rotation, so arms compare within a campaign, not across campaigns (the host's speed drifted ~12 % between campaigns of one morning). Pass 2, ms, median (q1-q3).

**Firefox `stream()` of 1 000 000 rows: a real regression of the branch, caused by `7f67c01`'s worker half, fixed by a code shape.**
- Reproduced, n = 12: Memory `async` 717 (701-729) → 760 (741-776), +6 %; WriteAhead 358 (354-380) → 416 (406-444), +16 %.
- Bisected, Memory `async`, n = 8, every `src/`-changing commit of the branch as an arm: every commit up to `fd0b695` sits with `main` (705-728; Task 4's worker mutex `c1e459f` 708), the step is `7f67c01` (`fd0b695` 717 (714-743) → `7f67c01` 753 (746-775)), every later commit stays there (752-767).
- Split: `7f67c01`'s client with `fd0b695`'s worker 702 / 369 (Memory `async` / WriteAhead), `fd0b695`'s client with `7f67c01`'s worker 735 / 413, against `main` 689 / 369.
- **Refuted:** `flatten`'s per-row signal closure (`fd0b695`, and a HEAD arm without it), `carryAffected`'s own property on the stream object and `settleOnClose` (HEAD arms without them stay at the branch's level), and the `drainWrites` path running at all (HEAD with `drainWrites` never sent stays slow: 741 / 388 against `main` 704 / 354).
- **Cause:** the drain code (`kept`, `finished`, the final `Affected`) in the worker's async generator `run`, whose per-row loop SpiderMonkey runs slower with it present, executed or not. HEAD with that code removed: 695 / 369.
- **Fixed in `c6c0ce6`:** the row loop alone in its generator (`rows`), the drain in a generator of its own that consumes it (`drainWrite`), `run` a plain function choosing between them (no delegation level added for a read). The commit itself, n = 8, `main` / branch before / `c6c0ce6`: Memory `async` 701 (695-721) / 749 (739-753) / 708 (693-716), WriteAhead 364 (358-384) / 394 (391-415) / 371 (366-381). The prototype it came from, against `main`: Memory `async` 702 / 718, WriteAhead 355 / 351; Chrome Memory `sync` 161 / `main` 164 and `jspi` 504 / 513, where the branch shows no delta either (164, 506): ROUTING-VS-MAIN's Chrome `jspi` W5 +5 % was noise.
- **No test guards it (user, 2026-10-28):** the comment on `rows` is the guard. A structural test would check a guessed trigger (which feature of the code slows SpiderMonkey was not isolated), and an A/B of the branch against its merge-base in Firefox was refused as too dependent on the browser chosen. Do not propose either again.

**`OPFSAdaptiveVFS` W4 (repeated writes): no delta.** W4 alone (fill of 100 000 rows, then 10 000 × `INSERT INTO w2 VALUES (?, ?)` per pass), n = 6, `main` / `branch` / the fix above: Chrome 59 723 (56 844-60 864) / 61 300 (58 624-62 537) / 58 719 (58 290-62 342), +2.6 %, overlapping; Firefox at 2 000 statements a pass (10 000 take ~280 s there) 44 949 (41 580-46 916) / 47 117 (43 147-50 914) / 48 749 (41 698-53 124), overlapping, run-to-run spread ±15 %. ROUTING-VS-MAIN's Chrome +8 % at n = 3 does not reproduce.
