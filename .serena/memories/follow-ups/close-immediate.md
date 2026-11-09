# Follow-up — an option for `close()` that interrupts everything at once

**Status: OPEN** — 2026-11-09 (user): "il faut prévoir une option pour close qui interrompe tout immédiatement". Not designed.

Part of `mem:follow-ups`, opened 2026-11-09 from a question of the user: does `close()` stop the queries in flight cleanly?

## What `close()` does today (read in `src/client.ts`, `createSQLiteClient/close`, 2026-11-09)

- Queued work and pending write-lock requests reject at once with `CLIENT_CLOSED` (`scheduler.shutdown`, `closeAbort`).
- A transaction is abandoned through `closeSignal` (`src/transaction.ts`, merged with its deadline): it rejects with `CLIENT_CLOSED`, its statements in flight see the abort, the origin's write lock is given back.
- **A plain query in flight (`run`/`all`/`first`…) is not interrupted: it is drained**, bounded by `drainTimeout` (60 s by default), then each worker is closed (bounded the same way) and terminated.
- Not checked: a `stream()`/`chunk()` being consumed when `close()` comes.

## The idea

An option (name and shape not decided) under which `close()` also interrupts the statements in flight instead of waiting for them, then closes and terminates the workers. What to settle when designing it:

- where a statement can be stopped: the abort slot under cross-origin isolation, the `jspi`/`async` builds; the `sync` build without isolation cannot stop a running statement (`API.md`, § Interrupting a call) — terminate then is the only way, and on Safari a terminated worker's WASM keeps running (WebKit 328618, `mem:follow-ups/safari-suite`);
- what the interrupted calls reject with (`CLIENT_CLOSED` like the queued ones, or the abort's reason);
- whether `drainTimeout` still bounds anything under the option;
- the current release allows fine-tuning of the existing API, not a big feature (`mem:follow-ups`, user 2026-11-06): to weigh when scheduling it.
