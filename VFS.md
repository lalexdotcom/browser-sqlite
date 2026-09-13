# VFS

[browser-sqlite](README.md) delegates storage to a
[wa-sqlite Virtual File System](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#readme)
(VFS).

**[Run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)** —
which VFS wins depends on the engine, and a single browser release can move the answer.

> [!IMPORTANT]
> **A database belongs to the VFS that wrote it.** It is not visible through
> another — the bytes are still there, but nothing reads them, and changing
> `vfs` migrates nothing.<br>
> The exception is the OPFS VFS that address files by path, which are one store
> between them: <!-- BEGIN GENERATED SHARED VFS — edit `layout` in src/types.ts -->
> `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS`, `OPFSCoopSyncVFS` and `OPFSAnyContextVFS`.
> <!-- END GENERATED SHARED VFS -->

## Contents

<!-- BEGIN GENERATED TOC — headings are the source; run `pnpm docs:vfs` -->

- **[Browser compatibility](#browser-compatibility)**: [Recommendations](#recommendations) · [Per browser](#if-you-can-guarantee-a-browser)
- **[VFS reference](#vfs-reference)**: [OPFSWriteAheadVFS](#opfswriteaheadvfs) · [OPFSAdaptiveVFS](#opfsadaptivevfs) · [OPFSCoopSyncVFS](#opfscoopsyncvfs) · [AccessHandlePoolVFS](#accesshandlepoolvfs) · [IDBBatchAtomicVFS](#idbbatchatomicvfs) · [IDBMirrorVFS](#idbmirrorvfs) · [OPFSAnyContextVFS](#opfsanycontextvfs) · [MemoryVFS](#memoryvfs) · [MemoryAsyncVFS](#memoryasyncvfs)
- **[Builds reference](#builds-reference)**: [sync](#build-sync) · [async](#build-async) · [jspi](#build-jspi)
- **[Concurrency](#concurrency)**: [Concurrent reads](#concurrent-reads) · [Reduced mode](#reduced-mode)

<!-- END GENERATED TOC -->

## Browser compatibility

### Recommendations

**`OPFSWriteAheadVFS` and `OPFSAdaptiveVFS` are both safe and universal
recommendations**, and what separates them is speed and interruptibility, not
correctness.

- **`OPFSWriteAheadVFS`** — faster on every engine we measured, on bulk loads, scans
  and reads alike. Its `sync` build (the default) only stops a running statement when
  your page is cross-origin isolated: without it, an aborted call rejects straight away
  but the statement runs to its end on its worker. `build: 'async'` buys that back
  without touching your hosting, at the cost of the speed it is chosen for.
- **`OPFSAdaptiveVFS`** — it picks its strategy per engine, and its `async` build (the
  default) stops the running statement on every browser, with no headers to set.

### If you can guarantee a browser

You would leave that choice when you control which browser runs your code — an
Electron app, a kiosk, a managed fleet — and need something it cannot give you:

| Browser you can guarantee | [Concurrent reads](#concurrent-reads) | Write-heavy workloads |
|---|---|---|
| Chromium 121+ (Chrome, Edge, Electron…)<br>desktop and mobile | [`OPFSWriteAheadVFS`](#opfswriteaheadvfs) | [`OPFSWriteAheadVFS`](#opfswriteaheadvfs) |
| Firefox 111+ | [`OPFSAnyContextVFS`](#opfsanycontextvfs) | [`OPFSWriteAheadVFS`](#opfswriteaheadvfs) |
| Safari 26+<br>desktop and mobile | [`OPFSAnyContextVFS`](#opfsanycontextvfs) | [`OPFSWriteAheadVFS`](#opfswriteaheadvfs) |

**Where you can guarantee nothing, stay on the recommendation.**
[`IDBBatchAtomicVFS`](#idbbatchatomicvfs) is the only VFS that gains from running
several reads at once on *every* engine, where both recommendations are flat off
Chromium — but it pays an order of magnitude for that on writes. It earns its
place in a read-mostly workload that must run anywhere, and nowhere else.

## VFS reference

What each VFS can do at all. Follow its name for the browser versions it needs
and the rest of its detail; wa-sqlite describes the implementations themselves
on its [VFS page](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#readme).

<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->

| VFS | [`sync`](#build-sync) | [`async`](#build-async) | [`jspi`](#build-jspi) | Pool | Persistent | `readwrite-unsafe` |
|---|---|---|---|---|---|---|
| [`OPFSWriteAheadVFS`](#opfswriteaheadvfs)<br>**(recommended)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [`OPFSAdaptiveVFS`](#opfsadaptivevfs)<br>**(recommended)** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [`OPFSCoopSyncVFS`](#opfscoopsyncvfs) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| [`AccessHandlePoolVFS`](#accesshandlepoolvfs) | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| [`IDBBatchAtomicVFS`](#idbbatchatomicvfs) | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| [`IDBMirrorVFS`](#idbmirrorvfs) | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| [`OPFSAnyContextVFS`](#opfsanycontextvfs) | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| [`MemoryVFS`](#memoryvfs) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| [`MemoryAsyncVFS`](#memoryasyncvfs) | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |

<!-- END GENERATED VFS TABLE -->

### `OPFSWriteAheadVFS`

<!-- BEGIN GENERATED OPFSWriteAheadVFS -->

**Builds:** [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 111+/153+<sup><a href="#reduced-mode">[reduced]</a></sup>, Safari 15.4+/27+<sup><a href="#reduced-mode">[reduced]</a></sup>, Android 109+/?, iOS 15.4+/27+<sup><a href="#reduced-mode">[reduced]</a></sup>

**Pool size:** Any, 1 without `readwrite-unsafe` · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup>

<!-- END GENERATED OPFSWriteAheadVFS -->

Stores the database as one file in OPFS and keeps its own write-ahead log,
implemented inside the VFS rather than through SQLite's own WAL. It is
synchronous, and it wants the `readwrite-unsafe` access-handle mode to run
several connections at speed.

**It takes `readwrite-unsafe` where the engine offers it — Chromium 121+, for now.** There it holds one access handle per connection, and serves a read while a long query runs, on its `sync` build.

**Everywhere else it opens the handle exclusively and rotates it between workers.** A browser without `readwrite-unsafe` ignores the `mode` option rather than rejecting it, so the VFS still works and falls into [reduced mode](#reduced-mode): no read is served while another worker holds the handle, for as long as its statement runs.

Bulk loading is what it is fastest at, on every engine measured.

### `OPFSAdaptiveVFS`

<!-- BEGIN GENERATED OPFSAdaptiveVFS -->

**Builds:** [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 111+/153+<sup><a href="#reduced-mode">[reduced]</a></sup>, Safari 15.4+/27+<sup><a href="#reduced-mode">[reduced]</a></sup>, Android 109+/?, iOS 15.4+/27+<sup><a href="#reduced-mode">[reduced]</a></sup>

**Pool size:** Any · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup>

<!-- END GENERATED OPFSAdaptiveVFS -->

Stores the database as one file in OPFS, reached through synchronous access
handles. Only one access handle may be open on a file at a time, so it closes
and reopens lazily to let a second connection in; where the browser allows
several handles at once it takes that path instead, which is what it adapts to.

### `OPFSCoopSyncVFS`

<!-- BEGIN GENERATED OPFSCoopSyncVFS -->

**Builds:** [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 111+/153+, Safari 15.4+/27+, Android 109+/?, iOS 15.4+/27+

**Pool size:** Any · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup>

<!-- END GENERATED OPFSCoopSyncVFS -->

Stores the database as one file in OPFS, synchronously, and stays filesystem
transparent. It holds a pool of access handles for everything but the main
database and its journal, and closes those two lazily so several connections
can take turns on them.

**It does not read concurrently, and stalls unpredictably under a pool.** It implements its own locking and silently ignores the `lockPolicy: 'shared'` this library constructs every VFS with, holding one *exclusive* access handle and rotating it between workers instead of one per connection. A read issued while a write transaction is open is **never served**: the pool acquisition blocks before any `AbortSignal` is consulted. A bulk insert either finishes promptly or **exceeds 30 seconds**, with no middle ground and no consistency across runs. None of this depends on `readwrite-unsafe`, so it happens on Chromium too.

### `AccessHandlePoolVFS`

<!-- BEGIN GENERATED AccessHandlePoolVFS -->

**Builds:** [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 111+/153+, Safari 15.4+/27+, Android 109+/?, iOS 15.4+/27+

**Pool size:** **1**<sup><a href="#fn-4">[4]</a></sup> · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup> · **Default PRAGMAs:** `locking_mode=exclusive`, `journal_mode=wal`

<!-- END GENERATED AccessHandlePoolVFS -->

Stores the database in OPFS behind a pool of access handles opened up front,
with every method synchronous. Its files are not filesystem transparent — they
cannot be imported or exported directly — which is what buys it
`locking_mode=exclusive` and `journal_mode=wal`.

**`AccessHandlePoolVFS` runs a pool of one.** You do not have to say so — omitting `poolSize` gives you 1 here rather than the usual 2. Passing anything above 1 throws synchronously at client creation time.

**`AccessHandlePoolVFS` allows one connection per origin, not one per tab.** A second client on the same database — in this tab or another — fails its first query with `BUSY`, immediately. Close the first client and the next one opens. An application that expects to be open in two tabs cannot run on it.

### `IDBBatchAtomicVFS`

<!-- BEGIN GENERATED IDBBatchAtomicVFS -->

**Builds:** [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 95+/153+, Safari 15.4+/27+, Android 92+/?, iOS 15.4+/27+

**Pool size:** Any · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup>

<!-- END GENERATED IDBBatchAtomicVFS -->

Stores database pages in IndexedDB, which every context implements, so it is
the general-purpose choice where OPFS is not available. It uses SQLite's
batch-atomic write mode, which needs no separate journal file when the page
cache is large enough to hold the journal.

The **RAM** line above is not the whole story: `PRAGMA cache_size` also decides whether a transaction runs in IndexedDB's
batch-atomic mode. The VFS takes that path only when the cache can hold the
transaction's pages, and falls back silently when it cannot — at SQLite's
default of `-2000` a 5000-page transaction never enters it, on either engine.
Raising the bound reserves nothing up front; the heap grows only as the workload
uses it. **This library sets no default for it**, because raising it saved no
time in either engine — so this is something to know about your own workload,
not a knob to turn on principle.

It holds no exclusive access handle, so [reduced mode](#reduced-mode) does not
apply to it — but it still does not serve a read while a long query runs, on any
engine. See [Concurrent reads](#concurrent-reads).

### `IDBMirrorVFS`

<!-- BEGIN GENERATED IDBMirrorVFS -->

**Builds:** [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 95+/153+, Safari 15.4+/27+, Android 92+/?, iOS 15.4+/27+

**Pool size:** **1**<sup><a href="#fn-5">[5]</a></sup> · **RAM:** Whole database<sup><a href="#fn-3">[3]</a></sup>

<!-- END GENERATED IDBMirrorVFS -->

Keeps every file in memory and persists the database to IndexedDB, so it runs
in any context. It only takes databases that fit in available memory, counted
per worker rather than per origin.

Read-your-own-writes does not hold across tabs here: it mirrors the whole
database in memory per worker and propagates commits asynchronously. See
[Guarantees](README.md#guarantees).

### `OPFSAnyContextVFS`

<!-- BEGIN GENERATED OPFSAnyContextVFS -->

**Builds:** [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 111+/153+, Safari 26+/27+, Android 109+/?, iOS 26+/27+

**Pool size:** Any · **RAM:** Page cache<sup><a href="#fn-2">[2]</a></sup>

<!-- END GENERATED OPFSAnyContextVFS -->

Stores the database in OPFS through the `File` and `FileSystemWritableFileStream`
APIs rather than synchronous access handles, which is what lets it run in any
context instead of a dedicated worker only. Writes get worse as the file grows,
so it suits read-only or nearly read-only databases.

> [!NOTE]
> **This VFS needs a patched wa-sqlite to work on Safari.** browser-sqlite ships
> that patch inside its own worker bundle — there is nothing for you to install
> or configure.

### `MemoryVFS`

<!-- BEGIN GENERATED MemoryVFS -->

**Builds:** [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 95+/153+, Safari 15.4+/27+, Android 92+/?, iOS 15.4+/27+

**Pool size:** **1**<sup><a href="#fn-6">[6]</a></sup> · **RAM:** Whole database<sup><a href="#fn-3">[3]</a></sup>

<!-- END GENERATED MemoryVFS -->

Keeps the database in RAM and nothing outlives the connection. wa-sqlite ships
it as a minimal reference implementation and as a baseline for behaviour and
performance, not as storage.

### `MemoryAsyncVFS`

<!-- BEGIN GENERATED MemoryAsyncVFS -->

**Builds:** [`async`](#build-async), [`jspi`](#build-jspi)

**Browsers:**<sup><a href="#fn-1">[1]</a></sup> Chrome 92+/137+, Firefox 95+/153+, Safari 15.4+/27+, Android 92+/?, iOS 15.4+/27+

**Pool size:** **1**<sup><a href="#fn-6">[6]</a></sup> · **RAM:** Whole database<sup><a href="#fn-3">[3]</a></sup>

<!-- END GENERATED MemoryAsyncVFS -->

Keeps the database in RAM, reached through the asynchronous VFS interface rather
than the synchronous one. Like `MemoryVFS`, a reference implementation and a
baseline rather than storage.

## Builds reference

Each VFS runs on one or more wa-sqlite WebAssembly builds. The `build` option
selects one; omitted, the first build the VFS declares is used — the `Builds`
line of its entry lists them in that order. A pair the VFS does not support
throws a `SQLiteError` with code `INVALID_OPTION` at construction, naming the
builds it does support. The pairing is declared in one place,
`VFS_CAPABILITIES`, which is also what the `SQLiteVFS` type is derived from.

A build carries its own engine requirement, independent of where the VFS stores
data — so a VFS can be reachable in `sync` on an old browser and in `jspi` only
on a much newer one.

<!-- BEGIN GENERATED BUILD TABLE — edit FEATURE_SUPPORT in scripts/render-vfs-matrix.ts -->

### Build `sync`

Plain synchronous WebAssembly. Needs nothing beyond baseline WASM, so it runs anywhere — but only VFS whose file operations are all synchronous can offer it.

### Build `async`

Asyncify: the WASM stack is unwound and rewound around asynchronous file operations. Also needs nothing beyond baseline WASM. Every VFS here can run on it.

### Build `jspi`

| Chrome / Edge | Firefox | Safari | Chrome Android | Safari iOS |
|---|---|---|---|---|
| 137+ | 153+ | 27+ | Yes | 27+ |

JavaScript Promise Integration — the same asynchrony handled by the engine rather than by Asyncify. Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it.


<!-- END GENERATED BUILD TABLE -->

## Concurrency

### Concurrent reads

**Serving a read while a write transaction is open** and **running several reads
at once under a pool** are the same mechanism. A VFS holding one exclusive access
handle can do neither, because it is the same handle a second worker never gets.

Off Chromium, **reading during a long query** is served by `OPFSAnyContextVFS`
and by nothing else — and it is the exception on every engine. On Chromium,
`OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` serve it too; `OPFSCoopSyncVFS` and
`IDBBatchAtomicVFS` do not.<br>
The [benchmark page](https://lalexdotcom.github.io/browser-sqlite/) reports this
per VFS on the browser you run it in.

### Reduced mode

A VFS marked `[reduced]` for an engine runs there, but without
`readwrite-unsafe` access handles: one exclusive handle rotated between workers
instead of one held per connection. Chromium 121+ is, for now, the only engine
that implements `readwrite-unsafe`, so every other one runs these VFS this way.<br>
**It is not a partial failure**: everything a VFS does, it still does correctly,
and what degrades is concurrency alone.

What it costs is pool concurrency whenever one worker holds that handle for a
long time. **On an engine without `readwrite-unsafe`, a VFS that rotates a single
exclusive OPFS access handle cannot serve any other worker while one of them
holds it** — the holder does not give it back before its statement ends, and the
next acquisition blocks in the scheduler, before an `AbortSignal` is ever
consulted. That covers `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` in reduced
mode, and it reaches into other tabs: serializing writers changes who writes
when, not which handle the VFS holds.

**A long *read* does this as much as a write transaction.** A worker inside a
single long statement cannot answer a hand-over request, so a query that runs for
seconds serializes every other read for its whole duration.

<!-- BEGIN GENERATED FOOTNOTES — edit scripts/render-vfs-matrix.ts -->

---

<a id="fn-1"></a>
<sub>**1.** Derived from documented platform support, not from our own test runs. These versions cover where the VFS stores its data; which builds are reachable on each engine is a separate question, answered under [Builds reference](#builds-reference) — the **Builds** line links straight to the build it names.</sub>

<a id="fn-2"></a>
<sub>**2.** Page cache only, bounded by `PRAGMA cache_size`.</sub>

<a id="fn-3"></a>
<sub>**3.** **Whole database in RAM**, multiplied by `poolSize`.</sub>

<a id="fn-4"></a>
<sub>**4.** Pool size: 1 max — it cannot share access handles between connections.</sub>

<a id="fn-5"></a>
<sub>**5.** Pool size: 1 max — its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright.</sub>

<a id="fn-6"></a>
<sub>**6.** Pool size: 1 max — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently.</sub>

<!-- END GENERATED FOOTNOTES -->
