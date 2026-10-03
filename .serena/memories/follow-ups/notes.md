# Follow-ups — notes, with nothing to fix

Part of `mem:follow-ups`: what was examined and closed or kept on purpose, and what to do if it comes back.

### Two worker fallback messages carry the path — kept, 2026-10-03

`src/worker/worker.ts`'s open and delete fallbacks read `Failed to open ${file}` / `Failed to delete ${data.file}`, a path such as `.ad/name`, and `startupError` forwards it verbatim. They fire only when the chain throws something that is not an `Error`, and every `throw` in wa-sqlite's sources is an `Error`, a `SQLiteError` or a rethrown `Error`/`DOMException` (read, not measured). The path is the form `db.files` already makes public, and the thrown value travels in `cause`. Replacing the path with `String(error)` would be the only change worth making; no test can pin it without injecting a non-`Error` throw into the open chain.

### The barrier has no falsifier of ours — by decision, 2026-10-03

`barrier.test.ts` pins when and how the barrier is sent, and the worker's column-name capture: the staleness the barrier was first built for was our worker reading names before the first `step()` (spike 2026-09-25, `mem:history`). Nothing of ours fails when its effect is gone. That effect, data freshness on `OPFSWriteAheadVFS`, is real — 37 of 616 tests stale without it under sixteen busy loops, 0 with it (BARRIER-DATA, `mem:measurements`) — and is `PRAGMA wal_read_latest`, whose falsifier is wa-sqlite's deterministic test for #365. A timing falsifier of ours was not built: the old timing-only barrier read 0/100 even under 48 busy loops.

### rstest's pages are off-the-record — a measurement caveat (2026-09-28)

**rstest's pages are off-the-record: OPFS sync-access-handle calls cost 160-290 µs there against 0.6-2.6 µs on a persistent profile (RSTEST-OTR, `mem:measurements`, 2026-09-28).** rstest opens pages with Playwright's `browser.newContext()`. Every absolute OPFS timing taken under rstest — the checkpoint and page-size campaigns included — carries that per-call cost; only ratios between arms of one run compare. No persistent-context harness is planned (user, 2026-10-03).

### The open-side init lock is kept as defence (2026-10-03)

**The open-side init lock guards nothing a test sees (2026-09-28).** With `locks.withLock(initLockName…)` removed from the worker's `open()`, `pnpm test`'s three configs stay green; the delete side is guarded (`delete.test.ts`, BUSY while the lock is held). What it seemed to guard — a writing pragma at open against another client's write — was a defect of its own, fixed by running those pragmas through the write path (PRAGMA-BUSY, `mem:vfs`); since then the open applies only connection pragmas, and the lock serialises opens with nothing left to protect that a test has found. Kept anyway: removing it buys nothing measured; the delete side takes the same lock, so without it a deletion would no longer exclude an open in progress (read, not measured); and it gives `db.debug`'s `boot` its `waiting for the open lock` step, which the `open-retry` entry reads.

### What no test can see about the statement cache

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".

### `page_size` on `OPFSWriteAheadVFS` — not pursued, closed by the user on 2026-09-28

32 KiB pages made a bulk insert 3.25× faster on Chromium and 1.18× on Firefox (PAGE-SIZE, `mem:measurements`), but only that workload was measured. The user set the lever aside: no advice in the docs, no follow-up.

### wa-sqlite's `autoCheckpoint` treats any positive value as "after every transaction" — deliberate, closed by the user on 2026-09-28

`#autoCheckpoint()` (`WriteAhead.js`) tests `autoCheckpoint > 0` only. The author says so explicitly in a comment; the user keeps it that way. Do not propose it upstream again.

### #361's executor allocates per read and per write, not once per checkpoint — declined upstream, closed by the user on 2026-09-28

The single allocation was suggested in the reply to rhashimoto's review (2026-09-26). His answer: "Not necessary as far as I'm concerned. I don't care so much about achieving a strict memory cap, only that there is a way to tune memory usage up or down if needed" — which `checkpointBufferSize` gives. In the same comment he declined a tighter planner (unretired reads kept across writes) on complexity: "It can be a lot more complicated but it can't get that much faster." #361 merged without either. The user holds to his call.

### `pool-cap`'s surplus-slot flake — margin widened, never reproduced; closed by the user on 2026-09-27

**The test.** `tests/browser/pool-cap.test.ts :: a pool capped by its environment > a surplus slot that times out, then declines in the retry round, is not announced lost` — Firefox only (`CAPPED`, no `readwrite-unsafe`). It holds slot 1's round-1 `open` back so round 1 gives up on it, then lets the retry decline, and asserts no `onWorkerLost`, a pool of 1, no warning.

**The flake and its mechanism.** Seen under load as `Worker 1 did not become ready within 600 ms`: `openTimeout` is client-wide, so it also governs slot 0's HEALTHY worker, and it was that one that missed. Squeezed on an idle machine, slot 0 needs some tens of ms (10, 25, 50 ms fail; 100 ms passes). `2be2ae6` (2026-09-21) moved `openTimeout` 600 → 3000 (~10× → ~50×) and the held-back `open` 3000 → 15000.

**Why it is closed although the cure is not demonstrated.** The flake was never reproduced, before or after — 64 busy loops left both budgets green — and on 2026-09-27 it ran in all ten whole-config Firefox passes under sixteen busy loops without failing (REUSE-LOAD, `mem:measurements`).

**If it is seen again:**
- Keep the whole run log and note the engine and the message — `did not become ready` means slot 0 missed the shared budget again.
- **Do not scale the numbers a third time.** The next move is a budget of slot 0's own, which is a product change: `openTimeout` is one option for the whole client.

### `WORKER_BUSY` seen once on 2026-09-14, never reproduced — closed by the user on 2026-09-27

**The sighting.** `query-timeout.test.ts :: rejects with OPERATION_TIMEOUT and leaves the client usable` failed once in a pre-push `pnpm test` on a loaded machine, with "Worker 1 already has a query in flight" — the reuse guard, now `WORKER_BUSY` (`src/pool.ts`). The log was not kept. That test then ran on `MemoryVFS`'s default `sync` build, which cannot cut a statement without isolation, so the timed-out query kept its worker for its whole natural length (22 s on Firefox, 60 s loaded) while the follow-up read raced it; it has run on `async` with that read bounded since 2026-09-15 (CI-QUERY-TIMEOUT).

**Chased twice, in both contexts, 0 each** — one file under sixteen busy loops, 0 of 40, with a positive control proving the detection path (LEASE-QUIESCE, 2026-09-21); the whole Firefox config ten times under sixteen busy loops, 0 in 7 453 tests (REUSE-LOAD, 2026-09-27). Both in `mem:measurements`.

**If it is seen again:**
- **Keep the whole `pnpm test` log** and note the engine, the target project and the test.
- It was at the CLIENT level (`db.read` through the scheduler), so the transaction queue does not explain it. With transactions serialised the guard means one thing only: **the scheduler handed a lease for a worker that was not idle** — that is the sentence to test, starting from where the lease is returned (`quiesce()` in `onReadLease` and `streamWithRetry`, `src/client.ts`).
- Before trusting a reproduction, check it aborts the statement it names: a wait on "a worker is running" once let aborts land on the freshness barrier (`mem:lessons`, 2026-09-27).

### An abort through the shared slot reports `done`, not `error` — and that is right

The worker breaks out of its row loop rather than throwing, so the query ends with `done` and
the pool's `onServed` fires exactly as for a completed query. That looks like a
misclassification and is not one: `onServed`'s only effect is `slot.restarts = 0` in
`src/supervisor.ts`, and it means "this worker executed SQL and came back", which an
interrupted worker has just demonstrated. Withholding it would make the supervisor readier to
condemn a healthy worker. Raised by the final review of the query-interruption lot,
2026-09-05, and deliberately not changed.

### Twelve `any` remain in `src/`, and they are structural

The return type of the dynamic VFS and WASM imports inside their `satisfies`
constraints; the VFS instance, which upstream does not type (it declares only
`examples/tag.js`); `bulk.ts`'s `{ [K in KEYS]: any }` row shape, where `unknown`
breaks the `keys.map((k) => data[k])` indexing; and one overload dispatch in
`locks.ts`. Thirty-seven became twelve on 2026-08-31 and the remainder is not
worth chasing. **Re-count before citing this.**

**Kept deliberately, do not "clean up":** the no-op degradation branch in
`locks.ts`, unreachable in Node ≥ 21 and every current browser. Spec-mandated,
correct, zero maintenance.


### The library's floor is computed, not transcribed (2026-08-28)

`LIB_FLOOR` in `scripts/render-vfs-matrix.ts` is read from
`@mdn/browser-compat-data` (a devDependency) over a named list of the APIs the
published bundle uses, mobile columns from `chrome_android` / `safari_ios`
rather than inherited from desktop. The computed floors reproduced the
transcribed ones byte for byte, so the old numbers were right — they simply
could not stay right on their own. `bcdVersion` throws rather than guessing when
BCD gives `true` or `false` instead of a version.

**`FEATURE_SUPPORT`, right above it, is still transcribed by hand and cannot be
fully mechanised**: JSPI's `Safari: '27'` comes from a WebKit blog post, not from
BCD. Its "checked 2026-08-24" comment is load-bearing; do not delete it under the
impression that the file now reads everything from BCD.

**`structuredClone` was the trap.** It would have raised the floor from Chrome 92
to 98 — for an error *cause*. `cloneable()` now probes with `MessageChannel`
(Chrome 2, Firefox 41, Safari 5), which runs the same algorithm and throws the
same `DataCloneError`. The probe exists because a cause that cannot be cloned
makes `postMessage` throw *inside a catch block*, so the client receives no reply
at all and waits for ever. It lives in `src/worker/cloneable.ts` — pure, and
tested in Node, for the reason `statement-cache.ts` is.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome
86+, so a pre-86 engine cannot run the six OPFS VFS at all. What was built
instead is a classic ES5 script ahead of the module in the bench page that
watches for the module having started and, after 8 s, replaces the banner with
what is missing. It tests for the module *running*, not for syntax, so it also
covers a failed `dist/` fetch. Falsified by blocking that fetch, not reasoned
about.

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says
supported but gives no first version, the cell keeps `?` rather than adopting the
library's number — the true floor is at least that and may be higher.

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer.
`HAS_UNSAFE_HANDLES` stays on the page because it needs a worker and two access handles.

**The live rule: changing either copy obliges a review of the other, both directions.** The
page's row ids are normalized from the conformance `describe()` titles, so a row whose id
no longer maps to a `describe()` is the signal. Two places where the copies legitimately
differ and must **not** be aligned: the page returns `'blocked'` where invariant 6 logs a
`console.warn` and passes (a table has somewhere to render a third state, a suite does
not); and the page reopens the column's client after `survives-reopen` and `close-settles`,
because it runs every row against one client where the suite gets a fresh one per `it()`.
