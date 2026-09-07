# VFS

Where [browser-sqlite](README.md) writes your database, and which WebAssembly build runs
behind it.

**▶ [Run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)** —
which VFS wins depends on the engine, and a single browser release can move the answer.

## VFS Selection

browser-sqlite delegates storage to a
[wa-sqlite Virtual File System](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#readme)
(VFS).

**`vfs` is required — there is no default.** A VFS decides *where* your database
is written, so a default that moved between versions would leave you reading an
empty database while your bytes sat in a store nothing queries.

**Pass `OPFSAdaptiveVFS` unless you have a reason not to.** Across every engine we
could test — Chrome, Firefox and Safari, desktop and mobile — it opened and passed
every conformance check without exception. It is the only VFS here of which that is
true.

> **Each VFS is a separate store.** A database written through one VFS is not
> visible through another — the bytes are still there, but nothing reads them.
> Changing `vfs` later does not migrate anything.

You would leave that choice when you control which browser runs your code — an
Electron app, a kiosk, a managed fleet — and need something it cannot give you:

| Browser you can guarantee | Concurrent reads | Write-heavy workloads |
|---|---|---|
| None — the open web | `OPFSAnyContextVFS` if you can require Safari 26+; otherwise `IDBBatchAtomicVFS` | stay on `OPFSAdaptiveVFS` |
| Chromium 121+ | already the case | `OPFSWriteAheadVFS` |
| Firefox 111+ | `OPFSAnyContextVFS` | stay |
| Safari 26+ / iPadOS 26+ | `OPFSAnyContextVFS` | stay |
| iOS (iPhone) | none measured to help | stay |

**Concurrent reads** covers three things, and they do not move together. The
column above answers the first two — serving a read while a **write transaction**
is open, and running **several reads at once** under a pool: a VFS holding one
exclusive access handle can do neither, because it is the same handle a second
worker never gets. Serving a read while a **long query** runs is stricter, and
off Chromium only `OPFSAnyContextVFS` does it — not `IDBBatchAtomicVFS`, which
the column recommends for the other two. [Reads during a long query](#reads-during-a-long-query)
gives that one per VFS. For how much any of this is worth on your own targets,
run [the benchmark page](https://lalexdotcom.github.io/browser-sqlite/) — no
timings appear in this file.

<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->

| VFS | Builds | Browser compatibility | Pool size | Shared between connections | Survives close | Memory | Default PRAGMAs |
|-----|--------|-----------------------|-----------|----------------------------|----------------|--------|-----------------|
| `OPFSAdaptiveVFS` **(recommended)** | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| [`OPFSWriteAheadVFS`](#opfswriteaheadvfs) | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| [`OPFSCoopSyncVFS`](#opfscoopsyncvfs) | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| [`AccessHandlePoolVFS`](#accesshandlepoolvfs) | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | **1** — it cannot share access handles between connections | No | Yes | Page cache only, bounded by `PRAGMA cache_size` | `locking_mode=exclusive`<br>`journal_mode=wal` |
| [`IDBBatchAtomicVFS`](#idbbatchatomicvfs) | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| [`IDBMirrorVFS`](#idbmirrorvfs) | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright | No | Yes | **Whole database in RAM**, multiplied by `poolSize` | — |
| [`OPFSAnyContextVFS`](#opfsanycontextvfs) | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 26+/27+<br>Android 109+/?<br>iOS 26+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `MemoryVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` | — |
| `MemoryAsyncVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` | — |

<!-- END GENERATED VFS TABLE -->

The **Browser compatibility** column is derived from documented platform support,
not from our own test runs. It covers where the VFS stores data; which **builds**
are reachable on each engine is a separate question, answered under
[Builds](#builds) — the `Builds` column links straight to the build it names.

### (*) Reduced mode

The VFS runs on that engine, but without `readwrite-unsafe` access handles: one
exclusive handle rotated between workers instead of one held per connection. It
is not a partial failure — `OPFSAdaptiveVFS` passes 102 of 104 browser tests on
Firefox in exactly that mode.

What it costs is pool concurrency whenever one worker holds that handle for a
long time. **On an engine without `readwrite-unsafe`, a VFS that rotates a single
exclusive OPFS access handle cannot serve any other worker while one of them
holds it** — the holder does not give it back before its statement ends, and the
next acquisition blocks in the scheduler, before an `AbortSignal` is ever
consulted. That covers `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` in reduced mode.

**A long *read* does this as much as a write transaction.** A worker inside a
single long statement cannot answer a hand-over request, so a query that runs for
seconds serializes every other read for its whole duration. This file said the
opposite until it was measured per VFS.

`IDBMirrorVFS`, `OPFSAnyContextVFS` and `IDBBatchAtomicVFS` hold no such handle,
so reduced mode does not apply to them. That is not the same as never making a
read wait — `IDBBatchAtomicVFS` does, on every engine, for a reason of its own.
See [`IDBBatchAtomicVFS`](#idbbatchatomicvfs).

`OPFSCoopSyncVFS` has the same symptom for a different reason, and it is **not**
conditional on the engine — it never uses `readwrite-unsafe`, so it is never in
reduced mode. See [`OPFSCoopSyncVFS`](#opfscoopsyncvfs).

**Reads still wait on the file where your browser gives you one access handle.** Serializing writers does not change which handle a VFS holds. Where `readwrite-unsafe` is unavailable, a read in another tab still waits for the rotated exclusive handle while a writer holds it.

### Reads during a long query

Off Chromium, none of them — `OPFSAnyContextVFS` is the only exception, and it is the exception on every engine. On Chromium, `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` serve it; `OPFSCoopSyncVFS` and `IDBBatchAtomicVFS` do not. The [benchmark page](https://lalexdotcom.github.io/browser-sqlite/) reports this per VFS on the browser you run it in.

## Builds

Each VFS runs on one or more wa-sqlite WebAssembly builds. The `build` option
selects one; omitted, the first build the VFS declares is used — `async` for the
default VFS. A pair the VFS does not support throws a `SQLiteError` with code
`INVALID_OPTION` at construction, naming the builds it does support. The pairing
is declared in one place, `VFS_CAPABILITIES`, which is also what the `SQLiteVFS`
type is derived from.

A build carries its own engine requirement, independent of where the VFS stores
data — so a VFS can be reachable in `sync` on an old browser and in `jspi` only
on a much newer one.

**`build: 'jspi'` is not available everywhere.** The [`jspi` build table](#build-jspi) carries the per-engine versions; it is generated, so it is the one place that stays current. The build is opt-in and no default uses it, so this constrains nobody who does not ask for it.

<!-- BEGIN GENERATED BUILD TABLE — edit FEATURE_SUPPORT in scripts/render-vfs-matrix.ts -->

### Build `sync`

Plain synchronous WebAssembly. Needs nothing beyond baseline WASM, so it runs anywhere — but only VFS whose file operations are all synchronous can offer it.

### Build `async`

Asyncify: the WASM stack is unwound and rewound around asynchronous file operations. Also needs nothing beyond baseline WASM. This is the default, and every VFS here can run on it.

### Build `jspi`

| Chrome / Edge | Firefox | Safari | Chrome Android | Safari iOS |
|---|---|---|---|---|
| 137+ | 153+ | 27+ | Yes | 27+ |

JavaScript Promise Integration — the same asynchrony handled by the engine rather than by Asyncify. Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it.


<!-- END GENERATED BUILD TABLE -->

## Per-VFS notes

### `OPFSWriteAheadVFS`

**`OPFSWriteAheadVFS` serves no concurrent reads outside Chromium — but it is faster there than the default.** It opens access handles with `mode: 'readwrite-unsafe'`, which only Chromium 121+ implements; Firefox and Safari ignore the option rather than reject it, so it still works and falls back to the same reduced mode as `OPFSAdaptiveVFS`. What it keeps is speed: on both Firefox and Safari its `sync` build beats `OPFSAdaptiveVFS` on single-write latency, point reads, list pages, scans and transactions. Prefer it where your workload is latency-bound, and `OPFSAdaptiveVFS` where you need reads to run alongside a long query.

**Targeting Chromium, it is the most balanced choice on the benchmark page.** It is rarely first on a single row — `OPFSCoopSyncVFS` edges it on scans, `AccessHandlePoolVFS` on write latency — but it is near the front of every one, it leads bulk loading, and it is the only VFS that keeps concurrent reads there while still running the faster `sync` build. That combination is what no other VFS offers on Chromium. Read the numbers on the [benchmark page](https://lalexdotcom.github.io/browser-sqlite/) rather than trusting this sentence a year from now.

### `OPFSCoopSyncVFS`

**`OPFSCoopSyncVFS` does not read concurrently, and stalls unpredictably under a pool.** Unlike the other OPFS VFS it implements its own locking and silently ignores the `lockPolicy: 'shared'` this library constructs every VFS with, holding one *exclusive* access handle and rotating it between workers instead of one per connection. A read issued while a write transaction is open is **never served** — the pool acquisition blocks before any `AbortSignal` is consulted — where `IDBBatchAtomicVFS`, `IDBMirrorVFS` and `OPFSAnyContextVFS` serve it every time. A bulk insert either finishes promptly or **exceeds 30 seconds**, with no middle ground and no consistency across runs. None of this depends on `readwrite-unsafe`: unlike the reduced mode described above, it happens on Chromium too.

### `AccessHandlePoolVFS`

**`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.

**`AccessHandlePoolVFS` allows one connection per origin, not one per tab.** A second client on the same database — in this tab or another — fails its first query with `BUSY`, immediately. Close the first client and the next one opens. This is the one VFS where two tabs cannot share a database at all, so choose another if your application expects to be open twice.

### `IDBBatchAtomicVFS`

On **`IDBBatchAtomicVFS`** the **Memory** column is not the whole story:
`PRAGMA cache_size` also decides whether a transaction runs in IndexedDB's
batch-atomic mode. The VFS takes that path only when the cache can hold the
transaction's pages, and falls back silently when it cannot — at SQLite's
default of `-2000` a 5000-page transaction never enters it, on either engine.
Raising the bound reserves nothing up front; the heap grows only as the workload
uses it. **This library sets no default for it**, because raising it saved no
time in either engine — so this is something to know about your own workload,
not a knob to turn on principle.

It holds no exclusive access handle, so [reduced mode](#-reduced-mode) does not
apply to it — but it still does not serve a read while a long query runs, on any
engine. See [Reads during a long query](#reads-during-a-long-query).

### `IDBMirrorVFS`

It is the one VFS where read-your-own-writes does not hold across tabs: it mirrors
the whole database in memory per worker and propagates commits asynchronously. See
[Guarantees](README.md#guarantees).

### `OPFSAnyContextVFS`

This VFS needs a patched wa-sqlite to work on Safari. browser-sqlite ships that
patch inside its own worker bundle — there is nothing for you to install or
configure.
