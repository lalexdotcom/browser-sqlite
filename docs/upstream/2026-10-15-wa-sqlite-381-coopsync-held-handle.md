# wa-sqlite #381 — `OPFSCoopSyncVFS` fails a statement with a raw DOM error after a terminated connection

*2026-10-15 — measured on Chrome 153, Firefox 155/156 and Safari 26.6.2/27.0.1, on GitHub Actions runners (Linux, Windows, macOS) and in the container*

[pr381]: https://github.com/rhashimoto/wa-sqlite/pull/381

**Why this is here.** A worker terminated while it holds OPFS sync access handles releases its Web Lock at once and its handles only later. `OPFSCoopSyncVFS` hands its handle over between connections through that lock: the connection granted it next called `createSyncAccessHandle()` once, got `NoModificationAllowedError` (`InvalidStateError` in WebKit), and `#requestAccessHandle()` rethrew it from a retry operation, so it left the SQLite call as a raw exception. This library terminates a worker whose open misses its timeout, and turns a worker's JS exception into an `Error` with no code (`statementError`, `src/pool.ts`): a client sharing the database then saw `undefined: No modification allowed`.

## How it was found

The Windows CI of `ci/windows-macos` (2026-10-15, run 38693552137): `coopsync-handover` › "two clients opened together fail no statement" on Firefox reported 12 × `TIMEOUT` (the library's 30 s open timeout, Firefox paying OPFS fsyncs on every hand-over, Mozilla bug 2072928) and 2 × an error with no code. The path was read in the code (`#requestAccessHandle` → `retry()` → the worker's `{ message }` reply → `statementError`), then the cause probed with a page using only OPFS and Web Locks (`scripts/probe-handover.ts` at `6050a53` on `ci/windows-macos`, throwaway, removed since): a clean close-then-release never races (0/30 on six browser/OS pairs); a holder TERMINATED with its handle open does, everywhere — B's first attempt failed 3-29 times in 30, the file free after at most 8-40 ms on Chrome and on Firefox on Linux and macOS, **956 ms on Firefox on Windows** (holder terminated inside a JS loop; 411 ms inside WebAssembly). Safari 26.6.2 released with the lock when the holder was terminated while awaiting or in a JS loop, never terminated a worker spinning in pure WebAssembly, and showed the race in the suite's test (holder terminated inside a SQLite call). Safari's `removeEntry` on a held file succeeds. Full numbers: `mem:follow-ups` (§ A worker terminated with an open sync access handle…).

The same race was already known on this side as HANDLE-CORPSE (`mem:vfs`, 2026-09-18): the library retries `create()` and `sqlite3_open_v2` on `NoModificationAllowedError` for 10 s. No wa-sqlite VFS retried a held file; upstream names it only in its test harness (`maybeReset`, `vfs_open_last_error`).

## The change

Once `#requestAccessHandle()` holds the lock, a `NoModificationAllowedError` or `InvalidStateError` from `createSyncAccessHandle()` is retried: the handles that attempt got are closed, the lock is kept, every 10 ms for up to 5 s (first written with 1 s, raised once Windows Firefox measured 956 ms). Any other error is thrown at once. Cost: a file held outside the protocol fails after 5 s instead of immediately; the open path still reports `SQLITE_CANTOPEN` with its `lastError`. Both names, because WebKit throws `InvalidStateError` where Chromium and Firefox throw `NoModificationAllowedError`.

## The test

In `test/vfs_handover.js`: B opens a database, A opens it and starts a long query, B queues a query on the lock, A's worker is terminated directly (not through `TestContext.destroy()`, which the #373 test PR plans to make close the VFS first — that would close cleanly and remove the race), 10 rounds per build. A first version leaned on `destroy()`; a second let a failing round outlast its 60 s timeout on Windows Firefox and keep its workers running into the next tests, which failed in cascade (Jasmine runs in random order, so the report order misled): each round is now bounded and cleans up in a `finally`.

On `master`: Chrome Linux 10/10 on default, asyncify and jspi; Firefox 155 Linux 10/10 ×3; Firefox 156 Windows 10/10 ×3; Safari 26.6.2 default 2/10, asyncify 7/10 (no JSPI); Safari 27.0.1 default 3/10, asyncify 3/10, jspi 0/10. With the change, `OPFSCoopSyncVFS.test.js` passes on all of them (123, or 82 on Safari 26), and the whole suite on Chrome (6315). The Firefox and Safari runs used a throwaway branch on the fork (`probe/held-handle`, the WebDriver harness of `probe/stock-browsers`) and ran with the 1 s bound; a longer bound can only keep them green.

## Posted upstream

PR [#381][pr381], opened 2026-10-15 from `lalexdotcom:opfscoopsync-retry-held-handle`, on `master` at `6238f532`: the fix (`cb2ed6e4`), the test made independent of `destroy()` (`147357f1`), bounded rounds (`a79a5ea6`), the 5 s bound (`3c75a3c8`). The body, cut by the user to the essentials, carries no measurement: it says the race reproduces in Chrome, Firefox and Safari, most reliably in Firefox, especially on Windows, and that `OPFSAdaptiveVFS`, which hands its handle over the same way without `readwrite-unsafe`, is being looked into separately. It does not mention this library. Upstream CI on the head commit: [run 38714899901](https://github.com/rhashimoto/wa-sqlite/actions/runs/38714899901), pending at the time of writing.

## What stays ours

- **No carry yet.** The fix is not in [`patches/`](../../patches); the library's own retries (HANDLE-CORPSE) still cover the open path. Once #381 is merged and pinned, `openWithRetry` is redundant for `OPFSCoopSyncVFS`; `createVfsInstance`'s retry stays for `AccessHandlePoolVFS`.
- **The library side, open:** a worker's JS exception reaches the caller with no `SQLiteError` code (`mem:follow-ups`); the library's `HELD_ELSEWHERE` matches `NoModificationAllowedError` only, so not WebKit's `InvalidStateError`; and `coopsync-handover`'s "two clients opened together" is skipped on Firefox on Windows until Mozilla bug 2072928 or the hand-over cost is solved.
