# Follow-up — when a call's `timeout` starts counting

Part of `mem:follow-ups`, opened 2026-10-19 (user): "on va revoir ça dans un autre chantier". Found on `perf/stream-iterator`, whose `API.md` now states the facts as they are.

Today the `timeout` budget does not start at the same moment everywhere: from the call for the promise-returning methods (`read`, `write`, `first`, `transaction`, `bulkWrite`…) and for `tx.chunk()`/`tx.stream()` (their `withSignal` runs at the call); from the first `next()` for a client's `chunk()`/`stream()` (`withDeadline` runs inside `chunkRows`, which starts at the first `next()`). `API.md` § Interrupting a call and the JSDoc in `src/api.ts` say so since 2026-10-19; `src/utils.ts`'s `withDeadline` comment too. To decide in its own workstream: whether the two should be aligned (and which way — starting at the call costs a timer for a generator that is never read, and raises who releases it), and how a consumer should reason about it.
