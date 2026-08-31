# Follow-ups — the open backlog

One short entry each, and every entry OPEN. Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## Designs owed — rc.5 or later

### W-multitab — uncoordinated by design, and rc.5 decides whether it stays that way

`currentWriterIndex` and both queues are **per client**, not per realm —
`createScheduler` runs once per `createSQLiteClient` — so two clients in the
*same tab* do not serialize their writes against each other either. Only the
commit epoch is realm-wide: what clients share is **visibility**, never
exclusion. One part is already coordinated, because the user required it:
`output()` is multi-tab safe, its staging sweep `navigator.locks`-guarded.

**rc.5 studies whether to build or abandon it, and multi-CLIENT comes with it**
(user, 2026-08-31): a second tab is a second client that cannot be reached
through a module-level channel, so anything that coordinates tabs coordinates
clients by construction. Solving one is solving both; the reverse is not true.

What rc.4 owed — a Known Limitations line describing what is true today — is
written, and `tests/browser/multi-client.test.ts` pins it on both regimes. Read
those two before designing anything: they carry the behaviour, the falsifiers,
and the deadlock the first version of the tests walked into. Nothing about it is
repeated here.

**One compiled `WebAssembly.Module` for the pool rides on whatever rc.5 builds
(user, 2026-08-31).** Every worker compiles its own copy of the 1.23 MB binary
today. Sharing one is verified and priced in `mem:measurements`: the clone is
free and arrives usable, but it buys ~2 ms on Chromium, which overlaps those
compiles anyway, and ~8 ms at the default `poolSize` on Firefox, which does not.
Too little to justify infrastructure by itself — and better than measured if a
coordinator appears, since a coordinator compiles once per **origin** rather than
once per client, so the second tab gains and not only the second worker.

**A SharedWorker cannot be the pool, only a coordinator.** Upstream's context
column (`mem:vfs`) reads `Worker`, not `All`, for `OPFSAdaptiveVFS`,
`OPFSCoopSyncVFS`, `OPFSWriteAheadVFS` and `AccessHandlePoolVFS` — the
`createSyncAccessHandle()` restriction. It can compile, arbitrate and hold a
registry; it cannot open a connection on the four VFS that matter, the
recommended default included. **That rc.5 will want one is a premise, not a
finding:** the lead these memories carry is Web Locks as a registry, and the
discussion below is still unread.

### Read before designing anything cross-tab (user, 2026-08-28)

**`https://github.com/rhashimoto/wa-sqlite/discussions/81`** — the user wants this
discussion examined as part of multi-tab / multi-client handling. **Nobody here has read it
yet**, so nothing in these memories reflects it and no claim below is informed by it. Read
it before the Web-Locks-as-registry lead underneath, and before any cross-tab design: it
is upstream's own thread on the problem, and this project has twice built on a premise it
could have sourced instead.

### A cross-tab lead, recorded unverified

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

### CoopSync turns a protocol step into a failure — `busy_timeout` is option A

`OPFSCoopSyncVFS`'s `jLock` returns `SQLITE_BUSY` while a handle request is in flight and
expects a retry; no `busy_timeout` is applied anywhere, so the library surfaces a step of
the VFS's own transfer protocol as a user-visible error (`mem:vfs`).

**The risk to measure, not deduce:** SQLite's busy handler sleeps, and in a synchronous
VFS inside a worker it may block the very thread that owes the handle release — turning a
failure into a deadlock.

### A timed flush — out of rc.4 (user, 2026-08-27)

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost the argument turns on is measured**: ~3.4 ms on Chromium/sync and ~5.3 ms on
Chromium/async (`mem:measurements`). That price is what a timer would pay per flush on a
trickle, and it is no longer a deduction.

## Evidence owed

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

### GATE-1 — what the readiness gate still rests on, after 2026-08-31

Three things the readiness gate rests on are reasoned rather than measured.

- **The tests force the wrong kind of failure.** The four covering the retry
  round point a worker at a missing URL, which is a *load* failure. None
  exercises handle starvation, the actual cause. They pin the orchestration,
  not the phenomenon.
- **The gate costs the SUM of the opens, not the slowest**, and nobody has
  measured `poolSize: 8`. `bsq:init:<file>` is exclusive and origin-wide
  (`locks.ts`, `withLock`), held across `open_v2` *and* the PRAGMAs, so opens
  serialise across every worker, client and tab on that file. 2 and 4 are
  measured (`mem:measurements`); the shape above 4 is the open part.
- **The retry round multiplies the worst case**: up to two `openTimeout`,
  ~60 s by default, before the first query on a pool that will never open.

## Notes, with nothing to fix

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
