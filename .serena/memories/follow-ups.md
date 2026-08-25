# Follow-ups — open issues

Source: `docs/reviews/2026-08-17-0759-browser-sqlite.md` (2026-08-17), re-triaged.
IDs `B*` match the review. Severity here is **our** grading, not the review's — the
review marked all 9 axes BLOCKING, which discriminates nothing.

Status legend: `open` / `in-progress` / `done` / `wontfix`. Keep this column current.
Line numbers are from the 2026-08-17 snapshot — re-locate symbols with Serena before editing.

## Blocking — must fix before any stable release

| ID | Status | Issue | Where |
|---|---|---|---|
| B1 | **done** | **Wave 1, 2026-08-18.** Fixed by construction, not by care: `PoolWorker.available` is **deleted**, availability lives in `scheduler.ts` behind opaque leases, and the per-statement `finally` that republished a borrowed worker is now inexpressible. `transaction()` holds one lease for its whole lifetime. `stream()`'s early `break` is covered too — the transport waits for the worker's in-flight `done` before the lease returns. Evidence: the pinned `it.fails` flipped and was dropped; 12 Node unit tests in `tests/unit/scheduler.test.ts` drive the scheduler directly in milliseconds. Superseded detail removed 2026-08-18. | `scheduler.ts`, `pool.ts`, `queries.ts`, `transaction.ts` |
| B2 | **done** | **Wave 2, 2026-08-18.** `onerror` rejects the in-flight query with `WORKER_CRASHED` and names the URL the pool tried to load (the actionable load-failure message that makes VIT-1 non-blocking in practice). `messageerror` rejects the in-flight query with `PROTOCOL_ERROR` while keeping the worker alive. `ready` is only posted on success; failure posts `open-error` instead (masks the multi-tab exclusive-lock failure fixed). Every `cause` is structured-clone-probed before crossing the thread boundary. The supervisor (`supervisor.ts`, new in wave 2) caps restarts, resets the counter on a served request, and fails the client permanently when no live slot remains. Evidence: `tests/browser/lifecycle.test.ts` — crash detection, restart, permanent failure, load-failure message, `messageerror`. **Known residual:** a worker killed silently *while a query is in flight* is noticed only if the caller aborts. Nothing is waiting on a timer at that moment — the worker's row loop is an unbroken chain of `await sqlite.step()`, so no heartbeat can arrive and the status byte in the `SharedArrayBuffer` does not move either (a corpse looks the same as a live worker). The alternatives were a wall-clock bound on the query itself (kills a legitimate long `ORDER BY`) or nothing. It is "nothing", deliberately. BP-1 in wave 4 **narrows** this residual, it does not remove it (corrected 2026-08-19, user): a per-chunk ack is a heartbeat, so silence between chunks becomes detectable without guessing — but the ack lives *between* chunks, and a big `ORDER BY` sorts entirely inside the **first** `step()`, before any row exists. After wave 4 the residual reads: "a worker that dies inside a single long `step()` is noticed only if the caller aborts". Smaller, not gone. See BP-1 for the measurement that must precede its design. A caller who wants a bound today writes `AbortSignal.timeout(n)` — the abort reaches the drain, the drain is bounded by `drainTimeout`, and the slot is reclaimed and restarted. | `pool.ts`, `worker/worker.ts`, `supervisor.ts` (new), `client.ts` |
| B3 | **done** | **Wave 2, 2026-08-18.** `close()` is now `() => Promise<void>`. It calls `scheduler.shutdown(CLIENT_CLOSED)` (rejecting all queued work), drains in-flight work (bounded by `drainTimeout`), sends a `close` message to each worker and awaits the `closed` reply (bounded), then terminates. `sqlite.close(db)` is called worker-side on the `close` message. Post-close queries receive `CLIENT_CLOSED` immediately. A second call to `close()` returns the same promise — the operation runs exactly once. Evidence: `tests/browser/close.test.ts`. | `pool.ts`, `worker/worker.ts`, `client.ts`, `scheduler.ts` |
| B5 | **done** | **Wave 3, 2026-08-19.** `output()` loads into `__bsq_staging_<uuid>` (a normal table in `main`) and swaps it in with one short transaction: `DROP TABLE IF EXISTS <target>; ALTER TABLE <staging> RENAME TO <target>;` then the indexes **inside that same transaction, after the rename** (SQLite has no `ALTER INDEX … RENAME`). Until `close()` succeeds the previous table stays intact and fully populated. `bulkWrite` latches the first batch failure: later batches are not attempted, `enqueue()` throws once latched, and `close()` rejects with `BulkWriteError` (code `BULK_WRITE_FAILED`) carrying `rowsWritten` / `rowsNotWritten`. A `closed` flag makes `enqueue()` after a successful `close()` throw instead of buffering rows nobody will ever flush — that path was found by the final whole-branch review and is the same family of silent loss. Evidence: 9 Node tests in `tests/unit/bulk.test.ts` (emitted DDL order, latch, counters) plus `tests/browser/output.test.ts` (target intact mid-load, target untouched on failure with no staging left, orphan collected, double-close rejected). **Measured, against a review claim that said otherwise:** a double `output().close()` does NOT destroy the target — the second call's `ALTER` fails and `transaction()` rolls the `DROP` back, leaving the table and its rows intact. | `bulk.ts`, `locks.ts` (new) |
| B7 | **done** | Wave 0, 2026-08-17. `.github/workflows/ci.yaml` runs biome + tsc + build + the full suite on push/PR; `tests/` added to the tsc `include`; characterization suites added for `transaction()` (`tests/browser/transaction.test.ts`), `bulkWrite()` (`bulk-write.test.ts`), `output()` (`output.test.ts`) and the `AccessHandlePoolVFS` + `poolSize` guard (`vfs.test.ts`); both unfalsifiable abort assertions in `concurrency.test.ts` fixed. 81 → **105 tests, all green**. | `tests/`, `tsconfig.json`, `.github/workflows/ci.yaml` |
| B9 | **done** | **Wave 1, 2026-08-18.** `chunk()` throws `signal.reason` before any `postMessage` when the signal is already aborted. Superseded detail removed 2026-08-18. | `queries.ts` `chunk()` |
| B10 | **done** | **Wave P, 2026-08-17.** Built `src/worker/worker.ts` as a second rslib entry (`url: false`, `asyncChunks: false`); the three `.wasm` copied flat beside `worker.js` via `output.copy`; `dist/` flattened; `exports["./worker"]` added; worker reference in `client.ts` updated to `./worker/worker.js` with `type: 'module'`. Evidence: 11/11 consumer smoke stages pass across all four modes (Vite dev, Vite build+preview, rsbuild preview, no-bundler static serve). | `rslib.config.ts`, `package.json`, `client.ts` |
| B8 | **done** | **Wave P, 2026-08-17.** wa-sqlite vendored into `worker.js` at build time (`importDynamic: true` absorbs the five VFS modules and three Emscripten glues); `wa-sqlite` moved to `devDependencies`; `@lalex/promises` removed (`defer()` → native `Promise.withResolvers()`). `dependencies` is empty in the published manifest. Evidence: `assertNoBareSpecifiers` reports nothing; all four smoke modes pass. | `package.json`, `src/client.ts` |
| FLK-1 | **done** | **Wave 1, 2026-08-18.** Root cause was that only the worker was told to stop; the client then drained chunks already sitting in the message queue. `chunk()` now refuses to yield anything once the signal has fired, which makes the outcome independent of the race. `INT-09` rewritten to assert an exact chunk count and a rejection. Evidence: **10 consecutive full browser-suite runs, all identical**. Superseded detail removed 2026-08-18. | `tests/browser/concurrency.test.ts` |

| SUP-1 | **done** | **2026-08-21, `07b075a`. A worker that died while replacing a worker that died left the client alive, empty and silent — forever.** The supervisor's `alive` went false on death and true only on `ready`, so between `spawn()` and the replacement's first `ready` the slot looked dead. When the replacement itself died, `report(index,'died')` hit the duplicate-signal guard (`if (!slot.alive) return undefined`, which exists because `onerror` and a drain timeout both fire for one crash) and returned **no decision**. `handleDeath` acts on `restart` and on `fail-client`; on `undefined` it does nothing. So: no restart, no `failClient`, no `scheduler.shutdown` — every queued request and every later request waits on a pool that will never hold a worker again, with no error. The `openTimeout` net does not save it: it calls the same `handleDeath` and is swallowed by the same guard. Fix: a `spawned` event, because **a slot holds a worker from creation, not from `ready`** — which is already what the constructor's `alive: true` encodes for the first spawn; only the restart path never re-entered that state. Pinned deterministically, not by timing: `tests/browser/lifecycle.test.ts` redirects the **replacement** worker to a URL that does not exist. **How it was found is the reusable part** — see the debugging note at the end of this file. | `supervisor.ts`, `client.ts` |

## Important — fix before calling the API stable

| ID | Status | Issue | Where |
|---|---|---|---|
| B4 | **done** | **Wave 3, 2026-08-19.** All four interpolation sites closed — there were exactly four in the whole project, confirmed by grep: the INSERT, `output()`'s CREATE TABLE, the CREATE INDEX, and the worker's PRAGMA line. `quoteIdent()` (doubles internal `"`, rejects `\0` and empty) is applied to every table, column and index name; the derived index name is assembled from the RAW parts and quoted as a whole. `type` and `generated` are **not** identifiers and cannot be quoted — they are validated by shape (`assertColumnType`, `assertGeneratedExpression`); that channel is narrowed, not closed, and the JSDoc says so. Pragmas: `renderPragmas()` validates syntactically (name `^[A-Za-z_]\w*$`; value integer, bare word, or well-formed quoted literal passed through unchanged), rejects at client construction, and the statements now run **once in the worker's `open()` before `ready`** instead of being prepended to every query — which is what the JSDoc and README always claimed. Read PRAGMAs are reads again: `isReadQuery` accepts a whole-string single PRAGMA with no assignment and no argument (`/^\s*PRAGMA\s+(\w+\.)?\w+\s*;?\s*$/i`); `PRAGMA` stays in `WRITE_KEYWORDS` so a pragma after a `;` still routes to the writer. A review ran seven bypass attempts (trailing newline, `--` comment, stacked statement, double `;`, multi-part schema qualifier, assignment, argument) — all rejected. **A worker-side pragma failure is unreachable through the public API** and deliberately untested: the client validates first, and SQLite silently ignores unknown pragma names and clamps out-of-range values, so no well-formed `PRAGMA k=v` can fail at execution. | `utils.ts`, `bulk.ts`, `worker/worker.ts`, `client.ts` |
| B6 | **done** | **Wave 3, 2026-08-19.** Wired behind `debug?: string \| boolean` — absent/`false`: no collection, no log, `db.debug` is `undefined` and now typed that way (was `unknown`); `true`: prefix falls back to `clientPrefix`; a string is the prefix. **§1.3 was wrong about the size of the job:** wave 1's split kept the worker-level and query-level writes in `pool.ts` but lost the request level entirely — `createRequestDebugState` had NO call site, so `worker.currentRequest` was never set and every surviving pool write had nothing to write into. That level was recreated behind a single `acquireInstrumented(kind)` wrapper rather than at the six acquisition sites, so no site can be silently missed; `grep "scheduler.acquire" src/` now hits only the wrapper. `scheduler.ts` stays pure and gained one read-only `stats()`; `debug.state.queue` reads through it via the same Proxy trick as `status`, so no hand-maintained counter can go stale. Four pre-wiring fixes landed first: `worker.requests` bounded (it grew with the client's total query count — the blocking one), the `>` → `>=` off-by-one that let history peak at 51, `status: 'HAHA'` replaced, `Buffer` already done. New `logger.ts`: prefixed `console.debug/warn/error` on **lifecycle events only** — 10 call sites (worker created/ready/open-error/crash/messageerror/closed, supervisor restart/eviction, client close, skipped sweep). No per-query line, ever: it would be illegible under load and would put user values on the console. Disabled, the logger returns three no-op closures allocated once. | `client.ts`, `debug.ts`, `logger.ts` (new), `pool.ts`, `scheduler.ts` |
| BP-1 | **done** | **Wave 4, 2026-08-20.** The worker takes a credit before sending each chunk, and taking one always costs a task turn first — that unconditional turn is the mechanism, and it is what makes a worker inside a query reachable by `postMessage` at all. The client grants one credit per chunk **consumed** (after the `yield` in `pool.ts`'s generator, never on arrival — crediting on arrival defeats the whole thing). Window 2 by default, an internal constant; `first()` passes 1, which is what finally gives it the exact one-row bound its JSDoc always promised. Credits carry the `callId` and the gate resets per query; `stop` wakes a wait already in progress, without which every `first()` call would park its worker until `drainTimeout` and get it replaced. The gate lives in `src/credits.ts`, pure and Node-tested, for the reason wave 1 established about `scheduler.ts`. Evidence: `tests/unit/credits.test.ts` (including the load-bearing "awaits the tick on every take, even when credits are available", which goes red if the obvious optimisation is applied) and `tests/browser/backpressure.test.ts`. **Cost measured on the SHIPPED code, 2026-08-20, not just on the prototype** — a 200k-row `read()`, three passes, merged code against `src/` restored to `c07c92f`. At the default `chunkSize` of 500 (400 chunks): 113 ms → 116 ms, i.e. **nothing measurable**, inside the run-to-run spread. At `chunkSize` 50 (4000 chunks, the probe's adversarial shape): 121 ms → 170 ms, **12.2 µs per chunk**, squarely inside the 9-14 µs the prototype had measured. So the prototype's figure holds for the real implementation, and a consumer at default settings pays nothing they can see. ~~Original entry below.~~ **Back-pressure on `stream()` / `chunk()` — a credit/ack scheme.** The worker posts chunks as fast as it can produce them (`worker.ts:208-228`); nothing throttles it. Named and bound to **wave 4** on 2026-08-18 (user), promoted out of the unnumbered perf list because it is not an optimisation — it unblocks three separate things written down in three places that did not know they were linked: (1) **D2 / W-sab** — awaiting a client credit per chunk is what returns the worker to its event loop, and therefore the only thing that makes the `ABORTING` flag replaceable by `postMessage`; without it wave 4 removes the init mutex, keeps a SAB for the abort flag, and banks none of D2's benefit. (2) **`first()`'s hard bound** — today the worker races ahead between the first row and the client's abort flag write (two real threads; the delay is short but unbounded in rows), so `first()` on a small result set saves nothing and its JSDoc over-promises. With credits it costs exactly one row. (3) **FLK-1's root cause** — wave 1 makes the test deterministic client-side, but the worker queueing 20 chunks before the flag is read is what BP-1 removes. Its own original motivation still stands: unbounded chunk pile-up **contradicts the memory guarantee the README already advertises**. **MEASURED 2026-08-19 — settled, do not re-run and do not reopen.** The four-combination probe
was run on branch `feat/wave-4-backpressure` (commit `dc96f57`, reverted in `bbf31b9` — the probe
and its `ping`/`pong` scaffolding live in history only). Method: a `ping` message posted to the
worker every 25 ms while a query runs; the worker replies `pong` reporting whether a query was in
flight when the handler actually ran. Round-trips measured on the main thread's clock only —
worker and window do not share a time origin.

| VFS | load | channel OK | query | pings sent | handled **in** query | handled **after** |
|---|---|---|---|---|---|---|
| `OPFSPermutedVFS` (Asyncify) | CPU (recursive CTE) | yes | 5160 ms | 206 | **0** | 206 |
| `OPFSPermutedVFS` (Asyncify) | I/O (24 MB scan, `cache_size=10`) | yes | 1063 ms | 42 | **0** | 42 |
| `OPFSCoopSyncVFS` (sync) | CPU | yes | 4116 ms | 164 | **0** | 164 |
| `OPFSCoopSyncVFS` (sync) | I/O | yes | 1126 ms | 44 | **0** | 44 |

**Two controls are what make the zero mean anything, and the first attempt had neither.** A ping
sent while the worker is idle always comes back (`channelOk`), so the channel itself works; and
every ping sent during a query is handled immediately after it, so nothing is lost — the messages
queue. The first run reported zero late pongs through a defect in the measurement (the snapshot was
taken before the queued messages could run), which would have proved nothing. Without both
controls, "0 pongs" is indistinguishable from a broken probe.

**Third build closed 2026-08-20** (commit `df73833`, reverted in `fd03788`). The result above had
been verified on two of wa-sqlite's three WASM builds. **JSPI** — reached only through
`OPFSAdaptiveVFS` — was never measured, and it is not a variant of Asyncify: it suspends by
integrating with real promises rather than unwinding to a JS trampoline, so it was the one that
could plausibly yield on its own. Measured: CPU 4122 ms / 165 pings / **0** handled in query, I/O
1291 ms / 52 pings / **0**. Same as the other two. **The claim now holds as broadly as it is
written — all three builds, both loads.** Side finding: the probe's "unavailable" path did not
fire, and the jspi build instantiates `WebAssembly.Suspending`, so JSPI is live in the pinned
Chromium and `OPFSAdaptiveVFS` runs there.

**Result: §1.5's claim is CONFIRMED, not refuted** — on all three WASM builds (synchronous,
Asyncify, JSPI), and on an I/O-bound query as well as a CPU-bound one. A `postMessage` is not
delivered to a worker inside a query. Consequences: no liveness probe exists today without BP-1
(so B2's residual stands exactly as documented); the `ABORTING` flag cannot leave the
`SharedArrayBuffer` until the worker yields to its event loop; and **the credit/ack scheme does
not exploit an existing yield — awaiting a client message per chunk is what creates it**, which is
why BP-1 gates D2 rather than merely accompanying it. The design must also price one round-trip per
chunk: `chunkSize` and a credit window > 1 are design parameters, not details.

**Second measurement, 2026-08-19 — does creating a task turn restore delivery? YES** (commit
`fae6423`, reverted in `d82c673`). Run on the real row loop and the real VFS, 4000 chunks (200k
rows, `chunkSize` 50), three passes: baseline without back-pressure 338 ms and the abort **never**
delivered; with a `MessageChannel` task turn per chunk, 373-393 ms and the abort handled within
**0-1 chunk** at every window size; with a counter only and credits batched 16 at a time, 340 ms
and the abort handled **14 chunks late**. So: the task turn is load-bearing and its absence is
detectable by a test; credits themselves are free (340 vs 338); the tick costs 9-14 µs per chunk,
which at the default `chunkSize` of 500 is 20-30 ms over a 1M-row read; a window of 2 recovers the
round-trip that lockstep pays and nothing is gained beyond 2.

**The design that measurement corrected — do not re-propose the original.** "The worker awaits one
credit *message* per chunk, so the await is both the accounting and the yield, no counter needed"
**deadlocks**: credits sent ahead are dispatched during the query's start-up awaits, each resolving
a signal nobody is waiting on, after which the worker awaits a fresh signal that never arrives. The
probe found it by hanging. **Accounting and yielding are two separate roles** — a counter for the
first, an unconditional task turn for the second. Full design and cost: the DRAFT spec
`docs/superpowers/specs/2026-08-19-wave-4-backpressure-design.md`.

**Unmeasured hypothesis, flagged as such:** the Asyncify unwind probably changes nothing here
because `OPFSPermutedVFS` reads through synchronous `FileSystemSyncAccessHandle`, so the
continuation is a microtask, and a microtask never lets a `message` event run; the genuinely
asynchronous work (IndexedDB, BroadcastChannel) would sit at transaction boundaries. Not worth
measuring unless a design option turns out to depend on it — it explains *why*, and the *what* is
already settled. | `worker/worker.ts`, `queries.ts` (post-wave-1) |
| W-route | **done** | **Wave 1 (half 1) + wave 2 (half 2).** Half 1: `isReadQuery` is now an allowlist requiring BOTH an allowlisted opening keyword AND no write keyword anywhere — the second clause matters because the worker executes `;`-separated statements. An adversarial review ran 47 cases with no dangerous-direction misclassification. Accepted cost: `SELECT 'INSERT'` and `EXPLAIN INSERT …` serialize through the writer — correct, merely slower. Half 2: `write()` routes to the writer unconditionally; `read()`, `chunk()`, `stream()`, and `first()` reject a non-read statement with `NOT_A_READ_QUERY` before any lease is taken. Every PRAGMA is currently classified as a write and must go through `write()` — this is documented in `assertReadable`'s JSDoc and in the README, and it pins a test in `tests/browser/routing.test.ts` that will turn red when B4 lands its pragma allowlist. String-literal misclassification is not fully solved (needs tokenisation), but the failure direction is safe toward the writer. | `utils.ts`, `client.ts` |
| RYOW-1 | **DONE — barrier built and reviewed 2026-08-21 on `feat/ryow-barrier`; see the block at the end of this entry. Everything before it is history, kept for the measurements.** | **The default VFS changed to `OPFSAdaptiveVFS` on Asyncify and the bulk of the staleness went with it, but the case that matters to `output()` did not.** Measured across connections at `poolSize` 4: `OPFSPermutedVFS` 85 stale reads in 360; `OPFSAdaptiveVFS` **0 in 360**, and 0/80 on each of four separate axes — data INSERT, table CREATE, table DROP, and a table REPLACED under the same name with a different shape (the `DROP` + `ALTER … RENAME` inside one transaction that `output()` performs). `IDBBatchAtomicVFS` likewise 0. **And yet unpinning `output()`'s two `poolSize: 1` tests fails 6 runs in 10**, on `drops and replaces a pre-existing table with a different schema`, with `expected undefined to be 42`: the reader gets one row — the OLD table's — so its schema still describes the pre-swap shape. ~~The isolated reproduction of that DDL sequence shows zero staleness, so the trigger lives somewhere in `output()`'s real path that the reproduction does not capture — candidates not yet eliminated: the indexes created inside the same transaction, the `navigator.locks`-guarded sweep on first call, and `bulkWrite`'s one-lease-per-batch.~~ **Answered by (4) below: the sweep, and not for the reason listed here — it is its READ that primes the reader, not its writes.** **The two tests therefore stay pinned to `poolSize: 1`, and wave 4 still owes the barrier.** Finding that trigger is where the barrier's brainstorming starts — it is a narrower question than it was, which is worth something. **Two follow-up measurements, 2026-08-20.**

**(1) The stale read is NOT our bug — the fork is settled.** After `out.close()` resolves, the WRITER connection sees the new table **15/15**, so the swap transaction is genuinely committed and the ordering in our code is right; a barrier is not answering a mis-posed question. What happens is that typically **one connection out of four** is transiently behind — 8 of 15 iterations had exactly 3 of 4 reads correct — and it catches up **within one event-loop turn** (converged at a `sleep(0)` retry in all 15). That is why a single read after `close()` fails ~60% of runs: it lands on the lagging connection. **This shrinks the barrier's job enormously**: not synchronising an asynchronous BroadcastChannel+IndexedDB channel as Permuted required, but stopping a read being served by a connection that has not yet observed a commit one turn old. Lead not yet verified: `PRAGMA data_version`, which SQLite provides precisely so a connection can detect that another has modified the database.

**(2) The writer designation no longer has to be sticky.** Re-measured with a temporary scheduler rotation forcing every write onto a different worker: 45 schema-dependent writes (`CREATE` → `INSERT` → `ALTER` chains) spread over **all four workers, zero errors**, where wave 3 measured `no such table` against Permuted. Both controls pass — the sticky run used exactly one worker (index 3), the rotated run used [0,1,2,3] — so the zero is not a harness that failed to rotate. **Honest limit: this cannot demonstrate the harness would have caught the Permuted failure, because Permuted is gone.** Relaxing stickiness is therefore now *supported by measurement* rather than blocked by it, and it has not been made.

**(3) What stickiness actually costs — reasoned 2026-08-20, MEASURED and FIXED 2026-08-21 (`e2f454b`): 30 ms against ~950 ms, the reasoning below was right.** The designation is cleared in exactly one place, `remove(index)` — worker death or eviction. It is never released when writes finish. So a write goes to that worker and **queues behind it even when every other worker is idle**: `takeAvailable` enters the writer branch, finds it unavailable, and returns `undefined` without ever looking at the others. Now combine that with the read rule: reads take the **lowest available index**, and the first write designates the **lowest available index** too — so on an idle pool the designated writer is typically worker 0, **the very worker every read prefers**. The worker most likely to be busy serving a read is the one all writes depend on. **A single long read on worker 0 freezes every write in the client**, whole pool idle or not. That is head-of-line blocking we impose on ourselves, and it is the same cause as the perf note about reads piling onto worker 0, seen from the other side. Stickiness only ever protected `prepare` from a stale page map; it protects nothing else, and that protection is what the VFS change made unnecessary.

**(4) THE TRIGGER IS FOUND — 2026-08-20, later session. It is priming, not lag, and it is not the VFS.**
Reproduced on the real test, unpinned, at the default `poolSize` (which is **2**, not 4 —
`DEFAULT_POOL_SIZE` in `client.ts`): 3 failures in 10. Instrumented with `debug: true`, attributing
every SQL statement to its worker and sorting by `startTime`. The correlation is total:

- everything on `w0` (writer = `w0`) → correct;
- writes on `w1`, final read on `w0` → stale, every time.

**The stale row is `{"old_col": 42}` — the NEW data under the OLD column name.** Not the old table's
row. So the reader holds a **stale page 1** (schema / change counter) while reading data pages fresh
from the file: an **incoherent** snapshot, not a coherent lagging one. This entry's earlier
description ("the reader gets one row — the OLD table's") was wrong about this.

**Trigger: any earlier read on the connection that later serves the read.** `output()` guarantees one
— the sweep's `SELECT name FROM sqlite_master …`, dispatched to the lowest available index, i.e.
exactly the connection reads prefer — while the writer designation lands elsewhere whenever worker 0
loses the ready race. Verified both directions on the real path:

- **necessary** — sweep short-circuited in `bulk.ts`: 8 runs, 4 of them in the failing configuration,
  **0 stale**;
- **sufficient** — sweep still disabled, one bare `db.read()` added before `output()`: 8 runs, 3 in the
  failing configuration, **3 stale**, same signature.

In the failing configuration: **primed 5/5 stale, unprimed 4/4 correct.** Nothing to do with indexes,
`bulkWrite`'s one-lease-per-batch, or the `navigator.locks` hold — the three candidates this entry
listed are all cleared.

**Determinism tool, worth rebuilding rather than reinventing.** A temp probe in `scheduler.ts`
forbidding the writer designation on index 0 (three sites: `handOver`, `takeAvailable`, and `add`'s
own writer-first branch) makes writer = `w1` always at `poolSize` 2, so the failing configuration is
deterministic: control **8/8 stale**, no race. **The test that pins the barrier needs exactly this**,
otherwise it only fails ~30 % of the time.

**Barrier candidates, each executed on the reading connection immediately before the read (in
`readWorker`), forced configuration:**

| Prelude | Result |
|---|---|
| *(none — control)* | 8/8 stale |
| `PRAGMA data_version` | 8/8 stale — **this entry's recorded lead is DEAD** |
| `PRAGMA schema_version` | 8/8 stale |
| `BEGIN; COMMIT` | inconclusive — errors `cannot start a transaction within a transaction` |
| one event-loop turn (`setTimeout 0`) | 8/8 stale |
| 150 ms wait | 6/6 stale |
| `SELECT 1` | 6/6 stale |
| **`SELECT * FROM out_replace`** (the target table) | **6/6 correct** |
| **`SELECT count(*) FROM sqlite_master`** | **6/6 correct** |

**~~It catches up within one event-loop turn~~ — measurement (1) above is wrong on this point.** A
primed connection is not behind, it is **stuck**: neither a turn nor 150 ms changes anything. What
had looked like convergence at a `sleep(0)` retry was the **second read**, not elapsed time.

**Mechanism, and the shape it gives the barrier.** The connection only learns of the change by
actually reading pages, never at `prepare` — and the statement that triggers the refresh **still
returns the stale result**; the next one is correct. So the barrier must be a **separate statement
that opens a real read transaction on the file**. `SELECT 1` does not qualify (touches no page);
neither PRAGMA does. A generic `SELECT count(*) FROM sqlite_master` suffices — **the barrier does not
need to know the query's tables.** Cost: one extra worker round-trip on the reads that need it.

**VFS matrix — 40 runs, 40 stale, forced configuration, 4 runs per combination:**

| VFS | `sync` | `async` | `jspi` |
|---|---|---|---|
| `OPFSAdaptiveVFS` | — | 4/4 stale *(control)* | 4/4 stale |
| `OPFSWriteAheadVFS` | 4/4 stale | 4/4 stale | 4/4 stale |
| `OPFSCoopSyncVFS` | 4/4 stale | 4/4 stale | 4/4 stale |
| `IDBBatchAtomicVFS` | — | 4/4 stale | 4/4 stale |
| `AccessHandlePoolVFS` | *not testable — the client rejects `poolSize > 1`* |

Consequences, in order of what they save: **it is not an `OPFSAdaptiveVFS` defect, so the default-VFS
choice is not reopened** and `feat/vfs-default` stands on its own merits; **it is not the Asyncify
bridge**, since `jspi` behaves identically and `OPFSWriteAheadVFS` on `sync` too; and **the WAL lead
recorded in `mem:resume-plan` is dead**, measured 12/12 across its three builds. The common factor is
wa-sqlite itself (one WASM build, advisory locks between workers) — a native SQLite across two
processes should not produce this. Going one level deeper would change who we report it to, not what
we build. **The barrier is therefore permanent architecture, not a stopgap awaiting a better VFS.**
Note also: **CoopSync did not hit `COOP-1` on this workload** (`poolSize` 2, one `output()`); that
does not clear `COOP-1`, it does not test it.

**Design space for the barrier, for the brainstorming that comes next:** (a) prelude on every read —
simple, correct, one round-trip on the ~99 % of reads that follow no write; **(b) prelude conditional
on a commit epoch** — the client counts commits, each worker carries the epoch it last executed or
observed, only a worker behind gets the prelude — **recommended, the client already holds the
information**; (c) eager refresh broadcast at commit time — an optimisation of (b), still needs (b)'s
epoch for the read that arrives before the ping lands; (d) route reads to the designated writer —
wave 3's rejected option, zero round-trip, but it re-entangles read scheduling with the designation
and worsens the head-of-line blocking of (3) above.

**Barrier BUILT, REVIEWED AND MEASURED 2026-08-21** — `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md`,
branch `feat/ryow-barrier` off `main` at `f427018`. Option **(b)** chosen, scope set to **same-tab**
RYOW (two clients in one tab must see each other; cross-tab is out). Read the spec rather than this
entry for the design; four things it settled that the list above does not know: the bump **cannot**
ride on `lease.release()` (release is async, so `write()` resolves first, and a read chained after it
would still see the old epoch); new workers start at `seen = -1`, because a commit can land between a
worker opening the file and entering the pool — the nominal startup ordering at `poolSize: 2`, not a
rare race; `file` is normalized once at the client entry with `new URL(file,'file://').pathname`,
which is what 4 of the 5 VFS already do internally (and which fixes `initLockName`'s raw-string key
and `OPFSWriteAheadVFS` throwing on `'./name'`); and a failed fallback `ROLLBACK` in `transaction.ts`
leaves an open transaction on a pooled connection, where the prelude would succeed and refresh
nothing — the worker is evicted instead.

**Cross-tab lead, NOT VERIFIED — Web Locks as a registry, not as mutual exclusion.** Preferred over
`BroadcastChannel`, which loses the race on a message still in flight. Shape: a tab holds
`bsq:epoch:<file>:<n>`, takes `n+1` and releases `n` at commit, and other tabs read the epoch as the
max of the held names via `navigator.locks.query()` — the same "lock as liveness marker" pattern
`stagingLockName` already uses. It is *state*, not *delivery*, so there is no in-flight window.
**The measurement that settles it:** the cost of `navigator.locks.query()` per acquisition, against
the one worker round-trip it is meant to avoid — `query()` returns every lock held in the origin and
is specified as a diagnostic snapshot. If it is not clearly cheaper, the exact cross-tab answer is
the unconditional prelude (option (a)), probably as an opt-in, not this. **Do not treat this as
promising until that number exists** — that is exactly how `PRAGMA data_version` and the WAL VFS cost
a session each.

**What actually shipped, 2026-08-21 — read the spec, not this entry, for the design.**
`docs/superpowers/specs/2026-08-21-ryow-barrier-design.md`, 25 commits on `feat/ryow-barrier`, green
at 302 tests. Epoch counter per database in `globalThis[Symbol.for('browser-sqlite.epochs.v1')]`, one
choke point (`applyBarrier` in `acquireInstrumented`) covering reads, writes, transactions and bulk,
`seen = -1` on every new worker, and the bump posted synchronously in the write path's `finally`
because lease release is asynchronous and `write()` resolves first. **Acceptance: `output()`'s two
`poolSize: 1` pins are gone and those tests run at the default pool size, 20/20 green** — they
predate the barrier and were not written for it, which is what makes them the evidence worth
trusting. Also shipped: `SQLiteError` code `BUSY` on the query *and* open paths; eviction of a worker
whose fallback `ROLLBACK` failed (an open transaction would have made the barrier refresh nothing and
report success); one normalized database name everywhere in **relative** form, which also fixed
`OPFSWriteAheadVFS` throwing on `'./name'`.

**The domain of the bug is narrower than this entry ever said — measured 2026-08-21.** It needs
**DDL without material growth of the file**. Barrier disabled, forced configuration: a write growing
the file 3 → 253 pages left the primed connection **fresh** 3/3; a tiny write leaving it at 2 pages
left it **stale** 3/3, and 3/3 on each of six structural variants — eighteen runs, all stale. The
growth is the only difference. **Mechanism inferred, not observed**: a file-size mismatch check that
re-reads page 1 through a path the change-counter bug does not defeat. It explains why `output()` was
always the reliable trigger — small staging table, no growth, nothing auto-heals. Spec §1.1.
**Do not turn this into "skip the barrier after a large write"**: that rests on the inference, and one
growth ratio at one page size. Rejected until the threshold is measured.

**Three small things the whole-branch review triaged as non-blocking, worth keeping so they are not
rediscovered:** `tests/unit/epochs.test.ts` replaces `globalThis[Symbol.for('browser-sqlite.epochs.v1')]`
with no teardown (latent ordering dependency); the barrier statement still lands in the debug request
tree — `noServed` suppresses the served callback but not `currentQuery`, and that is deliberate
because a browser test counts it there; and `workerError` in `pool.ts` has no unit test, with the
open-path BUSY mapping verified by inspection only.


**Sequencing decided 2026-08-20: relax it AFTER the barrier, not before.** Reasons, in order: the barrier changes the staleness surface, so doing both at once makes the next debugging harder (~~`output()` still fails 60% unexplained~~ — explained by (4) above, 2026-08-20); `COOP-1` shows a VFS can pass a gentle workload and lock up once DDL meets concurrent readers, and spreading writes increases exactly that contention; and the stickiness measurement used 45 **sequential** writes with no concurrent readers, which is narrower than the change it would license. **When it is done, the test must fail if stickiness is restored** — a load that mixes spread writes with concurrent reads, not sequential chains.

**DONE 2026-08-21, commit `e2f454b`.** `handOver` releases the designation when the writer queue is empty. The stickiness-detecting test is `tests/browser/writer-spread.test.ts` — a read holds worker 0 while DDL and inserts are issued, and it asserts the writes were served by **two distinct workers**, read out of the debug tree. That assertion is what goes red if stickiness returns, and it was verified by deleting the release line and watching it happen.

**The gain, and its honest bound.** poolSize 2, a long read holding worker 0: five writes in **30-32 ms** on worker 1 against **934-1052 ms** queued behind the read — ~31×. Cost: one extra prelude (worker 1's first use). On alternating write/read, mixed concurrent, and read-heavy loads: **neutral on preludes and on wall clock, three runs each**. So the change buys the pathological case only. The spec's §2.2 claim that relaxing stickiness would mitigate the barrier's alternating-load worst case is **not confirmed** — on an idle pool the write and the following read both take the lowest free index, i.e. the same worker, so there was nothing to mitigate there.

**Prelude census, for whoever measures the read-side policy next** (poolSize 2, 20 rounds, 21 commits): alternating 1 prelude / perWorker [41,0]; mixed concurrent 14-17 / [21,20]; read-heavy 5 / [25,20]. The mixed figure sits near the theoretical ceiling of one prelude per commit per other worker, so a read policy that followed the last writer has room to recover something — see the open item below.

**Method note, worth 20 minutes to the next person:** `rstest.config.ts` disables browser log forwarding (`browserLogs: false`), so `console.log` from a browser test is invisible. Measurements must be surfaced through an assertion failure message. The probe was not committed — the pre-commit hook runs the full suite and a deliberately-failing probe cannot pass it. | **Read-your-own-writes is not guaranteed across workers — found the hard way in wave 3, 2026-08-19.** The default VFS is `OPFSPermutedVFS` (`client.ts`'s `DEFAULT_VFS` — note the worker's own fallback is `OPFSCoopSyncVFS`, which is what made this easy to get wrong), and it propagates commits to other connections asynchronously over BroadcastChannel + IndexedDB. A read dispatched to a worker that has not yet received the broadcast serves a stale view. This surfaced as a 40 %-reproducible test failure: after `output().close()` resolved, a `read()` returned the pre-swap schema. **No mitigation ships — this was reworked on user instruction, 2026-08-19.** A first attempt made `takeAvailable` prefer the designated writer for reads. The user rejected that shape: it entangled read scheduling with writer designation, and it was inconsistent with `handOver`, which cleared the designation when the writer served a queued read. **The rules now are: a read never takes the designation by preference and never clears it, both acquisition paths behave identically, and no preference of any kind applies to reads.** So RYOW is simply not guaranteed across workers, full stop, until wave 4 supplies a real propagation barrier.

**~~Measured while doing this, and it is now a hard constraint: the writer designation MUST stay sticky.~~ ANSWERED 2026-08-21 — the barrier is the propagation barrier this paragraph demands, and the designation is now released. The reasoning below is kept because it is exactly what breaks if anyone removes the barrier.** The user also asked that the designation be released once no write is outstanding or queued, so the next write could take the first free worker. That was implemented, measured, and **reverted with evidence**: when consecutive writes land on different workers, the second fails with `no such table` because the creating worker's commit broadcast has not arrived. `OPFSPermutedVFS` does check staleness — but at `SQLITE_LOCK_RESERVED`, and it signals `SQLITE_BUSY`, which is retried. `sqlite3_prepare_v2` reads the schema through the stale page map *before* that lock is ever requested, so it returns `SQLITE_ERROR`, which is not retried. Stickiness is therefore a correctness requirement backed by measurement, not a legacy habit. Any future wave that wants to relax it must first supply the propagation barrier. ~~This narrows the window, it does not close it~~ — if a concurrent write claims the writer as a read is dispatched, that read still falls back to a possibly-stale worker. Documented in the README and on the JSDoc of `read`/`chunk`/`stream`/`first`; the workarounds are reading inside the same `transaction()`, or `poolSize: 1`.

**Two browser tests are pinned to `poolSize: 1` because of this, and that is a scope boundary, not a weakened test.** `drops and replaces a pre-existing table with a different schema` and `does not collect a staging table that is still in flight` both read back what they wrote; their subjects are `output()`'s atomicity and the cross-client sweep respectively, neither of which is about cross-worker visibility. The second one was measured at ~7.5 % failure (4 in 53 runs, always `no such table: target_a`) before being pinned, and 20/20 after — and it still goes red when the sweep's staleness filter is defeated, so it still pins its property. Two clients at `poolSize: 1` are still two connections holding two Web Locks, which is exactly what that test is for. **When wave 4's barrier lands, revisit both: they should go back to the default pool size.** | `scheduler.ts`, README, `client.ts` |
| W-multitab | partial | Multi-tab is entirely uncoordinated and undocumented — `currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single writer". No `navigator.locks`, no `BroadcastChannel`. Implement or document as unsupported. **Partly settled: `output()` must be multi-tab safe (D3, user requirement) — its staging sweep is `navigator.locks`-guarded in wave 3. That brings the locks primitive into the codebase; the rest of the client stays uncoordinated until this item is done.** | `client.ts` |
| W-types | partial | **Wave 1, 2026-08-18:** `TransactionDB`'s `...args: any[]` replaced by real signatures; `SQLiteQueryOptions` consolidated into `types.ts`; the no-op `SQLiteStreamOptions` deleted; dead `signal` removed from `PoolWorkerQueryOptions`. Still open: `SQLiteDB` is a hand-maintained duplicate, the shipped `.d.ts` leaks unnameable internal types, `SQLiteVFS` is used in a public option but never exported. Superseded detail removed 2026-08-18. | `client.ts`, `types.ts` |
| W-arch | **done** | **Wave 1, 2026-08-18.** `client.ts` split into `scheduler.ts` (pure, Node-testable) / `pool.ts` (transport) / `queries.ts` / `transaction.ts` / `bulk.ts`, with `client.ts` reduced to assembly. The scheduler being reachable only through slow browser tests is exactly why B1 survived; it is now driven by unit tests. Superseded detail removed 2026-08-18. | `src/` (six modules) |
| W-sab | **done** | **Wave 4, 2026-08-20.** `src/orchestrator.ts` is deleted, 183 lines, and `grep -rE 'orchestrator\|SharedArrayBuffer\|WorkerStatuses'` over `src/` returns nothing. Its three jobs went three ways: the init mutex to `navigator.locks` (`initLockName(file)`, one `withLock` covering open **and** the pragmas, releasing on throw — which is what the old explicit `unlock()` in the `.catch` existed to do); the per-worker status byte to a plain `status` field on `PoolWorker`, which the pool already knew better than the byte did, retiring the Proxy indirection in `debug.ts`; and the abort flag to a `stop` message observed through the credit gate. **Gated on BP-1 exactly as §1.5 predicted** — without a task turn per chunk the `stop` message is undeliverable. **Evidence for the payoff is a demonstration, not an assertion: the consumer smoke passes 11/11 across four bundler modes with no COOP/COEP header served anywhere.** The headers are gone from `rstest.config.ts`, `scripts/static-server.mjs`, both consumer apps, the no-bundler HTML, the README and `createSQLiteClient`'s JSDoc. Consuming applications no longer need cross-origin isolation. ~~Original entry below.~~ The `SharedArrayBuffer` / COOP+COEP requirement is self-imposed: the SAB serves only the init mutex and the `ABORTING` flag. Removing it removes cross-origin isolation as a hard requirement on every consuming app. Highest leverage per line changed. **Measured 2026-08-18:** `grep -rE 'SharedArrayBuffer\|Atomics\.'` over all of `node_modules/wa-sqlite` (`src/` + `dist/`) returns **nothing** — no VFS, no Emscripten glue, no `.wasm` needs it. The requirement is 100 % ours. **Corrected the same day (`mem:resume-plan` §1.5):** the two usages do *not* share a replacement date — `navigator.locks` covers the init mutex (wave 3), but the `ABORTING` flag cannot move to `postMessage` until the worker yields to its event loop per chunk, i.e. until back-pressure exists. Removing only the mutex in wave 4 banks none of the benefit. | `orchestrator.ts`, `worker.ts`, `client.ts` |
| W-chunks | wontfix | **Chunked worker impossible while Vite is a supported consumer.** Attempted in wave P Task 7 (`asyncChunks: true`): Vite re-bundles worker entries through Rollup with `format=iife`, and Rollup refuses code-splitting in that format — "UMD and IIFE output formats are not supported for code-splitting builds." Reverted immediately. This is structural, not a tuning problem: as long as the worker must survive Vite's re-bundling step, it cannot ship a chunk graph. Monolithic worker (117,405 bytes gzip) is the permanent shipped shape. **Re-litigated and re-closed 2026-08-24 (user asked whether the D6 Vite plugin would fix it).** Two answers. (1) It could only work by bypassing Vite's worker pipeline entirely — copying our prebuilt `dist/worker/**` chunks and rewriting the worker URL — which is a different and much larger plugin than D6 as specified (wasm copy + `wasmUrl` escape hatch); the `worker.format: 'es'` alternative on the consumer side is unverified. (2) **It is not worth doing anyway**: a first load fetches `worker.js` at **123,652 bytes gzip** *and* one `.wasm` at ~286 KB, so the worker is not the dominant cost and splitting out the unused VFS would save ~10 KB gzip, about **2 %** of first load, for Vite consumers only. Measured the same day: the four candidate VFS sources total 10,667 bytes gzip (`IDBMirrorVFS` 6808, `OPFSAnyContextVFS` 1899, `MemoryVFS` 1321, `MemoryAsyncVFS` 639) against a 123,652-byte worker — roughly +9 %, and `dist/` was confirmed to contain exactly two JS files with all five wired VFS inlined. **Wiring a VFS costs bytes for every consumer; exposing an already-wired one costs nothing extra.** So the "wire but keep private" middle ground buys no bytes — it is purely a support decision. | `rslib.config.ts` |
| VIT-1 | open | **Vite requires consumer configuration** — two independent reasons: (1) Vite's esbuild pre-bundling (`optimizeDeps`) rewrites `import.meta.url` in `node_modules` during dev, breaking the worker URL; fix: `optimizeDeps: { exclude: ['browser-sqlite'] }` in the consumer's `vite.config`. (2) Vite's prod build does not copy `node_modules` wasm beside the emitted worker output; fix: a ~10-line Vite plugin that copies `dist/worker/*` beside the emitted worker. rsbuild and no-bundler modes need nothing. Not a bug in the artifact — a Vite-specific gap documented in the README's "Bundler Configuration" section. Recorded here so it is not re-litigated as an artifact defect. **Fix decided 2026-08-18 (D6, `mem:resume-plan` §1.4): we ship the plugin ourselves as a `browser-sqlite/vite` subpath, wave 4.** Two known fragilities in the currently documented snippet, both fixed by owning the code: `dist/assets` is hard-coded (breaks as soon as the consumer changes `build.assetsDir`) and `node_modules/browser-sqlite/…` assumes a flat node_modules (breaks in a pnpm workspace / monorepo). | README, `tests/consumer/vite.config.ts` |

| COOP-1 | open — **next up**, mechanism analysed 2026-08-24 | See the dedicated block below the tables; it outgrew a row. | `README.md:64`, `worker/worker.ts`, VFS selection |
| VFS-COV | open, **and it is now the blocker for the Firefox recommendation** | **Two of the five wired VFS have no test at all: `OPFSWriteAheadVFS` and `IDBBatchAtomicVFS`.** A sixth exists in the pinned wa-sqlite and is **not wired at all**: `OPFSAnyContextVFS`. That trio is no longer bookkeeping — HANDLE-1 shows the only VFS that structurally escape the pool-blocking defect are `IDBBatchAtomicVFS` and `OPFSAnyContextVFS`, i.e. exactly the untested and the unwired one. Recommending either as the Firefox answer without covering it first would repeat COOP-1's mistake of recommending unmeasured code. `IDBBatchAtomicVFS` is cheap to cover: it extends `WebLocksMixin(FacadeVFS)` like the default, honours our `lockPolicy: 'shared'`, needs no OPFS, and measured 0/360 stale in the 2026-08-20 probe. `OPFSAnyContextVFS` needs wiring first, and upstream warns its write performance is "very bad" — that is the trade the measurement must price. Exercised today: `OPFSAdaptiveVFS` implicitly everywhere (the default), `AccessHandlePoolVFS` in five places, `OPFSCoopSyncVFS` in one. | `types.ts`, `worker/worker.ts`, `tests/browser/vfs.test.ts` |
| RWU-1 | **done — answered by measurement 2026-08-24** | **The WebIDL deduction was right, and its feared consequence does not happen.** Probe in a dedicated worker on a secure `http://localhost` page: Chromium opens **two simultaneous `readwrite-unsafe` handles on the same file** (mode honoured); **Firefox accepts the call, ignores the mode, and throws `NoModificationAllowedError` on the second handle** — exactly the silent degradation predicted from "WebIDL ignores unknown dictionary members", now observed rather than reasoned. But `OPFSAdaptiveVFS` detects it (`hasUnsafeAccessHandle`, `OPFSAdaptiveVFS.js:8`) and its fallback path holds: **102/104 browser tests pass on Firefox**, concurrency, transactions, barrier, `output()` and `bulkWrite` included, at `poolSize: 2`. Two concurrent reads genuinely overlap (ratio **1.03**, against a Chromium control at 0.88 that proves the harness can detect serialization). The degraded path is real, exercised, and correct. **What the fallback does NOT survive is a long uninterruptible statement — that is HANDLE-1 below, a different defect found by the same campaign.** | closed |

## COOP-1 in full — `OPFSCoopSyncVFS` under a pool

**Status: open, but demoted 2026-08-24 — and its subject has largely been absorbed by HANDLE-1.**

**The symptom did not reproduce.** The whole browser suite forced onto `OPFSCoopSyncVFS`:
**103/104 on Chromium, 104/104 on Firefox, zero `database is locked` on either.** That neither
confirms nor refutes the 2026-08-20 observation — the suite defaults to `poolSize: 2` and never
plays the shape that produced it (interleaved DDL with four concurrent readers at `poolSize: 4`).
It does establish that **the suite is not the instrument for COOP-1**; a dedicated adversarial test
is, and that was already step 1 of the recommended order.

**What changed the stakes is HANDLE-1:** CoopSync rotates one exclusive access handle exactly like
the degraded `OPFSAdaptiveVFS`, so it inherits the pool-blocking defect wholesale. Its 104/104 on
Firefox is therefore not a reason to recommend it there. Between that and the niche analysis below,
the likely destination is now removal rather than repair — which would make COOP-1 moot.

**One new defect, distinct from COOP-1, recorded here because nowhere else fits:** forced onto
CoopSync, Chromium fails `lifecycle :: restarts the slot once and keeps serving` with
`sqlite3_open_v2`. The replacement worker cannot reopen the database after a crash — consistent
with the exclusive-handle model, the dead worker's handle not yet being released.

Symptom recorded 2026-08-20; mechanism below analysed from source 2026-08-24 and **never measured** —
treat everything under "Why" as a hypothesis with a falsifiable prediction, not as a finding.

### What was measured (2026-08-20, `poolSize` 4, Chromium)

- **Fails with `database is locked` in ~100 ms, reproducibly (3 runs)**, on interleaved DDL
  (`CREATE`/`DROP`) while four connections read concurrently.
- **Does not fail on a gentler workload**: it passed the VFS matrix at `poolSize` 4 (init,
  INSERTs, concurrent reads, 0/40 stale) and all three of its declared builds passed the
  combination check. So the trigger is DDL under concurrent readers, not the pool alone.
- **It is 2-3× slower than the default at concurrent reads**: 8 reads in **29, 35, 33 ms**
  against `OPFSAdaptiveVFS`'s 13, 12, 16 and `IDBBatchAtomicVFS`'s 15, 26, 19 (probe `a68047b`).

### Why, as read from the source on 2026-08-24 — hypothesis

1. **The handle is exclusive.** A `FileSystemSyncAccessHandle` is exclusive per file for the whole
   origin unless opened `readwrite-unsafe`, and CoopSync never asks for that mode
   (`grep -c 'readwrite-unsafe' OPFSCoopSyncVFS.js` = 0). So N connections do not read
   concurrently — they **rotate one handle**, requested over a `BroadcastChannel`.
2. **`SQLITE_BUSY` is this VFS's transfer protocol, not an error.** `jLock`
   (`OPFSCoopSyncVFS.js:391-423`) returns `SQLITE_BUSY` while the handle request is in flight and
   expects the caller to retry. Upstream says so itself: its contention handling "returns an error
   and retries", which it calls "not very efficient".
3. **We never retry.** No `busy_timeout` is applied — `client.ts:83` is explicit that no PRAGMA is
   applied beyond SQLite defaults — and since wave 4 we map `SQLITE_BUSY`/`SQLITE_LOCKED` straight
   to `SQLiteError('BUSY')` and hand it to the caller. **We turn a protocol step into a user-visible
   failure.**
4. **DDL is what makes it reproducible.** `CREATE`/`DROP` needs EXCLUSIVE, so every other connection
   must have dropped its shared lock *and* released the handle at the same instant. With four
   readers churning, that window barely opens.
5. **Our `lockPolicy: 'shared'` does not reach it.** `OPFSCoopSyncVFS extends FacadeVFS`, **not**
   `WebLocksMixin(FacadeVFS)` — it implements `jLock`/`jUnlock` itself, so the option we pass every
   VFS at `worker/worker.ts:134` is silently ignored here. `OPFSAdaptiveVFS` and
   `IDBBatchAtomicVFS` do extend the mixin and do honour it.

**Falsifiable prediction:** give SQLite a working busy handler and the ~100 ms failure becomes a
delay, not an error. If it instead *hangs*, hypothesis 3 is wrong about where the retry must live.

### The README is already broken here, independently of the bug

`README.md:64` sends the reader to Known Limitations "before using it with `poolSize > 1`", and
**there is no CoopSync entry in Known Limitations** (`:241-248`). It also claims
`Constraint: None`, which point 1 above contradicts. Fix this even if the rest is deferred.

### Option space — none decided

| | Option | Assessment |
|---|---|---|
| A | Default `busy_timeout` PRAGMA | Cheapest, already on the perf backlog for other reasons. **Risk to measure, not to deduce:** SQLite's busy handler sleeps; in a synchronous VFS in a worker that may block the very thread that owes the handle release, converting a failure into a deadlock. |
| B | Bounded retry with backoff in **our** layer | We own the choke point (`applyBarrier` / `acquireInstrumented`, `client.ts:457`/`:513`), and yielding to the event loop avoids A's risk. But it touches every VFS, and replaying a statement inside an open transaction is not safe. |
| C | `poolSize: 1` guard on CoopSync, like `AccessHandlePoolVFS` | One line, synchronously testable, an established pattern in this code. Costs nothing real: point 1 says a pool buys no concurrency here anyway. |
| D | Drop CoopSync from the public surface; document `IDBBatchAtomicVFS` as the universal fallback | See the note below — its niche may be empty. Gated on VFS-COV. |
| E | Documentation only | Minimum honest fix: closes the dangling reference and the false "Constraint: None". |

### The question that precedes the options: does CoopSync have a niche left?

Checked against the source 2026-08-24. Among VFS that never ask for `readwrite-unsafe` and so work
outside Chromium: `IDBBatchAtomicVFS` (IndexedDB, extends `WebLocksMixin`, honours our shared lock
policy, 0/360 stale, 15-26 ms), `AccessHandlePoolVFS` (`poolSize: 1` only), and CoopSync. The
default `OPFSAdaptiveVFS` also degrades on such platforms, by its own detection. **CoopSync's only
distinguishing combination is OPFS + `poolSize > 1` outside Chromium — which is exactly the
combination that fails.** That argues for D, but D depends on `IDBBatchAtomicVFS` having tests
(VFS-COV) and on someone having actually run a non-Chromium browser (RWU-1).

### Recommended order — measure before designing

1. Pin COOP-1 as a failing browser test (DDL interleaved with 4 readers) so there is a stable red.
2. Probe A against B; the answer alone splits the option table in half.
3. Run the non-Chromium paths under Playwright's Firefox/WebKit (RWU-1) — that decides D.

## HANDLE-1 — one long statement serializes the whole pool off Chromium

**Status: open. Root cause established by observation 2026-08-24; no remedy exists at our layer.**
This is the most consequential finding of the browser-matrix campaign and it is not a bug to fix,
it is a limit to decide and document.

### Symptom

`tests/browser/long-query.test.ts :: does not terminate the worker it abandoned, and does not
block the pool` fails on Firefox: the second `read()` takes **28-29.5 s** against a 3 s budget —
exactly the run time of the abandoned `longQuery(20_000_000)`. Reproducible in isolation, so it is
not cross-test contamination.

### Evidence — statuses sampled without wrapping `Worker`, so the race is not perturbed

| moment | W0 | W1 |
|---|---|---|
| after `CREATE TABLE` | READY | READY |
| after the abort | **ABORTING** | READY |
| +100 ms → +4000 ms | ABORTING | **RUNNING** |
| after `SELECT 1` (28 143 ms) | READY | READY |

**The second read is dispatched to the free worker immediately.** W1 goes RUNNING at once and stays
RUNNING for 28 s. So the scheduler, the lease and `quiesce()` are all innocent — three hypotheses
that were checked and killed, along with test calibration and zombie accumulation across tests.
**The block is inside the worker, below our layer.**

### Cause

Without `readwrite-unsafe` there is **one exclusive OPFS access handle**, rotated between
connections over a `BroadcastChannel`. A worker inside a single long `sqlite3_step()` never returns
to its event loop — which `long-query.test.ts`'s first test pins deliberately ("runs to completion
untouched") — so it can never answer the hand-over request. Any file-touching work on another
worker waits for the abandoned query to finish.

**It is a race, not a certainty.** In an instrumented run W1 had taken the handle before W2 started
its recursion, and W1's barrier prelude completed in 3 ms while W2 ground on. That is why the test
goes green when observed and red when not — a genuine Heisenbug. The unperturbed measurement is the
one to trust.

**Not established:** which of W1's two statements blocks — the barrier prelude or `SELECT 1`'s own
lock acquisition. It does not change the conclusion.

### What it means, and why it is not fixable here

**"Does not block the pool" is false off Chromium.** The assertion is right; the behaviour is worse.
Concurrent reads hold on Firefox **only while no worker is running a long uninterruptible
statement**. One abandoned long query degrades the entire pool to serial for its full duration, and
since a single `step()` cannot be cut short there is no remedy in our code.

**The dividing line is not `readwrite-unsafe`, it is the synchronous access handle**, so the obvious
"just use CoopSync on Firefox" is wrong — CoopSync rotates one exclusive handle too and inherits the
same defect, its 104/104 notwithstanding.

| VFS | model | escapes HANDLE-1 |
|---|---|---|
| `OPFSAdaptiveVFS` (degraded) | one exclusive handle, rotated | no |
| `OPFSCoopSyncVFS` | one exclusive handle, rotated | no |
| `AccessHandlePoolVFS` | one handle, `poolSize: 1` enforced | n/a |
| **`IDBBatchAtomicVFS`** | IndexedDB, no handle at all | **yes, structurally** |
| **`IDBMirrorVFS`** *(not wired)* | RAM mirror, persisted to IndexedDB | **yes, structurally** |
| **`OPFSAnyContextVFS`** *(not wired)* | File API (`getFile` / `createWritable`) | **yes, structurally** |

**`IDBMirrorVFS` is the strongest candidate on paper, and it is easy to miss** — it is documented
on upstream's examples README but **not in the comparison table**, which is why a first reading
declared it undocumented. Upstream's own words: it "keeps all files in memory, persisting database
files to IndexedDB", "works on all contexts", "has the same characteristics as IDBBatchAtomicVFS in
the table" — so multi-connection ✅, all contexts ✅, relaxed durability available via `PRAGMA
synchronous=normal` — and the differences are "(1) **it is much faster both with and without
contention**, and (2) it can only use databases that **fit in available memory**". Its source
agrees: sync `jRead`/`jWrite`/`jTruncate`/`jFileSize` over a `Map<number, Uint8Array>`, async
`jOpen`/`jLock`/`jClose`, cross-connection coherence over `BroadcastChannel('mirror:' + pathname)`
plus `navigator.locks`. Builds: `async`, `jspi` — inferred from the async methods, **to be verified
by running, per this project's rule of executing every declared combination rather than trusting a
table.** The memory ceiling is the whole trade, and it is per worker: `poolSize` copies.

**Upstream's README carries no per-browser recommendation, no choice guidance, and no deprecation
notice.** That documentation does not exist anywhere and is ours to write.

The last two are therefore the only candidates worth measuring as a Firefox recommendation, and
**neither has a single test** — `IDBBatchAtomicVFS` is one of VFS-COV's two gaps and
`OPFSAnyContextVFS` is not even wired into `VFSConfigs`. Upstream warns its write performance is
"very bad". The measurement to run is that trade: **write latency against pool non-blocking.**

## Two Firefox test failures — recorded so they are not rediscovered

Both from the 2026-08-24 matrix run, both open, neither about OPFS availability.

- **`long-query :: does not terminate the worker it abandoned`** — this is HANDLE-1 above. Not a
  test defect.
- **`lifecycle :: rejects the in-flight query on a deserialization failure`** — times out at 30 s.
  Leading explanation is calibration, not code: the test does `sleep(100)` and then synthetically
  dispatches `messageerror`, betting the query is already in flight. **Firefox is 5.5× slower than
  Chromium on the same CPU-bound query** (4192 ms vs 755 ms for `longQuery(3_000_000)`), so any
  Chromium-tuned constant is suspect. Unverified — nobody has traced this one.

## WebKit — dead lead, do not re-add without re-running the check

Playwright's WebKit on Linux exposes **no `navigator.storage` at all**: no OPFS, no
`FileSystemHandle`, no `FileSystemDirectoryHandle`, no `showDirectoryPicker`. Only `indexedDB`
answers. Verified in a dedicated worker on a secure `http://localhost` page, so it is neither a
secure-context nor an rstest problem. The suite reports 9/104 for that single cause. It is a gap in
the Linux port, not the engine — OPFS is Baseline since March 2023 and shipping Safari has it. A
real WebKit signal needs Playwright on **macOS**. rstest accepts no provider but `playwright`
(`BROWSER_PROVIDERS = ['playwright']`), so there is no escape hatch. Removed from CI and the
devcontainer in `ee2e9f3`.

## MIRROR-1 — `IDBMirrorVFS`'s `multiConnection: true` has an observed counter-example

**Status: open. Low-rate flake, mechanism plausible and named, declaration not yet corrected.**

`tests/browser/vfs.test.ts :: newly wired VFS > IDBMirrorVFS opens and serves a round trip` failed
once with **`no such table: wired`** — in a pre-commit hook run, 2026-08-24. Measured immediately
after: **8/8 green in isolation, 6/6 green on the full suite**. So the rate is roughly ≤1 in 15 and
it is not reproducible on demand, which is precisely the rate that eventually reddens CI with no
one able to say why.

**It has now been seen four times.** Third sighting 2026-08-24 and fourth 2026-08-25, both in a
pre-commit hook and both on **docs-only commits** whose trees had gone 323/0 in the same hook
minutes earlier — so the flake is independent of any source change and the rate estimate above
survives. Four sightings across two days of heavy committing puts it near the ≤1-in-15 estimate and
means a CI run will eventually go red on it with nobody able to say why.
Task 3 of the wiring plan reported the same failure and could not
reproduce it either; the declaration was carried forward as PROVISIONAL on the reasoning that the
conformance suite would settle it. Conformance passed — but its invariants exercise one write and
one read, or concurrent writes counted afterwards, never the tight
`CREATE TABLE` → `INSERT` → `SELECT` sequence at `poolSize: 2` that this test runs.

### MEASURED 2026-08-25 — the declaration is false, and it is not only staleness

A deliberate probe settled it. Method, which matters as much as the number: a temporary
`tests/browser/mirror-probe.test.ts` repeating the failing sequence unchanged — `CREATE TABLE` →
`INSERT` → `SELECT`, `IDBMirrorVFS` at `poolSize: 2`, a fresh database each round, 60 rounds — with
**no instrumentation at all**: no `Worker` wrapper, no `debug: true`. The last millisecond-scale
race in this project was hidden by its own instrument, and browser `console` output is not
forwarded, so the count was surfaced through the assertion message instead.

**In isolation: 0/60. Under the full suite: 5 failures across 300 rounds (~1.7 %), in 4 of 5 runs.**
The defect needs contention to appear, which is exactly why every sighting has been a pre-commit
hook and why nobody could reproduce it on demand.

**Two distinct symptoms, not one:**
- `no such table: wired` — the stale cross-connection read the entry predicted;
- `database is locked` — `SQLITE_BUSY`, which the entry did not predict.

So `multiConnection: true` is **false as declared** for this VFS: a second connection neither sees a
committed `CREATE TABLE` reliably nor waits for it correctly. `VFS_CAPABILITIES` is the single
source the client guards, the conformance suite, the README table and the benchmark page all read,
so one wrong field propagates everywhere.

**Consequence for the VFS's standing.** It was one of two candidates escaping HANDLE-1 and it is the
fastest persistent option on Safari (bulk 44 ms vs IDBBatchAtomic's 77 ms, transactions 28 vs 31).
With `multiConnection` false it leaves the multi-connection shortlist entirely, and — with
ANYCONTEXT-1 removing `OPFSAnyContextVFS` on Safari — `IDBBatchAtomicVFS` is left as the only
persistent multi-connection VFS that works on all three desktop engines.

**What is NOT yet decided:** whether the field becomes `false`, or `true` with a stated visibility
window, and what `maxPoolSize` should then be. That touches `src/types.ts`, the conformance suite
and the README generator, and it needs its own review.

**The `it.fails` convention does not fit here.** A characterization test pinning a defect that
appears 1.7 % of the time would itself fail most runs. Until the declaration is corrected,
`tests/browser/vfs.test.ts :: IDBMirrorVFS opens and serves a round trip` stays a genuine ~1-in-60
liability in CI — and it is now understood, not mysterious.

**Mechanism, predicted and now half-confirmed.** `IDBMirrorVFS` keeps the whole database in memory
*per worker* and propagates commits between connections over `BroadcastChannel` — asynchronously.
That is structurally the same defect that got `OPFSPermutedVFS` deleted from this library (24 %
stale cross-connection reads, measured 2026-08-20). The commit-propagation barrier does not save
it: the barrier's prelude opens a real read transaction to refresh page 1, but if the mirror has
not yet received the broadcast there is nothing fresher on the connection to read.

**What that would mean if confirmed:** `multiConnection: true` is false for this VFS, or true only
with a visibility window. Since `IDBMirrorVFS` is one of the two candidates for the non-Chromium
recommendation (see HANDLE-1), this is load-bearing rather than cosmetic.

**Do not** weaken the test, add a retry, or pin it to `poolSize: 1` to make the hook green. The
next step is a deliberate probe: the failing sequence at `poolSize: 2`, repeated enough times to
get a rate, with the worker that served each statement recorded — the same instrumentation that
settled HANDLE-1, and the lesson from that session applies, that wrapping `Worker` can shift the
race and hide it.

## JSPI-1 — three README claims are wrong about Firefox

**Status: open, sourced 2026-08-24.** `caniuse.com` gives **JSPI as available in Firefox from 153**
(user, 2026-08-24), and our own conformance run on Playwright's Firefox 153 independently detected
`WebAssembly.Suspending` and executed all 22 declared build pairs, jspi included. Documented source
and observation agree exactly, which is the strongest state a fact in this project can be in.

Wrong in three places, all asserting Chromium-only JSPI:

- `README.md:91` — "`jspi` (JavaScript Promise Integration, Chromium-only)"
- `README.md:256` — "only `build: 'jspi'` does, and JSPI is Chromium 126+"
- `README.md:263` — "JavaScript Promise Integration is not available in Firefox or Safari as of 2025"

**"Chromium 126+" is itself unsourced** and appears twice. It gets the same treatment as everything
else: a named source, or it goes.

**How this was found, because the method is the point.** Asked where the Firefox claim came from,
the answer was: from this README and nowhere else. It had never been sourced — it was inherited,
repeated, and then contradicted by our own measurement without anyone noticing. The rule that
catches this class is **a fact with no citable source does not enter the table**, and it is why the
per-browser compatibility work (see `mem:resume-plan` §0.2 item 2b) must carry a named source and a
date per cell.

**Lucky detail worth keeping:** Firefox 153 is exactly the first supporting version, so our run sat
on the boundary. On 152 the nine jspi pairs would have skipped with their stated reason and nothing
would have failed — the feature detection was validated by accident.

## ABORT-1 — `bulkWrite` and `output` take no `signal`

**Status: open, raised by the user 2026-08-24** while reviewing the benchmark page spec
(`docs/superpowers/specs/2026-08-24-bench-page-design.md`).

`signal` is on `SQLiteQueryOptions` and is honoured by `read` / `write` / `first` / `stream` /
`chunk` — `queries.ts`'s `chunk()` is the only place an `AbortSignal` is read at all. **`src/bulk.ts`
contains no `AbortSignal`.** So the two long-running methods in the public surface, the ones most
likely to need cancelling, are the two that cannot be cancelled. `signal` reads as universal in the
docs and in `SQLiteQueryOptions`; that it stops at `bulkWrite` is undocumented.

**Why this is cheaper than it looks for `bulkWrite`:** it already calls the **public** `write` once
per batch and releases the worker between batches (a property D3 depends on — do not consolidate it
into one held lease). Threading a `signal` down to each batch's `write` therefore gives an abort
that lands *between* batches, which is both the natural granularity and the only point where
stopping is meaningful — a multi-row INSERT is statement-atomic.

**`output()`'s abort semantics — decided by the user, 2026-08-24: an abort drops the staging table
and touches nothing else.** No rename, no partial publication, and the previous target is left
exactly as it was — which the wave-3 change already gives for free, since the target is only
created at `close()`. So an aborted `output()` is observationally a no-op.

Two mechanical consequences to carry into the implementation:

- The eager `DROP` is a write and therefore needs a worker *after* the abort that freed one. It is
  **best-effort**: if it fails, the state falls back to the one already handled — an orphan staging
  table, swept by `staleStagingTables` (`locks.ts`) once the staging lock is released. The abort
  path must not hang or throw on a failed cleanup.
- Releasing the staging lock is what arms that sweep, so it must happen after the `DROP` attempt,
  not before.

**First observed consumer of the gap:** the benchmark page's containment design (§5.3 of its spec).
Because `bulkWrite` cannot be aborted, the only bound available for its row is a `Promise.race`
against a timer, which abandons the *wait* without stopping the *work* — leaving the worker busy
and every later row in that column timed against a machine still executing. The page therefore has
to abandon the whole column on that one row, where every other row simply moves on. **When ABORT-1
lands, that special case disappears**; the page reads which regime applies from the method it
calls, so nothing else changes.

Not blocking: no consumer on rc.3, and a caller wanting a bound today can chunk their own batches.

## BENCH-DRIFT — the page holds a second copy of the invariants and the probes

**Status: standing rule, not a bug. Opened 2026-08-24 with the benchmark page.**

`bench/index.html` re-implements, in plain JS, what `tests/conformance/invariants.test.ts` and
`tests/conformance/helpers.ts` hold in TypeScript: the six invariants, the `readwrite-unsafe`
behavioural probe, and the JSPI detection. The duplication is deliberate — a self-contained HTML
file cannot import `tests/**` , which import `src/` — and it is bounded: these describe properties
of SQLite and of the platform, not of our implementation, so they are expected to be static.

**The rule: changing either copy obliges a review of the other.** Both directions.

What makes a divergence visible rather than silent: **the page's row ids are normalized from the
conformance `describe()` titles** — the `invariant N — ` prefix is dropped and the remainder is
kebab-cased — giving `opens`, `write-read-back`, `survives-reopen`,
`concurrent-writes-lose-nothing`, `rollback-leaves-nothing`, `close-settles`,
`no-read-inside-transaction`. A row whose id no longer maps to a `describe()` is the signal.

Two places where the copies legitimately differ, and must not be "aligned":

- The page returns `'blocked'` where invariant 6 logs a `console.warn` and passes. Same
  observation, different medium: a test suite has nowhere to render a third state, a table does.
- The page reopens the column's client after `survives-reopen` and `close-settles`, because it runs
  every row against one client where the suite gets a fresh one per `it()`.

This is the class of defect this repository already knows it has — *"here, comments drift faster
than code"* — applied to code rather than comments.

## DELETE-1 — there is no way to delete a database, and the JSDoc advised a wrong one

**Status: open, found 2026-08-25 by the benchmark page failing on its own second run.**

Every persistent VFS wa-sqlite ships implements `jDelete`, and for `AccessHandlePoolVFS` it is the
**only** correct removal: `#deletePath` un-associates the SQLite path and returns the slot to the
pool, deliberately leaving the OPFS file in place because that file *is* a reusable slot. The
library never exposes it — the worker holds the VFS instance and nothing routes to it.

**How it surfaced.** The bench page opened a uniquely-named database per column and removed it with
`removeEntry(ourName)`. `AccessHandlePoolVFS` stores every database inside one directory named after
the VFS class (`#directoryPath = name`), holding `DEFAULT_CAPACITY = 6` files with `Math.random()`
names, so that removal matched nothing and no slot was ever freed. The seventh column on an origin
failed with `unable to open database file`. Seven real-device runs fit the 6-slot ceiling exactly,
including why a single-run browser and Safari (two columns per run, no jspi) never hit it.

**`client.ts`'s `close()` JSDoc told consumers to do exactly the wrong thing** — "to delete OPFS
files, use the `navigator.storage.getDirectory()` API directly" — which is correct only for the
plain OPFS VFS on an already-closed database, leaves `-journal`/`-wal` behind even there, silently
costs `AccessHandlePoolVFS` its capacity, and is a no-op for the two IndexedDB VFS whose data is not
in OPFS at all. It shipped in `dist/*.d.ts`. **Corrected 2026-08-25** to describe the per-VFS
reality and to say that no deletion API exists yet — the wrong advice is gone, the missing feature
is not.

**What a `deleteDatabase(file)` owes, and why it was not bolted on at the end of the VFS branch:**

- it must route to the open VFS's `jDelete`, so it needs a worker that has the VFS loaded — which
  means opening one to delete, or keeping the deletion in the same worker lifecycle as `close()`;
- what should happen when the database is open in another tab, where nothing here can revoke a
  handle;
- what it returns when the database does not exist — SQLite's `xDelete` is content with that;
- and whether it also removes the auxiliary files, which differ per VFS.

**It must delete IndexedDB databases too, not only OPFS entries (user, 2026-08-25).** The goal is a
removal a consumer can actually rely on, whatever VFS they chose. `IDBBatchAtomicVFS` and
`IDBMirrorVFS` keep their data in an IndexedDB database named after the VFS class, holding every
database opened with that VFS on the origin — so `jDelete` alone frees the SQLite file inside the
store while the store itself stays, and `indexedDB.deleteDatabase(<VFS name>)` would destroy every
other consumer's data on the same origin. Neither is the answer on its own: deleting one database
means routing through `jDelete`, and reclaiming the store means knowing it holds nothing else. That
asymmetry between the OPFS and IndexedDB families is the part of this design that actually needs
thought.

None of that is hard; all of it is a design, and the end of a large branch is the wrong moment.

**The bench page does not wait for it.** It diffs the OPFS root before and after a run and removes
what appeared — a rule that needs no knowledge of any VFS's layout and survives an upstream change
to them, and the same rule it already used for IndexedDB. Verified by reproduction: nine
`AccessHandlePoolVFS` columns across three consecutive runs in one persistent context, where six
used to fail.

## ANYCONTEXT-1 — `OPFSAnyContextVFS` does not open on Safari

**Status: open, measured 2026-08-25 on Safari 26.5.2 / macOS. Reproduced in three separate runs,
the last on a swept storage root — so it is not our residue.**

`opens` fails with **`file is not a database`** (`SQLITE_NOTADB`). Note what that is not: it is not
"OPFS unavailable" and not a clean refusal at open. The VFS reached storage and SQLite read
something that was not a database header. For a storage library that is the sharper signal.

**Why it matters beyond one VFS.** `mem:resume-plan` §0.2 named `OPFSAnyContextVFS` and
`IDBBatchAtomicVFS` as the only two VFS that escape HANDLE-1 structurally, hence the only candidates
for an engine without `readwrite-unsafe`. Safari is exactly such an engine, and one of the two
candidates does not run there. On Firefox, by contrast, `OPFSAnyContextVFS` measured the **best**
read-burst concurrency of any VFS (2.50x, where the default `OPFSAdaptiveVFS` fell to 1.08x), so it
is not a VFS to write off — it is engine-specific.

**Hypothesis, not established:** the VFS exists to avoid synchronous access handles, so it likely
writes through `createWritable()`. If that path does not land as expected on WebKit, the file stays
empty or incoherent and SQLite rejects the header. What would settle it: reading AnyContext's write
path in wa-sqlite v1.1.2 against what WebKit implements. Nobody has done that.

**The README does not say any of this yet.** Its `Browser compatibility` column is generated from
MDN/caniuse and cannot express an observed per-engine failure; `OPFSCoopSyncVFS` got a Known
Limitations entry for the same reason and this one has not.

## DEFAULT-1 — a platform-dependent default VFS was considered and rejected

**Status: decided 2026-08-25 (user). Recorded because the idea is attractive and will come back.**

The measurements make a per-platform default look obviously right: `OPFSAdaptiveVFS` reads 3.24x on
Chromium and 0.94-1.08x off it, where `OPFSAnyContextVFS` reads 2.50x on Firefox and
`IDBBatchAtomicVFS` is the only sound persistent choice on Safari. Picking by feature detection
would hand every user the best available VFS.

**It was rejected for a reason that has nothing to do with performance: the VFS decides where the
data is written.** A default resolved by detection moves the moment detection changes its mind —
Firefox ships `readwrite-unsafe`, the choice swings from one VFS to another, and the existing
database becomes invisible. The bytes are still there, in a VFS nothing queries any more. From the
user's side that is silent data loss, triggered by a browser update nobody asked for.

Staying on "whichever VFS created this database" does not save it: identifying that would mean
probing all nine, which is expensive and ambiguous.

An API that *returns* a recommendation for the application to pass explicitly was floated and also
dropped — the user's call: the default is universal and works everywhere, so a second mechanism
earns nothing. **The default stays `OPFSAdaptiveVFS`,** which is best where it shines and merely
degraded elsewhere, never broken, all invariants green on all three engines. The benchmark page is
what answers "which one here", and the README links to it prominently.

## Performance — after correctness, with debug instrumentation live

- No prepared-statement cache (`worker.ts:169`) — typically the largest single win (2-10×); worst for `bulkWrite`'s ~32k-placeholder template.
- ~~`stream()` has no back-pressure~~ — **promoted out of this list on 2026-08-18 and named BP-1** (Important table above). It was never a perf item: it gates D2, and it contradicts a guarantee the README already makes.
- No default PRAGMAs → consumers silently run `journal_mode=DELETE` + `synchronous=FULL`. Ship WAL + NORMAL + `busy_timeout`.
- PRAGMAs are re-applied on **every** query (`worker.ts:171`), contradicting the JSDoc and README which say "applied on open".
- `bulkWrite` flushes are separate transactions (~300 commits for 1M rows).
- Every worker compiles its own WASM copy (`worker.ts:118`, 1.23 MB × poolSize). `WebAssembly.Module` is structured-cloneable — compile once, `postMessage` it.
- ~~Scheduling is lowest-index-first with a sticky writer → reads pile on worker 0; use round-robin/LRU, prefer non-writer workers for reads.~~ **Read this together with RYOW-1 before touching it (2026-08-19).** Wave 3 made reads *prefer* the designated writer, deliberately, for a correctness reason this note did not know about: the writer is the only worker guaranteed to have the latest commit under `OPFSPermutedVFS`. The throughput concern stands — under read-heavy load reads now concentrate on the writer while other workers idle — but the fix is not simply reverting to lowest-index or round-robin. It needs a real commit-propagation barrier, after which the scheduling can be freed. Sequence it after BP-1. — **STRUCK 2026-08-21, and round-robin is now the WRONG answer.** `takeAvailable` picks the lowest *available* index, so a busy worker 0 never makes a read wait while another is free: the pool runs at full capacity whatever the policy, and the "throughput concern" this note asserts does not exist. Worse, since the barrier, spreading reads is a **cost**: after each commit the prelude is paid once per *distinct worker used* before the next commit, so concentrating minimises it and round-robin maximises it (up to `poolSize` per commit). Same conclusion for the per-connection page cache — one hot cache beats four lukewarm ones.
- **OPEN, and it is the one read-side idea worth measuring (user, 2026-08-21): prefer the LAST WRITER for reads, then lowest index.** A `lastWriterIndex` used purely as a freshness hint — no exclusivity, no effect on who may write, correctness carried by the barrier alone. Distinct from the shape the user rejected in wave 3 (reads preferring the *designated* writer), which was a correctness crutch. Rule 1 survives by construction: `handOver`'s reader branch has no choice to make, it serves the worker that just freed. **What the measurement must settle, because deduction cannot:** on an idle pool the hint coincides with lowest-index (the write and the next read both take the lowest free worker), so the gain exists only under contention; and following the writer makes it busier when the next write arrives, which may simply move the prelude to the write path instead of removing it. Baseline to beat is the prelude census in RYOW-1.
- Per-row `Object.fromEntries(cols.map(...))` in the hottest loop (`worker.ts:188`).

## Cleanups — cheap, batch them opportunistically

- ~~`Buffer.isBuffer` in browser code (`debug.ts:76`)~~ — **done 2026-08-17.** Now `value instanceof Uint8Array` (a Node Buffer is a subclass, so the unit test still passes) with a manual hex conversion. Surfaced as a compile error once `tsconfig.build.json` scoped the build program to `src`, which stopped pulling Node types in transitively through the test/config files.
- ~~`defer()` from `@lalex/promises` duplicates native `Promise.withResolvers()` — drop the dep.~~ **Done wave P, 2026-08-17.** `Promise.withResolvers()` now used throughout `client.ts`; `@lalex/promises` removed entirely.
- ~~Worker resolution is an unverified bundler assumption~~ — **verified broken 2026-08-17, promoted to B10.**
- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via a deep import; import the bare specifier instead.
- `types.ts:1-38` dead/stale protocol duplicate (with a `SQLiteCLientCallParams` typo).
- `SQLiteStreamOptions` (`client.ts:65-68`) is `SQLiteQueryOptions<T> & { signal?: AbortSignal }` — but `signal` is already in `SQLiteQueryOptions`. The intersection is a no-op type; delete it or give it real content.
- `worker.requests` (`debug.ts`) grows without bound — `MAX_QUERY_HISTORY_LENGTH` caps only `currentRequest.queries`. Blocks D5; see `mem:resume-plan` §1.3.
- ~~**[wave 1] Abort listener leak.**~~ **Done, wave 1 2026-08-18** — removal moved into `chunk()`'s `finally`, covered by a test using an instrumented signal that counts `addEventListener` against `removeEventListener`. Original text: `signal?.removeEventListener(...)` sits *after* the `while (deferredChunk)` loop (`client.ts:451`), so it is skipped on every early exit — and `oneWorker` exits early **by construction** (`client.ts:713` breaks after the first row). Every `one()` call therefore leaves an `abort` listener attached to the caller's signal. Found 2026-08-18 during wave 1's brainstorming; the `chunk()` relayering must move the removal into the `finally`.
- **[wave 1]** The JSDoc of `CreateSQLiteClientOptions.name` (`client.ts:25-28`) is wrong and self-contradictory: it claims the option is the OPFS database file name, but the file comes from the positional `file` argument — `name` only feeds `clientPrefix` (`client.ts:286`), which names the Web Workers via `WorkerOptions.name` and will feed the debug prefix. Its own `@defaultValue` line describes the prefix behaviour and contradicts the two lines above it.
- No exhaustiveness (`default: const _x: never`) on either message-union dispatch.
- `read<T>`/`one<T>`/`stream<T>` are phantom types (`as T[]`, no validation) and the JSDoc never says so.
- ~45 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Missing `sideEffects: false` and `engines`; release action pinned to a mutable `@v1` tag while holding `NPM_TOKEN`; inline rsbuild plugin uses the reserved `rsbuild:` name prefix and an ad-hoc `api` type.
- Leftovers visible to consumers: `status: 'HAHA'` (`debug.ts:158`), typo `'Cannot werite in read-only transaction'` (`client.ts:920`), `SQLiteQueryOptions.id` documented on 4 methods and never implemented, unused generic `SQLiteQueryOptions<_T>`, 4-level nested ternary (`client.ts:870`), `pool.find((w) => { if (w.available) return true; return false; })` (`client.ts:497`).

### Deferred minors from wave 3 (2026-08-19) — triaged by the final whole-branch review as "can wait"

None of these block anything; batch them opportunistically. Listed because the execution
ledger they came from is deleted at merge.

- Test names that overclaim what they pin: `quoteIdent`'s "preserves case" (passes without the
  quote-doubling), `renderPragmas`'s "re-escapes a quoted string literal" (it passes the literal
  through unchanged — rename), and the second assertion of the scheduler's "does not clear the
  writer designation" (the designation survives either way; only its first assertion is
  load-bearing).
- Vacuous assertions that sit beside falsifiable ones: `expect(sql).toHaveLength(1)` in
  bulk's "does not attempt later batches", and `calls > 0` in the zero-row `output()` test.
  In both cases a sibling assertion carries the pin.
- One test comment names the wrong assertion as the one that turns red (the `enqueue`-after-close
  case: it is the `toThrow`, not the `sql` length).
- `deps as any` cast in the third `output()` unit test can mask future drift against `TransactionFn`.
- `String(value)` in `renderPragmas` is a no-op on a `Record<string, string>`.
- Inserting `READ_PRAGMA` between the "Routing predicate" block comment and `isReadQuery`
  orphaned that JSDoc — it now reads as a section comment (`utils.ts`).
- `acquireInstrumented`'s comment says "seven acquisition sites"; there are six.
- Unit tests pin quoting only at the INSERT site; the CREATE TABLE column DDL and CREATE INDEX
  column list are covered by browser tests only.
- **Kept deliberately, do not "clean up":** the no-op degradation branch in `locks.ts` is
  unreachable in Node ≥ 21 and every current browser. The final review recommended keeping it —
  spec-mandated, correct, zero maintenance.

## Characterization-test convention (from wave 0)

Known bugs are pinned with `it.fails(...)` — the test asserts the *correct* behaviour
and `.fails` asserts the bug is still there. **When the bug is fixed the test starts
passing, which makes `it.fails` fail** — that red is the signal to drop `.fails`, not a
regression. No `it.fails` anywhere as of wave 2.

Behaviour that is wrong but not yet pinned is documented with a plain `it` plus a
comment naming the issue ID — e.g. B5's silent batch drop in `bulk-write.test.ts`.
Those tests will break when the bug is fixed; that is intended.

The B4 PRAGMA case uses this pattern: `tests/browser/routing.test.ts` pins the current
rejection of read PRAGMAs with a plain `it` and a comment (`// Documented regression…
B4 (wave 3) must give read pragmas back to read()`). When B4 lands, that test turns red —
that is the signal to update the routing guard, not a regression.

## Debugging note — how SUP-1 was caught (2026-08-21), reusable

The symptom was a browser test hanging on its last assertion in roughly one full-suite run in
eight, and never in isolation. Three things that worked, in order of how much time they saved:

1. **Instrument the PRODUCT, not the test.** Every probe placed in the test made the bug vanish —
   bounding the hanging call, enabling `debug: true`, shortening a sleep. A trace array on
   `globalThis`, pushed to from `client.ts` / `pool.ts`, caught it in five runs.
2. **A timed-out test still runs its `afterEach`.** Browser `console.log` is swallowed
   (`browserLogs: false` in `rstest.config.ts`), so the way to surface a trace from a test that
   never finishes is an `afterEach` that **throws** it. Gate the throw precisely: set a flag on
   the test's last line and dump only when that flag is unset, otherwise every healthy run dumps
   too. Two loose gates were tried first and both fired on healthy paths.
3. **A control that differs by two things controls nothing.** The first comparison was
   `main` vs the branch — which differed by a source change *and* by an added test file. Four
   combinations were needed to work out that the flake needed the added file at all, and the
   product bug turned out to be reachable on `main` regardless. State each arm's single variable
   before running it.

Context: `mem:project-state`. Sequencing: `mem:resume-plan`.
