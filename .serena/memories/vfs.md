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

## Per-VFS, beyond the table

| VFS | What you cannot read off the table |
|---|---|
| **`OPFSAdaptiveVFS`** *(recommended)* | The one general-purpose choice. Detects `readwrite-unsafe` and degrades correctly without it — but degraded means one exclusive handle rotated between workers, i.e. HANDLE-1 below. Best where it shines, merely degraded elsewhere, never broken. |
| **`OPFSWriteAheadVFS`** | Requires `readwrite-unsafe`, which **cannot be probed synchronously** (`UNPROBEABLE` in `capabilities.ts`), so the client guard cannot catch it. Off Chromium the first connection opens, the second cannot take the handle, and the pool breaks with no error naming the cause. Documented in Known Limitations; that is the only defence it has. |
| **`OPFSCoopSyncVFS`** | Holds one *exclusive* handle and rotates it — so a pool buys no concurrency here. `SQLITE_BUSY` is its transfer protocol, not an error: `jLock` returns it while a handle request is in flight and expects a retry, and **we never retry** (no `busy_timeout` is applied anywhere). We turn a protocol step into a user-visible failure. Its only distinguishing combination is OPFS + `poolSize > 1` outside Chromium — which is exactly the combination that fails. |
| **`AccessHandlePoolVFS`** | `poolSize: 1`, guarded synchronously at construction. Stores **every** database in one OPFS directory named after the class, holding `DEFAULT_CAPACITY = 6` files with `Math.random()` names — see RESIDUE-1 and DELETE-1 in `mem:follow-ups`. `jDelete` is the only correct removal; deleting the file by name matches nothing and frees no slot. |
| **`IDBBatchAtomicVFS`** | **The only persistent multi-connection VFS working on all three desktop engines.** Escapes HANDLE-1 structurally — no handle at all. Its page cache has a floor: upstream notes the cache must be large enough to hold the journal. |
| **`IDBMirrorVFS`** | Declared `multiConnection: false`, `maxPoolSize: 1` — **measured, not inferred**. Whole database in RAM per worker, commits propagated over `BroadcastChannel` asynchronously; the barrier cannot rescue it because there is nothing fresher on a connection whose mirror has not received the broadcast. Stores in one IndexedDB database named after the class. |
| **`OPFSAnyContextVFS`** | Escapes HANDLE-1 structurally (File API, not sync handles). Needed a WebKit fix — see ANYCONTEXT-1 below. |
| **`MemoryVFS` / `MemoryAsyncVFS`** | Volatile, single connection, whole database in RAM. |

`OPFSPermutedVFS` is **gone from the codebase** — removed, not deprecated in place
(merge `be314db`, 2026-08-20): 24 % stale cross-connection reads, and deprecated upstream
(rhashimoto/wa-sqlite#317). `grep -rn Permuted src/ README.md tests/` returns nothing.

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
