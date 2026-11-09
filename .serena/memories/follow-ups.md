# Follow-ups — the backlog, as an index

**One follow-up, one memory (user, 2026-10-26).** Every entry lives in its own sub-memory `mem:follow-ups/<name>`, and this file is only the index, so no entry has to fit under another's size limit.

**The status is in both places, and each entry stands on its own (user, 2026-10-26).** The index gives every entry's status, so whether it is done can be read here without opening it; the entry repeats it on a `**Status: …**` line right under its title, so it can be read alone. Change both in the same edit. Statuses: **OPEN**; **IDEA** (not planned for the short or medium term — keep it, do not present it as pending scope or as "the next thing", user 2026-09-03); **DORMANT** (waits for an event and needs no action until it comes; not part of the backlog and not listed when the user asks for it, user 2026-10-03); **DEFERRED** (moved to a later version, with the date and the reason; not part of the current release's scope, user 2026-11-02); **RECORD** (notes, nothing to fix); **CLOSED** (with the date and the branch or merge that closed it). A closed entry moves to § Closed in the same edit.

**An entry waiting on a bug we filed is presented only if that bug has moved (user, 2026-11-02).** Such a row says "bug-gated", names the bug and the state last seen. When listing the backlog, check each gated bug first (e.g. `curl -s "https://bugs.webkit.org/rest/bug/<id>?include_fields=status,resolution,last_change_time"` and its comments): unchanged since the state recorded → leave the entry out of the list; changed (a comment, an assignee, a status, a fix) → present it with what moved, then update the recorded state.

**The current release: no big feature, but fine-tuning of the existing API is fine (user, 2026-11-06).** Bugfixes were the priority of rc.11 (published 2026-11-03), which is where "bugfix only, no new feature, no new behaviour" (user, 2026-11-02) applied; since then, avoid adding a big feature, but an adjustment of the existing API — such as `deleteDatabase` options (`mem:follow-ups/delete-database-wait`) — is not ruled out. The entries DEFERRED on 2026-11-02 below stay deferred as the user decided them.

**Never delete an entry; mark it (user, 2026-10-26).** A closed follow-up keeps its memory and its row, with the status CLOSED: deleting it breaks the links that point to it. Inside an entry, the text above the status line is what the follow-up was; update the status rather than rewriting the history of it. `CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers, `mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## Open — the library

| Memory | Subject | Status |
|---|---|---|
| `lifecycle-restart-held` | A restarted worker meets its predecessor's held file | OPEN — fixed for Firefox (2026-10-21), WriteAhead on Firefox tested (2026-11-02); Safari open. **Bug-gated: WebKit 328618**, last seen 2026-11-02: NEW, unassigned, InRadar since 2026-10-30, no comment |
| `multi-client-bulkwrite-interleave` | `multi-client` bulkWrite interleave failure, chromium `IDBMirrorVFS/async` | OPEN — seen once, not reproducible; act at the next sighting |
| `debug-run-stage` | A `run` sub-status of a busy worker (debug-only, on the model of `boot`); `BootStage` as codes, not text | CLOSED 2026-11-05 — `feat/debug-run-stage` merged |
| `debug-verdict-visibility` | A first `all()`/`run()`/`chunk()`/`stream()` compiles in its verdict, outside any debug query: its wait and compile show in no stage | CLOSED 2026-11-05 — merged with `feat/debug-run-stage` (a request `kind: 'verdict'`) |
| `delete-database-wait` | `deleteDatabase` waits for an open in progress instead of refusing with `BUSY` (an option, default unchanged) | OPEN — the Windows `TIMEOUT`s diagnosed (an unused VFS instance, not a hold) and fixed on `fix/delete-without-vfs` (2026-11-06); `wait`/`timeout` options not designed, kept in the backlog (user, 2026-11-06) |
| `idb-unknown-error-delete` | `deleteDatabase` fails with an IndexedDB `UnknownError` (`WORKER_CRASHED`) in a test cleanup, Windows Firefox `IDBMirrorVFS/jspi` | OPEN — reproduced 1 in 18 whole cells (2026-11-06), at a client's open too, not only a deletion; a startup with no slot open is never retried (`src/client.ts`); second diagnostic pass running (2026-11-09) |
| `upstream-delete-api` | Ask wa-sqlite whether a VFS should offer a database deletion, or list a database's resources, instead of the library duplicating that knowledge | OPEN — the user's idea (2026-11-06); a discussion to open after `fix/delete-without-vfs` |

## Open — tests and CI

| Memory | Subject | Status |
|---|---|---|
| `false-greens-remaining` | Tests that can still pass without exercising their case (`abort-slot`, `early-exit`), and what the starved-runner work left open (`tx-timeout` on Windows, a file lost when a worker never starts, the library's unscaled budgets, the matrices not re-run) | OPEN — 2026-11-05; the four tests fixed (`feat/debug-run-stage`, merged), the rest open |
| `library-stock-browsers` | What stays open after the Vitest + WebdriverIO migration | OPEN — the iOS simulator, the WASM built once |
| `safari-suite` | Safari in the library's suite | OPEN — green on Safari 26/27 since 2026-10-23; WebKit 328618's remainder (issue #10). **Bug-gated: WebKit 328618**, last seen 2026-11-02: NEW, unassigned, InRadar since 2026-10-30, no comment |
| `macos-worker-startup` | Worker startups of 10-15 s on the macOS 26 runner: the runner's, or the users'? | OPEN — backlog (user, 2026-11-03); the user's Mac fast on Safari 27.2 (STARTUP-PROBE-MAC); the Safari case fits SAFARI-WASM-INSTANTIATE; Chrome stalls a plain worker over 10 s there (rerun 41714043416, 20/22) |
| `macos-ci-instability` | macOS workflows fail without a library cause: timers ~5× slower in Chrome and Firefox than on Linux (not in Safari), a lost Safari session | OPEN — low priority: the runner's, not macOS's (user's Mac fast); `BSQ_TIME_SCALE=2` on macOS since 2026-10-26; runner cause and Safari sessions open |

## Open — upstream (wa-sqlite)

| Memory | Subject | Status |
|---|---|---|
| `wa-sqlite-webdriver-pr` | wa-sqlite's suite on stock browsers (Discussion #373) | OPEN — accepted 2026-10-10; the PR is ours to send |
| `wa-sqlite-386-coopsync-bfcache` | `OPFSCoopSyncVFS.create()` after a bfcache navigation (#362, PR #386) | OPEN — PR open, waiting for review; the library-side navigation test dropped 2026-11-02 (the library does not reach #362 there, with or without #386) |
| `wa-sqlite-387-idb-factory` | `getIDBFactory` and `prefix` for the IndexedDB VFS (PR #387) | OPEN — PR open, waiting for review |
| `safari-async-slowdown` | Safari's `async` build slows down after a few seconds of work | OPEN — cause: JSC's OMG tier on the Asyncify `sqlite3VdbeExec`. **Bug-gated: WebKit 329813**, last seen 2026-11-02: NEW, filed that day, no comment |
| `wa-sqlite-389-adaptive-journal` | `OPFSAdaptiveVFS` keeps its journal's access handle between transactions (PR #389) | OPEN — PR open, waiting for review |
| `wa-sqlite-393-coopsync-hot-journal` | Carry PR #393 (not ours): `OPFSCoopSyncVFS` misses a hot journal left by a connection terminated mid-transaction, so another tab's open connection reads it half-applied (issue #392) | OPEN — 2026-11-06: to test, then carry in `patches/`; PR open, not reviewed |

## Deferred — a later version

| Memory | Subject | Status |
|---|---|---|
| `named-params` | Params as an object, bound by name | DEFERRED — 2026-11-02 (user): a new feature, after the bugfix release; not designed |
| `bulkwrite-types` | More `types` values for `bulkWrite()` | DEFERRED — 2026-11-02 (user): a new feature, after the bugfix release; not designed |
| `jspi-before-sync` | `jspi` before `sync` in the build order | DEFERRED — 2026-11-02 (user): a change of default, after the bugfix release; measurements owed |
| `bfcache-auto-suspend` | The client closes its workers when the page enters the back/forward cache and restarts them when it comes back (Safari keeps a cached page's locks: the next page times out or crashes) | DEFERRED — 2026-11-02 (user): a new behaviour, after the bugfix release; costs listed, not designed |
| `temp-store-anycontext` | `temp_store = MEMORY` by default on `OPFSAnyContextVFS` | DEFERRED — 2026-11-02 (user): a change of default, after the bugfix release; WASM heap unmeasured |

## Ideas

| Memory | Subject | Status |
|---|---|---|
| `idea-client-watcher` | A real watcher on a database's clients | IDEA |
| `idea-shared-wasm-module` | One compiled `WebAssembly.Module` for the pool | IDEA |
| `idea-params-buffer-recycling` | Recycling the params buffer through `done` | IDEA |
| `idea-binary-buffer-strategy` | Buffer strategy of the binary blocks, a measurement if questioned | IDEA |
| `idea-timed-flush` | A timed flush for `bulkWrite()` | IDEA |

## Dormant and records

| Memory | Subject | Status |
|---|---|---|
| `dormant` | Entries waiting on an event: `open-retry` on Firefox, wa-sqlite #297 `trace_v2` | DORMANT |
| `notes` | What was examined and closed or kept on purpose, and what to do if it comes back | RECORD |

## Closed

| Memory | Subject | Status |
|---|---|---|
| `matrix-windows-macos` | The matrix on Windows and macOS | CLOSED — 2026-11-03, `ci/matrix-os`: `matrix.yaml` a module called by CI, `matrix-<os>.yaml` by hand (Safari on macOS); Windows and macOS 27 green, macOS 26 red on runner speed (`macos-ci-instability`) |
| `ci-live-progress` | Reading a GitHub run's progress from `gh` while it runs (logs come only at job end) | CLOSED — 2026-11-03, `feat/ci-live-progress`: a progress check run per planner on CI (`[n/N]` lines, each failed test as it fails), `scripts/ci-watch.ts` to follow it |
| `test-plan-windows-file-arg` | On Windows `scripts/test-plan.ts` rejects every file argument (`collectFamily` compared `resolve()`'s `\` with Vitest's `/`) | CLOSED — 2026-11-02, `fix/test-plan-windows-file-arg`: compared as relative paths, unit-tested under `path.win32`, verified on `windows-latest` (run 41459385537) |
| `wa-step-upstream` | A cheaper `step()` upstream (#383, PR #388) | CLOSED — 2026-11-02, `build/repin-wa-sqlite-e4f54a0`: #388 merged upstream (`e4f54a05`), repinned, dropped from the patch |
| `firefox-opfs-fsync` | Firefox + OPFS metadata fsyncs; the 30 s default open timeout on Windows Firefox | CLOSED — 2026-10-30: the per-commit journal cycle fixed upstream (wa-sqlite #389, carried); the 30 s default open timeout kept, a second CoopSync client opening in 0.9-3.2 s on Windows Firefox |
| `tx-abort-race-window` | An abort fired during a savepointed statement's post is missed (`makeAbortRace` never tests `aborted`) | CLOSED — 2026-10-29, `fix/tx-abort-race-window`: `makeAbortRace` rejects at once on a fired signal |
| `time-based-tests` | Tests waiting on time where an event or a state would do; time only as a timeout (user) | CLOSED — 2026-10-29, `test/next-task-yields` and `test/time-based-a-b`: waits on states, time only as timeouts, each step re-falsified |
| `stale-falsifiers` | Three browser tests no mutation of their subject turns red (`abandon`, `abandon-transaction`, `chunk-delivery`) | CLOSED — 2026-10-29, `test/stale-falsifiers`: falsifiers diagnosed and written, one test added |
| `safari27-running-wait` | On Safari 27, routing tests waiting for a long statement to run time out (never seen `RUNNING`) | CLOSED — 2026-10-28, `fix/safari27-wait-yield`: Safari 27 ran the test page's timers once a second (SAFARI27-TIMER-1HZ); `waitUntil` now polls on a message, macOS 27 green twice; why Safari throttles not known |
| `timeout-start` | When a call's `timeout` starts counting (call vs first `next()`) | CLOSED — 2026-10-26, `fix/timeout-from-call`, merged: from the call everywhere |
| `tx-validation` | `tx.read()`/`tx.write()`/`tx.first()` threw on a bad argument | CLOSED — 2026-10-26, `fix/tx-api-consistency`, merged |
| `sqlite-routing` | One `run()` routed by SQLite's own read/write diagnosis, to stream a write's `RETURNING`; holds the `sqlite3_stmt_readonly` entry | CLOSED — 2026-10-28, `feat/sqlite-routing` merged; its parked ideas stay in the entry |
| `tx-read-methods-write` | Read methods that wrote inside a transaction | CLOSED — 2026-10-26, `fix/tx-api-consistency`, merged |
| `worker-js-exception` | A worker's JS exception with no `SQLiteError` code | CLOSED — 2026-10-26, `fix/tx-api-consistency`, merged, `WORKER_ERROR` |
| `close-test-falsifier` | `close.test.ts`'s refuted falsifier | CLOSED — 2026-10-26, `test/close-queued-promptly` |
| `failed-client-probe-memo` | `failed-client.test.ts` under `--full` | CLOSED — 2026-10-26, `test/failed-client-probe-memo` |
| `windows-ci-minors` | Deferred minors of the Windows/macOS CI review | CLOSED — 2026-10-26, `ci/windows-minors` |
| `held-handle-lock-order` | A terminated worker frees its Web Lock before its file (#381, #382) | CLOSED — 2026-10-23, both merged and pinned |
| `ci-workflows` | Linux through `tests.yaml`, `tests-ubuntu.yaml`, a `browsers` input | CLOSED — merged as `3d9d94c` |
| `safari-idb-stranded` | A stranded IndexedDB connection on Safari 26 | CLOSED — merged as `f4a07b3` |
| `test-planner-design` | The browser-suite planner's design decisions | CLOSED — done 2026-10-13; kept as the record |
| `matrix-2026-09` | What the matrix showed in September, and how its piles were read | CLOSED — resolved 2026-09-21; kept for its method |
