# Follow-ups — the open backlog

One short entry each. Anything closed is deleted from here — `CHANGELOG.md` and `git log`
record what was fixed. Evidence and numbers live in `mem:measurements`; VFS behaviour in
`mem:vfs`.

**Triaged 2026-08-27 (user).** The 2026-08-26 proposal was applied: `COOP-1` and the wave-3
deferred minors deleted, `RESIDUE-1` folded into `DELETE-1`, `BENCH-DRIFT` reduced to its
live rule, `D6` and `VIT-1` closed on measurement. Verdict annotations are gone with it —
what is written here is the backlog, not a proposal about it.

## Designs owed

`ABORT-1` and `DELETE-1` are gone from here: both shipped on 2026-08-27 (merge
`a2c1b26`). What they left behind is below and in `mem:lessons`.

### A timed flush — out of rc.4 (user, 2026-08-27)

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost is to be measured, not deduced, if it is ever picked up.**

**`maxBufferBytes` is dropped, not deferred (user, 2026-08-27).** It was my
counter-proposal to the timer, never something the user asked for. The input buffer is
bounded in *values*, not bytes, so one TEXT column admits 32 766 rows and 10 KB blobs mean
327 MB held before the first flush — the case is real. It is not worth a per-row size
computation on the hot path for an abstraction the consumer can handle themselves:
`queueSize` is theirs to set, and a blob loader sets it small. The spec's §7 still
describes the idea as it stood that day; it is a dated record, not a live proposal.

## Limits to document rather than fix

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single
writer". Partly settled: `output()` **must** be multi-tab safe (user requirement) and its
staging sweep is `navigator.locks`-guarded. The rest of the client stays uncoordinated.

**To treat, in rc.4: one Known Limitations line describing what is true today** (user,
2026-08-27 — an earlier note in this file scoped it to rc.5 and that was a misreading).
rc.4 documents multi-tab as it stands; rc.5 studies whether to build or abandon it. The
README already says it twice in the read-your-own-writes section — "It is not guaranteed
across tabs" and "Nothing serializes writes between clients" — so the line restates rather
than reveals, and Known Limitations is where a reader looks for it.

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

### HANDLE-1 — the evidence was a flake, and the README stands

This entry claimed that "does not block the pool" is false off Chromium, on the strength of
`tests/browser/long-query.test.ts :: does not terminate the worker it abandoned, and does
not block the pool` failing on Firefox at 28-29.5 s against a 3 s budget.

**At n=3 on 2026-08-27 that test failed once and passed twice.** One run had been read as a
reproduction. The README's measured claim on the other side — that a long read does not
delay short reads on the other workers, about a millisecond on Firefox — is unopposed, and
no Known Limitations line is owed.

What is left is a flake at 1/3 with no mechanism, tracked above with `barrier`. The
underlying VFS fact is unchanged and documented already: on an engine without
`readwrite-unsafe`, a VFS rotating one exclusive OPFS handle cannot serve another worker
while a write transaction holds it. That is in the README, measured, and is not this.

### FLAKE-ROW-1 — `no-read-inside-transaction` is a race, not a verdict

The bench row flips between `pass` and `blocked` on the same VFS, engine and build between
runs an hour apart — and **in both directions within a single pair of runs**. Four WebKit
runs, 2026-08-25.

**The honest reading is that `blocked` is the expected state and `pass` is the lucky one.**
In reduced mode a VFS rotates one exclusive handle; whether a read is admitted before the
write transaction takes it is timing, not a property. `OPFSAdaptiveVFS`'s read-burst of
0.94–1.00× on every engine without `readwrite-unsafe` says the same from the other side.

**Consequence: no single run may be cited for this row.** The `OPFSCoopSyncVFS` Known
Limitations entry rests on it and currently reads as a determinism. It happens to be right
(blocked on 8 of 8 earlier runs) but needs **n≥3 per engine** before that wording is
defensible — and the same row cannot then be read as a verdict for `OPFSAdaptiveVFS`.

### Firefox: two flakes at 1/3, and what the deterministic failures really were

Measured 2026-08-27, three full runs of the browser project on Firefox
(`TEST_BROWSER=firefox pnpm test:browser`, the override added that day; Chromium stays the
default).

| test | 3 runs |
|---|---|
| `concurrency :: rejects a read that never got a worker` | fail, fail, fail |
| `lifecycle :: rejects the in-flight query on a deserialization failure` | fail, fail, fail |
| `long-query :: does not block the pool` | pass, **fail**, pass |
| `barrier :: does not repeat the barrier on a worker that is already current` | pass, pass, **fail** |

**The two deterministic failures were calibration, and are fixed.** Both tests ran a
recursive CTE sized on Chromium and then waited for it: 40 M iterations cost 58.9 s on
Firefox and 20 M cost 29.7 s, against a 30 s budget. Given 180 s both passed, and the two
durations are in exact proportion to their iteration counts — the cost was the query and
nothing else. `concurrency` now abandons its holder instead of awaiting it; `lifecycle`
asks for 2 M iterations instead of 20 M.

**What remains is two flakes at 1/3**, and neither is understood. `long-query` is the one
this backlog used to cite as a deterministic Firefox failure — it is not. `barrier` had
never been recorded anywhere.

**Firefox cannot be a CI gate until those two are understood.** Nothing measured so far
points at a defect in the library; both flakes are in tests that race an abandonment
against a worker, which is where the timing lives.

### BASELINE-1 — two residuals, both small

Locate `structuredClone`'s BCD entry and confirm it does not raise the floor; and check
`chrome_android` / `safari_ios` in `LIB_FLOOR` rather than inheriting their desktop engine
(the assumption is commented in `scripts/render-vfs-matrix.ts`). Everything else shipped in
`9af6b37`. **About fifteen minutes.**

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says supported
but gives no first version, the cell keeps `?` rather than adopting the library's number —
the true floor is at least that and may be higher.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome 86+, so a
pre-86 engine cannot run the six OPFS VFS at all. What was built instead is a classic ES5
script ahead of the module in the bench page that watches for the module having started
and, after 8 s, replaces the banner with what is missing. It tests for the module
*running*, not for syntax, so it also covers a failed `dist/` fetch. Falsified by blocking
that fetch, not reasoned about.

## Notes, with nothing to fix

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer. The export
half is closed (`de3abdf`); the probe half is closed; `HAS_UNSAFE_HANDLES` stays on the
page because it needs a worker and two access handles.

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

- ~~No prepared-statement cache~~ — **built on `feat/statement-cache` (2026-08-28), not yet
  merged.** What it leaves open is one number: its own section below.
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
- ~~Prefer the last writer for reads~~ — **shipped 2026-08-27** (`feat/last-writer-routing`),
  extended to new write designations as well. The routing works, proven as a barrier-statement
  count on both engines; no latency gain is measurable on either, and `mem:measurements` says
  why the timer is the wrong instrument for an effect this size.

## The statement cache's bound is in entries, and an entry can weigh megabytes

**Built on `feat/statement-cache` (2026-08-28), not yet merged.** The design is in
`docs/superpowers/specs/2026-08-27-statement-cache-design.md` and every number is in
`mem:measurements`; neither is repeated here. What is open is the bound.

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
