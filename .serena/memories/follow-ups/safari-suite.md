# Safari in the library's suite — what its first runs left to fix (2026-10-22)

Part of `mem:follow-ups`. **The wiring is done on `feat/safari-suite`** (spec `docs/superpowers/specs/2026-10-22-safari-suite-design.md`): Safari is a third, opt-in browser (`--browser safari`, `test:safari*`, `test:conformance:safari`, `test:matrix --engine safari`), macOS only, its jobs one at a time, both macOS workflows test `chrome,firefox,safari`. How it works: `mem:stack-and-build`, `mem:stack-and-build/ci`. The numbers: SAFARI-LIB-SUITE, `mem:measurements/test-browsers/library`.

**What comes next (user, 2026-10-22): the Safari fixes, one branch each.** The goal stays the user's of 2026-10-20: every test that applies to Safari passes there; a skip keyed on Safari's version only for a WebKit defect, never for ours.

## Where the first runs' failures went (`fix/safari-held-file`, 2026-10-22)

- **WebKit's name for a held file is matched:** `isHeldElsewhere` (`src/worker/held.ts`) takes `NoModificationAllowedError` and `InvalidStateError`, as wa-sqlite #381/#382 do, in both open-path retries. Fixed `delete` and `vfs-create-retry` on `AccessHandlePoolVFS` (and `long-query` on 27). Runs 39773104130 / 39773107818.
- **A worker killed inside a long statement keeps running on Safari** (WebKit 328618, SAFARI-TERMINATE-WASM): `lifecycle` ×2, `debug`, `long-query` skip with that reason on Safari ≤ 27.0.1, `sync` build, OPFS VFS. The wipe failures on `.wa-sqlite`/`.wa` were that same still-running worker.
- **`fix/safari-restart-budget` (2026-10-23):** `lifecycle`'s restart-budget test gave its replacement 5 s, and Safari stalls a worker's wasm instantiation 1-11 s after hot wasm (SAFARI-WASM-INSTANTIATE): the bound is now the library's 30 s. And three `lifecycle` tests not skipped on `OPFSWriteAheadVFS/sync` killed their worker 100 ms into `longQuery(20M)`; on Safari 27 the still-running worker held `.wa-sqlite`/`.wa` past the file's wipe. They kill on `longQuery(2M)` now. Full macOS 27 run green, 523/523 (run 39944455281).

## WebKit 328618 — what stays open (2026-10-23)

`feat/safari-busy-terminate` (2026-10-23) stops a killed worker's statement through the abort slot under cross-origin isolation (`KILLED_SLOT`), and elsewhere lets the replacement wait for the held file up to `openTimeout`, then fail with a `WORKER_CRASHED` that names the cause. The four tests skipped for 328618 now skip only off isolation, and run green on isolated Safari 27. **What stays open is WebKit's**: the `sync` build without isolation cannot stop the statement. Tracked for consumers in [issue #10](https://github.com/lalexdotcom/browser-sqlite/issues/10) (user, 2026-10-23: a browser bug stays out of the README). When a Safari past 27.0.1 ships the fix, run the macOS workflows and close #10.

## Not seen on Safari in these runs

The IndexedDB strand (`mem:follow-ups/safari-idb-stranded`, fixed) did not show: `IDBBatchAtomicVFS` cells green on both OS.
