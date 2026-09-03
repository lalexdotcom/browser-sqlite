# Inspecting a database's live clients — design

**Status:** approved 2026-09-03, not yet planned.
**Backlog item:** "Counting live clients on a database, and the `debug` surface it belongs
on" in `mem:follow-ups` (user, 2026-09-02).
**Supersedes:** §5 of `2026-09-02-connection-lifetime-lock-design.md`, which deferred this
API deliberately and left the measurement banked.

Every cost quoted below is measured and cited to `mem:measurements`. Nothing here is
extrapolated from a slope — that mistake is what the `cache_size` arm-order run cost this
project on 2026-09-02, and it is the mistake a document about a polled API is most exposed
to repeating.

## 1. What has no answer today

Since rc.5 every client holds `bsq:conn:<ns>:<file>` for its whole life, and writes
serialize across clients and tabs. Both are invisible. An application cannot ask "is this
database open somewhere else", cannot show who is on it, and cannot tell a user why their
write is waiting — the wait is real, unbounded and first-come-first-served, and nothing
reports it.

The gap has a sharper edge at deletion. `deleteDatabase` raises `DATABASE_IN_USE` without
ever saying how many clients hold the database or where they are, and **nobody opens a
database to learn that they cannot close it** — the question arrives from outside, often
from a client that does not exist yet.

## 2. Non-goals

- **A watcher, an emitter, or any push notification.** §5 D1 records why. A real watcher is
  a separate feature, and the polling cost measured here is what makes it cheap later.
- **Identifying which *client* holds the write lock.** §5 D17. The realm is free; the
  client costs a lock on every write.
- **Reporting across storage namespaces.** §5 D7.
- **Guarding an action.** This API informs a UI. `deleteDatabase` remains the only
  authority on whether a database can be removed; see §6.
- **Detecting reduced mode.** `readwrite-unsafe` is in `UNPROBEABLE` (`capabilities.ts:37`)
  because WebIDL ignores the unknown option and answering yes is wrong. It is observed
  after opening, never before.
- **Exposing the epoch, sweep or staging locks.** Internal mechanism with no consumer
  meaning, and exposing `epoch` would owe compatibility on the thing most likely to change.

## 3. The surface

```ts
type DatabaseClient = {
  readonly id: string;       // UUID minted by createSQLiteClient
  readonly name: string;     // the clientName, e.g. "SQLite 1"
  readonly tab: string;      // the realm holding it
  readonly sameTab: boolean; // that realm is the caller's
  readonly vfs: SQLiteVFS;   // four VFS share the `opfs` namespace, hence the file
};

type InspectionBase = {
  readonly file: string;     // normalized
  readonly vfs: SQLiteVFS;
  readonly tabs: number;     // distinct realms
  readonly write: {
    readonly tab: string | null;  // the realm writing now, never the client
    readonly sameTab: boolean;    // false whenever `tab` is null
    readonly waiting: number;     // writers queued origin-wide
  };
};

type DatabaseInspection = InspectionBase & {
  readonly clients: readonly DatabaseClient[];
};

type ClientInspection = InspectionBase & {
  readonly self: DatabaseClient | null;
  readonly siblings: readonly DatabaseClient[];
};

export const inspectDatabase: (
  file: string,
  options: { vfs: SQLiteVFS },
) => Promise<DatabaseInspection>;

// on the client, ungated by `debug`:
db.inspect(): Promise<ClientInspection>;
```

**Amended during implementation, 2026-09-03 (user): `file` is positional.** The
signature above was originally `inspectDatabase({ file, vfs })`, a single options
object — which no other root export uses. `createSQLiteClient(file, options)` and
`deleteDatabase(file, options)` both name the database first, and a third shape for
the same argument is a difference a caller has to remember for no reason. It also
brings the missing-`vfs` guard with it: `inspectDatabase` now refuses a missing
option by name the way `deleteDatabase` does, rather than reporting `Unknown vfs
'undefined'`. `InspectDatabaseOptions` is exported, mirroring
`DeleteDatabaseOptions`.

And five readonly getters, making a `db` self-describing for a module that receives one:

```
db.id  db.name  db.file  db.vfs  db.build
```

## 4. The mechanism

**The roster marker.** A liveness marker, never mutual exclusion — the idiom `bsq:staging`
already documents at the head of `locks.ts`: held `shared`, contended by nobody, released
by the browser when the realm dies, with no timestamp and no grace period.

```
bsq:client:<ns>:<file>:<uuid>:<vfs>:<encodeURIComponent(clientName)>
```

Taken in `createSQLiteClient` under the same condition as `bsq:conn` — `sharesStorage(vfs)`,
so never on the memory VFS — and released by `close()`.

**Parsing.** `ns` and `file` are known, so the exact prefix is built and only entries
starting with it are kept; the remainder must split into **exactly three** segments.
`encodeURIComponent` escapes `:` as `%3A`, which is what makes the split unambiguous for any
name a consumer chooses. Anything else is **ignored, never guessed** — a future version that
lengthens the marker must not be misread by an older one. This is the discipline
`epochsFor` already applies for the same reason: a normalized file may contain a colon, so a
loose `lastIndexOf(':')` reads another database's state.

**The caller's realm.** `clientId` is stable for a realm's life, so it is learned once and
cached at module level. In the common case nothing is taken: **if a client exists in this
realm, its own marker is already in the `query()`** — the entry carrying our UUID carries our
`clientId`. A nonce (`bsq:realm:<uuid>`, taken and released at once) is needed only for a
realm with no client, and only once in that realm's life.

**One `query()` for everything.** The roster (held entries under the prefix), the writing
realm (held on `bsq:write:<ns>:<file>`) and the queued writers (pending on that same name)
all come out of the same call, so they describe the same moment. Two calls would give three
truths and a writer appearing without its lock.

**Cost, measured 2026-09-01, both engines.** `query()` is O(n) in the locks held by the
whole origin: `≈ 0.032 ms + 0.00038 ms × n` on Chromium, `≈ 0.034 + 0.00052 × n` on Firefox.
A plausible origin holds 60–120 and pays 0.06–0.08 ms. Polled at 300–500 ms that is
0.14–0.23 ms of main thread per second, and it takes no lock, no worker round trip and no
queue — **a consumer polling cannot slow a query down.** The marker adds one permanently held
lock per client, so `+0.00038 ms` per call per client; the 0.2 ms-per-call threshold sits
near 450 held locks on Chromium and 320 on Firefox.

## 5. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Read on demand; no maintained counter and no emitter** | Web Locks has no change notification, so an emitter can only poll internally — moving the polling under the hood and making it permanent. The alternative was a `BroadcastChannel` hello/bye reconciled by `query()`, which contradicts the two principles `db.debug` already embodies (nothing is a maintained counter; `queue` is getter-backed *because* hand-kept counters went stale) and charges every client for an observability nobody may read. Cost when nobody looks: zero. |
| D2 | **The standalone function is the primitive; `db.inspect()` is the client-attached form** | Counting clients on a database you have not opened cannot start from a client, and that is the case that matters — the question arrives from outside. `db.inspect()` exists because a `db` handed to another module carries no options. |
| D3 | **A roster, not a count** | A count of 3 does not say what to close, and a supervision window is opened for exactly that. The count derives from the roster; the reverse does not. |
| D4 | **A new, uncontended marker; `bsq:conn` is untouched** | `bsq:conn` is load-bearing: `AccessHandlePoolVFS` takes it exclusive to refuse a second connection, `deleteDatabase` takes it exclusive to raise `DATABASE_IN_USE`. A UUID in that name and both guards fall, because nothing would contend any more. The marker must never become a second occupancy detector — two sources for that answer would diverge. |
| D5 | **The marker carries `clientName` and `vfs`, not `exclusive`** | `exclusiveConnection` is `VFS_CAPABILITIES[vfs]`, a property of the VFS and not of the client; putting it in the marker would be a second copy of a truth that has a source. `vfs` earns its place because four VFS share the `opfs` namespace and therefore the file — which is the destructive-delete footgun the README documents. |
| D6 | **Strict parsing, and unmatched entries are ignored** | See §4. Forward compatibility is the point: an older reader must skip a longer marker, not misparse it. |
| D7 | **The silo is `(namespace, file)`; no cross-namespace scan** | `app.db` on `IDBBatchAtomicVFS` is a different database in a different store, not a sibling. Reporting it would be the same silent conflation this design fights everywhere else — `entries.length` vs `clientId`, clients vs tabs, same file vs same database. There is also no hazard to cover: deleting through the wrong VFS is destructive only *within* the `opfs-path` family, which `namespaceFor` already folds. |
| D8 | **`inspectDatabase` normalizes `file` with `normalizeDatabaseFile`** | `createSQLiteClient` does it first thing, as "one definition of database identity for the workers, the VFS, the epoch registry, every lock name". Without it `'./app.db'` returns an empty roster while a client holds `'app.db'` — zero clients, no error, nothing saying the question was malformed. |
| D9 | **Two shapes, one per surface** | `self`/`siblings` saves a find and a filter on the client side, where a window shows you and the others differently. From the standalone function there is no `self`, so `siblings` would have no referent — hence `clients` there. `self` is nullable rather than optional: `null` says "known: nobody", where an absent field reads as an oversight. |
| D10 | **`tabs` is a number; nothing counts the clients** | `clients.length` / `siblings.length` is the count. Two sources for one number diverge. `tabs` is a field precisely because deduplicating distinct realms is where a consumer gets it wrong in silence. |
| D11 | **The realm id comes from our own marker; the nonce is a fallback** | No API returns your own `clientId`. The nonce is paid once per realm, ever, and never at all when a client exists in that realm. |
| D12 | **No `signal`** | A documented exception to "`signal` on every method". `query()` takes no lock and waits for nothing, so the parameter could only abort the `.then()` — it would promise an interruption it cannot perform. Elsewhere `signal` cancels a real wait. |
| D13 | **`db.inspect()` throws `CLIENT_CLOSED` after `close()`** | Semantics beat ergonomics: a uniform contract on `db` is worth more than an exception a consumer must read the docs to discover. The fallback after closing is `inspectDatabase({ file, vfs })`, which D14 makes reachable. |
| D14 | **Five readonly getters on the instance** | The rule is: expose what the library **mints or transforms**, not what the caller passed unchanged. `id` and `name` are minted, `file` is normalized, `build` is resolved by `defaultBuildFor`. `vfs` is a pass-through and is exposed anyway, because D13 makes it the other half of the fallback path and because a `db` received by another module has no options to fall back on. `pragmas` stay in `debug`: also resolved, but they serve no fallback and already have a home. The entry is noted rather than hidden. |
| D15 | **`db.debug.name` carries the `clientName`** | Breaking, and worth it: today it is `clientOptions.name ?? 'SQLite'` — the label without the index, identical for every client that passed nothing, so it identifies nothing even within one tab. It has **no reader anywhere in the repository**. Aligning it on what the logger prints and what the marker carries makes the roster and a client's own view agree. |
| D16 | **`UNSUPPORTED` is a new error code; the memory VFS raises `INVALID_OPTION`** | Three degenerate cases must not all answer "0 clients": nobody there (true, `[]`), memory VFS (two clients are two databases, so the question has no meaning), Web Locks absent (we do not know, and cannot pretend zero). No existing code fits the third; `INVALID_OPTION` would blame an option that is correct. |
| D17 | **The writer is reported as a realm, never as a client** | The write lock's name *is* the mutex; identity cannot ride on it. Publishing the writer would need a companion lock on every write — measured at 0.058–0.073 ms against a 3.4–5.3 ms commit, so roughly doubling the lock cost of the write path for an observability most callers never read. |
| D18 | **`clientPrefix` is renamed `clientName`** | Internal, five lines across `client.ts` and `pool.ts`, nothing public bears the name. "Prefix" describes what two call sites do with the value; once it is also `db.debug.name` and the marker's label, naming it after one consumer recreates the two-vocabularies-for-one-thing this project just removed for tab/realm. `clientName` rather than `name` because `clientOptions.name` is in the same scope and is **not** this value. |

## 6. What this promises, and what it does not

- **The snapshot is stale on arrival.** An empty roster authorizes nothing: a tab can open
  between the read and the act. `deleteDatabase` raising `DATABASE_IN_USE` is the only
  authority, which is why D4 leaves `bsq:conn` alone.
- **`sameTab` means the caller's realm.** A same-origin iframe in your own page is another
  realm, so `sameTab` is `false` for it. The project's word is "tab" — the README uses it
  fifteen times and never writes "realm" — and the imprecision is harmless in prose about
  behaviour but becomes a lie in a boolean, so the definition is written at the field.
- **An empty roster does not distinguish an unused database from one that does not exist.**
  The lock registry knows holders, not files. `DATABASE_NOT_FOUND` exists for that.
- **Polling is on the call.** Each call is a complete fresh census; nothing is kept between
  two. This is the opposite of `db.debug`, which is a live object read synchronously and can
  be reread at 60 fps for nothing.

## 7. Where it touches the code

| File | Change |
|---|---|
| `src/locks.ts` | `clientMarkerName(…)`; `Locks` gains a method returning `held` **and** `pending` with `{ name, mode, clientId }`. `heldNames()` is unchanged — `epochsFor` needs nothing else. |
| `src/client.ts` | One `crypto.randomUUID()` per client; the marker held under `sharesStorage(vfs)` and released by `close()`; five getters; `inspect()`; `clientPrefix` → `clientName`. |
| `src/inspect.ts` *(new)* | `inspectDatabase`, the parser, the realm-id resolution and its module cache. Nothing in this file sits on a query path. |
| `src/debug.ts` | `name` carries the `clientName` (D15). No `siblings`, no `id`. |
| `src/errors.ts` | `UNSUPPORTED`. |
| `src/pool.ts` | `clientPrefix` → `clientName` (3 lines). |
| `src/index.ts` | `inspectDatabase`, `DatabaseInspection`, `ClientInspection`, `DatabaseClient`. |
| `README.md` | The surface; the definition of "tab" at `sameTab`; "the client prefix" → "the client name" at line 283; the note against stacking polls. |
| `CHANGELOG.md` | `Added` for the surface, `Breaking` for D15. |

## 8. Testing

Written test-first, as the rest of the project.

**Unit** (`tests/unit/`, Node, pure) — the parser is where this project has already paid:

- the exact prefix is required, then **exactly three** segments; a file containing `:` must
  not shift the split
- a `clientName` containing `:` and `%` survives `encodeURIComponent` and returns identical
- a malformed entry is **ignored, never guessed**
- `tabs`: N clients in one realm gives `tabs === 1` — distinct `clientId`, not `length`
- `noOpLocks` → `UNSUPPORTED`; memory VFS → `INVALID_OPTION`
- `'./app.db'` and `'app.db'` reach the same roster (D8)

**Browser** (`tests/browser/`, real `navigator.locks`) — `tests/browser/helpers/realm.ts`
already exists and is what the 2026-09-02 campaign used:

- N clients in the page → `clients.length === N`, `tabs === 1`
- N same-origin iframes → `tabs === N`, `sameTab` true only for the calling realm
- `write.tab` populated during a write transaction; `waiting > 0` with a second writer
- the marker is released by `close()`, **and** by tearing down an iframe without `close()` —
  that is the property the liveness lock buys
- `db.inspect()` after `close()` → `CLIENT_CLOSED`

**Non-regression, and it is the test that matters most:** `deleteDatabase` still reports
`DATABASE_IN_USE` and `DATABASE_NOT_FOUND` identically while markers are held. That is what
proves the marker contends with nothing and has not become a second occupancy detector.

## 9. Answered while writing this, and worth keeping

- **`db.debug.name` has no reader in the repository.** Not in `src/`, not in the nine test
  files that touch `.debug`, not in `bench/`, not in `scripts/`, not in the README.
- **The README documents `db.debug` in one line** — the options table, line 283 — and
  nowhere describes the shape of the object. The tree is undocumented for consumers.
- **`name`'s JSDoc described a database file name** and survived until 2026-09-03, when it
  was corrected: the file is the first positional argument and the option is a label.
- **`bsq:sweep` and `bsq:staging` are not namespaced by VFS**, unlike the four other lock
  names. Noted, not touched.

## 10. Open, and not decided here

- **A real watcher.** Deferred by the user on 2026-09-03 as its own feature. The polling
  cost measured here is what makes it cheap when it comes.
- **Publishing the writing client's identity.** D17 rejects the price today; it becomes
  reasonable if a companion lock is ever needed on the write path for another reason.
- **`mem:measurements`' origin-lock budget.** It reads "≤ 1 marker per tab per database";
  this design adds a second. Still far from the 450-lock threshold, but the sentence becomes
  false and must be corrected when this ships.
