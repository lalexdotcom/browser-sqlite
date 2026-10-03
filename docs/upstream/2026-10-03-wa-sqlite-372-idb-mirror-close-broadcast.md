# wa-sqlite #372 — a commit that completes after its connection closes

*2026-10-03 — measured on Chromium and Firefox (Playwright 1.62.1), in the container*

[pr372]: https://github.com/rhashimoto/wa-sqlite/pull/372
[pr371]: 2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md

**Why this is here.** On `IDBMirrorVFS` with `synchronous=normal`, a connection that closes right after a commit never tells the other connections about it. They keep reading the database as it was before that commit until they write, and their first write fails with `SQLITE_BUSY` when there is no busy timeout. The commit itself is stored. In this library, that is a client on `IDBMirrorVFS` with `synchronous: 'NORMAL'` in `pragmas` that calls `close()` right after a write, while another client (another tab) has the same database open. On Chromium, an uncaught `InvalidStateError` also reaches the page. Carried in [`patches/`](../../patches) since 2026-10-03, together with [#371][pr371].

## How it was found

While testing [#371][pr371]: its test worker closed a connection right after a `synchronous=normal` commit, and `#commitTx`'s `oncomplete` threw `InvalidStateError` from `BroadcastChannel.postMessage`. `jClose` closes the channel without waiting for the commits in flight. In #371's design matrix the error showed in 6 runs of 8 on `master` too, so #371's worker waits for pending commits before closing, and the defect was left for a PR of its own.

The error looked harmless: the commit is stored, only its broadcast is lost. Reading `jLock` said otherwise. A connection checks IndexedDB for newer transactions only when it takes `RESERVED`, so a lost broadcast leaves a connection that only reads on its old view indefinitely.

## Reproduced

wa-sqlite `7fcc30df`, wa-sqlite's own runner, one worker per connection. Connection A sets `synchronous=normal`, inserts a row and closes in the same worker message; connection B, open all along, only reads. 6 runs per cell, Chromium and Firefox, asyncify and jspi: 24 runs per row.

| scenario on `master` | uncaught error in A | B sees the row (300 ms, 1.3 s) | B's first write | row stored |
| --- | --- | --- | --- | --- |
| A's worker lives on | `InvalidStateError`, 24 of 24 | never | `database is locked`, then the row is there | 24 of 24 |
| A's worker is terminated right after the close | none | never | (same) | 24 of 24 |

With a busy timeout, SQLite retries B's first write itself and the application sees nothing; without one it gets `SQLITE_BUSY` once (24 of 24, with and without `BEGIN IMMEDIATE`). Both engines throw: "Channel is closed" on Chromium, "no longer usable" on Firefox.

## Three fixes, measured side by side

Same probe, 24 runs per cell:

| arm | uncaught error | B sees the row, worker alive | B sees the row, worker terminated |
| --- | --- | --- | --- |
| `master` | 24 of 24 | 0 of 24 | 0 of 24 |
| S — skip the broadcast once the file is closed | 0 | 0 of 24 | 0 of 24 |
| D — post on a new channel from `oncomplete` once closed | 0 | 24 of 24 | 10 of 24 |
| **W — `jClose` waits for the commits in flight (sent)** | **0** | **24 of 24** | **24 of 24** |

S silences the error and keeps the defect. D depends on `oncomplete` running in a context that may already be gone. W sends the broadcast before the close returns, so the context's fate no longer matters. With D and W, B already sees the row at 300 ms.

## What it costs

`close` waits only for commits still in flight. Median close time in ms, 45 runs per cell (15 × 3 runs interleaved with `master`), machine idle:

| commit, then close at once (`normal`) | Chromium asyncify | Chromium jspi | Firefox asyncify | Firefox jspi |
| --- | --- | --- | --- | --- |
| one row | 0.5 → 0.5 | 0.3 → 0.4 | 0 → 0 | 0 → 0 |
| one row, close 300 ms later | 0.7 → 0.7 | 1.3 → 1.2 | 1 → 1 | 1 → 1 |
| 2000 rows of 500 bytes | 0.4 → 34.6 | 0.2 → 27.0 | 0 → 10 | 0 → 9 |

After the large commit, statement plus close take about what the statement alone takes with `synchronous=full`: 38-52 ms against 43-50 ms on Chromium, 73-77 ms against 75-77 ms on Firefox. The statements themselves do not change. Firefox rounds `performance.now()` to the millisecond in a worker.

## The test

`test/vfs_close_broadcast.js` and its worker, wired into `test/IDBMirrorVFS.test.js`: A sets `synchronous`, inserts and closes in one message, optionally terminated right after; B must see the row within a second without writing; A must report no uncaught error. On `master` the four `normal` tests fail on both builds and both engines (`Expected 1 to be 2.`, plus `Expected $.length = 1 to equal 0.` for the error); the `full` ones pass there too. With the change, the file's 108 tests pass 3 of 3 on both engines; the whole suite passes on Chromium (6192).

On Firefox the whole suite shows three failures and a timeout that `master` shows too: `OPFSWriteAheadVFS`'s `vfs_read_freshness` cannot open its second connection there, and `sql.test.js` hangs (the hang reproduced on `master` alone; the `IDBMirrorVFS` part of that file passes in 7-8 s, 3 of 3, on both). Neither is mentioned in the PR.

## In this library

Measured through `createSQLiteClient`: client A with `synchronous: 'normal'`, client B reading, A writes then `close()`. The library's `close()` terminates the worker right after the worker's `closed` reply, so this is the terminated case. 8 runs per cell; Chromium jspi and async, Firefox async.

| `IDBMirrorVFS` | B stale after A's close | B's next write | error in the page |
| --- | --- | --- | --- |
| the pin with #371 only | 8 of 24 (Chromium 7/16, Firefox 1/8) | `BUSY: database is locked` in those 8 | `InvalidStateError`, 4 of 16 on Chromium |
| with W on top of #371 | 0 of 24 | always succeeds | none |
| `synchronous: 'full'`, either | 0 of 24 | always succeeds | none |

The worker error reaches the page because the pool's `worker.onerror` does not cancel it. A first reading of these runs took B's 2 rows for a lost update; B's write had in fact failed with `BUSY`, and a fresh client counted A's row before it (48 of 48).

## Posted upstream

PR [#372][pr372], opened 2026-10-03 from `lalexdotcom:fix/idb-mirror-close-broadcast`, on `master` at `7fcc30df`: the fix (`a9811d75`), then the tests (`69e00270`). Based on `master` rather than on #371 so that the maintainer chooses the merge order (user). The description states the conflict with #371 — the `File` constructor, `jClose` and the end of `#commitTx` — and that we rebase whichever is merged second (user). It does not mention this library.

## Carried with #371

The patch carries `IDBMirrorVFS.js` as #371's head `3367cb65` plus #372. The two conflict in `jClose` only; the resolution waits for the commits in flight first, then removes the journal of an aborted view, so that a commit that aborts during the wait is seen. Both PRs' tests run together on the merged file: 226 of 226, 3 of 3, Chromium and Firefox. The installed `src/` equals that file on the pin; `dist/` is the pin's.

## What stays ours

- **The carry.** Until #371 and #372 merge; the second to merge gets the rebase.
- **The probes.** Throwaway, kept outside git; the numbers are in `mem:measurements` (IDBMIRROR-CLOSE-BROADCAST).
