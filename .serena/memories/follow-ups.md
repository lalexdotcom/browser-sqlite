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

### DELETE-TIMEOUT-1 — `deleteDatabase` expires on two VFS off Chromium

Measured 2026-08-27, six devices, one run each. `deleted-is-gone` reports
`timeout` on **`OPFSWriteAheadVFS`** (macOS Safari 26.5.2 `sync`, iPadOS 27.0
`jspi`, Firefox 154 `sync` and `async`) and on **`OPFSCoopSyncVFS`** (macOS
Safari 27.0 and Firefox 154, both `async`). **Never on Chromium, never on iOS
26.6.** Counts in `mem:measurements`.

Both are the VFS that rotate one exclusive OPFS access handle where there is no
`readwrite-unsafe` — so this is `HANDLE-1` reaching the delete path, not a
defect of the deletion itself. It is a timeout, never a false success.

**Owed before a release: one Known Limitations line.** It is the honest half of
what the campaign found, and rc.4 would otherwise ship a method with a measured
limit nobody wrote down. n=1 per device, so cite it as an observation until a
second campaign says otherwise.

## Limits to document rather than fix

### HANDLE-1 — a long statement serializes the pool off Chromium

Root cause established 2026-08-24; **no remedy exists at our layer**. Full account in
`mem:vfs`. The public consequence: *"does not block the pool"* is false off Chromium.
Concurrent reads hold on Firefox only while no worker is running a long uninterruptible
statement.

`tests/browser/long-query.test.ts :: does not terminate the worker it abandoned, and does
not block the pool` fails on Firefox at 28-29.5 s against a 3 s budget. The scheduler, the
lease and `quiesce()` were each checked and exonerated — statuses sampled without wrapping
`Worker`, so the race was not perturbed.

**To treat:** write it into Known Limitations (today only `OPFSCoopSyncVFS` has an entry
covering this shape), then delete this item.

### W-multitab — multi-tab is entirely uncoordinated

`currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single
writer". Partly settled: `output()` **must** be multi-tab safe (user requirement) and its
staging sweep is `navigator.locks`-guarded. The rest of the client stays uncoordinated.

**To treat:** one line in Known Limitations saying so, before 1.0.

### `OPFSWriteAheadVFS`'s `requires` is wrong — measured 2026-08-27

It declares `requires: ['opfs', 'readwrite-unsafe']`, and `mem:vfs` said that off Chromium
"the second connection cannot take the handle, and the pool breaks with no error naming the
cause". **Both are false.** Forced onto Firefox with `HAS_UNSAFE_HANDLES=false`, the VFS
passes all three build pairs and all six invariants — including invariant 3, concurrent
writes — at `poolSize` 1, 2 and 4. The mechanism was inferred and never executed.

**Why nobody saw it: the declaration and the skip confirmed each other.** `requires` caused
the conformance skip, and the skip prevented `requires` from ever being falsified. Nine
pairs skipped themselves on the strength of their own declaration.

**There was never a guard to design.** `missingFeature` skips `UNPROBEABLE` features, so
`requires: ['readwrite-unsafe']` has never blocked anything at construction on any engine.
The long-running "accept it, or design an async probe?" question was about a defence that
did not exist.

**The fix is `requires: ['opfs']` with `degradesWithout: ['readwrite-unsafe']`** — the
shape `OPFSAdaptiveVFS` already uses. It changes no runtime behaviour, un-skips nine
conformance entries, and changes the generated README row.

**Do not simply delete the README warning.** Firefox is one engine; WebKit is where OPFS
diverges (ANYCONTEXT-1 was a WebKit-only bug in this exact area) and cannot be tested here,
Linux WebKit having no OPFS at all. Narrow the entry from "does not work off Chromium" to
"not measured on Safari", and add this VFS to the owed Safari 27 / iOS 26 / iPadOS 27
campaign. The degradation itself is also unmeasured — the read-burst ratio would say
whether it degrades like `OPFSAdaptiveVFS` or not at all.

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
