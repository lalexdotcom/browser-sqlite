# A stranded IndexedDB connection on Safari 26.6.2, through the library's own suite — to investigate first (user, 2026-10-20)

Part of `mem:follow-ups`. **The user's order (2026-10-20): investigate this cold, in a new session, before the Safari suite's spec** (`mem:follow-ups/safari-suite`): while it is there a Safari run is red at random, so "everything passes on Safari" cannot be reached, and it may be a defect consumers meet.

## What was seen (SAFARI-LIB-SPIKE, `mem:measurements/test-browsers`)

`conformance safari` (the three conformance files, one Vitest process, one safaridriver session) on GitHub's `macos-latest` (macOS 26.6.2, Safari 26.6.2, 3 cores): **3 runs of 10 failed, every file of the run at once**, with the per-file storage wipe's `This file left storage behind that could not be wiped: IndexedDB "IDBBatchAtomicVFS" (still open after 5000 ms)` (`tests/browser/setup/storage-wipe.ts`); the tests themselves passed (70 passed / 27 skipped in the failed run read). Alone: 1 of 8 runs (the second of two back-to-back runs; five later back-to-back or after-quit runs all passed). With another load on the machine: 2 of 2 — once beside a second Safari session that was refused, once beside `conformance chrome` and `conformance firefox` running at the same time.

## The probable cause — not yet shown

WEBKIT-IDB-TERMINATE (`mem:measurements/test-browsers`): a worker terminated while an IndexedDB transaction is committing keeps its connection for ever, so `deleteDatabase` stays blocked; [WebKit 324094](https://bugs.webkit.org/show_bug.cgi?id=324094), fixed by 321564@main on 2026-09-22, **not in Safari 26.6.2 nor in 27.0.1**. In wa-sqlite's harness, closing the VFS before `terminate()` took the hangs from 8 in 20 to 0 in 20. The library terminates workers without closing the VFS on several paths (read on 2026-10-05): `close()` (sends `close`, the worker finalizes and runs `sqlite3.close`, never the VFS's `close()`), `failClient`, `handleDeath` (open timeout, poisoned worker after a failed rollback), `retireSlot`, and the `deleteDatabase` worker. On 2026-10-05 those paths did not reproduce it on Playwright's WebKit (10/10 per VFS); this is the first time the library's own code is seen to strand a database on a real Safari.

## Not known

- Which test and which termination path leave the connection: the wipe only names the database, the run's last writer is not traced.
- Whether a consumer meets it: a database that can neither be deleted nor, maybe, reopened while the tab lives (a new client on the same name was not tried).
- Whether Safari 27 (JSPI, the other build order) shows it too; a Safari 27 runner image existed as `xcode-27` (STOCK-BROWSERS).

## How to pick it up

- **The reproducer is on origin, branch `spike/safari`** (commits `896c0c3`, `ce106e0`, `bd1df8f`, off `main` `d12f8f6`): `tests/vitest.config.ts` gets Safari projects under `BSQ_SPIKE_SAFARI=1` (headless off, a plain `webdriverio({ capabilities: { browserName: 'safari' } })` provider, no `browsers-setup`), and `.github/workflows/spike-safari.yaml` runs on every push to that branch (`sudo safaridriver --enable`, one build, then scenarios of `node node_modules/vitest/vitest.mjs run … --project 'conformance safari'`, one Vite cache per process, `set +e`). One Safari session at a time per machine: never run two Safari processes at once. ~10 min a round. Delete the branch (local and origin) when the investigation is over.
- First measurements to take: loop `conformance safari` alone and beside a CPU load until the wipe fails, with a trace of each worker's termination (path, whether an IndexedDB transaction was in flight) and of which test last wrote `IDBBatchAtomicVFS`; then the same with the VFS closed before `terminate()` on the path found; then whether a new client on the stranded name can open, write and read.
- Then the user decides: a library change (close the VFS before terminating, where it can), or a skip keyed on the Safari version with its reason (`mem:conventions` § Testing in browsers), or both.
