# History — what each wave shipped

One line each, with one sanctioned exception: a **release** also gets a short section
saying what it was, because a table of increments cannot show an arc. `CHANGELOG.md` holds
the consumer-facing delta; `git log` holds the detail. This file exists only so a date or a
merge commit can be found without archaeology.

| When | Branch / wave | What it shipped |
|---|---|---|
| 2026-03-26 | — | **`1.0.0-rc.3` published.** Everything below is unreleased. |
| 2026-08-17 | Wave 0 | The safety net: CI, `tests/` type-checked, characterization suites. 81 → 105 tests. |
| 2026-08-17 | Wave P | Packaging. Self-contained worker entry, `dist/` flattened, wa-sqlite vendored, both runtime deps dropped, consumer smoke over four bundler modes made blocking. Toolchain to TypeScript 7. |
| 2026-08-18 | Wave 1 | Exclusivity by lease. `client.ts` split into scheduler / pool / queries / transaction / bulk. `one()` → `first()`, `stream()` yields rows, `chunk()` introduced, abort implemented once. 15 commits, 148 tests. |
| 2026-08-19 | Wave 2 | Error surface (`SQLiteError` + codes), worker lifecycle (death detection, bounded restart, `supervisor.ts`), real async `close()`. 17 commits, 193 tests. |
| 2026-08-19 | Wave 3 | SQL safety: `quoteIdent` everywhere, pragma allowlist applied once at open, atomic `output()` via staging + rename, `bulkWrite` failure latch, debug subsystem wired. Merge `5eb5ace`, 24 commits, 272 tests. |
| 2026-08-20 | Wave 4, first half | Back-pressure (BP-1) and the `SharedArrayBuffer` removed with `orchestrator.ts`. **Cross-origin isolation no longer required.** Merge `5292b70`, 26 commits. |
| 2026-08-20 | `feat/vfs-default` | `OPFSPermutedVFS` deleted, `OPFSAdaptiveVFS` on Asyncify made the default, public `build` option, the single VFS table as source of truth. Merge `be314db`, 8 commits. No spec — it opened with probe `a68047b` and the measurement is in that commit message. |
| 2026-08-21 | `feat/ryow-barrier` | The commit-propagation barrier. Spec `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md`, 25 commits, merge `36c664e`. Acceptance: `output()`'s two `poolSize: 1` pins removed, 20/20 green. |
| 2026-08-21 | `feat/writer-stickiness` | The writer designation released once nothing is queued (`e2f454b`), plus SUP-1 — a restarted slot holds a worker from spawn, not from ready (`07b075a`). Merge `4f215f8`. |
| 2026-08-24 | `feat/vfs-capabilities` | `VFS_BUILDS` → `VFS_CAPABILITIES`, four more VFS wired, the conformance project, the generated README VFS table. |
| 2026-08-25 | (same branch) | The benchmark page and its Pages publication; the device campaign; the WebKit `OPFSAnyContextVFS` patch; `IDBMirrorVFS` corrected to single-connection; the sourced browser baseline. |
| 2026-08-26 | `feat/tx-query-surface` | A transaction gets the client's whole querying surface. `SQLiteQueryAPI` factors both surfaces so they cannot drift; the public type layer moves to `src/api.ts`; `createBulk` splits in two stages so the sweep memo stays per-client; `tryWithLock` stops the sweep waiting; `READ_ONLY_TRANSACTION`. Spec `2026-08-26-tx-query-surface-design.md`, plan of seven tasks, 16 commits, merge `6f8ff48`. Followed on `main` by four cleanups (`c64b8c9`) and BENCH-DRIFT's export guard (`de3abdf`). |
| 2026-08-26 | `feat/vfs-required` | `vfs` required, `DEFAULT_VFS` unexported, `src/capabilities.ts` and the construction-time platform guard. 7 commits, merge `1783db7`. First `CHANGELOG.md`. |
| 2026-08-27 | `feat/delete-database` | `deleteDatabase`, and the three abort defects a device campaign uncovered behind it. Spec `2026-08-27-delete-database-design.md`, plan of six tasks executed by subagents; `feat/bulk-abort` (ABORT-1) folded in. Also `Abortable<T>`, the README's per-method options and TOC, a `chunk()` section, and the bench page's delete row. Merge `a2c1b26`, 22 commits, 383 tests. |
| 2026-08-27 | `feat/last-writer-routing` | The scheduler prefers the last writer, for reads (which then skip the barrier) and for new write designations (which stops `bulkWrite` walking the pool between batches). A preference, never a pin. Proven as a barrier-statement count on both engines; no latency gain measurable on either — see `mem:measurements`. Nothing in the README or CHANGELOG: internal mechanics with no claimable effect. Merge `6728499`, 2 commits, 410 tests. |
| 2026-08-27 | `feat/bulk-backpressure` | `BACKPRESSURE-1`: `enqueue()` returns a promise, `queueSize` bounds the rows queued for writing, default derived from the column count, the promise never rejects, an abort releases a parked producer. Spec `2026-08-27-bulk-backpressure-design.md` and plan `2026-08-27-bulk-backpressure.md` — the first branch to get a written plan and a pre-merge subagent review. Merge `f613e9a`, 4 commits, 405 tests. |
| 2026-08-27 | `feat/transaction-signal` | `transaction()` honours a `signal` — four checkpoints, the callback raced against it, every `tx` statement inheriting it, `BEGIN`/`COMMIT`/`ROLLBACK` deliberately excluded. `mergeSignals()` rather than `AbortSignal.any()`. A failed `BEGIN` stops evicting a healthy worker. `Abortable` → `OptionsWithSignal`. No spec — bounded, brainstormed in chat. Merge `05596f4`, 1 commit, 397 tests. |
| 2026-08-27 | `feat/wasm-url` | `wasmUrl`, approved 2026-08-18 and never built: a directory or a callback naming one file, resolved once on the client, reaching Emscripten's `locateFile` only when given. No spec — bounded, brainstormed in chat. Merge `003cc09`, 1 commit. |
| 2026-08-28 | `feat/statement-cache` | `PREPARE-1`: a per-worker LRU of prepared statements, so single-statement SQL is compiled once instead of once per execution. wa-sqlite's own `unscoped` option retains what its generator yields; the worker takes over only the statement's lifetime — `reset` + `clear_bindings` on every non-error exit, finalise-and-evict on error, drain before `close`. A `prepared` counter on the `done` message proves reuse. Carried a latent fix: column names are read after the first row, not before, which four barrier tests turned out to depend on. Spec `2026-08-27-statement-cache-design.md`, plan of five tasks by subagents. Measured on two engines and two builds — `mem:measurements`. 16 commits, 428 tests. |
| 2026-08-28 | `feat/pool-readiness-gate` | `poolSize` becomes a promise instead of a request: nothing is served until every slot has settled, a slot that failed to open is retried once when another one opened, and a worker lost for good warns unconditionally and calls `onWorkerLost`. It began as a Firefox flake and ended elsewhere — `long-query :: does not block the pool` was failing *every* run because last-writer routing had removed the coin flip hiding it, and the test timed the file rather than the pool. The real defect the diagnosis turned up: a worker's `open` needs the same rotating exclusive handle, so a long query during warm-up could starve it and shrink the pool for good, silently. **Firefox is a CI gate from here on.** Merge `fa65cf3`, 2 commits. |
| 2026-08-31 | on `main`, no branch | The type work and the surface it exposed: `exactOptionalPropertyTypes` and the seven sites it named, wa-sqlite's own types adopted with only the gaps declared here, thirty-seven `any` down to twelve. A breaking fix rode with it — `bulkWrite`'s public signature now accepts the options it documents. Plus the signal audit with its tests, the floor computed from `@mdn/browser-compat-data`, and `W-multitab`'s Known Limitations line. Inline work, per the rule that a branch is for a feature going through the workflow. |
| 2026-08-31 | `feat/perf-measure` | The performance backlog closed on measurement rather than argument. Kept: the per-row object built by a loop instead of `Object.fromEntries(cols.map(...))` — 17.5 → 4.4 ms on Chromium, 23 → 14 ms on Firefox over 50 000 rows x 12 columns. Dropped: sharing one compiled `WebAssembly.Module` across the pool, because Chromium overlaps those compiles (6.0 ms at one worker, 8.1 at four) and Firefox does not (29 against 68) — ~8 ms at the default `poolSize`, for a handshake on the open path. Both numbers in `mem:measurements`. Merge `6bbb01e`. |
| 2026-08-31 | `feat/release-notes-from-changelog` | A tag now produces a GitHub Release whose body is the matching `CHANGELOG.md` section, and npm is never published before that release exists. Spans two repositories: `lalexdotcom/action-release-and-publish` gained an optional `release-notes-file` (a path, never a string — an interpolated body would execute on a runner holding `NPM_TOKEN`) and moved release creation ahead of `npm publish`; here, one inline shell step asserts the tag, `package.json` and a dated heading all name the same version, then extracts the section. Nothing writes to `CHANGELOG.md`. Spec `2026-08-31-release-notes-from-changelog-design.md`, plan of four tasks by subagents. Merge `d8d7cf4`. |
| 2026-08-31 | — | **`1.0.0-rc.4` published.** On npm under `rc`, `next` and `latest`; a GitHub prerelease carrying the CHANGELOG section. |

## What rc.4 was — the one entry that is not one line

**Deliberately longer than the rule above (user, 2026-08-31),** because the table
reads as twenty increments and rc.4 was not twenty increments. Between rc.3 of
2026-03-26 and rc.4 the library was **reimplemented**, and the rows are the steps
of one arc rather than a list of features.

What actually changed shape:

- **Concurrency became a design instead of a hope.** Exclusivity moved to opaque
  leases with availability unreachable from outside the scheduler; one query is in
  flight per worker; the writer designation is released as soon as nothing is
  queued behind it. `SharedArrayBuffer` and `orchestrator.ts` were deleted
  outright, which is what removed the cross-origin-isolation requirement.
- **Cross-connection staleness turned out to be a property of the setup, not of a
  VFS** — measured identical on every VFS and every build. The commit-propagation
  barrier is permanent architecture because of that, and it is what holds the
  scheduling rules up.
- **The VFS surface became declared and executed rather than described.**
  `VFS_CAPABILITIES` is the single source of truth the client guard, the
  conformance suite, the README generator and the benchmark page all read; every
  declared pair is run, never trusted. `vfs` became required, because a default
  that moves decides where a consumer's bytes live.
- **The failure surface was built.** Typed errors and codes, worker death
  detection with bounded restart, a real asynchronous `close()`, abort implemented
  once and honoured everywhere, back-pressure on `bulkWrite`, and a readiness gate
  so `poolSize` means what it says.
- **Evidence became the currency.** A benchmark page on Pages, a conformance
  project, device campaigns on real Apple hardware, a bundler matrix over five
  bundlers, and `mem:measurements` — where a number without a date and a method
  does not go.

The consumer-facing delta is `CHANGELOG.md`; this section is the shape, which the
changelog's Breaking/Added/Changed/Fixed cannot show.

## Where the specs are

`docs/superpowers/specs/` and `docs/superpowers/plans/`, dated by filename. Two carry
in-place corrections written after execution proved them wrong — the wave-4 back-pressure
design (§3.6 and §6.2) and the wave-3 SQL-safety design (§2.4, §2.5, §3.1). Read the spec
for a design, but read it knowing execution corrected it; `mem:lessons` records why.
