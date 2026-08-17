# Resume Plan — how to pick this project back up

Read `mem:project-state` for what the code is, `mem:follow-ups` for the issue backlog.
This file holds only: what is in flight, what is undecided, in what order we work, and
what changed last.

## 0. Current state

The stack upgrade of 2026-08-17 is **done and verified green** — see `mem:project-state`
for the resulting versions and the TS 7 editor notes. Nothing is in flight.

**Next up: wave 0** in §2 below.

## 1. Three decisions pending — nothing downstream is safe to start before them

| # | Decision | Recommendation | Consequence |
|---|---|---|---|
| D1 | Keep wa-sqlite, or move to `@sqlite.org/sqlite-wasm`? | **Keep wa-sqlite.** The official build's OPFS SAHPool VFS is single-connection, which removes the concurrent-read pool — i.e. the library's reason to exist. Fix the packaging complaint (B8) by vendoring the prebuilt WASM+glue at build time instead. | Reopening it means a rewrite, not a refactor. |
| D2 | Drop the `SharedArrayBuffer` (→ `navigator.locks` + a `postMessage`-driven boolean)? | **Yes.** It removes the COOP/COEP requirement from every consuming app; the SAB only serves the init mutex and the `ABORTING` flag. Small blast radius for the leverage. | Touches `orchestrator.ts`, `worker.ts`, and the rstest browser plugin. |
| D3 | Does `output()` leave the core for an optional module? | Undecided — the user's call. | Decides `1.0.0-rc.4` vs `2.0.0-rc.1`, since it is a breaking change on an API already in RC. |

Status: **all three still open** as of 2026-08-17.

## 2. Order of work

Each wave is independently shippable. The ordering rationale that matters: **the test
safety net comes first**, before the scheduler refactor — the original review put tests
last, which is backwards. B1 survived precisely because the scheduler is only reachable
through slow browser tests.

The stack upgrade in §0 lands **before** wave 0 — no point writing the safety net on a
toolchain we are about to replace.

| Wave | Contents | Covers |
|---|---|---|
| 0 | CI running the suite; put `tests/` in the tsc program; characterization tests for `transaction` / `bulkWrite` / `output`; fix the assertions that cannot fail | B7 |
| 1 | Extract pool + scheduler into a pure module unit-testable in Node (parameterized over a minimal `{ available: boolean }` shape); make `releaseWorker` the single owner of `available`; real abort on `stream()` | B1, W-arch |
| 2 | `onerror` / `onmessageerror`, per-request timeouts, distinct `open-error` message, `close()` handshake that settles in-flight work and calls `sqlite.close()` | B2, B3 |
| 3 | `quoteIdent()` + pragma allowlist; `output()` wrapped in one transaction; `bulkWrite` surfaces per-batch failures; debug wired for real or deleted | B4, B5, B6 |
| 4 | Packaging: vendor wa-sqlite, ship a prebuilt worker entry; remove the SAB (pending D2) | B8, W-sab |
| 5 | Performance, **with the debug instrumentation live** so the gains are measurable | perf section |

Correctness items not tied to a wave (`W-route`, `W-multitab`, `W-types`) fold into
whichever wave touches the same code.

## 3. Working conventions for this project

- Follow `AGENTS.md`: user leads, one step at a time, French in chat / English everywhere
  else, no unsolicited action on a question, `pnpm check` (biome) after every modification.
- Serena symbolic tools are primary for code; built-in Read/Edit for `.md`/JSON/config only.
- Agent framework is **superpowers**. The old `.planning/` directory was deleted on
  2026-08-17 — do not recreate it or trust anything quoting it.
- These memories live in `.serena/memories/`, which is **not** gitignored — commit them.

## 4. Changelog of this plan

- **2026-08-17** — Stack upgrade **completed and verified green**: TS 7.0.2, rslib 0.23.2,
  rstest 0.11.8, biome 2.5.8, playwright 1.62.1. Two devcontainer rebuilds (the second for
  the VS Code TS-7 extension swap). Only fallout was a one-line `biome.json` migration.
  `tsc --noEmit`, `biome check`, `pnpm build`, 57 unit tests and 24 browser tests all pass.
  No source file was touched.
- **2026-08-17** — Created. Triaged `docs/reviews/2026-08-17-0759-browser-sqlite.md`,
  verified B1/B6/B8 and the SAB usage directly in source, re-graded severities, inverted
  the review's test-vs-refactor ordering, and closed D1 with a recommendation. No code
  changed yet; work has not started.
