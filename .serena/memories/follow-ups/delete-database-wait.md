# Follow-up — `deleteDatabase` waits for an open in progress instead of refusing with BUSY (user, 2026-11-03)

**Status: OPEN** — not designed; idea of the user, 2026-11-03.

Part of `mem:follow-ups`, opened 2026-11-03 while fixing `verdict.test.ts`'s cleanup on the macOS 26 matrix (`test/macos26-flakes`).

**The gap.** `deleteDatabase` takes the connection lock, then the open lock (`bsq:init:<vfs>:<path>`), both with `ifAvailable` (`src/delete.ts`), and refuses with `BUSY` ("is being opened or deleted elsewhere. Try again in a moment.") when an open is in progress. `API.md` documents that `BUSY` as transient, to retry. A caller deleting right after `close()` can meet it: a worker the client restarted and `close()` then terminated can hold the open lock a moment longer — Chrome on GitHub's macOS 26 runner did, in the tests' cleanup (first macOS matrix, run 41629313260, `chrome · AccessHandlePoolVFS/async`). The tests' `cleanUp` now waits for that lock itself (`navigator.locks.request` on the open lock, bounded by `scaled(10 s)`), proven by `tests/browser/pairs/cleanup.test.ts`.

**The user's idea:** an option of `deleteDatabase` saying whether to wait, off by default (first phrased as `maxRetries`, default 0).

**Leaning (Claude, 2026-11-03, not decided):** wait for the lock's release rather than retry on a timer — the browser grants the lock the moment it is released — as an option such as `wait: true`, bounded by `timeout`/`signal`, default unchanged. **Deadlock constraint:** `delete.ts` takes both locks with `ifAvailable` precisely so that it can never deadlock with a client opening (which takes the connection lock, then the open lock); a waiting variant must wait on the open lock BEFORE taking the connection lock, never hold one while blocking on the other. A user-visible API addition: CHANGELOG `Added`, `API.md`.

**A `timeout` option too (2026-11-05):** `deleteDatabase`'s own bound is `DELETE_TIMEOUT = 30_000` in `src/delete.ts`, with no option; the tests stretch a client's open timeout under `BSQ_TIME_SCALE` (`tests/browser/helpers/library.ts`) but cannot stretch this one, and `failed-client` "lets the database be deleted, before close" went red on it on Windows Firefox (run 41875605671). A `timeout` (the pendant of `openTimeout`) fits the same design; `mem:follow-ups/false-greens-remaining`.
