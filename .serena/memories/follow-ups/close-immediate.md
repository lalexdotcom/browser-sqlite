# Follow-up — an option for `close()` that interrupts everything at once

**Status: CLOSED — `feat/close-immediate` merged 2026-11-13.** Opened 2026-11-09 (user): "il faut prévoir une option pour close qui interrompe tout immédiatement". Designed 2026-11-12/13 with the user: spec `docs/superpowers/specs/2026-11-12-close-immediate-design.md`, plan `docs/superpowers/plans/2026-11-13-close-immediate.md`.

Part of `mem:follow-ups`.

## What was decided (user)

- **Opt-in, per call:** `close({ immediate: true })`; `close()` without it drains as before (a plain query in flight is waited for, bounded by `drainTimeout`).
- **Two steps:** interrupt every statement in flight where the interruption reaches SQLite (`async`, `jspi`, `sync` under cross-origin isolation), then close cleanly; a worker whose statement cannot be stopped (`sync` without isolation) is terminated at once. "Immediate everywhere, clean wherever possible."
- **Interrupted calls reject with `CLIENT_CLOSED`**, like the queued ones — not with the abort's reason.
- **Accepted costs, documented in `API.md` (§ close, `#### immediate`):** a write that completed just before may reject although it landed; a write cut by a termination is lost and rolled back at the next open; on Safari a terminated `sync` worker's statement runs on (WebKit 328618), so a rejected write may still land after `close()` resolved and a reopen at once may fail.

## How it is built (what the code will not say on its own)

- A client-wide `immediateAbort`, aborted with `closingError`, is merged into each call's signal: eagerly for `run`/`all`/`first` and the direct reads/writes, **lazily at the first `next()` for `chunk()`/`stream()`** — an eager merge left relay listeners behind for a generator created with a `signal` and never read (final review, 2026-11-13).
- The waits of `close()` are a pure factory (`src/close-waits.ts`, `createCloseWaits`, unit-tested with fake timers): `drainTimeout` when draining, the grace (`CLOSE_IMMEDIATE_GRACE_MS`, 300 ms; internal option `closeImmediateGrace` for tests) when immediate, a fresh grace when a draining close is escalated mid-wait.
- Whether a statement can be stopped comes from `BUILD_CAPABILITIES[build].interruptibleWithout`, not a hard-coded build test.
- `closing` is assigned before the body runs: `closeAbort.abort()` fires user listeners synchronously (a transaction's `signal`), and a `close()` from one used to start a second close.
- **`PoolWorker.terminate` must not return early once dead:** `handleDeath` calls it after `die()` already poisoned the worker, and it must still terminate the thread. A double terminate in `close` is avoided by re-checking the `cut` set instead.
- **A bulk load's `close()` rejects with `BULK_WRITE_FAILED` whose `cause` is `CLIENT_CLOSED`**, under the option as under the default close — kept so the default does not change, and the error carries `rowsWritten`.
- A `stream()` consumer can still receive rows of the chunk it was in, after `close()` resolved, then `CLIENT_CLOSED`; `chunk()`'s next `next()` rejects.

## How the tests prove it (no duration bet, `mem:follow-ups/time-based-tests`)

- `close-immediate.test.ts` hands the client `drainTimeout` (and, for the clean-close test, `closeImmediateGrace`) of an hour, and the statements to cut run 2 G iterations: a broken option fails the test by its timeout. No elapsed-time assertion.
- **A paused `chunk()`/`stream()` is ended by two mechanisms, each enough alone:** the abort reaches the signal its first `next()` merged, and the grace terminates the worker. Only both removed together turn those tests red (mutation, 2026-11-13).
- The single-terminate test: a draining `close()` with `drainTimeout: 200` reaches its wait for the worker's answer (`post:close` in the trace), then `close({ immediate: true })`; red with the `cut` re-check removed (two `terminate`). Escalation during that wait is otherwise covered by `close-waits.test.ts` (fake timers), a browser comparison there being a duration bet: `drainTimeout` bounds both waits.
