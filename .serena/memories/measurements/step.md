# Measurements — the step loop: the fast step, then wa-sqlite's `step_asap()`

Part of `mem:measurements`, which indexes every entry; its rules apply here. Moved out of `mem:measurements/statement-cache-and-perf` as written on 2026-10-23, when that memory reached 39 800 characters.

## FAST-STEP — the library's own step, `perf/fast-step` against `main`, in the library, stock browsers, 2026-10-16

**Method.** The direct harness of BINARY-PROTOCOL (`mem:measurements/binary-protocol`), rebuilt: a small Node server sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, serving the two builds of the library side by side (`main` at the commit the branch left, built before any change to `src/`; the branch at `57fc7c7`) and one page; results POSTed back as JSON lines. **Stock binaries from `scripts/browsers.ts`**: Chrome for Testing 153.0.8010.52 (`--headless --no-sandbox --user-data-dir`) and Mozilla Firefox 158.0 (`--headless --no-remote --profile`; the install taken from the 155.0.1 release), launched by hand, no Playwright, no WebDriver, **one fresh browser process and profile per run** (killed with its process group after), agent environment variables stripped. One page per run imports ONE arm's `index.js`, makes a client (`poolSize: 1`), creates `w(a, b)` and fills it with recursive-CTE inserts of 250 000 rows, then times each operation twice; the headline below is the **second pass** (the first is in the log; the two passes' medians differ by up to 16 % in a cell, the first usually the slower). **`main` and branch alternate within each repetition, the first arm alternating from one repetition to the next**; Chromium and Firefox ran as two parallel chains on the same machine (16 cores, 96 GB, load average about 1.5 at the start), so compare within a cell only. Row counts checked on every pass (total and the last row's value; `first()` checks each row's `a` and `b`): **216 measured runs, 0 wrong counts, 0 errors, 0 timeouts**. `a` = `b / 2` = rowid. `chunkSize`: the default 500, plus 5 000 where marked. Times are ms, median (range) of the second pass. **The Firefox install (the 155.0.1 release, unpacked under the WebdriverIO cache) updated itself in place to 158.0 during the campaign when launched by hand**: the page's user agent reads Firefox/155.0 for repetition 1 of the Firefox `sync` studied cell (`main` and branch) and Firefox/158.0 for every other Firefox run; repetition 1's values are in line with the other repetitions. **Trap for next time: a stock Firefox launched by hand from that cache updates itself unless updates are disabled** (observed, not tested as a recipe: `app.update.disabledForTesting` or `app.update.auto` off in the profile's `user.js`, or a `distribution/policies.json` with `DisableAppUpdate`); read `navigator.userAgent` in the log of every run.

**The studied case — 4 000 000 rows of two integers, `MemoryVFS`, n=5, `main` → branch:**

| | Chromium 153 `chunk()` | Chromium `stream()` | Chromium `chunk()` 5 000 |
|---|---|---|---|
| `sync` | 1 355 (1 343-1 878) → **686** (668-1 016) | 1 748 (1 318-2 073) → 1 532 (1 420-1 899) | 1 311 (1 163-1 544) → **590** (480-653) |
| `async` | 1 988 (1 719-2 045) → **1 223** (1 202-1 413) | 2 087 (1 918-2 224) → 1 861 (1 587-2 701) | 1 769 (1 572-1 828) → **1 027** (979-1 287) |
| `jspi` | 2 852 (2 733-3 178) → **2 275** (2 076-2 621) | 3 372 (2 750-3 979) → 2 597 (2 146-2 919) | 2 725 (2 671-3 084) → **2 046** (1 822-2 242) |

| | Firefox 158 `chunk()` | Firefox `stream()` | Firefox `chunk()` 5 000 |
|---|---|---|---|
| `sync` | 4 194 (4 105-4 424) → **839** (771-863) | 5 598 (4 919-6 789) → 5 531 (4 859-5 729) | 3 963 (3 758-4 106) → **599** (538-636) |
| `async` | 5 471 (5 070-5 572) → **2 227** (2 138-2 320) | 5 646 (5 295-6 298) → 4 964 (4 845-5 616) | 4 858 (4 781-5 403) → **1 960** (1 894-2 239) |
| `jspi` | 5 749 (5 603-6 064) → **3 552** (3 440-3 652) | 6 734 (6 378-7 104) → **4 955** (4 801-5 163) | 5 479 (5 370-5 642) → **3 309** (3 210-3 474) |

So `chunk()`: Chromium −49 % `sync`, −38 % `async`, −20 % `jspi`; Firefox −80 % `sync`, −59 % `async`, −38 % `jspi` (−85 % / −60 % / −40 % at `chunkSize` 5 000). The estimate made before (−50 / −30 / −20-25 % on Chromium) held. **`stream()` gains much less**, because the page's per-row `for await` is most of its time: Firefox `sync` equal (0.99 of `main`), `async` −12 %, `jspi` **−26 %**; Chromium `sync` −12 %, `async` −11 %, `jspi` −23 %. The fast step shortens only the worker's half. **At n=5 only Firefox `jspi` `stream()` is separated from `main`**: the `main` and branch ranges overlap in the five other `stream()` cells (Chromium three, Firefox `sync` and `async`), so their medians are indications. In every `chunk()` cell of both tables, and every VFS cell, the ranges are disjoint.

**Other VFS, each on its default build, `chunk()` of 4 000 000 rows, n=3, `main` → branch** (no VFS needed fewer rows: the slowest fill took 11 s, the slowest pass 13 s):

| VFS (default build) | Chromium | Firefox |
|---|---|---|
| `OPFSWriteAheadVFS` (`sync`) | 1 460 (1 449-1 531) → **826** (743-849) | 4 794 (4 783-5 004) → **1 336** (1 275-1 535) |
| `OPFSCoopSyncVFS` (`sync`) | 1 434 (1 392-1 590) → **835** (701-945) | 4 483 (4 332-4 551) → **1 316** (1 276-1 362) |
| `AccessHandlePoolVFS` (`sync`) | 1 397 (1 395-1 435) → **706** (677-823) | 4 455 (4 343-4 557) → **1 379** (1 359-1 400) |
| `OPFSAdaptiveVFS` (`jspi`) | 2 771 (2 741-2 835) → **2 067** (2 041-2 237) | 6 537 (6 266-7 211) → **4 310** (4 216-4 350) |
| `IDBMirrorVFS` (`jspi`) | 2 658 (2 626-2 686) → **2 004** (1 982-2 106) | 5 385 (5 270-5 457) → **3 335** (3 318-3 415) |
| `MemoryAsyncVFS` (`jspi`) | 2 730 (2 603-2 775) → **2 016** (1 991-2 151) | 5 496 (5 335-5 948) → **3 513** (3 358-3 942) |
| `IDBBatchAtomicVFS` (`jspi`) | 5 522 (5 373-5 602) → **4 984** (4 643-5 016) | 9 232 (9 107-9 306) → **6 578** (6 467-6 685) |
| `OPFSAnyContextVFS` (`jspi`) | 13 047 (12 803-13 197) → 12 425 (11 771-12 449) | 8 793 (8 637-8 919) → **6 202** (6 195-6 302) |

The gain holds on every VFS and no cell is slower. **Where the VFS really suspends** (`IDBBatchAtomicVFS`, `OPFSAnyContextVFS`: the storage is asynchronous) it shrinks on Chromium to −10 % and −5 % — storage dominates — and is still −29 % on Firefox. `MemoryAsyncVFS` never suspends (its `create()` returns a `MemoryVFS`, `mem:follow-ups/wa-step-upstream`), so its cell is `MemoryVFS`/`jspi` over again. `OPFSAnyContextVFS` takes 11 s to fill 4 000 000 rows on Chromium and 13 s to read them, for 3.6 and 8.8 s on Firefox.

**A one-row query — 10 000 × `first('SELECT a, b FROM w WHERE rowid = ?', [k])`, 100 000-row `MemoryVFS` table, n=5, `main` → branch** (about 0.21-0.27 ms a call, the round trip): Chromium `sync` 2 740 (2 468-2 866) → 2 266 (2 159-2 464), `async` 2 254 (2 217-2 764) → 2 134 (2 056-2 484), `jspi` 2 307 (2 275-3 147) → 2 214 (2 128-3 283); Firefox `sync` 2 492 (2 433-2 556) → 2 472 (2 281-2 561), `async` 2 540 (2 518-2 561) → 2 553 (2 431-2 584), `jspi` 2 595 (2 464-2 713) → 2 560 (2 458-2 591). **No cost: every cell equal or within noise**; the ranges overlap everywhere but Chromium `sync` (−17 %), which is not read as a gain: its first pass reads 2 365 (2 273-2 441) → 2 200 (2 157-2 330), −7 % with overlapping ranges.

**The existing bench**: `pnpm bench:build` then `BENCH_PORT=8123 node scripts/bench/check.ts chrome --all` on the branch (Chrome 153): 22 declared pairs, all runnable, export `OK`, `"reasons": {}`.

**Not measured**: Safari, WebKit, how many steps really suspended on the asynchronous-storage VFS (not instrumented; the fast step's path for a suspended step is exercised by the test suite, not by these runs), `stream()` on the other VFS, memory. What `stream()` still spends per row in the page is the next thing a `stream()` reader would look at.

## STEP-ASAP-LIB — wa-sqlite's `step_asap()` (#388) against the fast step and wa-sqlite's own `step()`, in the library, 2026-10-23

**Method.** FAST-STEP's direct harness and studied case (`.scratchpad/step-asap-lib/`, copied from `.scratchpad/fast-step/`), with **three arms**: `master` = `main` at `41c4dfd` with the worker calling `await sqlite.step()` and the patch without #388 (wa-sqlite's `step()` as upstream ships it), `fast` = `20366bd` (the fast step, pin `8a8bc2ee`), `asap` = `41c4dfd` (`step_asap()`, pin `66336807` + #386-#388). Chrome for Testing 153 and Firefox 155.0.1 (update policy installed; the user agent reads 155 on every run), launched by hand, one fresh process and profile per run, **Chrome's chain then Firefox's, never in parallel** (user: a first parallel attempt was discarded). The three arms rotate so that each takes each position twice in 6 repetitions. `MemoryVFS`, 4 000 000 `(a, b)` rows, `poolSize: 1`, each operation timed twice, the **second pass** reported: median of 6 (range). **108 runs, 0 errors, 0 wrong counts.**

| ms, `chunk()` / `stream()` / `chunk()` 5 000 | master | fast | asap | asap/fast |
|---|---|---|---|---|
| Chrome `sync` | 1 257 / 1 266 / 1 077 | 617 / 612 / 453 | 665 (658-745) / 653 / 494 | 1.08 / 1.07 / 1.09 |
| Chrome `async` | 1 529 / 1 530 / 1 375 | 1 021 / 1 041 / 847 | 1 061 / 1 084 / 910 | 1.04 / 1.04 / 1.07 |
| Chrome `jspi` | 2 404 / 2 396 / 2 356 | 1 774 / 1 793 / 1 678 | 1 980 / 1 990 / 1 864 | 1.12 / 1.11 / 1.11 |
| Firefox `sync` | 3 768 / 4 738 / 3 800 | 699 / 1 173 / 457 | 756 / 1 156 / 487 | 1.08 / 0.99 / 1.07 |
| Firefox `async` | 4 863 / 6 189 / 4 706 | 1 754 / 2 682 / 1 556 | 1 824 / 2 735 / 1 560 | 1.04 / 1.02 / 1.00 |
| Firefox `jspi` | 5 709 / 7 059 / 5 523 | 3 605 / 4 474 / 3 586 | 3 718 / 4 629 / 3 740 | 1.03 / 1.03 / 1.04 |

**Reading.** `step_asap()` keeps most of the fast step's gain over wa-sqlite's `step()` (asap/master 0.13-0.83) and costs 0-12 % against the fast step. On `jspi` that is `ccall` (Chrome +11-12 %), which #388 leaves in place because `sqlite-api.js` cannot tell JSPI from Asyncify; the `libadapters.js` way out is offered in the PR. On `sync`, +7-9 % on both engines: `verifyStatement` and the `retry()`/`retryResult()` calls the fast step did without (attributed by wa-sqlite's own decomposition, `docs/upstream/2026-10-23-wa-sqlite-388-step-asap.md`, not re-measured in the library).
