# A second client, on every VFS — design

Branch `fix/second-client`. Reliability, so rc.5 by the triage rule (user, 2026-09-09).

## 1. The problem

Found by the multi-VFS probe of the CoopSync hand-over work (COOPSYNC-HANDOVER,
`mem:measurements`): on Firefox, a second `OPFSWriteAheadVFS` client on a database another client
holds open fails **every** query with `WORKER_CRASHED`, `sqliteCode` 14,
`sqlite3_open_v2: NoModificationAllowedError` — 20/20 attempts in each of five shapes. Chromium: 0/20.

It is the VFS's design, stated upstream (`node_modules/wa-sqlite/src/examples/README.md`: *"It
requires the proposed 'readwrite-unsafe' locking mode"*). `OPFSWriteAheadVFS.js` opens the database
and its `-wa0`/`-wa1` files with `createSyncAccessHandle({ mode: 'readwrite-unsafe' })`; an engine
without the mode ignores the option and grants an exclusive handle; the VFS keeps all three for the
connection's whole life and has no hand-over. Off Chromium, **one connection per database per
origin** can open. The pool cap of 2026-09-14 drew that consequence inside one client
(`singleConnectionWithout`); nothing drew it between clients, and `VFS.md` never says "a second tab
is refused".

Nothing caught it because every multi-client test runs on one VFS. `multi-client.test.ts` (6 tests)
and `cross-tab.test.ts` (4) — the whole multi-client and cross-tab coverage of rc.5 — hard-code
`OPFSAdaptiveVFS`. Every conformance invariant runs one client per database. A static count on
2026-09-15 found ~150 browser tests in 29 files on one VFS, mostly `createTestClient`'s default. The
one test that met the refusal, `pool-cap.test.ts` T5, asserts it — its subject is the error message
for a file a third party holds, which stays correct (§5).

## 2. Decisions (user, 2026-09-15)

- **D1 — Three steps, in this order.** (1) The second-client contract: the guard below and a matrix
  that tests it on every VFS. (2) `multi-client.test.ts` and `cross-tab.test.ts` on every VFS whose
  contract is "shared". (3) The single-VFS browser tests run on **both** recommended VFS by default.
  Step 2 depends on the contract step 1 fixes; step 3 is independent.
- **D2 — Off an engine with `readwrite-unsafe`, a second `OPFSWriteAheadVFS` client gets
  `DATABASE_IN_USE`**, as `AccessHandlePoolVFS` already does. Sharing by rotating the handles would
  redesign the VFS against its own premise, upstream; keeping `WORKER_CRASHED` would pin a defect as
  the contract (`mem:lessons`, 2026-09-15). Whether it stays a recommended VFS is a separate question,
  not this branch's.
- **D3 — What a second client gets is derived from `VFS_CAPABILITIES`, with one new field**,
  `exclusiveConnectionWithout` (§3.1). Three outcomes: **refused** where the VFS is exclusive on this
  engine; **isolated** where `layout === 'memory'`; **shared** everywhere else. `IDBMirrorVFS` is
  counted shared; its behaviour under load across clients is a measurement (§6), not an assertion.
  A typed replacement for `poolLimitReason` was considered and set aside: a public field rework this
  branch does not need. A table of expectations in the test was refused: a second copy of the truth.
- **D4 — The matrix lives in `tests/browser/`, over every declared (vfs, build) pair, on both
  engines**, so `pnpm test` runs it at every merge. The build matters across clients: the CoopSync
  hand-over defect survived on `jspi` alone once the first fix landed. Its cost is measured first
  (§8, task 1); the fallback, if too heavy, is the default build in `tests/browser/` and every pair
  in `tests/conformance/`, with `pnpm test:conformance` added to the delivery verification.
- **D5 — Scenarios** in §4.1.
- **D6 — The client learns the feature before anything opens: worker 0 probes, then waits** (§3.2).
  A throwaway probe worker buys nothing over it. Translating the open failure after the fact was
  rejected: it keys on an error name that differs by engine, and when both clients are built
  together nothing guarantees the second one loses — AHP-2TAB saw the first client break.
  Memoising the probe result per realm is deferred unless the cost measurement asks for it.
- **D7 — Step 2 runs on the "shared" VFS of the engine, default build, recommended first** (§4.2).
- **D8 — Step 3: both recommended VFS by default, exceptions written down** (§4.3). `createTestClient`
  loses its default VFS.
- **D9 — A refused client never recovers**, even once the first closes: the lock is requested once,
  at construction, and without it `failClient` is final (`src/client.ts`). The consumer builds a new
  client. Unchanged here.

## 3. The mechanism

### 3.1 Declaration

A new field on every `VFS_CAPABILITIES` entry — additive; `exclusiveConnection` keeps its type,
since `VFSCapability` is public:

```ts
/**
 * Without these features the VFS holds its database file exclusively for a
 * connection's whole life, across the origin: one client at a time.
 */
readonly exclusiveConnectionWithout: readonly PlatformFeature[];
```

`['readwrite-unsafe']` on `OPFSWriteAheadVFS`, `[]` everywhere else. `exclusiveConnection: true`
stays on `AccessHandlePoolVFS`. The field is not `singleConnectionWithout`: `OPFSAdaptiveVFS`
declares that one (one worker per client) and must not declare this one (it shares across tabs).

A VFS is **exclusive here** when `exclusiveConnection` is true, or when a feature of
`exclusiveConnectionWithout` is missing on this engine.

### 3.2 The client

`readwrite-unsafe` cannot be probed from the page (`UNPROBEABLE`, `src/capabilities.ts`); it is
probed in a worker by `src/worker/probes.ts` since 2026-09-13. So, when
`exclusiveConnectionWithout` is not empty:

1. At construction the client spawns **worker 0 only**. Its `open` message carries the features to
   probe. The worker runs the probe first — before `WA_SQLITE_BUILDS[build]()`, no wasm, no VFS, no
   file touched — posts what is missing (or nothing missing), and waits.
2. **Nothing missing** (Chromium): the connection lock `bsq:conn:<ns>:<file>` is requested `shared`,
   as today; the client tells worker 0 to open and spawns the rest of the pool.
3. **A feature missing**: the lock is requested `exclusive` with `ifAvailable`.
   - **Granted**: worker 0 is told to open; the surplus workers are spawned and decline through the
     existing `declineWithout` path, so the client runs one worker, as today.
   - **Refused**: `failClient` with `DATABASE_IN_USE`; worker 0 is terminated having touched nothing.
4. The error names the VFS and the missing feature and says to close the other client. It carries
   no `sqliteCode`, so `readWithRetry` does not act on it.

**Every place that awaits the connection lock today must await the probe first**:
`acquireInstrumented`'s guard, and `close()`. The connection lock promise is no longer created
synchronously at construction for this VFS — which is the hazard the AHP guard paid a Critical
defect for (`mem:vfs`, AHP-2TAB): a `close()` called before the probe answers must return
promptly, request no lock afterwards, and leave no worker alive. It gets its own test.

The message names (`probeFirst`, `probed`, `proceed`, or others) are the plan's to fix, beside the
existing `declineWithout` / `declined` in `src/types.ts`.

**Cost:** one message round trip before the wasm load, on `OPFSWriteAheadVFS` only. Measured (§6).

### 3.3 Where the rest of the library reads the lock

`deleteDatabase` and `inspect` read lock names and modes. The plan checks, by reading and by a test
each, that an exclusive `bsq:conn` held by an `OPFSWriteAheadVFS` client is reported as a live
client and still makes `deleteDatabase` refuse with `DATABASE_IN_USE`.

## 4. The tests

### 4.1 The second-client matrix — `tests/browser/second-client.test.ts`

- **Loops:** every VFS of `ALL_VFS`, then every declared build of it. A pair the engine cannot run
  is skipped with `missingHere`'s answer as the reason. `for` loops calling `describe`/`it` — rstest
  0.11.8 has no `it.each`.
- **Expectation:** one test helper, `secondClientOutcome(vfs)` → `'refused' | 'isolated' |
  'shared'`, from `VFS_CAPABILITIES` and the features this engine really has. It reuses the
  conformance helpers' `AVAILABLE_FEATURES`, which probes `readwrite-unsafe` in a worker
  (`HAS_UNSAFE_HANDLES`). Step 2 filters on the same helper.
- **Two shapes**, because AHP-2TAB measured them apart: **together** — both clients constructed
  before either queries; **after** — B constructed once A has written.
- **Shared:** A writes and B reads it; B writes and A reads it; both clients stay usable.
- **Refused:** B's first query rejects with `DATABASE_IN_USE` within 3 s; **A is untouched** — it
  reads and writes after B's refusal; after `A.close()`, **a new client** C opens and reads A's data.
- **Isolated:** B does not see A's table; both work.
- **In every case:** no `WORKER_CRASHED` reaches either client and `onWorkerLost` stays empty — a
  suite that proves a VFS works must prove how many workers it worked with (`mem:lessons`,
  2026-09-13).
- **Cleanup:** close both clients, then `deleteDatabase(file, { vfs })` — the one removal correct on
  every layout; removing an `AccessHandlePoolVFS` file by name frees no slot.
- **Order:** the matrix is written first and goes red on `OPFSWriteAheadVFS` × Firefox; the guard of
  §3 turns it green.
- **Falsifiers, run, not reasoned:** remove `exclusiveConnectionWithout` from `OPFSWriteAheadVFS` —
  the refused rows go red on Firefox; set `exclusiveConnection: false` on `AccessHandlePoolVFS` —
  its rows go red.

### 4.2 Step 2 — `multi-client.test.ts` and `cross-tab.test.ts`

- They run on the VFS whose outcome is **shared** on this engine, from `secondClientOutcome`, never
  from a hand list. `describe` order puts the recommended first. On Chromium: `OPFSWriteAheadVFS`,
  `OPFSAdaptiveVFS`, then `OPFSCoopSyncVFS`, `OPFSAnyContextVFS`, `IDBBatchAtomicVFS`,
  `IDBMirrorVFS`. On Firefox, `OPFSWriteAheadVFS` drops out as refused.
- **Excluded, with the reason read off the contract:** `AccessHandlePoolVFS` and
  `OPFSWriteAheadVFS` where refused — B cannot exist, the matrix covers them; the two memory VFS —
  `sharesStorage` is false (`src/locks.ts`), so they take no write lock and publish no epoch marker,
  and all ten tests would test nothing.
- **Default build of each VFS** — the matrix covers builds for the contract, and these tests are
  heavy (two batches of ~2 000 rows × 16 columns).
- `twoClients(vfs)` and `oneClient(vfs)` take the VFS; cleanup goes through `deleteDatabase`.
- Bodies stay as they are unless a VFS forces a change. **Every red is triaged**: a defect, a
  documented limit, or a calibration. `IDBMirrorVFS` is not excluded in advance although
  read-your-writes across clients is not promised there; a red on it is triaged like any other.
- `leaves nothing behind when a tx.bulkWrite is interrupted` opens one client; it moves to §4.3's
  regime.
- **Falsifiers re-verified** on both recommended VFS × both engines, by deleting the line and
  observing red. They were verified on `OPFSAdaptiveVFS` only.

### 4.3 Step 3 — single-VFS tests on both recommended VFS

- **The list moves** from `scripts/render-vfs-matrix.ts` to a side-effect-free
  `scripts/recommended-vfs.ts`, imported by the renderer and by the tests. The renderer cannot be
  imported as is: it loads `@mdn/browser-compat-data` and `node:fs` and writes `VFS.md` at module
  load. The list stays out of `src/` (decided 2026-09-08).
- **`createTestClient` requires `vfs`.** 67 calls in 34 files take `OPFSAdaptiveVFS` without saying
  so today; a test that forgets the loop must fail to compile, as the library itself requires `vfs`.
- **Its cleanup removes the sidecars** — `DB_RELATED_SUFFIXES` plus the VFS's `extraFileSuffixes` —
  or `OPFSWriteAheadVFS`'s `-wa0`/`-wa1` stay in OPFS between tests. It cannot use `deleteDatabase`,
  which refuses while a client lives.
- **Loop:** `for (const vfs of RECOMMENDED_VFS) describe(vfs, …)`.
- **Exceptions keep their VFS** with a `// One VFS: <reason>` comment: the subject is the VFS
  (`coopsync-handover`, `idb-long-read`, `exclusive-connection`, …), a build, or two workers inside
  one client — which neither recommended VFS runs on Firefox (`writer-spread`, `barrier`, …; spec
  2026-09-13 §10.3).
- **A dry run first:** the default forced to `OPFSWriteAheadVFS` in the working tree, the suite run
  config by config on both engines, reds and durations recorded, the tree restored — the method of
  spec 2026-09-13 §10.3. `OPFSWriteAheadVFS` defaults to `sync`, `OPFSAdaptiveVFS` to `async`, so
  some reds will be calibrations rather than defects: a timeout test on `sync` measures the query's
  length (`mem:lessons`, 2026-09-15).

### 4.4 Existing tests

The list of tests to change is **grepped, never guessed** (`mem:lessons`, 2026-09-11). Known now:
`tests/unit/capabilities.test.ts` (its `exclusiveConnection` describe, and a sibling for the new
field modelled on `singleConnectionWithout`'s); any test that opens two `OPFSWriteAheadVFS` clients;
`delete.test.ts`. `pool-cap.test.ts` T5 stays: the file is held by a raw worker, which no lock of
ours can see, so `WORKER_CRASHED` with its storage cause is the right report there.

## 5. What this promises, and what it does not

- **Promised:** on every engine and every VFS, a second client on a database either shares it,
  opens its own isolated database (memory VFS), or is refused within 3 s with `DATABASE_IN_USE`
  while the first client is unharmed. A raw `WORKER_CRASHED` is no longer what a second client sees.
- **Promised:** the matrix fails if any VFS's declared outcome stops matching what it does.
- **Not promised:** that a refused client recovers (D9).
- **Not promised:** mixing VFS of the `opfs-path` family on one database. Four VFS resolve one name
  to one file (CROSS-VFS, `mem:vfs`), and their connection locks share a namespace: off Chromium, an
  `OPFSAdaptiveVFS` client requesting the lock `shared` while an `OPFSWriteAheadVFS` client holds it
  `exclusive` waits for it. That case is not designed here; the plan records what it observes.
- **Not promised:** a pool or a second client for `OPFSWriteAheadVFS` off Chromium. That is the
  VFS's design.

## 6. Measurements owed

- **The matrix's and step 2's cost**, per config, before committing to D4's placement.
- **The three unmeasured points of the defect**, on both engines, before the guard: what the first
  client sees; whether a new client opens once the first closes; the together shape. If they
  contradict D2, back to the user before the guard is written.
- **The probe round trip:** `createSQLiteClient` to a resolved `SELECT 1` on `OPFSWriteAheadVFS`,
  before and after, both engines, medians over repeated runs.
- **`IDBMirrorVFS` under load across two clients**: a throwaway probe in `tests/browser/`, deleted
  afterwards, method after MIRROR-1. The 2026-09-01 measurement of sharing ran isolated, and its own
  entry says loaded behaviour across clients was not probed. Stale reads across clients would be a
  decision for the user, not handled silently on this branch.

Every figure goes to `mem:measurements` with its date and method.

## 7. Documentation

- **`VFS.md`**: the `OPFSWriteAheadVFS` section (today "Everywhere else it runs on a single worker")
  says one client at a time without `readwrite-unsafe`. The paragraph on `AccessHandlePoolVFS`'s one
  connection per origin names both VFS — and says `DATABASE_IN_USE`: it says `BUSY` today, while
  the code has raised `DATABASE_IN_USE` since the guard shipped. Whether the generated table shows
  the new field is decided with the renderer; a hand edit inside a generated span is erased by the
  next render (`mem:lessons`).
- **`API.md`**: the `DATABASE_IN_USE` row already covers "a second client where the VFS supports one
  connection at a time"; checked, changed only if its wording needs `OPFSWriteAheadVFS`.
- **`CHANGELOG.md`**, unreleased section: *Changed* — a second `OPFSWriteAheadVFS` client without
  `readwrite-unsafe` fails with `DATABASE_IN_USE` instead of `WORKER_CRASHED`; *Added* —
  `VFSCapability.exclusiveConnectionWithout`.
- The bench page reads `singleConnectionWithout`; it is grepped for anything the new field changes
  (BENCH-DRIFT rule).

## 8. Order of work

1. Cost: the step-3 dry run on `OPFSWriteAheadVFS`, and an estimate of the matrix's duration.
2. The three unmeasured points (§6).
3. The matrix, red; the guard, green; the falsifiers run.
4. The `IDBMirrorVFS` probe.
5. Step 2.
6. Step 3.
7. Documentation, then the full verification: the whole baseline table of `mem:state` re-read in one
   pass — `pnpm test` (three reports), `pnpm exec tsc --noEmit`, `pnpm test:conformance` (two
   reports), `pnpm test:consumer`.

Memories at closure: `mem:vfs` (the `OPFSWriteAheadVFS` row: one tab without `readwrite-unsafe`),
`mem:measurements` (§6), `mem:follow-ups` (the entry deleted), `mem:state` (rewritten),
`mem:lessons` if the branch teaches one.

## 9. Out of scope

- A typed reason for the pool cap in place of `poolLimitReason` (D3).
- Memoising the probe result per realm (D6), unless §6 asks for it.
- Whether `OPFSWriteAheadVFS` stays recommended (D2).
- Recovery of a refused client (D9).
- Safari: the probe answered `false` there on 2026-09-13, so the guard applies; a second client on
  Safari is not measured, and the guard does not depend on it.

## 10. Amendments — 2026-09-15, while planning (user)

Confronting §3.2 with `src/client.ts` changed two things. The sections above stand as amended here.

- **A1 — The probe answer is memoised per realm, for determinism, not cost (reverses D6's
  deferral).** With each client waiting on its own worker 0, two clients built together request the
  lock in the order their workers answer — so the SECOND client constructed can win and the first
  be refused. A module-level promise per feature list, resolved by the first worker 0 to answer,
  makes every client of the realm subscribe in construction order, so the first constructed requests
  the lock first and wins, as with `AccessHandlePoolVFS`. Every worker 0 still probes and still
  waits for `proceed`: the memo decides the lock's order, never whether a worker may open. Across
  tabs the order stays first-come, which is correct.
- **A2 — The pool is spawned at construction, as today; only worker 0 waits.** The surplus workers
  already carry `declineWithout`: without the feature they decline before touching the file, and with
  it they open while worker 0 waits for the lock, as every shared VFS does today. §3.2's "spawns
  worker 0 only … then the rest" is dropped, which leaves the scheduler's startup gate untouched. It
  holds on one condition, pinned by a unit test: every feature of `exclusiveConnectionWithout` is
  also in `singleConnectionWithout`.
- **A3 — A refused client is `connRefused`, not "no releaser".** The guard in `acquireInstrumented`
  tests a flag set only when an `ifAvailable` request comes back empty. "No releaser" would also be
  true of a client whose worker 0 died or closed before answering, and it must report its own
  failure, not `DATABASE_IN_USE`. `failClient` and `close()` settle the pending answer as "none", so
  that `close()` and every query awaiting the connection lock always settle.

## 11. Amendment — 2026-09-15, found by the dry run (user)

- **A4 — A write transaction begins `IMMEDIATE`.** The step-3 dry run (plan Task 1) found
  `output()` failing on `OPFSWriteAheadVFS` with "disk I/O error", both engines. Diagnosed the
  same day by four throwaway probes: that VFS refuses a write transaction that did not announce
  itself at `BEGIN` — its `jLock` throws `Write transaction cannot use BEGIN DEFERRED`, by design
  ("which this VFS treats as an error") — so a transaction whose first statement reads, or runs a
  write that changes nothing, fails with `SQLITE_IOERR_WRITE` (778; `IOERR_LOCK`, 3850, on an
  empty file) and leaves the connection unusable. `BEGIN IMMEDIATE` passes every shape;
  `OPFSAdaptiveVFS` passes every shape either way. `transaction()` sent a plain `BEGIN`, and
  `output()`'s swap begins with a `DROP TABLE IF EXISTS` that writes nothing on a new target.
  Decided: `transaction()` sends `BEGIN IMMEDIATE` unless `readOnly`, which keeps `BEGIN`. The
  origin write lock is already held at that point, so `IMMEDIATE` moves SQLite's RESERVED lock to
  the start of a transaction no other writer can be in. Guarded by a browser test over every
  (vfs, build) pair. **Not established:** why the connection stays broken after the refusal — a
  consumer who sends a raw `BEGIN` through `write()` can still reach it; that goes to
  `mem:follow-ups`. Inserted in the plan as Task 3b, before Task 4.
