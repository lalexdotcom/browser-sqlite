# Interrupting a running query — design

**Status:** approved 2026-09-04, not yet planned.
**Backlog item:** INTERRUPT-1, "a running `step()` cannot be stopped, and the primitive to
stop it is already there", in `mem:follow-ups` (2026-09-03).

Every number below was read off a run in this container on 2026-09-04, on Chromium
151.0.7922.34 and Firefox 153.0, from two throwaway probes kept in
`.scratchpad/interrupt-1/` with their instructions. Nothing here is extrapolated. Where the
first probe and the second disagree, the second is quoted: the first priced the handler
against a cold baseline and against one query shape, and was wrong by a factor of two.

## 1. What cannot be done today

A `signal` cancels a query still queued for a lease, stops `bulkWrite` between batches, and
stops `stream()`/`chunk()` pulling rows. What it cannot do is stop a single
`sqlite3_step()` already running: `makeAbortRace` in `src/client.ts` abandons the WAIT, the
worker steps on, and `quiesce()` returns the lease only once it is genuinely idle.

Measured 2026-09-04, Chromium, `poolSize: 1`: a 1 980 ms statement aborted 100 ms in
settles its promise in **0 ms**, and the very next short read then takes **1 889 ms**
waiting the statement out. A runaway query holds its worker to the end, and `close()` pays
its `drainTimeout` behind it.

## 2. Non-goals

- **A budget for a transaction, a `bulkWrite` or an `output`.** Those carry a `signal`
  because it lands between statements or between batches; a time budget over many
  statements is a different feature with a different rollback story. `timeout` therefore
  goes on the query surfaces only — where it is reachable from inside a transaction, per
  query, which is the case that has a meaning.
- **A capability getter on the client.** Rejected by the user, 2026-09-04: it is noise on an
  API surface, and the question belongs in the README where a reader is already looking.
- **A warning, or a refusal, on a configuration that cannot interrupt.** Passing a `signal`
  there stays legal and keeps doing exactly what it does today.
- **`sqlite3_interrupt`.** Unusable: it must be called from another thread while `step()`
  runs, and the worker's thread is inside that call.
- **A row on the benchmark page.** The page measures VFS; interruptibility is a property of
  the build. Worth deciding separately if the behaviour is ever wanted on real devices —
  and note the page can only ever demonstrate the `async` path, because GitHub Pages cannot
  send the header that would isolate it (§6).

## 3. The surface

**`signal` — unchanged.** It still rejects with `signal.reason`, still settles immediately.
Its TSDoc gains one link, not one clause: the promise's meaning does not change, only what
happens behind it.

**`timeout?: number` — new**, on `SQLiteQueryOptions` and `SQLiteChunkOptions` only. It is a
budget of **execution time inside SQLite**, in milliseconds, accumulated over the whole
call — every statement the call prepares draws on the same budget, so a ten-statement
script does not silently get ten budgets.

Counting execution rather than wall clock is what makes the option worth having beside
`AbortSignal.timeout()`, which counts wall clock from its own creation and works here
already. Two different sentences: *"this query has used 5 s of engine"* and *"five seconds
have passed since I asked"*. The first is the one that cannot be said any other way, and
the one that does not kill a `stream()` because the application was slow to read its rows.

**`QUERY_TIMEOUT` — a new public error code.** `TIMEOUT` already means "a deadline this
library imposed on itself expired" — a worker that never became ready, a deletion that did
not complete. The new case means "the budget YOU set is spent". Conflating them would force
a caller to read the message to know which one they hold; this is the argument that already
separates `DATABASE_IN_USE` from `BUSY`.

**`SQLITE_INTERRUPT` never reaches the caller.** SQLite's code says that the statement
stopped, not why. The worker knows which trigger fired and translates — `signal.reason` or
`QUERY_TIMEOUT`. An `SQLITE_INTERRUPT` surfacing raw would be a defect, not an acceptable
leak.

**Documentation.** `signal` is documented exactly once, on `OptionsWithSignal`
(`src/api.ts:32`), and the five public option types are built from it, as is the inline
options bag of `client.exec` — so one comment reaches every `signal` in the shipped
`.d.ts`. That comment, and the new `timeout`, point by name
to a new README section placed after `## Options`, in the style the code already uses
("see the README's VFS Selection guide", `src/client.ts:140`). The section carries the
matrix of §6 once, in prose. The VFS table is not touched: this is not a VFS property.

## 4. The mechanism

`sqlite3.progress_handler(db, nProgressOps, handler, userData)` is exposed by all three
builds (`src/sqlite-api.js:507`, typed at `src/types/index.d.ts:622`). SQLite calls the
handler every N VM instructions **on the worker's own thread, inside `step()`**, and a
non-zero return ends the statement with `SQLITE_INTERRUPT`. Measured on both engines and
all three builds: it does, and the connection serves the next query immediately afterwards.

### 4.1 The handler is installed per query, and its shape depends on what the query carries

Installed when the query carries a `signal` or a `timeout`; removed in the `finally` that
already resets the statement, including when it throws. A permanently installed handler
would charge every query, and on `async`/`jspi` it would yield the event loop inside every
query, moving the timing of everything else.

| the query carries | build | handler | what it reads |
|---|---|---|---|
| `timeout` only | all three | synchronous | the local clock |
| `signal` | `async` / `jspi` | **async** — it yields | the `stop` that arrived during the yield |
| `signal` | `sync`, isolated | synchronous | `Atomics.load(view, myIndex)` |
| `signal` | `sync`, not isolated | none, for the signal | — (degraded, §6) |

A `timeout` alone never needs to yield, even on `async`: the synchronous handler suffices
and avoids the only cost this design has.

### 4.2 Two channels, not one

The `stop` message already posted by `src/pool.ts` stays, and is still required: a worker
parked waiting for a credit reads no flag — the file says so where it happens. The shared
slot covers the disjoint case: a worker that is computing, not waiting.

**One `SharedArrayBuffer` per client, one `Int32` per worker.** One allocation, one
teardown, and the worker already has the index the pool uses in its messages. The slot
holds the **`callId` to abort**, not a boolean: a stale value never matches a future
`callId`, so nothing has to be cleared between two queries, and no reset races the start of
the next one.

**One obligation this shape adds:** zero the slot when a worker is created into it.
`currentCallId` is per worker and restarts at 0 on a restart (`src/pool.ts:174`), while the
slot keeps the dead worker's last value — a replacement would otherwise meet its
predecessor's abort on reaching that number. One `Atomics.store(view, i, 0)` at the spawn
site closes it.

Adjacent `Int32` slots share a cache line, so a write for one worker briefly invalidates it
for the others reading in their handler. At `poolSize` ≤ 8, with aborts rare, this does not
earn 64-byte padding; the remedy is known if a measurement ever says otherwise.

**Without isolation, none of this exists**: no buffer is allocated, no index is sent, no
slot is read. The degraded path is a branch not taken, not a cost paid.

### 4.3 `N = 100 000`, internal

Not an option. It is an engine tuning, like the statement cache's byte bound: nobody can
choose it better than the measurement, and exposing it would commit us to holding it.

Cost of the installed handler, five repetitions round-robin across conditions, two shapes
each calibrated to ~500 ms on the engine running them — S1 a single long `step()` of pure
computation, S2 a scan returning 100 000 rows × 6 columns materialised the way the worker
does it:

| | S1 Chromium | S1 Firefox | S2 Chromium | S2 Firefox |
|---|---|---|---|---|
| sync handler, N=10⁵ | −1.0 to +1.3 % | −0.6 to +1.0 % | −3.4 to −1.6 % | −1.6 to +0.7 % |
| sync handler, N=10⁶ | +0.4 to +0.5 % | 0.0 to +2.2 % | −2.5 to −0.3 % | −1.4 to +1.9 % |
| async handler, N=10⁵ | +2.3 to +3.2 % | +2.2 to **+4.7 %** | −0.2 to +1.8 % | −0.9 to +0.1 % |
| async handler, N=10⁶ | +0.5 to +2.3 % | 0.0 to +1.8 % | −1.6 to −0.9 % | −0.2 to −0.1 % |

Negative values are the noise floor, not a gain. **The synchronous handler is free at both
N**, and **on a query that returns rows nothing is measurable at all** — row marshalling
dominates. The only real cost is the yield, on pure computation: ~2-5 % at 10⁵, ~0-2 % at
10⁶, and only for a query that carries a `signal` on an `async`/`jspi` build.

Overshoot past the moment the decision was taken:

| | N=10⁵ | N=10⁶ |
|---|---|---|
| Chromium `sync` / `async` / `jspi` | 1 / 1 / 1 ms | 3 / **7** / 3 ms |
| Firefox `sync` / `async` / `jspi` | 5 / 6 / 2 ms | 31 / **87** / 33 ms |

10⁶ would recover 2-4 points on the one shape nobody writes, and pay for it with 87 ms on
Firefox/`async` — the slowest combination already. The exchange is bad in that direction.

## 5. Decisions

**D1 — The promise still settles immediately; it does not wait for the worker to confirm.**
Rejected alternative: settle once the `step()` has genuinely ended. It cannot be honoured
everywhere — on `sync` without isolation there is no interruption, so "wait for the real
end" would mean waiting 1 889 ms, making abort *slower than today* on exactly the
configuration this design promises not to harm. Making the wait conditional would make a
promise's settle time depend on the VFS, the build and the host's headers. And the web has
already fixed the meaning of an abort: `fetch()` rejects immediately, without waiting for
the connection to be torn down. The guarantee the alternative seems to buy is delivered
anyway by the scheduler, which serialises the next query on the worker's lease.

**D2 — The feature is detected as `cross-origin-isolated`, never as COOP/COEP.** A new
`PlatformFeature` with the probe `globalThis.crossOriginIsolated === true`, in `PROBES`
beside `opfs` and `jspi`, declared against the **build** (beside `BUILD_REQUIREMENTS`, in
the shape `degradesWithout` already has for VFS) — interruptibility is a property of the
build, not of the VFS. Naming the mechanism would be a mistake with a measured cost:
`Document-Isolation-Policy: isolate-and-require-corp` alone, with no COOP and no COEP,
makes a page **and its dedicated worker** cross-origin isolated on Chromium 151 —
`crossOriginIsolated=true`, `SharedArrayBuffer` constructible, `Atomics` working,
`postMessage(SAB)` accepted (measured; Firefox 153 ignores the header). A consumer who
adopts DIP becomes interruptible without this library learning its name.

**D3 — `SharedArrayBuffer` and `Atomics` must NOT enter the library's floor list.**
`LIB_FLOOR` in `scripts/render-vfs-matrix.ts` is computed from BCD over a named list of the
APIs the published bundle uses. These are used only behind a probe, exactly like
`readwrite-unsafe`, and adding them there would raise the floor for a capability that is
optional. This is the `structuredClone` trap recorded in `mem:follow-ups`, which would have
raised the floor from Chrome 92 to 98 for an error *cause*.

**D4 — `timeout` counts execution, not wall clock.** §3. The falsifier is a test, not an
assertion: a `stream()` whose consumer sleeps longer than the budget between pulls must not
time out.

**D5 — Approach B, not A.** The `SharedArrayBuffer` channel for an isolated `sync` build is
in this lot, chosen by the user on 2026-09-04 against a recommendation to defer it. The
recommendation's argument was the narrow audience — a consumer on a `sync`-default VFS who
also controls their headers — and it stands as a cost, not as an objection: the machinery
is a second code path, and §8 is what keeps it honest.

## 6. What this promises, and what it does not

| build (default VFS) | `timeout` | `signal` stops a running statement |
|---|---|---|
| `async` / `jspi` — `OPFSAdaptiveVFS` (recommended), `OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `MemoryAsyncVFS` | yes | **yes** |
| `sync`, isolated — `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS` | yes | **yes**, through the shared slot |
| `sync`, not isolated | **yes** | no — it stops the wait, as today |

The four `sync`-default VFS all declare `async` in their `builds`, so a consumer who wants
the signal without touching their hosting can ask for `build: 'async'` and pay what that
build costs.

The degraded row is today's behaviour exactly, which is why nothing about it is an error,
a warning or a refusal.

**GitHub Pages cannot send COOP/COEP or DIP** — measured: the live site returns no
`Cross-Origin-*` header, and Pages exposes no mechanism to add one. Our own benchmark page
is therefore permanently in the degraded row for `sync`, which is also the honest place for
it to be: every consumer on ordinary static hosting is there too.

## 7. Where it touches the code

- `src/api.ts` — `timeout` on `SQLiteQueryOptions` and `SQLiteChunkOptions`; the README
  pointer in `OptionsWithSignal`'s TSDoc.
- `src/errors.ts` — `QUERY_TIMEOUT`.
- `src/types.ts` — the `cross-origin-isolated` feature, and the per-build degradation
  declaration beside `BUILD_REQUIREMENTS`.
- `src/capabilities.ts` — the probe.
- `src/pool.ts` — the buffer, its slot per worker, zeroing on spawn, writing the `callId` on
  abort alongside the existing `stop` message.
- `src/worker/worker.ts` — installing and removing the handler around a query, its three
  shapes, the accumulated execution clock, and the translation of `SQLITE_INTERRUPT` into
  the cause that fired.
- `README.md` — the new section after `## Options`.
- `CHANGELOG.md` — Added (`timeout`, `QUERY_TIMEOUT`), Changed (a `signal` now stops the
  work, where it stopped the wait).

## 8. Testing

Each item is a falsifier for a claim above, in the ordinary suite, on both engines:

1. **The statement really stops.** `poolSize: 1`, a long query, an abort at ~100 ms, then a
   short query on the same client: 1 889 ms today, milliseconds after. The one test that
   fails if the interrupt does not work but everything else compiles.
2. **D1 holds**: the promise rejects with `signal.reason` without waiting for the worker.
3. **`timeout` rejects `QUERY_TIMEOUT`** and the connection serves the next query.
4. **D4 holds**: a `stream()` whose consumer sleeps past the budget does not time out.
5. **The budget is per call**: two long statements in one call, a budget only their sum
   exceeds.
6. **The degraded row is asserted, not assumed** — free, because the test host is not
   isolated (`crossOriginIsolated=false`, measured). On the `sync` build the signal rejects
   without interrupting, and the `timeout` interrupts. The asymmetry the whole design turns
   on is verified by the ordinary suite.
7. **Nothing is damaged**: the interrupted statement is still served from the cache, an
   interrupted transaction rolls back.

**The `SharedArrayBuffer` path is the riskiest code and the suite cannot see it**, because
the host is not isolated. Proposed: a fifth test project whose server sends COOP/COEP —
`server.headers` exists in rsbuild 2.1.13 (`dist/types/config.d.ts:349`, "Adds headers to
all responses") and both engines honour those headers. **Unverified: that an rstest config
passes the option through to the rsbuild server.** Check it first; if it does not, the
fallback is a hand-run probe in `.scratchpad/` and this design does not change.

Safari and real devices stay out of reach, as always here.

## 9. Open, and not decided here

- **A wall-clock budget** — deliberately not built, because `AbortSignal.timeout()` is it.
- **A benchmark page row for interruptibility** (§2).
- **Whether `N` should differ per handler shape.** The synchronous handler is free at 10⁶
  too, so it could afford a coarser interval; one constant is simpler and the difference is
  inside the noise on every shape that returns rows. Revisit only with a measurement that
  resolves it.
