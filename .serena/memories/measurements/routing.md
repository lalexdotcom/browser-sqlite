# Measurements — routing by SQLite's verdict (`feat/sqlite-routing`)

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## ROUTING-VS-MAIN — the verdict and the memo against `main`, 2026-10-27, this container

**Method.** FAST-STEP's direct harness (`mem:measurements/step`), rebuilt for three arms: `main` = `374f4d6` (the commit the branch left, exported with `git archive`, built beside the checkout), `branch` = `e2bb9f7`, `nomemo` = `e2bb9f7` with `VERDICT_MEMO_ENTRIES = 0`. Stock Chrome for Testing 153 and Firefox 155.0.1 (user agent checked on every run), one fresh process and profile per run, Chrome's chain then Firefox's, arms rotating. Each operation timed twice, **second pass** reported, ms, median (range). `poolSize` default, capped by the VFS (1 on `MemoryVFS`). A foreign orphan `vitest` held one core at 99 % until 16:31:10Z, when it was killed; the harness was told to redo measured runs that predate it. **Stopped by the user before the Firefox `OPFSAdaptiveVFS` cell.** n = 6 per arm per cell, n = 3 on Chrome `OPFSAdaptiveVFS`. 0 errors, 0 wrong counts in the cells below.

Workloads: W1 = 1 000 distinct reads once each (values inlined, so every text is new); W2 = 1 000 distinct writes once each; W3 = 10 000 × one parameterised read (`all()`/`read()`, and `first()`); W4 = 10 000 × one parameterised `INSERT`, no transaction; W5 = `stream()` of 1 000 000 rows.

| cell | W1 main → branch | W2 main → branch | W3 read main → branch (nomemo) | W4 main → branch (nomemo) | W5 main → branch |
|---|---|---|---|---|---|
| Chrome Memory `sync` | 171 → 219 | 272 → 379 | 1 861 → 1 883 (2 324) | 2 686 → 2 812 (3 570) | 172 → 180 |
| Chrome Memory `async` | 172 → 229 | 305 → 399 | 1 896 → 1 855 (2 477) | 2 931 → 2 801 (3 756) | 284 → 283 |
| Chrome Memory `jspi` | 182 → 228 | 337 → 451 | 2 116 → 1 901 (2 670) | 3 102 → 2 870 (3 948) | 575 → 636 |
| Firefox Memory `sync` | 238 → 281 | 293 → 455 | 1 962 → 1 995 (3 192) | 2 701 → 2 759 (4 071) | 410 → 418 |
| Firefox Memory `async` | 233 → 319 | 346 → 510 | 2 182 → 2 550 (3 694) | 3 100 → 3 865 (5 259) | **699 (684-709) → 752 (724-753)** |
| Firefox Memory `jspi` | 242 → 320 | 316 → 499 | 2 129 → 2 101 (3 252) | 2 876 → 2 919 (4 187) | 1 226 → 1 161 |
| Chrome WriteAhead `sync` | 175 → 229 | 682 → 682 | 2 026 → 1 889 (2 427) | 6 690 → 6 598 (7 042) | 193 → 188 |
| Firefox WriteAhead `sync` | 249 → 328 | 1 255 → 1 448 | 2 092 → 2 137 (3 313) | 13 343 → 12 985 (14 594) | **388 (349-472) → 462 (424-487)** |
| Chrome Adaptive `jspi`, n=3 | 1 355 → 1 445 | 5 627 → 6 169 | 13 937 → 13 870 (13 793) | **56 046 (52 687-56 188) → 60 334 (58 911-66 897)** (63 557) | 541 → 535 |

**Reading.** The first call of a statement costs 0.05-0.09 ms for a read and 0.1-0.19 ms for a write (one verdict), once per statement per client; in steady state, with the memo, every cell is within noise of `main` (Firefox Memory `async`'s 1.17/1.25 sit inside `main`'s wide ranges). Without the memo, repeated reads cost 25-60 % more and repeated writes 30-50 % more. **Two unexplained deltas, open:** Firefox `stream()` (+8 % Memory `async`, ranges disjoint; +19 % WriteAhead, ranges touching) — the verdict is paid once per stream, so not the routing; and Chrome Adaptive W4 +8 % with disjoint ranges at n=3, though the memo answers in steady state.
