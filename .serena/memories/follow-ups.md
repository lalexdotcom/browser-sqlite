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

### A timed flush, and the byte-bounded buffer behind it

Both raised on 2026-08-27 and kept out of the back-pressure spec, which records the full
argument in its §7. Short form: a timer's memory case is weak — the buffer is already
bounded at one batch — and it multiplies commits on exactly the slow-producer workload it
targets, each flush taking a write lease. What is real is that the buffer is bounded in
*values*, not bytes: one TEXT column admits 32 766 rows, so 10 KB blobs mean 327 MB held
before the first flush. **If either is ever built, `maxBufferBytes` is the one with a case,
and the timer's commit cost is to be measured, not deduced.**

## Limits to document rather than fix

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single
writer". Partly settled: `output()` **must** be multi-tab safe (user requirement) and its
staging sweep is `navigator.locks`-guarded. The rest of the client stays uncoordinated.

**Scoped to rc.5 (user, 2026-08-27): multi-tab is rc.5's subject, implemented or
abandoned, and its Known Limitations line goes with that decision.** The README already
says it twice in the read-your-own-writes section — "It is not guaranteed across tabs" and
"Nothing serializes writes between clients" — so nothing is currently unstated.

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

### HANDLE-1 — the backlog and the README contradict each other

**Do not write the Known Limitations line this entry used to ask for.** It would
contradict a measured claim already in the README, in the same file.

The README (§ the reduced-mode section, "A long *read* does not produce this effect") says
short reads on the other workers still return in about a millisecond on Firefox while a
long read runs, and records that an earlier revision claimed the broader form and that
measurement narrowed it. This entry claimed the opposite: that concurrent reads hold only
while no worker runs a long uninterruptible statement.

The evidence for this side is one test: `tests/browser/long-query.test.ts :: does not
terminate the worker it abandoned, and does not block the pool` fails on Firefox at
28-29.5 s against a 3 s budget, with `poolSize: 2` — a long read abandoned at 200 ms, then
a plain `SELECT 1` that should land on the other worker. The scheduler, the lease and
`quiesce()` were each checked and exonerated (statuses sampled without wrapping `Worker`,
so the race was not perturbed), and the failure was attributed to the exclusive-handle
rotation.

**What separates them is what nobody has measured:** whether it is the *abandonment* that
blocks — `interrupt()`, the generator's return path, `quiesce()` — rather than the long
statement itself, which the README's measurement says does not. Both readings fit the
evidence; only one can go in the README.

The two Firefox failures below block CI for the same reason. Measure before writing
anything.

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

### Two Firefox failures block wiring Firefox into CI

A browser cannot be a blocking gate while it is red.

- `long-query :: does not terminate the worker it abandoned` — this is HANDLE-1. Not a test
  defect; it needs a per-browser expectation.
- `lifecycle :: rejects the in-flight query on a deserialization failure` — times out at
  30 s. **Nobody has traced it.** Leading explanation is calibration: the test sleeps 100 ms
  then synthetically dispatches `messageerror`, betting the query is already in flight, and
  Firefox is 5.5× slower on the same CPU-bound query. Unverified.

Note the conformance suite already runs on both engines and is green on both; this is about
`pnpm test`'s browser project.

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

- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via three `declare module` deep
  imports. Not a one-liner — it touches how the worker compiles.
- 29 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` and
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

- **No prepared-statement cache** (`worker.ts`) — typically the largest single win (2-10×);
  worst for `bulkWrite`'s ~32k-placeholder template.
- **No default PRAGMAs** → consumers silently run `journal_mode=DELETE` + `synchronous=FULL`.
  Shipping WAL + NORMAL + `busy_timeout` is on the list for its own reasons — note that
  `busy_timeout` is also option A for CoopSync, with a risk to **measure, not deduce**:
  SQLite's busy handler sleeps, and in a synchronous VFS in a worker that may block the very
  thread that owes the handle release, converting a failure into a deadlock.
- `bulkWrite` flushes are separate transactions (~300 commits for 1M rows).
- **Every worker compiles its own WASM copy** (1.23 MB × `poolSize`).
  `WebAssembly.Module` is structured-cloneable — compile once, `postMessage` it.
- Per-row `Object.fromEntries(cols.map(...))` in the hottest loop.
- **The one read-side idea worth measuring (user, 2026-08-21): prefer the LAST WRITER for
  reads, then lowest index.** A `lastWriterIndex` used purely as a freshness hint — no
  exclusivity, no effect on who may write, correctness carried by the barrier alone.
  Distinct from the shape the user rejected in wave 3 (reads preferring the *designated*
  writer), which was a correctness crutch. The prelude census in `mem:measurements` says
  there is room to recover something on mixed loads.

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
