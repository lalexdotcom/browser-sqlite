# Safari in the library's suite — what its first runs left to fix (2026-10-22)

Part of `mem:follow-ups`. **The wiring is done on `feat/safari-suite`** (spec `docs/superpowers/specs/2026-10-22-safari-suite-design.md`): Safari is a third, opt-in browser (`--browser safari`, `test:safari*`, `test:conformance:safari`, `test:matrix --engine safari`), macOS only, its jobs one at a time, both macOS workflows test `chrome,firefox,safari`. How it works: `mem:stack-and-build`, `mem:stack-and-build/ci`. The numbers: SAFARI-LIB-SUITE, `mem:measurements/test-browsers/library`.

**What comes next (user, 2026-10-22): the Safari fixes, one branch each.** The goal stays the user's of 2026-10-20: every test that applies to Safari passes there; a skip keyed on Safari's version only for a WebKit defect, never for ours.

## Where the first runs' failures went (`fix/safari-held-file`, 2026-10-22)

- **WebKit's name for a held file is matched:** `isHeldElsewhere` (`src/worker/held.ts`) takes `NoModificationAllowedError` and `InvalidStateError`, as wa-sqlite #381/#382 do, in both open-path retries. Fixed `delete` and `vfs-create-retry` on `AccessHandlePoolVFS` (and `long-query` on 27). Runs 39773104130 / 39773107818.
- **A worker killed inside a long statement keeps running on Safari** (WebKit 328618, SAFARI-TERMINATE-WASM): `lifecycle` ×2, `debug`, `long-query` skip with that reason on Safari ≤ 27.0.1, `sync` build, OPFS VFS. The wipe failures on `.wa-sqlite`/`.wa` were that same still-running worker.

## Still open

- **`second-client` "fails the client with that worker's error rather than hanging"** (`OPFSWriteAheadVFS/sync`, Safari 26 and 27): `'still waiting'` at its 10 s bound. Not 328618 — worker 0 is terminated before its first message, no WASM runs. Red before and after the `InvalidStateError` match. Ours until shown otherwise: look at it on its own (what the second worker does once the first is gone, without `readwrite-unsafe`).
- **`lifecycle` "fails the client permanently once the restart budget is spent" on `OPFSAdaptiveVFS/async`** (Safari 26): replacement not ready within the test's 5 s — the intermittent one of SAFARI-IDB-LIB (8/20, on the IndexedDB VFS too), attributed then to Safari's startup time on 3 cores; not analysed.

## Not relying on `terminate()` to stop a busy worker on Safari — not designed (user, 2026-10-22)

Safari's `terminate()` does not stop a worker inside a WASM loop: the worker runs on, holding its OPFS handles, until the loop ends (SAFARI-TERMINATE-WASM, `mem:measurements/test-browsers/library`; a JS loop is stopped at once under WebDriver and on STP 255, not on ordinary Safari 27.0.1). So a slot whose worker the library kills mid-statement (`handleDeath`, a worker presumed dead when it never answers the stop request) cannot reopen until that statement ends — never, for a runaway one. The option: on Safari, stop the statement first and terminate after — `sqlite3_interrupt` through the progress handler on the `async` and `jspi` builds, the interrupt slot under cross-origin isolation on `sync`; **the `sync` build without isolation has no way to interrupt**, which bounds what this can buy. A separate piece (user). To weigh: what the pool waits for before giving up on an interrupt, and whether a held file after a death should then fail fast with a clear error rather than after the retry budget. Reported by the user as WebKit 328618 (2026-10-22); the tests that hit it skip on Safari ≤ 27.0.1 with that reason (`tests/harness/webkit.ts`, `killedStatementRuns()`), so a later Safari runs them again. Ordinary Safari 27.0.1 does not stop a JS loop either (WebDriver sessions and STP 255 do): a plain-JS busy worker is as stuck there.

## Not seen on Safari in these runs

The IndexedDB strand (`mem:follow-ups/safari-idb-stranded`, fixed) did not show: `IDBBatchAtomicVFS` cells green on both OS.
