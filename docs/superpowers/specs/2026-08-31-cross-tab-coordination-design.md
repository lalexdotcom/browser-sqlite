# Cross-tab coordination — design

**Date:** 2026-08-31 · **Status:** approved, unbuilt · **Target:** rc.5

Two clients of this library — in one tab or in two — neither serialize their writes
against each other nor see each other's commits. This design closes both, and they are
separate problems with separate answers.

The user asked for both when the scope question was put to them (2026-08-31).

---

## 1. What is true today

**Nothing is shared between clients except visibility, and only within a tab.**

`currentWriterIndex` and both wait queues live in `createScheduler`, which runs once per
`createSQLiteClient` — so two clients in the *same* tab do not order their writes against
each other either. Multi-tab and multi-client are therefore the same problem: a second tab
is a second client that no module-level channel can reach. Solving one solves both; the
reverse is not true.

The commit epoch is the one thing already shared. `epochs.ts` keeps its `Map` on
`globalThis` under `Symbol.for('browser-sqlite.epochs.v1')`, so every client in a tab reads
one counter, and `advanceSeen`'s second condition (`next === target + 1`) is written
precisely for the case where another client committed during our lease. **Cross-client
visibility inside a tab already works and is already reasoned about.** The gap is
cross-*tab*.

Two write regimes are pinned by `tests/browser/multi-client.test.ts`, and a consumer meets
whichever their user's browser gives them:

| regime | second writer |
|---|---|
| `readwrite-unsafe` available — one access handle per connection | refused at once, `BUSY`, because the conflict reaches SQLite's Web Locks which we ask for with `ifAvailable: true` |
| unavailable — one exclusive handle rotated | not refused at all: waits for the file, then goes through |

One part is already coordinated because the user required it: `output()`'s staging sweep is
`navigator.locks`-guarded and multi-tab safe.

## 2. Scope

**In:** write serialization across clients and tabs; cross-tab read-your-own-writes; a
storage-namespace key shared by every lock this library takes.

**Out, and each for a stated reason:**

- **A SharedWorker as the pool or as the sole writer.** Not costly — impossible on Chrome.
  The four VFS that matter need `createSyncAccessHandle()`, hence a dedicated Worker; a
  SharedWorker cannot open the connection itself, and the workaround of spawning a
  dedicated worker from inside a SharedWorker **throws on Chrome** (Firefox supports it,
  Safari 27 beta added it — rhashimoto/wa-sqlite#81, August 2026; Chromium's position is
  that nested workers from a shared worker are "substantially more complex to implement,
  no immediate plan"). SharedWorker on Android Chrome also only arrived in 148, far above
  this library's computed floor.
- **The migrating-service pattern** (upstream's `SharedService`, the shape drift uses). It
  is the only route to a true single connection per origin, and it inverts this library's
  architecture: every query becomes an inter-tab RPC, the pool becomes global, and the
  client becomes a proxy in every non-host tab. rhashimoto's own caveat stands — on
  migration you cannot know whether an in-flight write transaction reached the database.
  A different product, not an rc.
- **`BroadcastChannel` as the epoch transport.** It is delivery, not state, so it loses the
  race on a message still in flight.
- **A `writeLockTimeout` option.** A timeout that released the lock while SQLite still held
  its own would lie.
- **Any change to `IDBMirrorVFS`.** See §8.

## 3. The namespace key

Every lock and the epoch registry key on `(namespace, file)`, never on `(vfs, file)`.

**Keying on the VFS name would be wrong in the dangerous direction.** Four VFS resolve the
same name to the same OPFS path — `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS`
and `OPFSWriteAheadVFS` all walk from `navigator.storage.getDirectory()` and open
`getFileHandle(filename)`, so `name: 'foo'` is `/foo` for all four. (`OPFSCoopSyncVFS`'s
`DB_RELATED_FILE_SUFFIXES` begins with `''`; `OPFSWriteAheadVFS`'s `LIBRARY_FILES_ROOT =
'.wa-sqlite'` holds its scratch files, not the database.) A per-VFS key would let an
`OPFSAdaptiveVFS` client and an `OPFSCoopSyncVFS` client write the same bytes without ever
excluding each other. **A missed conflict corrupts; an invented one only slows.**

The axis already exists and is already load-bearing: `layout` in `VFS_CAPABILITIES`,
consumed by `delete.ts:79` and `worker/worker.ts:627`/`:635`, whose comment already reads
*"The gate is by layout declaration, not by VFS name"*.

| `layout` | VFS | real namespace | key |
|---|---|---|---|
| `opfs-path` | Adaptive, AnyContext, CoopSync, WriteAhead | OPFS root, `/<file>` — **shared** | `opfs` |
| `opfs-pool` | AccessHandlePool | OPFS directory named after the class, random filenames | `AccessHandlePoolVFS` |
| `idb-store` | IDBBatchAtomic, IDBMirror | one IndexedDB database **per class** | the VFS name |
| `memory` | Memory, MemoryAsync | nothing is shared | **no lock at all** |

`idb-store` is the one case that goes finer than `layout`: its two VFS each have their own
IndexedDB database, so grouping them would invent a conflict for free. `memory` earns zero
locks rather than a useless one — it is `maxPoolSize: 1`, `persistent: false`, and an
origin round trip paid on the VFS chosen for speed.

`namespaceFor(vfs)` lives in `locks.ts` and is used by **all three** names:

- `initLockName(vfs, file)` → `bsq:init:<ns>:<file>` (was `bsq:init:<file>`)
- `writeLockName(vfs, file)` → `bsq:write:<ns>:<file>` (new)
- `epochsFor(vfs, file)` → keyed `<ns>:<file>` (was `<file>`)

**`stagingLockName` and `sweepLockName` deliberately stay on `file` alone.** Their
uniqueness comes from the `crypto.randomUUID()` in the table name, not from the file, and
`staleStagingTables` builds the names it compares on both sides — so two clients sharing
`/foo` already agree. The sweep is opportunistic; a needless skip costs nothing.

**Version-mixing window, accepted:** an rc.4 tab and an rc.5 tab open on the same origin
would no longer exclude each other at open, nor share an epoch. Bounded to that window; no
mechanism is proposed. The `v1` suffix in the symbol key is **not** bumped — bumping it
would fragment identically and buy nothing.

## 4. Exclusion — the write lock

**`bsq:write:<ns>:<file>`, exclusive, origin-wide.**

`acquireInstrumented` (`client.ts:543`) is the single choke point through which `read`,
`write`, `transaction` and `bulk` all take a lease — `client.ts:733` substitutes it for
`scheduler.acquire` in the deps. The lock goes there and nowhere else, the same argument
that makes the barrier one wrapper rather than six.

**The order is load-bearing: lock first, lease second.** The reverse holds a pool worker
while blocked on a cross-tab lock; at `poolSize: 2`, two queued writes would starve the
same tab's reads. So: lock → lease → run → release lease → release lock.

**No new primitive is needed in `locks.ts`.** The release rides on `lease.release()` rather
than on a scope, so `withLock` is the wrong shape — but `Locks.hold` is already exactly
right (`hold: (name) => Promise<() => void>`), and `bulk.ts` already uses it for the staging
marker. `Lease.release()` is idempotent, which is what makes this safe: a dropped release
would now leak an origin-wide lock, not merely a worker.

**Granularity, which falls out of the existing architecture:**

| call | lock |
|---|---|
| `write()` | one per call |
| `transaction()`, not `readOnly` | **one for the whole callback** |
| `transaction({ readOnly: true })` | none |
| `bulkWrite()` | **one per batch** — `bulk.ts` calls the public `write` |
| `tx.bulkWrite()` | the transaction's, one |
| `read` / `stream` / `chunk` / `first` | none |

The per-batch grain for `bulkWrite` is not an oversight: it preserves the documented
"partial load, not a failed one" behaviour and the invariant that forbids consolidating
`bulk.ts` into one held lease.

**Waiting and abandoning.** `navigator.locks.request` takes an `AbortSignal`, so the wait
is abortable by the `signal` every public method already carries. The default wait is
unbounded and FIFO (Web Locks is specified FIFO per name). This is already the README's
advice: *"Pass a `signal` and the two read alike."*

**Accepted cost, stated plainly.** A transaction whose callback never returns now blocks
the whole origin, where today it blocks only its own client. That is a real widening of the
blast radius. No mechanism is proposed: a wedged pool is already an application bug, and
the remedy is the signal.

**Lock ordering.** `bsq:init` is held across `open_v2` and the PRAGMAs; the write lock never
nests inside it and it never nests inside the write lock. No cycle — to be pinned by a test,
not by this paragraph.

**Degradation.** Without `navigator.locks`, `noOpLocks` gives exactly today's behaviour.

## 5. Visibility — the origin-wide epoch registry

**The lock's name is the state.** A realm that has committed holds
`bsq:epoch:<ns>:<file>:<n>`. The origin's epoch is `max(n)` over held names, read with
`navigator.locks.query()`. State, not delivery — so there is no in-flight window — and the
browser releases a dead tab's locks, so a killed tab cannot pin a stale epoch. It is the
"lock as liveness marker" pattern `stagingLockName` already uses.

**The sharpest constraint, and where it comes from.** `client.ts:506` posts the bump
**synchronously** in the write path's `finally`, because `release` is async and a read
chained after `write()` would otherwise still see the old epoch. `query()` is async.
Therefore `current()` cannot become async.

**The cut that resolves it:** the local cell stays authoritative and synchronous for local
commits; the origin's contribution can only ever *raise* the target, never lower it, so it
folds into `applyBarrier`, which is already async and already awaits a worker round trip
when it decides to run the barrier.

```
const local  = epochs.current();            // sync, unchanged
const origin = await epochs.originMax();    // query()
const target = Math.max(local, origin);
if (target > local) epochs.raiseTo(target);
worker.epochTarget = target;
if (worker.seen >= target) return;
…BARRIER_SQL…
worker.seen = target;
```

**The realm-wide cell does not disappear — it becomes a floor.** That closes the hole
`epochs.ts:51-53` already describes: if the last realm holding a marker dies, `max` falls
back to 0 and a live worker with `seen = 5` would read `5 >= 0` and believe itself current
for ever. With `current() = max(cell, originMax)` a drop is invisible. The absolute value
means nothing; only the comparison does.

**Publishing, at commit, inside the write lock** — hence already serialized, which is what
§4 buys this section:

1. `next = epochs.bump()` — synchronous, local.
2. acquire `bsq:epoch:<ns>:<file>:<next>`, **then** release this realm's previous marker.
   In that order: `max` must never dip.
3. release the write lock **after** step 2 settles — otherwise another tab takes the write
   lock, runs its `query()`, and misses our marker. Costs ~0.06 ms per write.

**A realm releases its marker only when it takes a higher one, never on `close()`.** That
is the bound that keeps `query()` cheap: **at most one marker per realm per database**,
whatever `poolSize` and whatever the number of clients in that realm.

**Publication is per realm, not per client.** The epoch cell is already realm-wide, so two
clients in one tab publish one marker between them. The publisher is the registry, not the
client.

**If publishing fails** (the `request` rejects): the local cell has already bumped, so this
realm stays correct and others miss that commit. Log, do not throw; the next successful
publish restores a higher `max`.

**Degradation.** Without `navigator.locks`, `originMax()` returns 0 and behaviour is exactly
today's, realm-only. `noOpLocks` covers it with no extra branch.

**Parsing.** `<n>` is read with `lastIndexOf(':')`, never a `split` — `<file>` is a
normalized relative path and may contain separators.

## 6. Testing

**The pure part is driven from Node**, on the `staleStagingTables` precedent: name
composition, the `lastIndexOf` parse, `namespaceFor`, and `max`-with-floor, all fed a list
of `heldNames`.

**The falsifier is a same-origin iframe, and it was verified before this design was
written.** `multi-client.test.ts` argues in its header that two clients in one page contend
exactly as two tabs would — true of Web Locks and OPFS handles, and **false of the epoch**,
which those two clients share through the realm-wide registry. A same-page test passes today
and can falsify nothing.

A throwaway spike (deleted) measured the platform, **identically on Chromium 151 and Firefox
153**:

| | result | required |
|---|---|---|
| global **symbol** registry shared across realms | YES | — |
| iframe sees the parent's **epoch registry** | **NO** | NO |
| parent sees a lock held in the iframe | YES | YES |
| iframe sees a lock held in the parent | YES | YES |
| iframe **blocked** while the parent holds the name | YES | YES |
| `Worker` constructible in the iframe | YES | — |
| OPFS reachable from the iframe | reachable | — |
| blob `Worker` spawned from the iframe | replies | — |

**`Symbol.for()` is shared across realms** — the same symbol on both sides. The separation
does not come from the symbol but from `globalThis`, where `epochs.ts` puts its `Map`. The
mechanism is correct, but not for the reason its header comment suggests. Both properties
are true and distinct.

**A foreign tab manifests to us only as a held lock name**, so a browser test may hold
`bsq:epoch:<ns>:<file>:<n>` directly rather than run a second full client. That is faithful,
not a shortcut, and it isolates the mechanism. **Not verified:** whether the bundled client
module can be imported and evaluated inside the iframe. If a full second client is ever
wanted there, that question is still open.

**Three existing tests change meaning** and become the specification of the new behaviour:
the `it`s in `multi-client.test.ts`. The second carries its own falsifier in a comment —
*"ship `BEGIN IMMEDIATE` and B fails at the BEGIN"* — and §4 ships the equivalent at the lock
level. After this change B waits and then goes through, on both regimes, identically. **That
single behaviour replacing two is the principal gain.**

## 7. Measurements this design rests on

All in `mem:measurements`, dated 2026-08-31, Chromium 151 / Firefox 153, this container,
n=3, batch totals divided by their count.

- **Exclusive `hold`+`release`: 0.058–0.073 ms** — §4's per-write cost, against a commit
  measured at 3.4–5.3 ms. Under a percent.
- **`query()` ≈ 0.032 ms + 0.0004 ms × (locks held in the origin)**, linear on five points
  and both engines. The 0.2 ms budget — the worker round trip the registry avoids — is
  crossed near **450 held locks on Chromium, 320 on Firefox**.
- A shared read lock would cost 0.053–0.063 ms per read (~5 % of a 1.1 ms read). **Not
  used**: the chosen design does not need one. It returns only if we ever want to schedule
  the exclusive-handle contention ourselves, which is a different problem.

**Half the decision rule failed and the design was taken anyway.** The rule, set before the
run, was "viable if `query()` ≤ 0.2 ms **and** flat". It is the first and not the second.
Taken on this basis: our own contribution is ≤ 1 marker per realm per database, so a
plausible origin holds 60–120 and pays 0.06–0.08 ms — three to six times less than the round
trip it avoids — and the registry additionally *skips* the barrier when nothing changed,
where an unconditional prelude cannot.

**`poolSize` does contribute to `n`, through wa-sqlite and not through us.**
`lockPolicy: 'shared'` brings `WebLocksMixin`, which takes up to three named locks
`lock##<file>##{gate,access,reserved}` per connection (`WebLocksMixin.js:388`; `hint` is
`shared+hint` only, which we do not use), held only while that connection holds a SQLite
lock. One query in flight per worker bounds it at ~1–2 per simultaneously active worker. At
`poolSize: 4` that is +0.003 ms on a 0.03 ms `query()`. **Read from source, not measured** —
the probe ran on an empty origin with no client. Counting locks actually held under a
working pool is a ten-line measurement nobody has taken.

**The residual exposure is not ours to bound:** the count is origin-wide, so an application
using Web Locks heavily makes us pay for its locks on every `query()`. A fallback to the
unconditional prelude above a threshold is possible and is **not** built.

## 8. What this does not promise

To be written into Known Limitations rather than left to be inferred:

- **`IDBMirrorVFS` gains nothing cross-tab.** It mirrors the whole database per worker and
  propagates commits over `BroadcastChannel` asynchronously, so the epoch will correctly
  say "you are behind", the barrier will run, and there will be nothing fresher to read. The
  barrier cannot rescue it — that is already recorded in `mem:vfs`.
- **Reduced-mode read contention is untouched.** Where one exclusive OPFS access handle is
  rotated, another tab's *reads* still contend for the file. The write lock orders writers;
  it does not change the handle.
- **`OPFSCoopSyncVFS`'s stalls are untouched.**
- **An external writer that does not take our lock is not excluded.** SQLite's own locking
  stays the backstop.
- **`initLockName`'s coarseness is reduced, not removed.** Two clients on different layouts
  with the same name no longer serialize their opens; nothing else about the open path
  changes.

## 9. Open, and deliberately not decided here

- Whether the `deleteDatabase` error message should be corrected. It tells the consumer
  *"A database written through one VFS is not visible through another"* (`delete.ts:62`),
  which the four `opfs-path` VFS contradict. Noticed while establishing §3; out of scope
  for this design.
- Whether to fall back to the unconditional prelude above a `query()` threshold (§7).
- Whether a full second client can run in the iframe (§6).
