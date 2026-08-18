
---

## Final Fix Report — 2026-08-18

### Finding 1 (Important): `write()` ignores AbortSignal

**File changed:** `src/queries.ts` — `writeWorker`

The `_options` parameter (underscore-prefixed, never read) was replaced with `options`, and signal-handling logic was added mirroring `chunk()` exactly:
1. Entry check: `if (signal?.aborted) throw signal.reason;` before any work.
2. `aborted` flag + `onAbort` listener registered before the loop.
3. `if (aborted) break;` at the top of each loop iteration.
4. `if (aborted) throw signal?.reason;` after the loop.
5. `signal?.removeEventListener('abort', onAbort);` in a `finally` block.

**Tests added** (`tests/browser/concurrency.test.ts`, describe `AbortSignal on write() (INT-11)`):
- `rejects and performs no write when the signal is already aborted` — pre-aborted signal hits the entry check; asserts no row written.
- `rejects when the signal is aborted after write() is called` — two writes issued synchronously, signal aborted before either `writeWorker` continuation runs; first write succeeds, second rejects; state verified as consistent.

**Confirmed failure without fix:** both tests failed (2 failures, 0 passes) when `writeWorker` was reverted to the broken version ignoring the signal.

---

### Finding 2 (Important): Scheduler test cannot catch the writer-designation regression

**File changed:** `tests/unit/scheduler.test.ts` — new describe block added.

**Test added** (`scheduler — add() writer-designation with multiple queued writes`):
- `second queued write waits for the first lease when two workers are added` — creates a scheduler with no workers, queues two `acquire('write')` calls, adds two workers synchronously, asserts the second write is NOT served immediately (it must wait for the first lease to release), and that it is ultimately served on worker 0 (the designated writer).

**Confirmed failure without fix:** the test was run with `currentWriterIndex = worker.index` commented out of `add()`; it failed with an `AssertionError` (`secondWriteIndex` was `1` instead of `undefined`, proving the second write ran concurrently on worker 1). All 95 other unit tests passed.

---

### Finding 3 (Minor): `chunk()` JSDoc advertises `id` option that the type rejects

**File changed:** `src/client.ts` — JSDoc for `chunk` on `SQLiteDB`

Removed `, and \`id\`` from the `@param options` description. The type `{ chunkSize?: number; signal?: AbortSignal }` is unchanged.

---

### Verification

```
pnpm check   → exit 0 (2 pre-existing warnings, no errors)
tsc --noEmit → exit 0
pnpm test    → 148 tests, 0 failures (145 baseline + 2 browser + 1 unit)
grep -rn "it.fails" tests/ → 0 results (comments only)
```
