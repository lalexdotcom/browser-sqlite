# wa-sqlite #371 — a commit whose IndexedDB transaction aborts

*2026-10-03 — measured on Chromium and Firefox (Playwright 1.62.1), in the container*

[pr371]: https://github.com/rhashimoto/wa-sqlite/pull/371
[pr363]: 2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md

**Why this is here.** On `IDBMirrorVFS`, a commit whose IndexedDB transaction aborts (a quota error, for instance) was never undone. With `synchronous=full` its rows came back with the connection's next commit. With `synchronous=normal` the next commit was stored on top of a state that never existed, and the database was left corrupt. In this library, that is any client on `IDBMirrorVFS` that hits its storage quota. Carried in [`patches/`](../../patches) since the repin of 2026-10-03.

## How it was found

The question came while answering a review on [#363][pr363]: does the error path fixed there exist in `IDBMirrorVFS` too? Its main-database writes go to an in-memory `txActive` and cannot fail. The one place that can fail is `#commitTx`, whose IndexedDB transaction may abort. Reading it showed three things:
- it applies the transaction to the view (`#acceptTx`, `#setView`) before the IndexedDB transaction completes;
- it awaits that transaction only with `synchronous=full`;
- it undoes nothing when the transaction aborts.

rhashimoto accepted the PR when it was offered on #363 ("Yes, please, if you're up for that.").

## Reproduced

All probes run in wa-sqlite's own runner, with one worker per connection. The worker patches `IDBTransaction.prototype.commit` so that the next read-write transaction aborts instead, optionally after being kept alive for 300 ms. On `master`:

| case | `synchronous=full` | `synchronous=normal` |
| --- | --- | --- |
| the aborted commit | `SQLITE_IOERR` | `SQLITE_OK` (only an unhandled rejection) |
| the connection's next commit | stores the 3 failed rows with its own | stored on top of a state that never existed |
| a new connection | 204 rows: the failed ones are back | `Page 28: never used` |
| the aborted transaction is larger than the cache | — | `database disk image is malformed`, 8 of 8 |

Over the probe matrix (168 probes per version: eleven scenarios, both modes, two builds, two engines, two runs), `master` left 48 stores corrupt. In 48 others, it stored rows from a commit SQLite had reported as failed.

## Five fixes, measured side by side

The first fix sent to the fork failed every call after the abort, as `OPFSPermutedVFS` does. It corrupted the store again on reopen (8 of 8 with `synchronous=normal`). Tracing the VFS calls showed why:
- the failing `jWrite` makes SQLite give up the batch-atomic write and retry the commit with a rollback journal (`sqlite3PagerCommitPhaseOne`, SQLite 3.53.0);
- that journal stays in the VFS's memory;
- the next open plays it back over the stored database.

Same matrix, plus 300-commit timings interleaved with `master`:

| | stores corrupt | connection after the abort | cost |
| --- | --- | --- | --- |
| `master` | 48 / 168 | goes on from a view that was never stored | — |
| fail every call (first fix) | 8 (reopen, `normal`) | dead until reopened | none |
| fail reads, refuse commits, gate, drop the journal on close | 0 | dead until reopened | none measured |
| reload, awaiting the previous commit | 0 | recovers by itself | exclusive `normal` 1.7 to 2 times slower on Chromium |
| reload, gate request on every commit | 0 | recovers by itself | exclusive `full` 15-30 % slower |
| **reload, gate only while a commit is pending (sent)** | **0** | **recovers by itself** | **none measured** |

The user chose the reload design on 2026-10-03, after this comparison.

## What was sent, and why each part

Each part was removed in turn: every part kept makes a test fail on both engines without it, and a part that made none fail was dropped.

| part | why | removing it fails |
| --- | --- | --- |
| writes never fail; `#commitTx` refuses a transaction built on the aborted view | failing in the batch window makes SQLite write a journal | exclusive `normal`, the queued-commit and the journal tests; without it the connection also sees its own refused commits (206 rows) |
| reload from IndexedDB at the next `SHARED` | SQLite validates its cache against the file there | `normal`, normal locking |
| reload in the `full` error path | SQLite discards its cache after a failed commit, in exclusive mode too | `full`, exclusive: the connection stays failed |
| `SQLITE_BUSY` at `RESERVED` while aborted | the transaction has already validated its cache against the lost view; with a busy timeout SQLite releases the lock and retries from `SHARED` (`btreeBeginTrans`), so the application never sees it | `normal`, normal locking: `SQLITE_IOERR` instead |
| a gate request, only while another commit is pending | `IDBTransaction.abort()` throws once `commit()` was called, so queued commits cannot be cancelled from the aborted one | queued-commit test: the update is stored |
| the journal removed on `jClose` of an aborted file | a spilling transaction refused in exclusive `normal` leaves a journal | journal test: the aborted rows are stored, 12 of 12 |

Dropped because removing them changed nothing in the test or the matrix:
- a second check after `#commitTx`'s `await`;
- removing the journal on reload;
- a guard in `#processBroadcasts`.

**What it costs:**
- With `synchronous=normal`, the aborted commit is lost, and so are commits that returned before the connection learned of the abort. The store stays consistent.
- In exclusive locking mode with `synchronous=normal`, the lock is never released, so the view is reloaded only on reopen. Until then commits fail and reads still show the lost commit.
- Timings equal `master` within run-to-run variation, over 9 interleaved runs and every combination of engine, build, mode and locking mode.

## The test

`test/vfs_commit_abort.js` and its worker, wired into `IDBMirrorVFS.test.js`, six tests:
- one aborted commit for each combination of `synchronous` setting and locking mode;
- a commit queued behind the aborted one;
- a journal written on the aborted view.

On `master` all six fail, on both builds and both engines. With the change, the file's 190 tests pass, 3 runs of 3, on Chromium and Firefox, and the whole suite passes (6274, 0 failed). The probe matrix shows 0 stores corrupt.

The worker lets pending commits finish before closing. Closing right after a `normal` commit makes `#commitTx`'s `oncomplete` post on a closed `BroadcastChannel` (`InvalidStateError`). That happens on `master` too and is not part of this PR.

## Posted upstream

PR [#371][pr371], opened 2026-10-03 from `lalexdotcom:fix/idb-mirror-commit-abort`. It has two commits on `master` at `7fcc30df` (#370's merge): the fix (`1844c761`), then the tests (`1f7b2533`). The branch had first held the fail-every-call commits, pushed but never proposed. It was rebuilt from `master` and force-pushed before opening (user, 2026-10-03). The body explains each choice and its rejected alternative, and opens with "This one turned out trickier than I expected 😅" (user). It does not mention this library. Upstream CI on the head commit is green: [run 37137339446](https://github.com/rhashimoto/wa-sqlite/actions/runs/37137339446), `build (20.x)`, the only check.

## Revised the same day: exclusive `normal` recovers too

As opened, the PR left one avoidable cost: in exclusive locking mode with `synchronous=normal`, the connection failed every commit until it was reopened. The lock is never released there, so the view is never reloaded at `SHARED`. But SQLite discards its cache after a refused commit's `SQLITE_IOERR`, in exclusive mode too, which allows a reload at that point. Measured on 12 runs per cell (2 builds × 2 engines × 3), with an immediate or a delayed abort, and with and without a transaction larger than the cache:

| arm | refused ordinary commit | refused transaction that had spilled to a journal |
| --- | --- | --- |
| as opened | dead until reopen | dead until reopen |
| reload at every refusal | one `SQLITE_IOERR`, then recovers | **aborted rows stored, or "malformed" / "Page 28: never used", 12 of 12** |
| the same, and the journal removed on reload | same | same corruption |
| **reload unless the database has a journal (sent)** | **one `SQLITE_IOERR`, then recovers** | dead until reopen; store clean |

The corruption comes from SQLite rolling the refused transaction back through the journal it already holds open. That writes the lost view's pages over the reloaded one, and the next commit stores them. Removing the journal from the VFS's map does not stop a rollback through an open handle.

Sent as `3367cb65` on 2026-10-03, on the user's go, with [comment 5971457674](https://github.com/rhashimoto/wa-sqlite/pull/371#issuecomment-5971457674). The description's costs, change list and ablation table were updated to match. The exclusive `normal` test now expects the next insert to succeed without a reopen. It fails without the commit, and the journal test fails without the journal condition. The file's 190 tests pass 3 of 3 on both engines, the suite passes (6274), and the matrix shows 0 stores corrupt out of 168. Upstream CI on `3367cb65` is green: [run 37139391822](https://github.com/rhashimoto/wa-sqlite/actions/runs/37139391822). The same day, the description's sentence on lost commits was narrowed to exclusive mode (user).

## What stays ours

- **The carry.** Since the repin of 2026-10-03 to `7fcc30df`, [`patches/`](../../patches) carries this PR alone: `IDBMirrorVFS.js` at head `3367cb65`.
- **The broadcast on a closed channel.** A separate defect, a possible separate PR.
- **The probes.** Throwaway, kept outside git; the numbers are in `mem:measurements` (IDBMIRROR-COMMIT-ABORT, IDBMIRROR-ABORT-JOURNAL, IDBMIRROR-ABORT-DESIGNS).
