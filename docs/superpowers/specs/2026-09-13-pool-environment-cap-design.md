# A pool capped by its environment, not lost to it — design

**Status:** approved in chat 2026-09-13, section by section; not yet planned.
**Branch:** `fix/pool-environment-cap`, from `main` after `922c046`.
**Evidence:** `.scratchpad/worker-lost/` — every probe and log cited in §6.

## 1. The problem

Every Firefox run of the TX-SAVEPOINT probe logged `worker N lost; pool is now 1 of 2`
(`mem:follow-ups`, 2026-09-11). Investigated 2026-09-13; it is not a probe artefact.

**On an engine without `readwrite-unsafe`, an `OPFSWriteAheadVFS` client never has more than
one worker, whatever `poolSize` says.** wa-sqlite's `OPFSWriteAheadVFS` opens the main
database file and its two write-ahead files with
`createSyncAccessHandle({ mode: 'readwrite-unsafe' })` and **keeps those handles for the whole
life of the connection** — its `#open` Web Lock serialises the opening only. Firefox and WebKit
ignore the `mode` option (the attribute does not exist on `FileSystemSyncAccessHandle` there),
so each handle is exclusive:

- the first worker through `#open` keeps the file;
- every other worker's `createSyncAccessHandle` rejects — `NoModificationAllowedError` on
  Firefox, `InvalidStateError` on Safari (WebKit's `createSyncAccessHandle` returns
  `FileSystemStorageError::InvalidState` when its exclusive file lock is taken);
- `jOpen` returns `SQLITE_CANTOPEN`, the worker posts `open-error`, the client receives
  `WORKER_CRASHED: sqlite3_open_v2`;
- the startup retry round fails the same way, since the first worker still holds the file,
  and `onGateOpen` declares the slot lost: one `warn`, one `onWorkerLost` per slot, for a
  situation that is structural, not a failure.

Which slot survives is a race for `#open`; the loser's index varies between runs.

`OPFSAdaptiveVFS`, the other VFS that asks for `readwrite-unsafe`, is **not** affected: without
the feature it takes a Web Lock per file and hands its handle over on a `BroadcastChannel`
request, so every worker opens and the pool rotates one handle (measured, §7).

**What it cost, beyond the noise.**

- Every wa-sqlite failure prints two console lines per slot per attempt: `jOpen`'s
  `console.error(e.stack)` — an empty string, a `DOMException` carries no stack on either
  engine — and `jGetLastError`'s `console.error(this.lastError)`, called by SQLite after
  `SQLITE_CANTOPEN`. Six pairs at `poolSize` 4.
- The real cause never reaches the consumer. For `sqlite3_open_v2` wa-sqlite has no
  connection to ask `sqlite3_errmsg`, so its error carries only the function name; the cause
  lives in `vfsInstance.lastError` and is dropped at the worker boundary.
- **Commit `70b2b7a` (2026-08-27) refuted a claim that was true.** The README and `mem:vfs`
  said: off Chromium the first connection opens and the second cannot take the handle. The
  commit declared that false because conformance passed on Firefox at `poolSize` 1, 2 and 4.
  Conformance never counts live workers, and a pool shrunk to one passes it.
- Every bench export of `OPFSWriteAheadVFS` on Firefox and Safari ran on one worker of four
  (`poolFor` = 4 on the page), with no trace in the export: the page does not hook
  `onWorkerLost`. Its single-client figures stand — a consumer gets one worker too — but its
  concurrency rows describe one worker, not a rotated handle.

## 2. Decisions (user, 2026-09-13)

- **D1 — a pool the environment caps is capped, not lost.** Nothing is reported through
  `onWorkerLost`; nothing that was bound to fail is started.
- **D2 — the warning follows the consumer's request.** Default `poolSize`: the pool drops to
  1 silently (`debug` logs it). Explicit `poolSize` above the cap: **one** warning naming the
  cause. Chosen over warning in every case (a warning the default consumer cannot silence
  except by passing `poolSize: 1`) and over failing the client (an asynchronous failure of a
  client that would work on one worker).
- **D3 — errors: carry the cause, leave wa-sqlite's console alone.** The real error reaches
  the consumer's error, `onWorkerLost`'s `cause` and the `lost` warning. wa-sqlite's two lines
  stay: once nothing fails by construction, what remains accompanies a real failure, and
  silencing it means patching third-party code whose patch awaits an upstream release, or
  intercepting a worker's global console.
- **D4 — the effective size is readable: a `db.poolSize` getter.** Chosen over debug-only
  visibility (the bench needs it programmatically) and over an `onPoolCapped` callback.
- **D5 — every worker probes and declines itself.** Chosen over probing in worker 0 and
  spawning the rest afterwards — the startup gate waits for every slot
  (`src/scheduler.ts`, `acquire`), so every client's first query would pay one more worker
  boot on Chromium — and over reclassifying the open error, which still starts and fails
  the workers, keeps wa-sqlite's noise, depends on engine-specific error names, and still
  runs the retry round.
- **D6 — `WorkerLostEvent.size` becomes the effective size.** After a cap, "0 of 4" would read
  as four losses.
- **D7 — `db.ready` is rc.6.** A promise for the pool's startup was agreed in shape and moved
  to `mem:follow-ups` as a feature, by the triage rule; `db.poolSize`'s contract is written
  without it (§3.3).

The page cannot probe `readwrite-unsafe`: `FileSystemSyncAccessHandle` is exposed to
dedicated workers only (`typeof` it is `"undefined"` in the page on Chromium and Firefox,
measured), which is why `UNPROBEABLE` holds it. A dedicated probe worker spawned by the client
was set aside: it answers asynchronously all the same, and a `blob:` worker is refused by a
consumer CSP without `worker-src blob:`.

## 3. The mechanism

### 3.1 Declaration and probe

**Declaration.** A new field on every `VFS_CAPABILITIES` entry:

```ts
/**
 * Without these features the VFS holds its database file exclusively for a
 * connection's whole life, so exactly one worker of a pool can open.
 */
readonly singleConnectionWithout: readonly PlatformFeature[];
```

`['readwrite-unsafe']` on `OPFSWriteAheadVFS`, `[]` everywhere else. `OPFSAdaptiveVFS` keeps
only its `degradesWithout`. `scripts/render-vfs-matrix.ts` reads the field and the generated
Pool cell shows the cap.

**Who probes.** At `spawn`, the client adds `declineWithout: capability.singleConnectionWithout`
to the `open` message **only for slots of index ≥ 1**, and only when the list is not empty.
Slot 0 never probes and always opens, as today. The worker needs neither the capability table
nor its own index.

**The probe.** A new pure module, `src/worker/probes.ts`, tested in Node like
`cloneable.ts`:

```ts
const WORKER_PROBES = {
  'readwrite-unsafe': () =>
    typeof FileSystemSyncAccessHandle === 'function' &&
    'mode' in FileSystemSyncAccessHandle.prototype,
};
```

It runs first in `open()`, **before `WA_SQLITE_BUILDS[build]()`** — no wasm loaded, no VFS
created, no file touched. If a feature of `declineWithout` is missing, the worker posts
`{ type: 'declined', callId: 0, missing }` and stops there. Otherwise it opens as today and
posts nothing new.

Measured 2026-09-13 in a dedicated worker: Chromium `true`; Firefox `false`; Safari `false`
(the user, in Safari's console on the preview page). The day Firefox or WebKit ships the
feature, the probe passes and the pool regains its size with no code change.

`UNPROBEABLE` in `src/capabilities.ts` stays true for the page; its comment says the feature
is probed in the worker.

### 3.2 What the client does with a `declined`

**`src/pool.ts`.** `declined` settles the worker's init **without `die`** — no `onDeath`,
nothing died. `createPoolWorker` resolves with a result that tells "opened" from "declined
(missing feature)"; `spawn` branches on it, and its `openTimeout` timer is cleared as for an
opened worker.

**The client, for a declined slot:**

- terminates the worker (`terminate`, not `onDeath`) and clears `pool[index]`;
- **scheduler** — new `retire(index)`: settles the slot in the gate with a new kind,
  `'declined'`, which counts as settled but neither as opened nor as failed, so it never
  enters `failedIndices` and never triggers the retry round; the slot is unavailable for
  good;
- **supervisor** — new event `'retired'`: the slot leaves `liveCount`, is never restarted,
  yields no decision, and cannot be revived by a late `'spawned'`/`'ready'`; a later death
  reported for it is ignored by the existing guard;
- **`db.poolSize`** — the requested size minus retired slots;
- **the warning** — **once**, on the first `declined`, **only if `poolSize` was passed**:
  `OPFSWriteAheadVFS holds its database file exclusively without readwrite-unsafe: pool
  capped at 1 of 4`. Otherwise a `logger.info` line, visible under `debug` only;
- **no `onWorkerLost`.**

**Edges.**

- Slot 0 fails and every other slot declines: `openedCount === 0`, total failure as today;
  only slot 0 is announced lost, and the client fails with its real cause (§3.4).
- Slot 0 dies later: R1 restarts it as today; the respawn carries no probe.
- `abortSlots` stays sized on the requested pool; harmless.

### 3.3 `db.poolSize`

A readonly getter beside `id`, `name`, `file`, `vfs` and `build` in `src/api.ts`:

> **`poolSize`** — the number of workers the pool runs, which is `poolSize` as requested,
> capped by the VFS and by the environment. Exact once every worker has opened or declined;
> every query waits for that, so it is settled by the time any query returns.

Lost workers do not change it: it is the pool's capacity, and losses are reported by
`onWorkerLost` with `live`.

### 3.4 The real error reaches the consumer

**Worker, in `open()`.** `vfsInstance` is hoisted to the function's scope so the final `catch`
can read it. When `vfsInstance.lastError` is set, `open-error` carries:

- `message`: `sqlite3_open_v2: NoModificationAllowedError: No modification allowed` —
  wa-sqlite's message, then the cause's name and message;
- `cause`: `cloneable(lastError)`, through the existing clone probe, so a `DOMException` that
  cannot be cloned falls back to today's behaviour.

Without `lastError` — another VFS, or a failure before the VFS — nothing changes. A fresh
`vfsInstance` per `open()` means the value cannot be stale.

**Client.** The code stays `WORKER_CRASHED`; `busyFromCode` is untouched, so a `BUSY` stays
`BUSY`. The `lost` warning appends the cause, for every loss:
`worker 2 lost; pool is now 1 of 2 (sqlite3_open_v2: NoModificationAllowedError: No
modification allowed)`. `onWorkerLost({ cause })` and `failClient`'s error carry the same
error with its `cause`. `WorkerLostEvent.size` is the effective size (D6).

## 4. What this promises, and what it does not

- **Promised:** on every engine, a client whose VFS declares `singleConnectionWithout` and
  whose environment lacks one of those features runs on one worker, starts nothing that is
  bound to fail, prints nothing from wa-sqlite, and reports nothing through `onWorkerLost`.
  Where the feature exists, behaviour is unchanged.
- **Promised:** an open failure reports its VFS-level cause to the consumer.
- **Not promised:** a pool of more than one worker for `OPFSWriteAheadVFS` off Chromium. That
  is the VFS's design, not ours to change.
- **Not promised:** that the probe is right on an engine that exposes `mode` without honouring
  it. None is known; if one appears, the old failure path still reports it, now with its cause.

## 5. Out of scope

- `db.ready` — rc.6 (D7, `mem:follow-ups`).
- wa-sqlite's console lines on a genuine failure (D3).
- The `sqliteCode` lost at the worker boundary on the query path — its own entry in
  `mem:follow-ups`.
- `OPFSAdaptiveVFS`'s rotation — untouched.
- Re-measuring the bench on Firefox and Safari: the recorded single-client figures describe
  what a consumer gets; what changes is the label, which exports carry from now on (§8).

## 6. Measurements

All 2026-09-13, this container unless stated; logs in `.scratchpad/worker-lost/`.

| Probe | Method | Result |
|---|---|---|
| `probe.test.ts` | one client per VFS, `onWorkerLost` captured with its phase; 3 Firefox runs, 1 Chromium | Firefox: `OPFSWriteAheadVFS` loses slot 1 at +130-160 ms, before the first write resolves, `WORKER_CRASHED`, `sqlite3_open_v2`, 3/3. `OPFSAdaptiveVFS`, `MemoryVFS`: nothing. Chromium: nothing. |
| `probe-handles.test.ts`, raw | two dedicated workers, one file, `mode: 'readwrite-unsafe'` | Firefox: `h.mode` undefined, second open `NoModificationAllowedError`, 3/3. Chromium: both open in `readwrite-unsafe`. |
| `probe-handles.test.ts`, pool | `OPFSWriteAheadVFS` at `poolSize` 1/2/4, `OPFSAdaptiveVFS` at 4 | Firefox: **0/1/3 losses** and 0, 3/3, losing index varies. Chromium: 0 everywhere. |
| `probe-builds.test.ts` | `OPFSAdaptiveVFS` async/jspi at 2 and 4; `OPFSWriteAheadVFS` async/jspi at 2 | Firefox: Adaptive 0 everywhere; WriteAhead 1 loss on both builds, 3/3. Chromium: 0 everywhere. |
| `probe-mode.test.ts` | `'mode' in FileSystemSyncAccessHandle.prototype` in a worker; `typeof` in the page | Chromium `true`, Firefox `false`; page `undefined` on both. Safari `false` (user, console, preview page). |
| preview bench page | the user's Safari and Firefox consoles, `OPFSWriteAheadVFS` | Safari: 3 lost of 4, six `<empty string>` + `InvalidStateError` pairs, stacks `jOpen` then `jGetLastError`. Firefox: slots 1, 2 and 4 lost, same pairs with `NoModificationAllowedError`. n=1 each. |
| `pnpm test:firefox --reporter default` | the whole Firefox suite with its console | 12 `lost` lines, every one produced on purpose by `lifecycle.test.ts` or `firefox/handle-starvation.test.ts`. The default reporter omits a passing test's console, which is why the closure baselines never showed any. |

WebKit source read 2026-09-13 (`FileSystemStorageHandle.cpp`, `main`): `createSyncAccessHandle`
takes an exclusive lock through `acquireLockForFile` and returns
`FileSystemStorageError::InvalidState` when it fails; no `mode` is read. The mapping to
`InvalidStateError` is inferred from the default message the console shows, not read.

## 7. Tests

Each with the mutation that must turn it red.

**Unit (Node).**

- `probes.ts`: `FileSystemSyncAccessHandle` stubbed with `mode` on its prototype, without it,
  and absent. *Falsifier: a probe that returns `true` unconditionally.*
- `tests/unit/scheduler.test.ts`: `retire()` settles the slot without adding it to
  `failedIndices`, so no retry round; slot 0 failing while the others decline gives
  `openedCount === 0`. *Falsifier: settle it as `'failed'`.*
- `tests/unit/supervisor.test.ts`: `'retired'` leaves `liveCount`, is never restarted, ignores
  a later `'died'`. *Falsifier: treat `'retired'` as `'died'`.*

**Browser, one file shared by both engines — `tests/browser/pool-cap.test.ts`.** The arbiter is
`HAS_UNSAFE_HANDLES` from `tests/conformance/helpers.ts`: a behavioural oracle (two handles
opened) independent of the library's probe, so no engine is sniffed.

- **T1** `OPFSWriteAheadVFS`, `poolSize: 4`: `db.poolSize === (HAS_UNSAFE_HANDLES ? 4 : 1)`, no
  `onWorkerLost`, exactly one warning naming `readwrite-unsafe` and `1 of 4` where capped and
  none otherwise (`console.warn` replaced for the test, restored by `onTestFinished`).
  *Falsifiers: a probe always true (3 losses on Firefox); a probe always false (pool of 1 on
  Chromium); the probe sent to slot 0 (the client fails).*
- **T2** the same VFS, default `poolSize`: capped → `poolSize === 1`, no warning. *Falsifier:
  drop the "explicit" condition.*
- **T3** `OPFSAdaptiveVFS` at 4: `poolSize === 4` on both. *Falsifier: declare the field on it.*
- **T4** capped engines only: after the cap, crash slot 0 through `interceptWorkers()` with
  `maxWorkerRestarts: 0` → `onWorkerLost({ size: 1, live: 0 })`. *Falsifier: pass the
  requested size.*
- **T5** a raw dedicated worker holds the database file exclusively before the client opens;
  the client fails, and the `cause` carries the error name this same engine gives a second
  exclusive open, measured inside the test — no longer `sqlite3_open_v2` alone. *Falsifier:
  ignore `lastError` in the worker's `catch`.* What Chromium raises when the VFS's
  `readwrite-unsafe` open meets a third party's exclusive handle is not measured; checked at
  implementation.

**Conformance — the falsifier 2026-08-27 lacked.** `conformanceClient` and `createReopened`
register `onWorkerLost`, and an `afterEach` requires that no loss occurred: a conformance pass
with a lost worker is not a pass. **This must fail on Firefox today**, and is checked before
the fix is written — it is the reproduction. `poolSize` stays explicit there, so Firefox's
conformance run prints the legitimate D2 warning.

**Final verification.** The whole baseline table of `mem:state`, re-read in one pass:
`tsc`, `build`, `pnpm test` (three reports, four fields each), conformance, consumer, the
Chromium bench check, lint. Plus one Safari bench export read by hand on the preview.

## 8. Documentation

**`API.md`.**

- The `poolSize` row: "`2`, capped to the VFS's `maxPoolSize`" becomes "…and to what the
  environment allows".
- The paragraph "a VFS that holds a single connection caps it at `1` and throws if you pass
  more" separates the two caps: the declared one (`maxPoolSize`) is refused at construction as
  today; the environment's one (`OPFSWriteAheadVFS` without `readwrite-unsafe`) runs on one
  worker, no error, a warning only if `poolSize` was passed.
- Getters: `poolSize`, with the contract of §3.3.
- `debug` / `onWorkerLost`: the `lost` warning carries the cause; `size` is the effective size.

**`VFS.md`.**

- "Everywhere else it opens the handle exclusively and rotates it between workers" is false for
  `OPFSWriteAheadVFS`: rewritten — without `readwrite-unsafe` it holds its file for a
  connection's life and does not rotate, so the pool runs on one worker, capped automatically.
- *Reduced mode*: tells the two apart — `OPFSAdaptiveVFS` rotates its handle between workers,
  `OPFSWriteAheadVFS` has one connection.
- The VFS's generated header shows the cap, through the new field.
- The recommendations do not change (§1, last bullet).

**Code comments.** `src/types.ts` on `OPFSWriteAheadVFS`: the 2026-08-27 measurement ran at an
effective pool of one, and Safari is now observed. `UNPROBEABLE`: unprobeable from the page,
probed in the worker.

**`CHANGELOG.md`, `## Unreleased`.** *Fixed*: `OPFSWriteAheadVFS` no longer loses its workers
on Firefox and Safari; an open failure carries its real cause. *Added*: `db.poolSize`.
*Changed*: `WorkerLostEvent.size` is the effective size; the `lost` warning carries the cause.

**Bench.** Each export records `db.poolSize` per pair, beside `opfsRootAtStart`
(`scripts/bench/html/index.html`). `poolFor` is unchanged.

**Memories, at closure.** `mem:vfs`, the `OPFSWriteAheadVFS` row; `mem:measurements`, this
campaign as WORKER-LOST; `mem:lessons`, a conformance that does not count live workers cannot
see a shrunk pool, and made us refute a true claim; `mem:follow-ups`, the `worker 1 lost` entry
deleted.
