# VFS — the nine, and what is true of each

**`VFS_CAPABILITIES` in `src/types.ts` is the single source of truth.** The client guard,
the conformance suite, the README generator and the benchmark page all read it; one wrong
field propagates everywhere. `SQLiteVFS` derives from its keys, so adding a VFS without a
loader fails to compile. Read the table in the source — this file holds only what the
table cannot say.

Numbers live in `mem:measurements`.

## The rules that shape the table

- **`vfs` is required, and `RECOMMENDED_VFS` (`OPFSAdaptiveVFS`) is deliberately not
  exported.** The name must live in the consumer's own source. Rationale in `mem:state`.
- **Every declared (vfs, build) pair is executed, never trusted.** `tests/conformance/`
  runs all of them plus six invariants. Declaring a combination that does not work is the
  failure that suite exists to catch — `IDBMirrorVFS` was the row most at risk, its builds
  having been inferred from its source because upstream's table omits it.
- **Every VFS is constructed with `{ lockPolicy: 'shared' }`** (`worker/worker.ts:159`) —
  upstream's recommendation in rhashimoto/wa-sqlite#302 for exactly our shape. It reaches
  `WebLocksMixin`. **`OPFSCoopSyncVFS` does not extend `WebLocksMixin`** — it implements
  `jLock`/`jUnlock` itself and silently ignores the option.
- **`poolSize` multiplies the footprint whatever the VFS**, since every worker holds its
  own page cache. Default `poolSize` is 2.
- **Journal mode and durability are not ours to default (2026-08-31).** Upstream's own
  table, `node_modules/wa-sqlite/src/examples/README.md`, gives write-ahead logging to
  `OPFSWriteAheadVFS` alone — and there it is implemented *inside* the VFS, always on,
  not reachable through `PRAGMA journal_mode`. `AccessHandlePoolVFS` accepts
  `journal_mode=wal` only under `locking_mode=exclusive`, i.e. `poolSize: 1`.
  `OPFSAdaptiveVFS` without multiple access handles allows only `delete`, `memory` and
  `off`. No VFS shipped here implements `xShmMap`. Relaxed durability
  (`synchronous=normal`) is declared by three: `IDBBatchAtomicVFS`, `IDBMirrorVFS`,
  `OPFSWriteAheadVFS`. **So a universal default PRAGMA set of WAL + NORMAL was dropped**:
  it would buy nothing on six VFS and trade durability in silence on three — the shape
  DEFAULT-1 already rejected, arrived at from the other direction. The one sourced lever
  left is `cache_size` on `IDBBatchAtomicVFS`, whose batch-atomic mode needs a cache large
  enough to hold the journal; that is a documented recommendation, never a default.

## Per-VFS, beyond the table

| VFS | What you cannot read off the table |
|---|---|
| **`OPFSAdaptiveVFS`** *(recommended)* | The one general-purpose choice. Detects `readwrite-unsafe` and degrades correctly without it — but degraded means one exclusive handle rotated between workers, i.e. HANDLE-1 below. Best where it shines, merely degraded elsewhere, never broken. |
| **`OPFSWriteAheadVFS`** | It used to declare `requires: ['readwrite-unsafe']`, and this table used to state, as observed fact, that the pool breaks without it. **Both were inferred and never executed** — the declaration caused the conformance skip, and the skip kept the declaration from being falsified. Measured false on Firefox and on Safari 26.6 / 27.0 / iPadOS 27.0 (2026-08-27): it opens and passes every invariant, and **degrades exactly like `OPFSAdaptiveVFS` — read-burst ≈ 1.00, no concurrency at all**. So outside Chromium it earns nothing over the default. One real defect remains: `sync` cannot reopen on Safari 27 (REOPEN-1). |
| **`OPFSCoopSyncVFS`** | Holds one *exclusive* handle and rotates it — so a pool buys no concurrency here. `SQLITE_BUSY` is its transfer protocol, not an error: `jLock` returns it while a handle request is in flight and expects a retry, and **we never retry** (no `busy_timeout` is applied anywhere). We turn a protocol step into a user-visible failure. Its only distinguishing combination is OPFS + `poolSize > 1` outside Chromium — which is exactly the combination that fails. |
| **`AccessHandlePoolVFS`** | `poolSize: 1`, guarded synchronously at construction. Stores **every** database in one OPFS directory named after the class, holding `DEFAULT_CAPACITY = 6` files with `Math.random()` names. `jDelete` is the only correct removal; deleting the file by name matches nothing and frees no slot. **Two clients on one database silently break at least one of them — see AHP-2TAB below.** |
| **`IDBBatchAtomicVFS`** | **The only persistent multi-connection VFS working on all three desktop engines.** Escapes HANDLE-1 structurally — no handle at all. Its page cache has a floor: upstream notes the cache must be large enough to hold the journal. |
| **`IDBMirrorVFS`** | Declared `multiConnection: false`, `maxPoolSize: 1` — **measured, not inferred**. **But `multiConnection: false` does not mean "isolated from other clients":** two clients on one database DO share data here, immediately, over the origin-wide `BroadcastChannel` (3/3 both engines, isolated runs, 2026-09-01). The flag marks concurrent-writer unsafety, which MIRROR-1 measures under load. Whole database in RAM per worker, commits propagated over `BroadcastChannel` asynchronously; the barrier cannot rescue it because there is nothing fresher on a connection whose mirror has not received the broadcast. Stores in one IndexedDB database named after the class. |
| **`OPFSAnyContextVFS`** | Escapes HANDLE-1 structurally (File API, not sync handles). Needed a WebKit fix — see ANYCONTEXT-1 below. |
| **`MemoryVFS` / `MemoryAsyncVFS`** | Volatile, single connection, whole database in RAM. |

`OPFSPermutedVFS` is **gone from the codebase** — removed, not deprecated in place
(merge `be314db`, 2026-08-20): 24 % stale cross-connection reads, and deprecated upstream
(rhashimoto/wa-sqlite#317). `grep -rn Permuted src/ README.md tests/` returns nothing.

## AHP-2TAB — `AccessHandlePoolVFS` is not multi-tab, and it does not say so

Measured 2026-09-01, n=3 per engine; numbers in `mem:measurements`. **Pre-existing — the
cross-tab work did not cause it, it only made someone look.**

Two clients on one database, created before either queries: **the second resolves `SELECT 1`
and cannot read any table**, 6 runs of 6. It looks healthy and is useless. And **which client
loses the handle race is non-deterministic — it is sometimes the first one**, so two concurrent
clients leave at least one broken client and sometimes two.

**No cheap probe detects it.** `SELECT 1` touches no file. `SELECT count(*) FROM sqlite_master`
— the barrier statement — returns 0 on a frozen empty view rather than erroring. Anything that
verifies an open by running a statement will pass.

Created sequentially instead, the second client fails cleanly with `WORKER_CRASHED` (3/3, both
engines), and closing the first lets it in. **Match on the code, never the message:** Chromium
names `createSyncAccessHandle`, Firefox says "No modification allowed".

**Guarded since 2026-09-01.** `VFS_CAPABILITIES` gained `exclusiveConnection`, true for this
VFS alone, and a client on such a VFS holds `bsq:conn:<ns>:<file>` exclusively for its whole
life — taken with `ifAvailable`, so a second client fails its first query with `BUSY`
immediately rather than stalling. `acquireInstrumented` is where it is awaited, for the same
reason everything else in this area lives there: it is the one choke point every method passes
through.

**The predicate is `exclusiveConnection`, NOT `!multiConnection`.** `IDBMirrorVFS` declares
`multiConnection: false` and is deliberately left unguarded, because it genuinely shares data
between clients (measured). The two flags mean different things and conflating them would lock
out a working VFS.

**Two things the implementation needed that the design did not foresee.** Worker spawning is
deferred until the connection lock settles — on Firefox a worker that opens OPFS handles while
another client holds them crashes before the `BUSY` check can fire, so the guard has to run
first. And `close()` yields one event-loop turn after releasing the lock: Web Locks exposes no
"lock freed" notification, so there is no condition to await and a fixed one-turn yield is the
only way the next client sees the release. **The deferral cost a Critical defect on the way in**
— `close()` empties the pool *before* awaiting that promise, so a `close()` called before the
first query left a live orphan worker holding handles for thirty seconds, delivering exactly
the `WORKER_CRASHED` the guard replaces. Fixed by not spawning at all once `closing` is set.

## HANDLE-1 — the limit that shapes every recommendation

**Without `readwrite-unsafe` there is one exclusive OPFS access handle, rotated between
connections over a `BroadcastChannel`.** A worker inside a single long `sqlite3_step()`
never returns to its event loop, so it can never answer the hand-over request. **One
abandoned long query degrades the entire pool to serial for its full duration**, and since
a `step()` cannot be cut short there is no remedy at our layer.

**The dividing line is the synchronous access handle, not `readwrite-unsafe`** — so the
obvious "just use CoopSync on Firefox" is wrong: CoopSync rotates one exclusive handle too.
The three that escape structurally are `IDBBatchAtomicVFS`, `IDBMirrorVFS` and
`OPFSAnyContextVFS`.

It is a race, not a certainty, and a genuine Heisenbug: instrumenting it can shift the
race and turn the failure green. Trust the unperturbed run.

## ANYCONTEXT-1 — closed 2026-08-25, and the cause is worth carrying

WebKit's `FileSystemWritableFileStream.write()` **ignores a typed array view's
`byteOffset` and `byteLength` and writes the entire underlying `ArrayBuffer`**.
`OPFSAnyContextVFS.jWrite` passes `pData.subarray()` — a window into the WASM heap — so
every 4 KiB page landed as a multi-megabyte splat and the database header did not survive
the second write. Hence `SQLITE_NOTADB` at `opens`. The fix is one word: `pData.slice()`,
which keeps the Proxy unwrapping that `subarray()` was there for and copies exactly the
page. Shipped in `patches/wa-sqlite@1.1.1.patch`; upstream PR pushed but not opened.

## DEFAULT-1 — a platform-dependent default was considered and rejected

Decided 2026-08-25 by the user. Recorded because the idea is attractive and will come back.

The measurements make per-platform detection look obviously right. **It was rejected for a
reason that has nothing to do with performance: the VFS decides where the data is
written.** A default resolved by detection moves the moment detection changes its mind —
Firefox ships `readwrite-unsafe`, the choice swings, and the existing database becomes
invisible. The bytes are still there, in a VFS nothing queries any more. From the user's
side that is silent data loss triggered by a browser update nobody asked for. Staying on
"whichever VFS created this database" does not save it: identifying that would mean probing
all nine, which is expensive and ambiguous.

An API that *returns* a recommendation for the application to pass explicitly was floated
and also dropped — the default is universal and works everywhere, so a second mechanism
earns nothing. **The benchmark page is what answers "which one here"**, and the README
links to it prominently.

## Memory footprint — one axis, not the governing one

The user started the project to stop loading large data structures into RAM, and assumes
other consumers arrive for the same reason. **But it is one criterion among several** —
the user corrected exactly that over-weighting on 2026-08-24. A VFS that is frugal and slow
is as useless as one that is fast and enormous. The axes are footprint, throughput,
latency, whether the pool actually runs concurrently, durability, and browser
compatibility. **No axis vetoes on its own.** What the library owes a consumer is every
cursor made visible, not a ranking — which is also why the benchmark page names the best
candidate *per criterion* and never an aggregate score.

Footprint earns a declared field anyway, for a narrower reason: it is the one axis a
consumer cannot otherwise see at all, where builds, concurrency and persistence are at
least discoverable.
