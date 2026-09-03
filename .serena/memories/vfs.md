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
- **Under `lockPolicy: 'shared'`, exactly one lock transition can return
  `SQLITE_BUSY` (read from `WebLocksMixin`, 2026-09-03).** A reader taking SHARED
  acquires `gate` then `access` **without `ifAvailable`**, and `lockTimeout` is left at its
  default `Infinity` — so a reader meeting a writer **waits**; it never fails. A writer going
  RESERVED → EXCLUSIVE also waits. The one polling acquisition is SHARED → RESERVED
  (`POLL_EXCLUSIVE`), which returns `SQLITE_BUSY` when another connection already holds
  RESERVED — two would-be writers, and upstream's comment there says the loser "must retry".
  **rc.5's origin-wide write lock closes that path**: writers are serialized across every
  client and tab, so two connections cannot both be in that transition. Hence **a default
  `busy_timeout` has no path to act on for the eight VFS that use the mixin**, and it was
  dropped for that reason rather than on taste. `OPFSCoopSyncVFS` does not extend the mixin
  and none of this applies to it.

  Upstream also exposes **`lockTimeout`** beside `lockPolicy` — it aborts the Web Lock request
  through an `AbortController`, so the waiting happens at the locks layer, asynchronously,
  instead of in SQLite's *sleeping* busy handler. We do not set it. It converts an indefinite
  wait into an error, which is a different product question, adjacent to `openTimeout`.

- **`poolSize` multiplies the footprint whatever the VFS**, since every worker holds its
  own page cache. Default `poolSize` is 2.
- **Journal mode and durability are not ours to default — with exactly one exception
  (2026-08-31, amended 2026-09-02).** Upstream's own table,
  `node_modules/wa-sqlite/src/examples/README.md`, gives write-ahead logging to
  `OPFSWriteAheadVFS` alone — and there it is implemented *inside* the VFS, always on, not
  reachable through `PRAGMA journal_mode`. `OPFSAdaptiveVFS` without multiple access handles
  allows only `delete`, `memory` and `off`. **No VFS shipped here implements `xShmMap`**, so
  SQLite's own WAL is unavailable except where `locking_mode=exclusive` lets it run without
  shared memory. Relaxed durability (`synchronous=normal`) is declared by three:
  `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSWriteAheadVFS` — and it is never ours to set,
  because it spends the consumer's data rather than their milliseconds. **So a universal
  default set of WAL + NORMAL stays dropped**: it would buy nothing on six VFS and trade
  durability in silence on three.

  **The exception is `AccessHandlePoolVFS`, and it ships:** `locking_mode=exclusive` +
  `journal_mode=wal`, declared in `VFS_CAPABILITIES.defaultPragmas` and applied by
  `resolvePragmas`. That VFS is single-connection by construction, which is what makes
  exclusive locking free and SQLite's WAL reachable. **~4.7x on write-transaction overhead,
  measured on both engines, with no capacity or durability cost** — `mem:measurements`.

- **`cache_size` is NOT the lever this file used to call it (measured 2026-09-02).** The
  claim was that it is the one sourced per-VFS lever left, `IDBBatchAtomicVFS`'s batch-atomic
  mode needing a cache large enough to hold the journal. The mode is real and SQLite's
  default does miss it. But **raising the bound costs zero bytes** (it is a cap, not a
  reservation, 30 runs of 30) **and buys no measurable time** — Firefox shows none at all.
  It is a documented recommendation, never a default, and now for a measured reason.

- **Defaults are merged under the consumer's `pragmas`, never substituted for them.** A
  consumer setting `foreign_keys` is answering their own question, not declining the VFS's
  defaults; replacing would silently drop them. Naming a key is how a default is refused.
  The full per-VFS set is generated into the README's VFS table from the same declaration.

## Per-VFS, beyond the table

| VFS | What you cannot read off the table |
|---|---|
| **`OPFSAdaptiveVFS`** *(recommended)* | The one general-purpose choice. Detects `readwrite-unsafe` and degrades correctly without it — but degraded means one exclusive handle rotated between workers, i.e. HANDLE-1 below. Best where it shines, merely degraded elsewhere, never broken. |
| **`OPFSWriteAheadVFS`** | It used to declare `requires: ['readwrite-unsafe']`, and this table used to state, as observed fact, that the pool breaks without it. **Both were inferred and never executed** — the declaration caused the conformance skip, and the skip kept the declaration from being falsified. Measured false on Firefox and on Safari 26.6 / 27.0 / iPadOS 27.0 (2026-08-27): it opens and passes every invariant, and **degrades exactly like `OPFSAdaptiveVFS` — read-burst ≈ 1.00, no concurrency at all**. So outside Chromium it earns nothing over the default. One real defect remains: `sync` cannot reopen on Safari 27 (REOPEN-1). |
| **`OPFSCoopSyncVFS`** | Holds one *exclusive* handle and rotates it — so a pool buys no concurrency here, on **any** engine: `readwrite-unsafe` does nothing for it (HANDLE-1). Its `jLock` returns `SQLITE_BUSY` while a handle request is in flight — its transfer protocol, not an error — and **the library now retries a SQLite-reported busy read once**, which clears it (COOPSYNC-BUSY, `mem:measurements`). Before that fix one ordinary read per session failed, early, **on both engines and at the default `poolSize`** — this row used to say "outside Chromium", which was inferred and measured false. |
| **`AccessHandlePoolVFS`** | `poolSize: 1`, guarded synchronously at construction. Stores **every** database in one OPFS directory named after the class, holding `DEFAULT_CAPACITY = 6` files with `Math.random()` names. `jDelete` is the only correct removal; deleting the file by name matches nothing and frees no slot. **Two clients on one database silently break at least one of them — see AHP-2TAB below.** |
| **`IDBBatchAtomicVFS`** | **The only persistent multi-connection VFS working on all three desktop engines.** Escapes HANDLE-1 structurally — no handle at all. Its page cache has a floor: upstream notes the cache must be large enough to hold the journal. |
| **`IDBMirrorVFS`** | Declared `multiConnection: false`, `maxPoolSize: 1` — **measured, not inferred**. **But `multiConnection: false` does not mean "isolated from other clients":** two clients on one database DO share data here, immediately, over the origin-wide `BroadcastChannel` (3/3 both engines, isolated runs, 2026-09-01). The flag marks concurrent-writer unsafety, which MIRROR-1 measures under load. Whole database in RAM per worker, commits propagated over `BroadcastChannel` asynchronously; the barrier cannot rescue it because there is nothing fresher on a connection whose mirror has not received the broadcast. Stores in one IndexedDB database named after the class. |
| **`OPFSAnyContextVFS`** | Escapes HANDLE-1 structurally (File API, not sync handles). Needed a WebKit fix — see ANYCONTEXT-1 below. |
| **`MemoryVFS` / `MemoryAsyncVFS`** | Volatile, single connection, whole database in RAM. |

`OPFSPermutedVFS` is **gone from the codebase** — removed, not deprecated in place
(merge `be314db`, 2026-08-20): 24 % stale cross-connection reads, and deprecated upstream
(rhashimoto/wa-sqlite#317). `grep -rn Permuted src/ README.md tests/` returns nothing.

## CROSS-VFS — the four `opfs-path` VFS share one file, and deleting proves it

Measured 2026-09-02, n=3 per case per engine, both agreeing; table in `mem:measurements`.

`OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` all resolve one
database name to the same OPFS file. **Deleting through any of them destroys a database created by
any other, and `deleteDatabase` resolves without reporting anything.** Across layout families —
`opfs-path` against `idb-store` or `opfs-pool` — the data survives, as the docs always claimed.

**Reading is a different question from deleting, and the two must not be argued from each other.**
Within the family, three of four read pairs saw each other's data; `OPFSCoopSyncVFS` → `OPFSAdaptiveVFS`
did not, most likely because those two default to different builds (`sync` against `async`) rather
than because of the VFS. Deletion is unaffected either way: it removes a file, it does not read one.

This is why lock names in `locks.ts` derive from `layout` and never from a VFS name. The
documentation had been claiming the opposite of what the lock keys already assumed.

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
