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

### Counting live clients on a database, and the `debug` surface it belongs on (user, 2026-09-02)

**Deferred deliberately to its own session, with the measurement already banked.** Once every
client holds `bsq:conn:<ns>:<file>` for its lifetime (see DELETE-LIVE below), the count falls out
of `navigator.locks.query()` — measured 2026-09-02, both engines: **one entry per shared holder**,
N holds give N entries. `mem:measurements` carries it, so this needs no re-measurement to start.

**The trap is `clientId`.** It is realm-scoped, not hold-scoped: `entries.length` is the number of
*clients*, the count of distinct `clientId` is the number of *tabs*, and swapping them undercounts
or overcounts in silence.

The user wants this to travel with the adaptation of the `debug` mode rather than alone. The
product questions it opens: clients or tabs or both; on `db.debug` or a standalone function
(counting clients on a database you have not opened cannot start from a client); and what is
promised, given `query()` is a snapshot that is stale the instant it is read — observability, never
a basis for a decision, since exclusion is the lock's job and not the count's.

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

### `IDBBatchAtomicVFS`'s batch-atomic mode is undocumented, and a memory claimed otherwise

Upstream makes the cache size **a requirement for triggering batch atomic mode**, not a tuning
knob: without a cache large enough to hold the journal the VFS silently takes its slower path.
Measured 2026-09-02: the default `cache_size` does miss it on a 5000-page transaction, on both
engines, and raising the bound costs **zero bytes** until a workload uses it.

**Nothing in the README says any of this.** `mem:vfs` asserted it was "a documented
recommendation" and that was simply false — the table mentions `PRAGMA cache_size` for every
VFS as a footprint bound, and nowhere ties it to this VFS's mode.

What it needs is one line for consumers, in the README's voice: on `IDBBatchAtomicVFS`, a
`cache_size` large enough to hold a transaction's pages is what keeps it in batch-atomic mode.
**Not a default** — the measurement found no time saved by raising it, so this is information,
not a recommendation to act on blindly.

### npm trusted publishing — it would remove the secret, but not all of it

<https://docs.npmjs.com/trusted-publishers>. npm trusts GitHub Actions over OIDC
instead of a stored secret: the runner gets a short-lived token signed for one
named workflow, verified against a trusted publisher declared per package. **The
motivation is not tidiness — it is that `NPM_TOKEN` expired unnoticed and failed
the first rc.4 attempt**, after the GitHub Release had already been created.

**What is already satisfied**, checked 2026-08-31: cloud-hosted runner
(`ubuntu-latest`); npm ≥ 11.5.1 and Node ≥ 22.14.0 (the action takes
`node-version: lts/*`); and `repository.url` matching the repository exactly,
which npm requires. **Missing: `id-token: write`** — the `release` job declares
only `contents: write`.

**What blocks a clean adoption, and it is the whole question:** OIDC covers
`npm publish` and nothing else. `npm dist-tag add` explicitly still needs
traditional authentication, and the action runs it twice, for `latest` and for
`next`. So trusted publishing shrinks the token here rather than removing it,
unless the dist-tags are posted differently. Three shapes, and the choice is a
product one: keep a granular token for the dist-tags alone; publish directly
under the wanted tag and drop the triplet; or wait for a stable 1.0.0, after
which the action stops adding `latest` to prereleases by itself — today's
`rc`/`next`/`latest` triplet is an artefact of no stable existing yet.

**One thing to verify rather than assume:** the docs record a validation
mismatch for `workflow_call` reusable workflows. Our publish runs inside a
**composite** action, which executes in the calling job, so the claim should
carry `release-and-publish.yaml` — adjacent to a documented rough edge, not
inside it.

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

### CACHE-BYTES — three things the byte bound was shipped without

`DEFAULT_STATEMENT_CACHE_BYTES = 8 MB` (`client.ts`) is **derived, never run.** It follows from
two measured facts — a template ceiling of 3.4 MB and the rule's `B > (N − 1) × MAX` condition
— but no workload was ever executed at 8 MB to confirm the number it produces. A campaign at
4 / 8 / 16 MB against the two-concurrent-`bulkWrite` workload would settle it, and
`tests/browser/statement-cache.test.ts` already contains that workload.

**The `× poolSize` multiplier was falsified at n=1.** All 32 INSERT batches landed on worker 0
at `poolSize: 4` on both engines (`mem:measurements`), which is why 8 MB per worker is not
32 MB in practice. One workload, one run, and four reads afterwards did not move the write
designation — nothing says it cannot migrate over a long session.

**The eviction churn is unprofiled.** SQL generated per call fills the LRU with single-use
entries; the bound stops the growth, not the churn, and every eviction is a `finalize` on the
hot path. This predates the byte bound and neither bound addresses it.

Design: `docs/superpowers/specs/2026-09-02-statement-cache-byte-bound-design.md` §8.

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

### Two SDD scratch reports are tracked in the repository, and nobody meant them to be

`.superpowers/` is in `.gitignore`, yet two `final-fix-report.md` files are committed on `main`:
`.superpowers/sdd/2026-08-18-wave-1-pool-scheduler/` and
`.superpowers/sdd/2026-08-31-cross-tab-coordination/`. Both are subagent process reports, not project
documentation. An implementer force-added each; the first went unnoticed for two weeks and the second
only surfaced in a merge diff.

Removing them is `git rm --cached` plus a commit — **the user's call, since it deletes tracked files**.
Worth doing at the same time: find out how they got past the ignore rule, because it has now happened
twice and nothing catches it.

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
