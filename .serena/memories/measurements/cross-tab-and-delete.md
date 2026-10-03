# Measurements — cross-tab coordination, Web Locks, deletion

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## PRAGMA-BUSY — a pragma that writes, applied at open, against another client's write, 2026-10-01, Playwright's Chromium and Firefox, this container

**Attribution.** Two clients created in one task, each then writing, 12 runs per case, on `OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `OPFSAdaptiveVFS`. Never with one client, never without a writing pragma (`journal_mode=truncate` included). With `user_version=7` or `application_id=5`, two faces of one collision: the other client's user write rejected `BUSY: database is locked` (its own worker READY at generation 0, the barrier then its `CREATE TABLE` failing — the opening worker held RESERVED outside `bsq:write`), or the opening worker failed and was restarted (generation > 0). Two clients, pool 2, Chromium: 4-7 runs of 12 failing per VFS; Firefox `OPFSAnyContextVFS` up to 8/12 (pool 1), `IDBBatchAtomicVFS` 0-2/12, `OPFSAdaptiveVFS` 0/12.

**`busy_timeout=5000` placed first, same cases, both engines:** 0/12 everywhere on `jspi` and `async` of the three VFS, against up to 10/12 without; slowest pair of writes 75-258 ms with it, 61-245 without. `OPFSWriteAheadVFS/sync`: 0/12 with or without on Chromium, 12/12 `DATABASE_IN_USE` on Firefox (by design).

**Which pragmas write.** Two wa-sqlite connections on `IDBBatchAtomicVFS`, `lockPolicy: 'shared'`, A holding RESERVED (`BEGIN IMMEDIATE`), B running each assignable pragma, a fresh VFS per pragma (one shared instance skewed the second half), new database and database with a table: `BUSY` for `user_version`, `application_id`, `schema_version`, `incremental_vacuum` in both, `auto_vacuum = full|incremental` on the new one only; every other pragma ok in both. `optimize` and `wal_checkpoint` write only when they find work (SQLite 3.53.0 pragma.c), `journal_mode` only to or from WAL.

**`busy_timeout` forced on every VFS:** `coopsync-handover` hung for minutes on `OPFSCoopSyncVFS`, `sync` and `jspi`, and `coopsync-retry` took ~60 s; `OPFSWriteAheadVFS` (`sync`, `jspi`) and `IDBMirrorVFS` (`jspi`, `async`) passed their whole browser suite apart from an unrelated test the change had moved.

**Routing cost** of the new `isReadQuery` (`exec` + a `Set`) against the old (`test`), 2 M calls, Node: short `SELECT` 68 → 73 ns, 2 KB `SELECT` unchanged, `PRAGMA user_version` 31 → 65 ns, `INSERT` 21 → 28 ns.

## DELETE-WA — `deleteDatabase` left `OPFSWriteAheadVFS`'s write-ahead files, 2026-09-14, both engines

A throwaway probe: create, write, close, delete, list the OPFS
root. `OPFSWriteAheadVFS`: `(db)`, `-wa0`, `-wa1` before, **`-wa0`, `-wa1` after**;
`OPFSAdaptiveVFS`: `(db)` before, nothing after. Each deletion also printed three console errors —
its `jDelete` refuses every file but its own temporaries. Fixed by `extraFileSuffixes` and an
OPFS-only pass for the `opfs-path` layout (39d0dd4). Orphans from earlier deletions stay, and are
harmless: the VFS truncates them when it creates a database of that name.

## Web Locks priced — 2026-08-31, Chromium 151 / Firefox 153, this container

**Method.** Throwaway `tests/browser/locks-probe.test.ts` (deleted), headless, 16 cores,
origin empty at start (`query()` reported 0 held). Three runs per cell, medians below;
every figure is a **batch total divided by its count** — 1000 hold/release cycles, 500
`query()` calls — never a single timed call, because Firefox reduces `performance.now()`
to 1 ms. Control (`await Promise.resolve()` in the same loop): 0.0001 ms Chromium,
0.0030 ms Firefox, so no figure below contains its loop.

| | Chromium | Firefox |
|---|---|---|
| `hold`+`release`, exclusive | **0.0732 ms** | **0.0580 ms** |
| `hold`+`release`, shared | 0.0629 ms | 0.0530 ms |
| `query()`, 0 held | 0.0310 | 0.0340 |
| `query()`, 8 held | 0.0360 | 0.0360 |
| `query()`, 64 held | 0.0626 | 0.0680 |
| `query()`, 256 held | 0.1326 | 0.1560 |
| `query()`, 512 held | 0.2236 | 0.2980 |

**`navigator.locks.query()` is O(n) in the locks held by the WHOLE ORIGIN**, not flat, and
cleanly so: `≈ 0.032 ms + 0.00038 ms × n` on Chromium, `≈ 0.034 + 0.00052 × n` on Firefox.
The 64→512 slope equals the 0→512 slope on both engines, which is what makes it linear
rather than an artefact. **The 0.2 ms budget is crossed near 450 held locks on Chromium
and 320 on Firefox.**

**The decision it settled, and half the rule failed.** The rule was set before the run:
the cross-tab epoch registry is viable if `query()` is ≤ 0.2 ms **and** flat. It is the
first and not the second. Taken anyway, on this basis: our own contribution was ≤ 1 marker
per tab per database, so a plausible origin holds 60–120 and pays 0.06–0.08 ms — three to
six times less than the ~0.2 ms worker round trip the registry avoids, and the registry
also *skips* the barrier when nothing changed where the unconditional prelude cannot.
**The residual exposure is that the count is not ours:** an application using Web Locks
heavily makes us pay for its locks on every `query()`. A fallback to the unconditional
prelude above a threshold is possible and was not built.

**The budget sentence above is superseded, 2026-09-03: it is now ≤ 2 markers per CLIENT
per database.** Database inspection added `bsq:client:<ns>:<file>:<uuid>:<vfs>:<label>`,
held for every client's life on every persistent VFS. The arithmetic changes more than it
looks: the epoch marker is one per tab, this one is one per client, and a tab with four
clients on two databases now contributes eight rather than two. It stays far from the
threshold — 450 held locks on Chromium, 320 on Firefox — but the figure to re-derive when
someone next reasons about `query()`'s cost is this one, not the one above.

**The 256 and 512 points exist because the first run only went to 64** and showed growth
where flatness was expected. Extrapolating that slope was the obvious move and is exactly
what this project keeps paying for; they were measured instead.

Also settled: **the rc.5 write lock costs 0.058–0.073 ms per write** against a commit
measured at 3.4–5.3 ms — under a percent. And a shared read lock would cost 0.053–0.063 ms
per read, ~5 % of a 1.1 ms read; not needed by the chosen design.

n=3, one machine, headless, one container. The two engines agree closely.

## Cross-tab coordination priced as COUNTS — 2026-09-01, Chromium 151 / Firefox 153, this container

**Method.** Throwaway `tests/browser/cross-tab-probe.test.ts` (deleted). `navigator.locks.query`
and `navigator.locks.request` wrapped in the test page before the client is created and counted
by name prefix; `BARRIER_SQL` executions counted through `db.debug` the way
`tests/browser/barrier.test.ts` does. The before/after arm ran the same workload in a scratch
`git worktree` at `git merge-base main HEAD`. **Every figure below is a count. No durations
were taken, deliberately** — the effect is ~0.03 ms, Firefox clamps `performance.now()` to 1 ms,
and this project has already paid once for timing an effect this size.

| | Chromium | Firefox |
|---|---|---|
| `query()` per **read** | 1 | 1 |
| `query()` per **write** | 1 | 1 |
| `request(bsq:write:…)` per write | 1 | 1 |
| `request(bsq:epoch:…)` per write | 1 | 1 |
| `BARRIER_SQL`, mixed workload, **this branch** | 0 | 0 |
| `BARRIER_SQL`, same workload, **branch point** | 0 | 0 |
| `BARRIER_SQL`, 5 reads, no foreign marker | 0 | 0 |
| `BARRIER_SQL`, 5 reads, foreign marker held | **1** | **1** |

**The two numbers that matter.** A single-tab application runs **no extra barrier
statements**: identical to the branch point on both engines, so the `query()` is the whole of
what it pays. And a foreign commit costs **one barrier per worker, not one per read** — the
first read on a worker that is behind runs it, that worker is then current, and the reads after
it run nothing.

**A caveat the probe reported against itself, and it is right to.** The mixed workload produced
zero barriers on *both* arms, so the before/after comparison establishes "no regression" without
ever exercising the barrier. The cause is `lastWriterIndex`: alternating write→read routes the
read back to the worker that just wrote, which is always current, so the other worker never
serves a read. Not a probe defect — it faithfully measures that workload — but a workload that
forces reads onto a cold worker would be a stronger arm, and nobody has run one.

## Two clients on a `multiConnection: false` VFS — 2026-09-01, n=3 per engine

**Method.** Throwaway `tests/browser/multiconnection-probe.test.ts` (deleted). Two clients in
one page on one database name, `poolSize: 1` everywhere, `openTimeout: 5000` so a stall stays
inside the test budget. **Two clients in one page are a faithful stand-in for two tabs here** —
OPFS access handles and IndexedDB are origin-scoped. (The commit epoch is not, but it is not
part of this question.) Chromium 151 / Firefox 153, this devcontainer.

| VFS | 2nd client opens | data shared |
|---|---|---|
| `OPFSAdaptiveVFS` *(control)* | yes | **yes** |
| `IDBBatchAtomicVFS` *(control)* | yes | **yes** |
| **`AccessHandlePoolVFS`** | **yes, and broken** | **no** |
| `IDBMirrorVFS` | yes | **yes, immediately** |
| `MemoryVFS` / `MemoryAsyncVFS` | yes | no — isolated by construction |

### AHP-2TAB — `AccessHandlePoolVFS` fails silently, and it can break the FIRST client

Two clients created **before either queries**, n=3 per engine:

- **The second client resolves `SELECT 1` in 6 runs of 6, and cannot read any table in 6 of 6**
  (`no such table`). It looks healthy and is useless. A guard that probes an open with
  `SELECT 1` gives a false positive here — and so would `SELECT count(*) FROM sqlite_master`,
  which returns 0 rather than erroring on a frozen empty view.
- **Which client loses the handle race is non-deterministic**, and it is sometimes the FIRST
  one: client A crashed with `WORKER_CRASHED` in 1 of 3 Chromium runs and 2 of 3 Firefox runs.
  So two concurrent clients leave **at least one broken client, always, and sometimes both**.
- Created **sequentially** instead — B after A has run a query — B fails cleanly with
  `WORKER_CRASHED`, 3/3 on both engines, message stable within an engine but **different
  between them** (Chromium names `createSyncAccessHandle`, Firefox says "No modification
  allowed"). Matching on the message rather than the code will not port.
- After `A.close()`, B opens, 3/3 both engines.

**This is pre-existing, not caused by the cross-tab work.** It matters more now only because
the README began promising cross-tab write serialization.

### `IDBMirrorVFS` does share across clients

B sees A's row every time, 3/3 on both engines, **isolated runs**. So `multiConnection: false`
does not mean "isolated from other clients" — it flags concurrent-writer unsafety. This does
**not** refute MIRROR-1 (5 failures in 300 rounds, ~1.7 %): that was measured under a loaded
suite, and 0/60 in isolation. Loaded behaviour across clients was not probed here.

Wall-clock open timings in the report are single observations and are recorded as such.

## DELETE-LIVE — `deleteDatabase` under a live connection, 2026-09-02, n=3 per engine

**Method.** Throwaway `tests/browser/delete-live-connection-probe.test.ts`. Open a client,
create a table, insert and read back a row so the connection is demonstrably working, then call
`deleteDatabase` **with that client still open**. Fresh database name per case, storage cleaned
between cases, each VFS at its declared `maxPoolSize`. Chromium 151 / Firefox 153, this
devcontainer. **Identical on both engines, 3/3, no variation between runs.**

| VFS | outcome | data destroyed |
|---|---|---|
| `OPFSAdaptiveVFS` | throws `WORKER_CRASHED` | no |
| `OPFSCoopSyncVFS` | throws `WORKER_CRASHED` | no |
| `OPFSWriteAheadVFS` | throws `WORKER_CRASHED` | no |
| `AccessHandlePoolVFS` | throws `WORKER_CRASHED` | no |
| **`OPFSAnyContextVFS`** | **resolves** | **YES** |
| **`IDBBatchAtomicVFS`** | **resolves** | **YES** |
| **`IDBMirrorVFS`** | **resolves** | **YES** |

Controls: after `close()`, `deleteDatabase` resolves on every VFS, both engines.

**The README's sentence is wrong on both halves.** It claims a database that is open cannot be
deleted, and that `BUSY` is reported. Three VFS delete it. The four that survive report
`WORKER_CRASHED`, never `BUSY`.

**The protection on those four is accidental.** It is OPFS access-handle exclusivity: the
delete worker cannot open its own handles while the live client holds them, so it crashes. It
is an operating-system-level constraint that `deleteDatabase` was never designed around, and it
disappears for any VFS that does not hold exclusive handles. `bsq:init` plays no part — a live
client does not hold it, since `worker.ts` releases it when the open finishes.

**The three failure shapes differ, and `IDBMirrorVFS`'s is the worst:** after the delete
resolves, its live client keeps reading its correct row out of the in-memory mirror, with no
error and no signal, while a fresh client finds an empty database. `IDBBatchAtomicVFS` — **the
one persistent multi-connection VFS that works on all three desktop engines** — leaves the live
client hanging on any subsequent read. `OPFSAnyContextVFS` at least errors immediately.

**`AccessHandlePoolVFS`'s new `bsq:conn` guard plays no role here**: `deleteDatabase` contests
`bsq:init` only.

## `navigator.locks.query()` counts shared holders one by one — 2026-09-02, both engines

**Method.** Throwaway `tests/browser/query-holders-probe.test.ts` (deleted). The same name held
in `mode: 'shared'` from N contexts, then `query()`, counting entries carrying that name. Done
both same-realm (N holds from the page) and cross-realm (N same-origin iframes, via
`tests/browser/helpers/realm.ts`). Chromium 151 / Firefox 153, this devcontainer. **The two
engines agree completely.**

| N | same-realm entries | cross-realm entries |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 2 |
| 4 | 4 | 4 |

**So a per-client shared lifetime lock is countable**, which is what the DELETE-LIVE remedy
rests on. The assumption held; it was checked rather than reasoned.

**`LockInfo` carries exactly three keys on both engines** — no extras beyond the specification:

```json
{ "clientId": "94621D6D…", "mode": "shared", "name": "bsq:conn:opfs:app.db" }
```

**`clientId` is realm-scoped, not hold-scoped, and this is the part that matters for any API
built on it.** N holds from one page produce N entries carrying **one** `clientId`; N holds
from N iframes produce N entries with N distinct ones. So the two questions have two different
answers from one query:

- **how many clients** → `entries.length`, valid only if the design enforces exactly one hold
  per client;
- **how many tabs** → `new Set(entries.map(e => e.clientId)).size`.

Using `clientId` for the client count would undercount several clients in one page. Using
`entries.length` for the tab count would overcount them.

**An iframe is a separate Web Locks client.** Anything in this library that ever requested a
lock from inside an iframe would be counted as an independent client.

## A delete cannot slip past a client under construction — 2026-09-02, 20 runs per engine

**Method.** `tests/browser/delete.test.ts`, kept: `createSQLiteClient` and `deleteDatabase` issued in
**one synchronous task**, client first, no `await` between them. Twenty runs on Chromium 151 and
twenty on Firefox 153, this devcontainer. **20/20 refused with `DATABASE_IN_USE` on each engine, no
variation.**

A client's connection lock is *requested* synchronously at construction but *granted* asynchronously,
so the window is real in principle. The Web Locks queue being FIFO per name is what closes it: the
client's request is processed first, and the delete's `ifAvailable` request meets it pending and is
refused. **That was a reading of a specification until this measurement** — and it is the sixth claim
of that shape on this branch, the first five of which turned out false when finally tested.

The result rests on one property of the production code: `locks.hold` is called in
`createSQLiteClient`'s own body, and `hold` calls `manager.request` synchronously inside its Promise
executor. Move either behind an `await` and the window reopens without any test noticing.

## CROSS-VFS — deleting through the "wrong" VFS destroys data, 2026-09-02, n=3 per case per engine

**True of rc.5 and earlier only.** Since `feat/vfs-folders` (merged 2026-09-24) each path-addressed OPFS VFS keeps its own `.<folder>/`, and conformance `folders.test.ts` asserts the opposite of the table below on every pair of its ring (`mem:vfs`, CROSS-VFS).

**Method.** Throwaway `tests/browser/cross-vfs-probe.test.ts` (deleted). Create with VFS **A**, write a
row, `close()`, `deleteDatabase(name, { vfs: B })`, reopen with **A**, check the row. `poolSize: 1`
throughout. Chromium 151 / Firefox 153, this devcontainer. **Both engines agreed on every case, and
`deleteDatabase` RESOLVED in all seven — it never reported anything.**

| A | B | layouts | row survived |
|---|---|---|---|
| `OPFSAdaptiveVFS` | `OPFSCoopSyncVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `OPFSAnyContextVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSCoopSyncVFS` | `OPFSAdaptiveVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `OPFSWriteAheadVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `IDBBatchAtomicVFS` | opfs-path → idb-store | survived |
| `OPFSAdaptiveVFS` | `AccessHandlePoolVFS` | opfs-path → opfs-pool | survived |
| `IDBBatchAtomicVFS` | `IDBMirrorVFS` | idb-store → idb-store | survived |

**So the README's reassurance — "deleting through the wrong one deletes nothing and reports success" —
is true only ACROSS layout families and false WITHIN `opfs-path`, in the dangerous direction.** All
four members of that family resolve one database name to the same OPFS file, which is why this
library's lock names derive from `layout` and never from the VFS name. The doc and the lock keys had
been saying opposite things.

**Read-visibility, the sentence's other half, is not a clean yes or no.** Same family, no deletion:
Adaptive→CoopSync visible, Adaptive→AnyContext visible, Adaptive→WriteAhead visible — but
CoopSync→Adaptive **not** visible, 3/3 both engines, while the delete in that same direction still
destroyed the data. The likely cause is the build rather than the VFS: `OPFSCoopSyncVFS` defaults to
`sync` and `OPFSAdaptiveVFS` to `async`. **Deletion does not care** — it removes a file, it does not
read one — which is exactly why "not visible" cannot be used to argue "deletes nothing".

## EXISTS-PROBE — telling "this database is there" from "it is not", 2026-09-02, n=3 per cell per engine

**Method.** Throwaway probe (deleted). Each persistent VFS in three states — never created, created and
closed, created and closed then deleted — interrogated by two candidate signals. Chromium 151 /
Firefox 153, this devcontainer. **Both engines identical on every cell, no variation.**

### `jAccess` is NOT usable, and the reason matters more than the table

Reliable on four of seven — `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `AccessHandlePoolVFS`,
`IDBBatchAtomicVFS`. On the other three it returns 0 in **every** state, so an existing database and
one that never existed are indistinguishable: `OPFSCoopSyncVFS` consults an in-memory `Set`,
`OPFSWriteAheadVFS` and `IDBMirrorVFS` in-memory `Map`s, none of them seeded from storage at
construction.

**On `IDBMirrorVFS` it is deliberate** — the upstream source says SQLite never calls `xAccess` on a
main database file, so the VFS skips the IndexedDB round trip. We would be reading a field whose
contract explicitly excludes our use. **A signal that is right by luck on four of seven is worse than
none:** right often enough that nobody notices when it is wrong.

### `open_v2` without `SQLITE_OPEN_CREATE` is uniform on all seven

| state | every one of the seven persistent VFS |
|---|---|
| never created | `SQLITE_CANTOPEN` (14) |
| created and closed | **opens** |
| created, closed, deleted | `SQLITE_CANTOPEN` (14) |

One guard covers every VFS, no special cases, because it goes through `jOpen` — the VFS's real notion
of existence, and what SQLite itself does.

Three practical answers that make it usable and not merely correct:

- **The probe handle is closed immediately.** On `AccessHandlePoolVFS` `jClose` leaves the handle
  associated with the VFS *instance* rather than the file, and the delete worker runs the check and
  `jDelete` on that same instance — so nothing is re-acquired and nothing is held against the delete.
- **`CANTOPEN` (14) is distinguishable from the failures it must not swallow.** A corrupt file reaches
  the header read and returns `SQLITE_CORRUPT` (11); a WASM or VFS start-up failure throws before
  `open_v2` is reached at all.
- **It consumes no `AccessHandlePoolVFS` slot.** `getSize()` went 0→0 absent, 1→1 present, 0→0 after
  deletion.

## Delete campaign — 2026-08-27, six devices, `feat/delete-database` @ `a55a3bd`

The first campaign the benchmark page could complete on every engine. Its
predecessors on the same day stopped for good on Firefox 154 and macOS Safari
27.0; three abort defects were fixed between them (`mem:lessons`).

| device | clock | columns | `deleted-is-gone` | `not-run` cells | burst ratio reported |
|---|---|---|---|---|---|
| macOS Chrome 150 | 0.1 ms | 22 | 17 pass | 0 | 20/22 |
| macOS Firefox 154 | 1 ms | 22 | 14 pass, 3 timeout | 0 | **6/22** |
| macOS Safari 27.0 | 1 ms | 22 | 16 pass, 1 timeout | 0 | 15/22 |
| macOS Safari 26.5.2 | 1 ms | 13 | 9 pass, 1 timeout | 0 | 7/13 |
| iPadOS Safari 27.0 | 1 ms | 22 | 16 pass, 1 timeout | 0 | 19/22 |
| iOS Safari 26.6 | 1 ms | 13 | 10 pass | 0 | 11/13 |

**Zero `not-run` on all six** — the state the earlier runs could not reach at
all, because a wedged column abandoned every row after it.

**The six deletion timeouts sit on two VFS and nowhere else:**
`OPFSWriteAheadVFS` ×4 (Safari 26.5.2 `sync`, iPadOS 27.0 `jspi`, Firefox
`sync` and `async`) and `OPFSCoopSyncVFS` ×2 (Safari 27.0 and Firefox, both
`async`). Never on Chromium, never on iOS 26.6. Both rotate one exclusive OPFS
handle without `readwrite-unsafe` — `HANDLE-1` reaching the delete path.
`DELETE-TIMEOUT-1` in `mem:follow-ups`. **n=1 per device.**

**The concurrency burst was unmeasurable on a 1 ms clock at 24 reads.** The row
refuses a ratio when the median serial total falls below 4× the clock's
resolution; that refusal fired on 16 of 22 Firefox columns — the engine where
`HANDLE-1` makes the answer matter most. Raised to 96 the same day. Chromium
measured 2.15× at 24 and 2.26× at 96 on the same VFS, which is why the ratio is
held to survive the change: it is normalised, and 96 against a pool of 4
saturates it either way. The 96-read numbers are not in this table — the six
runs above predate that commit.

## `deleteDatabase` hangs — the whole corpus, split by era, 2026-09-07

**This supersedes the "six deletion timeouts sit on two VFS" reading above**, which was one
campaign on one build. Every bench export carries a `deleted-is-gone` row per
`(vfs, build)` pair in its `conformance` block — **86 files, 1 225 pair-rows**. Counted, not
sampled.

**The corpus must be split at 2026-09-02, and a first reading that did not split it was
wrong.** `src/delete.ts` was rewritten that day — `refuse to delete a database a client still
holds`, `report a database that is not there`, `correct INVALID_OPTION message` — on top of
`key lock names on the storage namespace, not the VFS` the day before. Exports before that
date exercise a different deletion path. The user caught this; the un-split table had been
committed and had to be corrected.

**Every timeout in the corpus is pre-rewrite. There is not one after it.**

| era | files | `OPFSWriteAheadVFS` timeouts |
|---|---|---|
| before 2026-09-02 | 50 | Firefox 154 **7/24** (3 `async`, 2 `jspi`, 2 `sync`), macOS Safari 26.5.2 **3/4**, iPadOS 27.0 **2/5** (`jspi`), iOS 26.6 **1/5** |
| 2026-09-02 onwards | 36 | **none, on any engine** — Firefox 15 runs over three builds, Chromium 24, macOS Safari 27.0 24, iPadOS 33, macOS Safari 26.6.2 6, iOS 26.6.1 2 |

`OPFSCoopSyncVFS` shows the same shape and the same split: 1/8 Firefox `async` and 1/12 macOS
Safari 27.0 `async`, both pre-rewrite, nothing after. `OPFSAdaptiveVFS` never hung in either
era.

**What the post-rewrite runs are worth.** Firefox is the arm that carries the weight: the
pre-rate there was ~29 %, so 15 consecutive clean runs is not a small sample against it. The
gap is **macOS Safari 26.5.2**, which produced 3 hangs in 4 and has not been re-run since —
the 26.x device in the post-rewrite set is 26.6.2.

**CLOSED 2026-09-07, on a mechanism and not only on absence.** `DELETE-TIMEOUT-1` was deleted
from `mem:follow-ups` the same day. `8a5a649` says in its own message that the surviving VFS
"survived by accident, on OPFS handle exclusivity this library never arranged" — HANDLE-1 — and
replaces that with a non-queuing acquisition carrying the comment *"A request that never queues
cannot deadlock"*. The same commit adds a `setTimeout(0)` before returning, because the Web
Locks API releases a lock by queuing a global task, so an immediate return made a freed lock
look held — and it notes **Chromium does not require this**, which matches Firefox being the
worst arm by far. The user closed it on 2026-09-07 with the argument that macOS users track
patch releases, so a caveat about a superseded 26.5.2 buys a consumer nothing; two further runs
on 26.6 were offered and declined as uninformative — that arm never failed. The fix is recorded
for consumers in `CHANGELOG.md` under Fixed, because **rc.4 is published with the old path**.

**The `readwrite-unsafe` attribution is now doubly unsupported.** It was already only a
correlation — the mode is Chrome/Android 121+ and `null` everywhere else, so "Chromium" and
"has the mode" name the same engines in every export we hold. And the era split says the
defect tracked OUR deletion path, not the engine's handle mode. **A Chrome 120 campaign was
proposed to separate the two on 2026-09-07 and is no longer worth running for this purpose**:
it would be testing an engine hypothesis for a defect the evidence attributes to a library
path that has since changed.

## SECOND-CLIENT — what a second client got before the guard, 2026-09-15, n=10 per build per shape

**Method.** A throwaway probe:
two clients on one database, `openTimeout: 5000`, every declared build, two shapes — `together` (both
built before either queries) and `after` (B built once A has written). Chromium 151 / Firefox 154.

- **Chromium: both clients work**, 60/60 rows, every build.
- **Firefox, `after`:** B fails every query with `WORKER_CRASHED`, 10/10 per build; it never recovers once
  A closes; a NEW client opens 10/10.
- **Firefox, `together`: the FIRST client fails** in 6/10 (`sync`), 3/10 (`async`), 4/10 (`jspi`) — the
  handle race picks either side, as AHP-2TAB did. This is what the per-realm memo (spec A1) removes.
- **Open latency** (`createSQLiteClient` → resolved `SELECT 1`, n=20, median): Chromium 58 ms before the
  guard, 55 after; Firefox 69 before, 63 after. The guard costs no measurable time.
