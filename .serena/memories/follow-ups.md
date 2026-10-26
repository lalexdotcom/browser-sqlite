# Follow-ups — the backlog, as an index

**One follow-up, one memory (user, 2026-10-26).** Every entry lives in its own sub-memory `mem:follow-ups/<name>`, and this file is only the index, so no entry has to fit under another's size limit.

**The status is in both places, and each entry stands on its own (user, 2026-10-26).** The index gives every entry's status, so whether it is done can be read here without opening it; the entry repeats it on a `**Status: …**` line right under its title, so it can be read alone. Change both in the same edit. Statuses: **OPEN**; **IDEA** (not planned for the short or medium term — keep it, do not present it as pending scope or as "the next thing", user 2026-09-03); **DORMANT** (waits for an event and needs no action until it comes; not part of the backlog and not listed when the user asks for it, user 2026-10-03); **RECORD** (notes, nothing to fix); **CLOSED** (with the date and the branch or merge that closed it).

**Never delete an entry; mark it (user, 2026-10-26).** A closed follow-up keeps its memory and its row, with the status CLOSED: deleting it breaks the links that point to it. Inside an entry, the text above the status line is what the follow-up was; update the status rather than rewriting the history of it. `CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers, `mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## Open — the library

| Memory | Subject | Status |
|---|---|---|
| `sqlite-routing` | One `run()` routed by SQLite's own read/write diagnosis, to stream a write's `RETURNING`; holds the `sqlite3_stmt_readonly` entry | OPEN — designed in outline by the user; large and breaking, after the small workstreams (2026-10-26) |
| `named-params` | Params as an object, bound by name | OPEN — not designed |
| `bulkwrite-types` | More `types` values for `bulkWrite()` | OPEN — not designed |
| `jspi-before-sync` | `jspi` before `sync` in the build order | OPEN — to examine; measurements owed |
| `temp-store-anycontext` | `temp_store = MEMORY` by default on `OPFSAnyContextVFS` | OPEN — to weigh; WASM heap unmeasured |
| `firefox-opfs-fsync` | Firefox + OPFS metadata fsyncs; the 30 s default open timeout on Windows Firefox | OPEN — count metadata operations per VFS first; timeout decision owed |
| `lifecycle-restart-held` | A restarted worker meets its predecessor's held file | OPEN — fixed for Firefox (2026-10-21); Safari open (WebKit 328618); WriteAhead on Firefox untested |
| `safari-async-slowdown` | Safari's `async` build slows after long statements | OPEN — an upstream report (wa-sqlite or WebKit) owed |
| `multi-client-bulkwrite-interleave` | `multi-client` bulkWrite interleave failure, chromium `IDBMirrorVFS/async` | OPEN — seen once, not reproducible; act at the next sighting |

## Open — tests and CI

| Memory | Subject | Status |
|---|---|---|
| `library-stock-browsers` | What stays open after the Vitest + WebdriverIO migration | OPEN — the iOS simulator, the WASM built once |
| `safari-suite` | Safari in the library's suite | OPEN — green on Safari 26/27 since 2026-10-23; WebKit 328618's remainder (issue #10) |
| `matrix-windows-macos` | The matrix on Windows and macOS | OPEN — later (user, 2026-10-15) |
| `macos-ci-instability` | macOS workflows fail without a library cause: timers ~5× slower in Chrome and Firefox than on Linux (not in Safari), a lost Safari session | OPEN — being investigated; next: a `setTimeout(0)` probe with App Nap off (2026-10-26) |
| `ci-live-progress` | Reading a GitHub run's progress from `gh` while it runs (logs come only at job end) | OPEN — not designed; recommended: a progress check run the planner updates |

## Open — upstream (wa-sqlite)

| Memory | Subject | Status |
|---|---|---|
| `wa-sqlite-webdriver-pr` | wa-sqlite's suite on stock browsers (Discussion #373) | OPEN — accepted 2026-10-10; the PR is ours to send |
| `wa-step-upstream` | A cheaper `step()` upstream (#383, PR #388) | OPEN — #388 open; revision committed locally, waiting for rhashimoto's answer |
| `wa-sqlite-386-coopsync-bfcache` | `OPFSCoopSyncVFS.create()` after a bfcache navigation (#362, PR #386) | OPEN — PR open; a browser test of the real navigation to do |
| `wa-sqlite-387-idb-factory` | `getIDBFactory` and `prefix` for the IndexedDB VFS (PR #387) | OPEN — PR open, waiting for review |

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
| `timeout-start` | When a call's `timeout` starts counting (call vs first `next()`) | CLOSED — 2026-10-26, `fix/timeout-from-call`, merged: from the call everywhere |
| `tx-validation` | `tx.read()`/`tx.write()`/`tx.first()` threw on a bad argument | CLOSED — 2026-10-26, `fix/tx-api-consistency`, merged |
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
