# Follow-up — tests based on time that could be based on events

**Status: OPEN** — inventory made 2026-10-29 (user: "le temps serait juste pour les timeout"); the yields are done (`test/next-task-yields`), groups A and B done (`test/time-based-a-b`, 2026-10-29), the rest is to do.

**Done 2026-10-29, A and B:** every "the statement is running" `sleep(100)` waits on `theQueryIsRunning` (`lifecycle` ×8, `debug`, `delete`, `long-query`, `open-retry`, `idb-long-read`; their clients take `debug: true`); `backpressure`'s parked-on-credit kill waits for the credit window to be full (≥ 2 chunks posted) and its close test for the first row; the replacement waits are `records[1]` reaching `ready` (30 s bound, Safari's wasm stall) in `long-query` and `backpressure`; `lifecycle`'s two post-kill sleeps wait for `onWorkerLost` and for worker 0's termination. Falsified: no `worker.onerror` (15 `lifecycle` tests red), no `emitWorkerLost` in the `lost` branch, no drain timer (`long-query` and `backpressure` red). **`backpressure`'s two `sleep(1500)` past `drainTimeout` ("does not restart", `first()` "never restarts") are group E, not B:** the window is what they prove.

Part of `mem:follow-ups`.

**Rule asked for by the user:** a test waits for an event or a state, and time appears only as a timeout. A yield to the task queue in a browser test is `nextTask()` (`tests/browser/helpers/index.ts`, a `MessageChannel` message), never a zero-delay timer: Safari 27 runs an idle test page's timers at 1 Hz (SAFARI27-TIMER-1HZ) and GitHub's macOS runners take 16-25 ms per `setTimeout(0)` in Chrome and Firefox. Not a microtask (worker messages are tasks), not `requestAnimationFrame` (throttled, paused on a hidden page). Unit tests run in Node, where `setTimeout(0)` is fine.

**Done 2026-10-29:** every yield-only `sleep(0)`/`sleep(1)`/`setTimeout(0)` of the browser tests moved to `nextTask()` (abandon, abandon-gc, abandon-transaction, chunk-delivery, run, stream-retention); `second-client`'s `REFUSED_WITHIN` goes through `scaled()` (it failed macOS 26 at 3193 ms against a raw 3000). Kept: `delete.test.ts`'s `setTimeout(0)`, which waits for Web Locks to process a release (group C below).

**To do — fixed waits (about 47 of the ~80 browser sites):**
- **A. "the statement is running"**: `sleep(100)` after launching a long query, before a kill or an abort — `lifecycle` (8), `debug`, `delete`, `long-query`, `open-retry`, `backpressure` (2), `idb-long-read`. → `waitUntil(theQueryIsRunning(db, sql))`. `early-exit` and `abort-slot` want "inside the step", finer than RUNNING: per test.
- **B. "the replacement is up"**: `sleep(1500)`/`sleep(2000)` "past drainTimeout plus a boot" — `backpressure` (3), `long-query`; `lifecycle` `sleep(100)` after a kill (2). → the replacement READY in `db.debug.workers`.
- **C. hand-written polling loops**: `lifecycle` `created.length` (4, an event: resolve a promise from the test's own `Worker` subclass); `writer-spread`, `run` (2), `failed-client`, `inspect-marker`, `inspect-write`, `bulk-write`, `multi-client`, `output`, `vfs-create-retry`, `inspect`, `delete` (external state with no event) → `waitUntil`.
- **D. a consumer paused at a point**: `chunk-delivery` `sleep(120)` (2), `backpressure` `sleep(300)`, `transaction` `setTimeout(100)`, `close` `sleep(100)` → a deferred the test resolves, or the request seen queued in debug.
- **E. absence over a window**: `realm` 250 ms, `cross-tab` 400 ms, `database-pragmas` 500 ms → a pending lock request seen through `navigator.locks.query()`/`inspectDatabase`; unit `verdicts` 200 ms → one task turn. Keep `interrupt` 300 ms ("not cut") and `debug` 50 ms.
- **Keep (time is the subject):** slow consumers/producers against a `timeout` or `drainTimeout` (`query-timeout`, `tx-timeout`, `chunk-delivery`, `backpressure`, `quiesce`'s `waited >= 200`), `abandon-gc`'s GC rounds, unit `debug`'s 5 ms, the tooling's own timeouts.

**To do — elapsed-time assertions (~25 with a verdict):**
- "the statement was cut" (`abort-slot` ×3, `interrupt`, `early-exit` ×2, `query-timeout`, `long-query`, `tx-savepoint` `natural × 0.6` ×2) → a causal witness, e.g. the worker's answer for that statement being an interrupt in `interceptWorkers`' trace; verify the witness per VFS/build first.
- order (`tx-savepoint` T2/T5) → the trace's order; "rejected at once" (`query-timeout` ×2, `interrupt`) → rejected while `theQueryIsRunning` still holds.
- anti-stall bounds (`second-client` ×2, `exclusive-connection`, `open-retry`, `pool-cap`, `params`, `backpressure`, `abandon-transaction`, `quiesce`) → drop the bound where the stall outlasts the test's timeout, or raise the library timeout in the test so it does.

Recommended order: A and B (most fragile under Safari 27, helper exists), then C and D, then the "cut" witnesses, which need design. Re-prove each changed test with a mutation (`mem:follow-ups/stale-falsifiers`).
