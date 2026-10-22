# Measurements — every number, with its date and method

**Rules for this file.** A number enters only with a date, a method and the machine it was
taken on. Correct an entry in place when it is re-measured; do not append a contradicting
one. A number nobody can reproduce is a story, not a measurement — say so in the entry.

The entries live in the sub-memories below, by theme, each in the order it was written. **A new entry goes in the sub-memory of its theme**; this index gets its line.

## `mem:measurements/test-browsers` — test harnesses across browsers and CI runners, an index of two sub-memories (split 2026-10-22)

### `mem:measurements/test-browsers/wa-sqlite` — wa-sqlite's own suite (Discussion #373)

- STOCK-BROWSERS
- SAFARI26-DATAVIEW-RACE
- SAFARI26-IDBMIRROR-KILL
- IOS-SIMULATOR
- WEBKIT-IDB-TERMINATE
- WA-WEBKIT-SUITE
- WA-FIREFOX-SQL-HANG
- PW-OPFS-QUOTA — Chromium's ephemeral context masks its quota and stops writes near 2 GB; a persistent one does not

### `mem:measurements/test-browsers/library` — the library's own suite (Vitest + WebdriverIO)

- LIB-VITEST-SPIKE — the library's own tests on Vitest + WebdriverIO, stock Chrome 153 / Firefox 155
- LIB-WIN-MAC — the library's suites on GitHub's Windows and macOS runners: durations, counts, what Windows needed
- BROWSERS-INSTALLER — the single installer: cold and warm cost, the runners, and LOCK-MACOS (the lock's two macOS defects)
- SAFARI-LIB-SPIKE — the library's suite on Safari 26.6.2 through safaridriver: one session per machine, beside the others, after a kill, and the stranded IndexedDB connection
- SAFARI-IDB-STRAND — what strands an IndexedDB connection on Safari 26 (a worker ended before its last transaction's `complete`), the library path that does it (the delete worker), the wait that removes it (0/71), its cost (none detectable), STP 27.0 clean
- SAFARI-IDB-LIB — the library's pair suite on Safari 26's IndexedDB VFS, one session per file: stock 45/75 files strand on IDBBatchAtomicVFS, fix 0/75; forced kills strand 3-22 % per kill with the fix, 0/800 with the quiesce; the two non-IndexedDB failures
- SAFARI-LIB-SUITE — the whole suite on Safari 26.6.2 / 27.0.1 through the planner: 7 failures per OS, all a killed worker and its file (`InvalidStateError`), conformance green; the two wiring defects found on the way

## `mem:measurements/ci-runners` — the library's suites on CI runners, from macOS 26/27 on

- MACOS-26-27 — the first runs of `tests-macos-26.yaml` / `tests-macos-27.yaml`: 26 green, 27 red twice then green with the fix
- TXQ-ABORT-TIMER — `tx-quiesce`'s abort test raced a `sleep(0)` that Firefox ran 26-105 ms late after its shard's other files; reproduced on macOS 26, fixed by aborting on the first chunk
- LIFECYCLE-HELD-PROBE — whether a restarted worker meets its predecessor's held file: 0 in 130 looped runs and 3 probed full suites; only `pool-cap`'s live holder held an open

## `mem:measurements/wa-sqlite-prs` — the campaigns behind wa-sqlite PRs

- IDB-CLOSE-384
- 363-ERROR-PATH
- 369-XCLOSE
- IDB-JOURNAL
- 363-SYNC-OFF
- 351-REVIEW-2
- 352-353-REVIEW
- 351-PERSIST
- RETRY-OPS
- VFS-PILES

## `mem:measurements/idbmirror` — `IDBMirrorVFS`: an aborted commit, a close with a commit in flight (#371, #372)

- IDBMIRROR-COMMIT-ABORT
- IDBMIRROR-ABORT-JOURNAL
- IDBMIRROR-ABORT-DESIGNS
- IDBMIRROR-ABORT-RELOAD-ON-REFUSAL
- IDBMIRROR-CLOSE-BROADCAST

## `mem:measurements/writeahead` — `OPFSWriteAheadVFS`: checkpoint, page size, read freshness

- 365-LIB
- 365-WORST
- BARRIER-DATA
- AUTOCHECKPOINT-LATENCY
- AUTOCHECKPOINT-THRESHOLD
- HANDLE-MODE
- PAGE-SIZE
- CHECKPOINT-COALESCE
- CHECKPOINT-DIRECT
- CHECKPOINT-PLAN
- CUT-RATIO
- WAL-COMPAT
- BEGIN-DEFERRED

## `mem:measurements/opfs-handles` — OPFS access handles, pool caps, leaks

- LEAK-LIB
- COOPSYNC-OPEN-CLOSED
- SAFARI-CAP
- WORKER-LOST
- POOL-SIZE
- HANDLE-1 measured per VFS
- Handle starvation reproduces deterministically
- HANDLE-ORPHAN
- HANDLE-2 does not reproduce
- HANDLE-CORPSE
- ADAPTIVE-JSPI-SAFARI
- SAFARI-OPFS
- HELD-LIVE

## `mem:measurements/held-handles` — a file still held after its holder let go: OPFS cost per operation, the terminated-holder race, #381 and #382

- OPFS-PROBE — each OPFS file operation per browser and OS: Firefox on Windows 40-220 ms
- HANDOVER-PROBE — a terminated holder frees its Web Lock before its file, on every engine and OS
- COOPSYNC-381-WINDOWS — two CoopSync clients on Windows Firefox with #381 carried: no failed statement, 25-60 s an attempt
- ADAPTIVE-382 — `OPFSAdaptiveVFS` after a terminated holder: B hangs and the lock stays held on Firefox, 0 with the change

## `mem:measurements/transactions` — transactions

- TX-M1M2
- TX-SAVEPOINT
- TX-AUTOCOMMIT
- TX-HANDLE
- TX-M1
- TX-QUIESCE
- TX-CONTROL-GUARD
- SAVEPOINT-STACK

## `mem:measurements/aborts` — interruption, abandoned generators, the write lock

- Query interruption
- ABANDON-RESTART
- ABANDON-WEDGE
- WRITELOCK-STUCK
- GEN-ABORT

## `mem:measurements/cross-tab-and-delete` — cross-tab coordination, Web Locks, deletion

- PRAGMA-BUSY
- DELETE-WA
- Web Locks priced
- Cross-tab coordination priced as COUNTS
- Two clients on a `multiConnection: false` VFS
- DELETE-LIVE
- `navigator.locks.query()` counts shared holders one by one
- A delete cannot slip past a client under construction
- CROSS-VFS
- EXISTS-PROBE
- Delete campaign
- `deleteDatabase` hangs
- SECOND-CLIENT

## `mem:measurements/scheduler-and-pool` — scheduler, barrier, pool and streaming

- LEASE-QUIESCE
- Cross-connection staleness
- The barrier's domain
- Writer stickiness released
- Back-pressure (BP-1)
- Concurrent reads by VFS
- Last-writer routing
- COOPSYNC-BUSY
- The eviction churn, priced
- The write designation DOES migrate
- The gate's cost is linear in `poolSize`
- The readiness gate, measured 2026-08-31 (Chromium 151 / Firefox 153, this container)
- `no-read-inside-transaction` per VFS, 2026-08-31
- The dropped chunk

## `mem:measurements/statement-cache-and-perf` — statement cache, pragmas, builds, performance

- Published artifact sizes
- Statement-cache gain
- Statement-cache bound in BYTES
- Per-VFS default PRAGMAs
- CACHE-BYTES settled
- Performance backlog closed
- The `sync` build against the `async` build
- JSPI-VS-SYNC — `jspi` walks rows as fast as `sync`
- JSPI-SYNC-RELAYS
- BULK-VALUES — converting cells in `enqueue()` costs nothing; JSONB faster on Chromium, slower on Firefox
- FAST-STEP — the library's own step against `main`, stock Chrome 153 / Firefox 158: `chunk()` of 4 000 000 rows −49 % / −80 % on `sync`, every VFS faster, one-row queries unchanged

## `mem:measurements/bench-and-devices` — the bench page, devices, browsers, bundlers

- IDB-SIGNAL
- Engine capabilities
- Device campaign
- MIRROR-1
- Browser baseline
- Bundler matrix
- Safari campaign
- VFS-MEDIAN
- Numbers that are one observation, not a measurement
- REOPEN-1 does not reproduce
- BENCH-SWEEP campaign

## `mem:measurements/footprint` — memory and disk per VFS, `bulkWrite` release

- FOOTPRINT-METHOD
- FOOTPRINT-REST
- FOOTPRINT-DISK
- BULK-RELEASE
- BULK-PLATEAU
- BULK-GC
- STREAM-FF
- FF-PW-AWAIT
- STREAM-GEN
- STREAM-ITER — the hand-written iterator in the library, measured at 207925e (supersedes 971dc38 and 59ab530), stock Chrome 153 / Firefox 155: `stream()` of 4 000 000 rows −49 % / −75 % on `sync`, `tx.stream()` −30 % / −76 %, `chunk()` unchanged; Chrome `jspi` only an indication
- FF-JUGGLER

## `mem:measurements/binary-protocol` — the binary protocol between page and worker

- BULK-BINARY
- BINARY-PROTOCOL
- RESULT-BINARY
- TEXT-EXTERNAL
- RESULT-BINARY-DELIVERY

## `mem:measurements/suite-and-matrix` — the test suite, the matrix, the Firefox harness

- PARALLEL-RUNS — several Vitest processes at once: `pnpm test` 519 s to 105 s, the matrix 6187 s to 765 s
- MATRIX-VITEST
- LIFECYCLE-INIT-RACE
- INSECURE-CONTEXT
- RSTEST-OTR
- REUSE-LOAD
- CI-QUERY-TIMEOUT
- MATRIX-TRIAGE (MATRIX-1, -2, -3, -5)
- MATRIX-DEFAULT-BUILD
- GETDIR-HANG closed
- LIFECYCLE-SEGV
- WORKER-LEAK
