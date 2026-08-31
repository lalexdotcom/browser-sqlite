# Follow-ups — the open backlog

One short entry each, and every entry OPEN. Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

## Designs owed

### A timed flush — out of rc.4 (user, 2026-08-27)

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost is to be measured, not deduced, if it is ever picked up.**

## Limits to document rather than fix

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are **per client**, not per realm — `createScheduler`
runs once per `createSQLiteClient`. This entry said "per-realm" until 2026-08-28 and that
understated the limit: two clients in the *same tab* do not serialize their writes against
each other either. Only the commit epoch is realm-wide, so what one tab's clients share is
**visibility**, never exclusion. Partly settled: `output()` **must** be multi-tab safe (user
requirement) and its staging sweep is `navigator.locks`-guarded. The rest of the client
stays uncoordinated.

**What happens when two clients write at once — RUN on both engines, 2026-08-28.**
This entry claimed "the second writer fails immediately with `SQLITE_BUSY`, identical
between two clients and two tabs", from reading `WebLocksMixin.js` (`ifAvailable: true`,
so it never waits), the absence of any shipped PRAGMA registering a busy handler, and
`pool.ts` turning the code into `SQLiteError('BUSY')`. **That reading is Chromium only.**
Three tests written for it pass on Chromium and all three *hang* on Firefox.

**There are two regimes, and the discriminator is `readwrite-unsafe`, never the engine
name.**

- **With it** (Chromium): the second writer fails at once with `BUSY`. The source reading
  was right here.
- **Without it** (reduced mode — Firefox, Safari): the contention is settled one layer
  earlier, by the rotating exclusive OPFS handle, and the acquisition blocks in the
  scheduler *before an `AbortSignal` is consulted*. Web Locks are never reached, so
  `SQLITE_BUSY` never happens — **the second writer waits.** This is the mechanism the
  README's "Reduced mode" section already describes for a write; it had simply never been
  connected to this entry.

Two falsifiers were executed, and one corrected its own claim:

- `BEGIN IMMEDIATE` in `transaction.ts` makes B fail at the BEGIN rather than at the first
  write inside it. `BEGIN` being DEFERRED is therefore pinned — on Chromium. On a
  reduced-mode engine B's BEGIN can block on the file, so the test does not prove it there.
- `pragmas: { busy_timeout: '5000' }` does **not** turn the rejection into a success: B
  waits 5111 ms and still fails. A busy handler is caught by an elapsed-time budget, never
  by the error type — which matters, `busy_timeout` being on the performance list above.

The third shape is unaffected and holds: a `bulkWrite` interrupted mid-way leaves its
earlier batches committed and raises `SQLiteBulkWriteError` — a *partial* load, which is
not where a reader looks for a failure. The consumer's only remedy today is to retry, or
to use `tx.bulkWrite`, which shares one transaction across every batch and so leaves
nothing behind rather than half.

**The test trap, paid for once: A cannot hold the lock while awaiting B.** The first
version opened A's transaction and awaited B's attempt inside the callback. On an engine
where B waits, the two deadlock — the test presupposed the fail-fast behaviour it was
written to observe. Any rewrite needs a BOUNDED wait on B.

**To treat, in rc.4: one Known Limitations line describing what is true today** (user,
2026-08-27 — an earlier note in this file scoped it to rc.5 and that was a misreading).
rc.4 documents multi-tab as it stands; rc.5 studies whether to build or abandon it. The
README already says it twice in the read-your-own-writes section — "It is not guaranteed
across tabs" and "Nothing serializes writes between clients" — so the line restates rather
than reveals, and Known Limitations is where a reader looks for it.

**IN PROGRESS, paused 2026-08-28 mid-task. The user chose the thorough option, in these
words: the line describes BOTH regimes, discriminated by `readwrite-unsafe` and not by the
engine name, with tests pinning both.** Estimated ~1 h. The cheaper option — a line
claiming only what holds everywhere, that two writers never corrupt and never both succeed
— was offered and NOT taken; do not quietly fall back to it.

- `tests/browser/multi-client.test.ts` exists and is **uncommitted and untracked**. Three
  tests: BUSY on the second writer, `BEGIN` deferred, and the half-loaded `bulkWrite`.
  3/3 pass on Chromium, 3/3 hang on Firefox for the deadlock described above. It is a
  starting point, not a result — every test needs the bounded wait before it means
  anything off Chromium. **Do not commit it as it stands.** The pre-commit hook runs
  `pnpm test`, which is Chromium only, so it would sail through — and then turn the
  Firefox CI step red, the step that became a gate the same day.
- **The discriminator already exists: `HAS_UNSAFE_HANDLES` in
  `tests/conformance/helpers.ts`,** resolved at module load by opening two access handles
  on one file. Use it rather than writing a third probe or branching on the engine.
- My 45-minute estimate for this line was wrong because it assumed true the very claim we
  had just decided to verify. Do not re-estimate from the memory; re-estimate from what
  the tests do.

### REOPEN-1 — `OPFSWriteAheadVFS/sync :: survives-reopen`, a flake at n=3

| device | runs |
|---|---|
| macOS Safari 27.0 | `timeout` `pass` `pass` |
| iPadOS Safari 27.0 | `timeout` `pass` `pass` |
| macOS Safari 26.5.2 | `pass` `pass` |
| iOS Safari 26.6 | `pass` `pass` `pass` |
| macOS Chrome 150 | `pass` |

One occurrence in three runs on each of the two devices that showed it, all 2026-08-27.
**Opened as a defect on the strength of "reproduced on two devices", which was two devices
at one run each and distinguishes nothing.** Both timeouts fell on the first run of the day
on their device — recorded as an observation, not a hypothesis: macOS's second run passed
while its root was in all likelihood still dirty.

Not worth a mechanism at this rate. If it is ever chased, note the prior question:
`OPFSWriteAheadVFS` gives no concurrency on Safari (`mem:measurements`), so whether it
should be recommended there at all comes first.

## Evidence owed

### GATE-1 — what the readiness gate still rests on, after 2026-08-31

Three things the readiness gate rests on are reasoned rather than measured.

- **The tests force the wrong kind of failure.** The four covering the retry
  round point a worker at a missing URL, which is a *load* failure. None
  exercises handle starvation, the actual cause. They pin the orchestration,
  not the phenomenon.
- **The gate costs the SUM of the opens, not the slowest.** `bsq:init:<file>`
  is exclusive and origin-wide (`locks.ts`, `withLock`), held across
  `open_v2` *and* the PRAGMAs, so opens serialise across every worker, client
  and tab on that file. Measured at `poolSize: 2` (70-105 ms per worker) and at
  `poolSize: 4` (**~15 ms of added first-query latency**, both engines).
  Nobody has measured 8.
- **The retry round multiplies the worst case**: up to two `openTimeout`,
  ~60 s by default, before the first query on a pool that will never open.

### FLAKE-ROW-1 — only the WebKit flip is left, and it is not reachable here

`no-read-inside-transaction` flipped in both directions on three VFS during the
four-device Apple campaign of 2026-08-27. Measured at n=3 per engine on
2026-08-31 it does not flip at all, so the `OPFSCoopSyncVFS` Known Limitations
wording that rested on it is defensible; the table is in `mem:measurements`.

What is left is the flip itself, on WebKit. Linux WebKit exposes no
`navigator.storage`, so no VFS this library ships runs there and the platform
cannot be reached from this container — it needs the user's Apple hardware, and
their machine is now macOS Safari 26.6.2, which makes the 2026-08-27 campaign a
stale baseline rather than a comparison. **It gates no published sentence**, so
it is curiosity rather than evidence owed.

## Notes, with nothing to fix

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

## Small and cheap

### W-types — one item, not three

`SQLiteDB` is hand-written rather than derived from the implementation. It is no longer a
*duplicate* of anything: it and `SQLiteTransactionDB` share `SQLiteQueryAPI`, and a
bidirectional compile-time pin fails the build if they drift.

### Two things called cleanups that are projects

- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types — 14 `declare module` blocks, not
  the three this entry claimed until 2026-08-27. Not a one-liner — it touches how the worker compiles.
- 32 `any` in `src/` (29 before back-pressure — the count drifts, do not cite it without
  re-counting); `tsconfig` could enable `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.

**Kept deliberately, do not "clean up":** the no-op degradation branch in `locks.ts`,
unreachable in Node ≥ 21 and every current browser. Spec-mandated, correct, zero
maintenance.

**The hygiene note this list earned.** Five entries were found already done and unmarked in
one session — VFS-COV, COOP-1's README half, `SQLiteVFS`'s export, six of nine cleanups,
and message-union exhaustiveness. The backlog was appended to and never retired, so its
length stopped meaning anything. **Verify an item against the source before scheduling work
on it**, and delete it the moment it is done rather than leaving it to be rediscovered.

## Performance backlog — after correctness, none blocking

- **No default PRAGMAs** → consumers silently run `journal_mode=DELETE` + `synchronous=FULL`.
  Shipping WAL + NORMAL + `busy_timeout` is on the list for its own reasons — note that
  `busy_timeout` is also option A for CoopSync, with a risk to **measure, not deduce**:
  SQLite's busy handler sleeps, and in a synchronous VFS in a worker that may block the very
  thread that owes the handle release, converting a failure into a deadlock.
- `bulkWrite` flushes are separate transactions (~300 commits for 1M rows). **Priced on
  2026-08-28**, as a by-product of the statement-cache campaign: ~3.4 ms per commit on
  Chromium/sync and ~5.3 ms on Chromium/async, from the gap between `bulkWrite` and
  `tx.bulkWrite` (`mem:measurements`). No longer a guess — it is what a consumer buys back by
  wrapping a bulk load in a transaction.
- **Every worker compiles its own WASM copy** (1.23 MB × `poolSize`).
  `WebAssembly.Module` is structured-cloneable — compile once, `postMessage` it.
- Per-row `Object.fromEntries(cols.map(...))` in the hottest loop.
## The statement cache's bound is in entries, and an entry can weigh megabytes

The design is in `docs/superpowers/specs/2026-08-27-statement-cache-design.md`
and every number is in `mem:measurements`; neither is repeated here. What is open
is the bound.

`DEFAULT_STATEMENT_CACHE_SIZE = 32` (`client.ts`) counts **entries**. That number was picked
before anything had been weighed. It has been weighed since: the two INSERT templates one
`bulkWrite` retains come to **3.06 MB together**, and there is one cache per worker,
multiplied by `poolSize`.

**The case the measurement did not cover.** One `bulkWrite` is fine. An application writing
to four tables of different widths produces eight distinct templates — order of 24 MB per
worker, ~100 MB at `poolSize: 4`. The whole-branch review called 32 entries safe and was
right about the case in front of it; that case was one table.

So moving the eviction criterion to a byte budget fed by `sqlite3_stmt_status(stmt, 99, 0)`
is **not an optimisation, it is the answer to a memory risk**. The change is confined to the
pure module — eviction is all it decides. Do not expect help from `_sqlite3_memory_used()`:
this build sets `SQLITE_DEFAULT_MEMSTATUS=0` and it returns 0.

**A smaller effect to know before touching this:** SQL generated per call fills the LRU with
single-use entries. The bound stops the growth, not the churn, and every eviction is a
`finalize` on the hot path. Nobody has profiled it.

## Three things about the statement cache that no test can see

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".

**An abandoned statement's read transaction is unobservable.** `settle` resets the statement
on every non-error exit, and the reset is what ends its implicit read transaction. That an
aborted query leaves its statement cached and reusable **is** tested, with a verified
falsifier. That it leaves no read transaction open is not. With the reset removed, a second
client writing the same file still succeeds and a later read still observes it — in
`journal_mode=DELETE` and in WAL. Either the statement had already reached `SQLITE_DONE`
before the abort landed, or the lock goes back on some other path; nobody has established
which. **The prior question, if this is ever chased:** can the abort be made to land strictly
inside a `step()` that has not yet returned `DONE`? Until that is answerable, no assertion
here can discriminate.

**The one-query-per-worker invariant became load-bearing.** The cache needs no lock because a
worker holds one lease at a time. Before the cache, breaking that would have produced
confusing behaviour; now it is a `reset` on a statement another query is stepping. Nothing at
the place where someone would break it says so.

## Read before designing anything cross-tab (user, 2026-08-28)

**`https://github.com/rhashimoto/wa-sqlite/discussions/81`** — the user wants this
discussion examined as part of multi-tab / multi-client handling. **Nobody here has read it
yet**, so nothing in these memories reflects it and no claim below is informed by it. Read
it before the Web-Locks-as-registry lead underneath, and before `W-multitab`'s Known
Limitations line is written: it is upstream's own thread on the problem, and this project
has twice built on a premise it could have sourced instead.

## A cross-tab lead, recorded unverified

**Web Locks as a registry, not as mutual exclusion.** Preferred over `BroadcastChannel`,
which loses the race on a message still in flight. Shape: a tab holds
`bsq:epoch:<file>:<n>`, takes `n+1` and releases `n` at commit, and other tabs read the
epoch as the max of the held names via `navigator.locks.query()` — the same "lock as
liveness marker" pattern `stagingLockName` already uses. It is *state*, not *delivery*, so
there is no in-flight window.

**The measurement that settles it:** the cost of `navigator.locks.query()` per acquisition
against the one worker round-trip it avoids. `query()` returns every lock held in the
origin and is specified as a diagnostic snapshot. If it is not clearly cheaper, the
cross-tab answer is the unconditional prelude, probably opt-in, not this. **Do not treat
this as promising until that number exists** — that is exactly how `PRAGMA data_version`
and the WAL VFS each cost a session.
