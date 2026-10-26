# Follow-up — A worker's JS exception reaches the caller with no `SQLiteError` code — not designed (user, 2026-10-15)

**Status: CLOSED** — done on `fix/tx-api-consistency` (2026-10-26): the user chose a dedicated code, `WORKER_ERROR`, the exception as `cause`, no `sqliteCode`.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`statementError` (`src/pool.ts`) turns a query failure that SQLite did not report — a JS exception in the worker — into a plain `Error` ("as before"): the caller gets no `code` to branch on. Seen as `undefined: No modification allowed` (`mem:follow-ups/held-handle-lock-order`). Fixing that case's cause (the CoopSync retry) removes that instance, not the class. To decide: wrap such failures in a `SQLiteError` (`WORKER_CRASHED`, or a dedicated code) with the original as `cause`. Consumer-visible (CHANGELOG, `API.md`'s error codes).
