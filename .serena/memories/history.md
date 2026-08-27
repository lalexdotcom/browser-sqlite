# History — what each wave shipped

One line each. `CHANGELOG.md` holds the consumer-facing delta; `git log` holds the detail.
This file exists only so a date or a merge commit can be found without archaeology.

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

## Where the specs are

`docs/superpowers/specs/` and `docs/superpowers/plans/`, dated by filename. Two carry
in-place corrections written after execution proved them wrong — the wave-4 back-pressure
design (§3.6 and §6.2) and the wave-3 SQL-safety design (§2.4, §2.5, §3.1). Read the spec
for a design, but read it knowing execution corrected it; `mem:lessons` records why.
