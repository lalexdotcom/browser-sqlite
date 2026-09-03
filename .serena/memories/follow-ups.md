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

## Designs owed — ideas, not scheduled work (user, 2026-09-03)

**The user has said explicitly that the three below are not planned for the short or medium
term — they are ideas.** Keep them, do not present them as pending rc.5 scope, and do not
propose them as "the next thing" the way this file's older framing invited.


### A real watcher on a database's clients — deferred by the user, 2026-09-03

Database inspection ships as a one-shot snapshot the consumer polls. The user asked for a
watcher during the brainstorm, then withdrew the word deliberately: *"ce sera une autre
fonctionnalité"*. **The measurement that makes it cheap is already banked** —
`navigator.locks.query()` is `≈ 0.032 ms + 0.00038 ms × n` on Chromium, so polling at
300-500 ms costs 0.14-0.23 ms of main thread per second and takes no lock, no worker round
trip and no queue.

**What it cannot be built on, and this is the whole design constraint:** Web Locks has NO
change notification. An emitter fed from the registry can only poll internally — which
moves the polling under the hood and makes it permanent, charging every client for an
observability most never read. That is why the shipped API is on-demand. A genuine push
mechanism needs a second channel (a `BroadcastChannel` hello/bye reconciled against
`query()` for tabs that were killed without saying goodbye), and that channel is the cost
to weigh, not the query.

**Two smaller emitters may be the better shape than "watch the count"** — the question a
consumer actually has is usually "a tab left" or "the database is free now", and the second
is nearly free already: waiting on `bsq:conn` exclusively IS the event "nobody left".

### One compiled `WebAssembly.Module` for the pool — the premise it waited on is dead

Every worker compiles its own copy of the 1.23 MB binary. Sharing one is verified and
priced in `mem:measurements`: the clone is free and arrives usable, but it buys ~2 ms on
Chromium, which overlaps those compiles anyway, and ~8 ms at the default `poolSize` on
Firefox, which does not.

It was carried on the premise that whatever solved multi-tab would improve those numbers —
a coordinator compiles once per **origin** rather than once per client. **That premise is
gone:** rc.5's cross-tab design has no coordinator and cannot have one, because a
SharedWorker cannot open a connection on the four VFS that matter (`mem:state`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

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

## Defects to fix (2026-09-03)

### BENCH-SWEEP — the page hangs on `cleaning…`, because the sweep has no deadline

**Symptom, seen on iPadOS Safari 27.0.** Clicking `Re-start` after a completed run leaves the
page on `cleaning…` for ever. It never starts, never reports, never times out. Reloading is
the only way out — and that reload is what produced the second failure below.

**Where.** `sweepBeforeRun()` in `scripts/bench/html/index.html`, awaited at the top of the
run's `try`, right after `status.textContent = 'cleaning…'`.

**Why the guards that ARE there do not help.** The sweep anticipates exceptions and handles
them well: the OPFS branch catches per entry (`removeEntry` → *"Still held; a later run will
try again"*) and catches the whole iteration, and `deleteIdb` resolves on `onblocked` instead
of waiting. **None of that defends against a promise that never settles.** On Safari,
`root.removeEntry(name, { recursive: true })` against a file whose access handle is still live
does not reject — it waits. `for await (const name of root.keys())` can do the same. And that
is exactly the state of the OPFS root immediately after a run that exercised the OPFS VFS.

**What the hang then cost, which is why the whole chain is written here.** The reload never
calls `close()`, so the previous page's IndexedDB connection was still held; the next two runs
failed at `IDBBatchAtomicVFS :: opens` with `Worker 1 did not become ready within 30000 ms`
and all eight rows of that column fell to `not-run`. Against 20 clean rc.3 exports this read
as an rc.5 regression and **is not** — those 20 never had a mid-session reload. Do not re-open
that hypothesis; `mem:measurements` records it as a closed false lead.

**The fix, three parts, and the second is not optional.**

1. **A deadline around the sweep**, OPFS side and IndexedDB side. On expiry, continue the run
   instead of blocking it: a floor that could not be established is worth reporting, not worth
   waiting for indefinitely.
2. **Say that it was partial** — in the page and in the export. A partial sweep changes what
   the measurements are worth, and a silent partial sweep is worse than the hang, which at
   least announced itself. The page already has a badge of this kind for a neighbouring case
   (*"OPFS cleanup limited — this browser will not …"*).
3. **The export carries no build ref.** `lib` is `package.json`'s version, identical on `/`
   and `/preview/` for as long as no bump has happened, so an export taken from a preview
   cannot be told from one taken from the release. That came up for real on 2026-09-03 and had
   to be answered from the user's memory. The page already computes `IS_RELEASE` and
   `BUILD_REF`; two top-level fields close it.

**Worth folding in while the file is open**, because it is the same page and the same session:
the page cannot report whether the OPFS root was empty when a run started (`mem:state`,
Unmeasured ground). A run that inventoried the root in its export would close that too — and it
is the same inventory the sweep already walks.

The user has said they want to retouch this page anyway; this is the list to bring.

### OPEN-TIMEOUT names a cause that is often false, and the roster can now tell

**The message.** `src/client.ts:1139` — on `openTimeout` expiry a slot fails with

> `Worker N did not become ready within 30000 ms. The database may be held under an
> exclusive lock by another tab or another client.`

**It is misleading in the case that actually happens.** Observed 2026-09-03 on iPadOS Safari
27: a page was RELOADED without `close()`, the previous context's IndexedDB connection was
still held, and the next page's opens burned their full 30 s. No other tab, no other client —
the holder was a dead context. A user reading that message goes looking for a second tab that
does not exist. The README now documents the trap under `client.close`; the error still points
the wrong way.

**The discriminator exists since rc.5 and did not before.** Every live client holds
`bsq:client:<ns>:<file>:…`, and `inspectWith` reads the roster from one
`navigator.locks.query()`. So on a timeout: **clients in the roster → the current message is
right**; **roster empty → no client of this library holds it, and a dead context is the likely
cause.** One `entries()` call on a path that is already failing.

**Three things to get right, and the third is the one that would make it a lie in turn.**

1. It must not make the failure worse: no throw, no hang, and a fall back to today's message
   if Web Locks is unavailable, if `sharesStorage` is false, or if the lookup fails at all.
2. It runs while the pool is half-open. Whatever it does must not touch the pool or the init
   lock.
3. **An empty roster does NOT mean nobody holds the database.** It means no client of THIS
   library does. Another library, another origin's tooling, or native code is invisible to
   it — the README's Known Limitations already says so in those words. The message must say
   "no client of this library", never "nobody".

Small, self-contained, and it turns a 30-second wait that misdirects into one that names the
likely cause.

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
