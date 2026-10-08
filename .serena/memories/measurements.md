# Measurements — every number, with its date and method

**Rules for this file.** A number enters only with a date, a method and the machine it was
taken on. Correct an entry in place when it is re-measured; do not append a contradicting
one. A number nobody can reproduce is a story, not a measurement — say so in the entry.

The entries live in the sub-memories below, by theme, each in the order it was written. **A new entry goes in the sub-memory of its theme**; this index gets its line.

## `mem:measurements/test-browsers` — wa-sqlite's suite across browsers and CI runners (Discussion #373)

- STOCK-BROWSERS
- SAFARI26-DATAVIEW-RACE
- SAFARI26-IDBMIRROR-KILL
- IOS-SIMULATOR
- WEBKIT-IDB-TERMINATE
- WA-WEBKIT-SUITE
- WA-FIREFOX-SQL-HANG

## `mem:measurements/wa-sqlite-prs` — the campaigns behind wa-sqlite PRs

- 363-ERROR-PATH
- 369-XCLOSE
- IDBMIRROR-COMMIT-ABORT
- IDBMIRROR-ABORT-JOURNAL
- IDBMIRROR-ABORT-DESIGNS
- IDBMIRROR-ABORT-RELOAD-ON-REFUSAL
- IDBMIRROR-CLOSE-BROADCAST
- IDB-JOURNAL
- 363-SYNC-OFF
- 351-REVIEW-2
- 352-353-REVIEW
- 351-PERSIST
- RETRY-OPS
- VFS-PILES

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

## `mem:measurements/transactions` — transactions, aborts, the write lock

- TX-M1M2
- TX-SAVEPOINT
- TX-AUTOCOMMIT
- TX-HANDLE
- TX-M1
- TX-QUIESCE
- Query interruption
- ABANDON-RESTART
- ABANDON-WEDGE
- WRITELOCK-STUCK
- GEN-ABORT
- TX-CONTROL-GUARD
- SAVEPOINT-STACK

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
- FF-JUGGLER

## `mem:measurements/binary-protocol` — the binary protocol between page and worker

- BULK-BINARY
- BINARY-PROTOCOL
- RESULT-BINARY
- TEXT-EXTERNAL
- RESULT-BINARY-DELIVERY

## `mem:measurements/suite-and-matrix` — the test suite, the matrix, the Firefox harness

- LIFECYCLE-INIT-RACE
- INSECURE-CONTEXT
- RSTEST-OTR
- REUSE-LOAD
- CI-QUERY-TIMEOUT
- MATRIX-1
- MATRIX-2
- MATRIX-3
- MATRIX-5
- MATRIX-DEFAULT-BUILD
- GETDIR-HANG closed
- LIFECYCLE-SEGV
- WORKER-LEAK
