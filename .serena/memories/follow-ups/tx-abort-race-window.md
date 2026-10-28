# Follow-up — an abort fired during a savepointed statement's post is missed

**Status: OPEN** — found 2026-10-28 by the fix wave of `feat/sqlite-routing`'s final review, confirmed by its re-review; predates the branch, not made more reachable by it.

Part of `mem:follow-ups`.

In `src/transaction.ts`, a statement with its own signal that runs savepointed checks `own.signal?.throwIfAborted()`, calls `start(via(true, mark), driving)`, and only then `makeAbortRace(own.signal)` (src/queries.ts). `makeAbortRace` subscribes to `'abort'` and never tests `signal.aborted`, so an abort that fires between the check and the subscription — i.e. synchronously inside `start()` — is never seen: the statement completes and resolves, and its write is kept instead of being undone by the savepoint.

**Reachability:** only an abort raised during `start()`'s synchronous run. No library path is known to do that; the fix wave's transaction test reached the window by aborting from inside the post and had to move its abort to `queueMicrotask` to test the intended path. So the exposure is narrow, but the guard is missing.

**Fix to weigh:** `makeAbortRace` rejects at once when `signal.aborted` is already true (it has other callers: src/transaction.ts and src/client.ts — check each one tolerates an already-rejected race), or subscribe before `start()`. A unit test aborting inside a stubbed `start()` falsifies it.
