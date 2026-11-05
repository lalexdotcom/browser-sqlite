# Follow-up — the verdict's compile and wait are invisible in `db.debug` (2026-11-05)

**Status: OPEN** — found by `feat/debug-run-stage`'s final review; a spec change, the user's call. Part of `mem:follow-ups`; context in `mem:follow-ups/debug-run-stage`.

The first time a client sees a SQL text through `all()`, `run()`, `chunk()` or `stream()`, it compiles it to classify it (the verdict, memoised per SQL). The verdict takes its worker through `scheduler.acquire('verdict', …)` (`src/client.ts`), not through the instrumented acquire, and runs before the debug query record exists: its lease wait, the worker mutex and its compile are in no request and no query. The query that follows on the same worker then finds the statement cached: `prepared: 0`, no `preparing` stage; on another worker, `preparing` shows. `API.md` § Debugging states the consumer-visible fact since the branch.

Why it matters: the run stages were made for diagnosis (where a statement sat on a starved runner, the prepare included), and a reader of `stages` on a first call concludes the statement was cached, which is false.

Option (from the review): record the verdict's lease as a request of its own (e.g. `kind: 'verdict'`) with an `internal` query, so its wait and compile get stages. Not done: the spec's non-goals exclude the verdict path.
