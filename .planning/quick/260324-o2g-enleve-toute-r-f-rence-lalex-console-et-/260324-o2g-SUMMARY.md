---
phase: quick
plan: 260324-o2g
subsystem: logging
tags: [cleanup, logging, breaking-change]
dependency_graph:
  requires: []
  provides: [silent-library]
  affects: [src/client.ts, src/worker.ts, src/types.ts]
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - src/types.ts
    - src/client.ts
    - src/worker.ts
    - package.json
    - README.md
  deleted:
    - src/logger.ts
    - tests/unit/logger.test.ts
decisions:
  - "Tasks 1 and 2 committed together because pre-commit hook runs tsc — client.ts and worker.ts referenced logger symbols that no longer existed after Task 1 changes, causing tsc failure on isolated Task 1 commit. Combined into one atomic commit."
metrics:
  duration: ~3min
  completed: 2026-03-24T17:32:01Z
  tasks_completed: 3
  files_changed: 7
---

# Quick Task 260324-o2g: Remove all @lalex/console and logLevel logging infrastructure

**One-liner:** Deleted logger.ts, removed LogLevel type and logLevel option, removed all shouldLog/LL/log() call sites from worker.ts and client.ts, and stripped @lalex/console from package.json — library is now completely silent.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1+2 | Remove logger module, types, and clean worker/client | f3cae4a | src/logger.ts (del), tests/unit/logger.test.ts (del), src/types.ts, package.json, src/worker.ts, src/client.ts |
| 3 | Remove logLevel from README, confirm tests green | 98aeaf0 | README.md |

## What Was Done

**src/logger.ts** — Deleted entirely. Contained `ScopedLogger` type, `makeConsoleShim()`, `shouldLog()`, and the `LL` module-level logger that attempted to load `@lalex/console` asynchronously.

**tests/unit/logger.test.ts** — Deleted entirely. Tested `shouldLog` and `makeConsoleShim` which no longer exist.

**src/types.ts** — Three surgical removals:
- `LogLevel` type union (11 variants) removed
- `logLevel?:` field removed from the `open` variant of `ClientMessageData`
- `| { type: 'log'; level: LogLevel; scope: string; args: unknown[] }` variant removed from `WorkerMessageData`

**src/worker.ts** — Complete removal of logging infrastructure:
- `import { shouldLog } from './logger'` removed
- `LogLevel` removed from types import
- `let currentLogLevel: LogLevel = 'warn'` removed
- `function log(...)` helper removed (posted type:'log' messages to client)
- All ~15 `log(...)` call sites removed from `open()` and query handler
- `logLevel` removed from open message destructure
- `currentLogLevel = logLevel ?? 'warn'` removed from top-level onmessage handler

**src/client.ts** — Complete removal of logging infrastructure:
- `import { LL } from './logger'` removed
- `logLevel?: 'debug' | 'info' | 'warn' | 'error'` field + JSDoc removed from `CreateSQLiteClientOptions`
- `LL.level = clientOptions?.logLevel ?? 'warn'` removed
- `if (data.type === 'log') { ... return; }` block removed from `worker.onmessage`
- `logLevel: clientOptions?.logLevel` removed from open postMessage payload
- `LL.debug(...)` call removed from `acquireNextWorker`
- `LL.debug(...)`, `LL.verb(...)` x2 removed from `releaseWorker`
- `LL.success(...)` and `.catch((e) => LL.error(...))` removed from pool initialization

**package.json** — `"optionalDependencies"` block (`@lalex/console: "2.0.0"`) removed entirely.

**README.md** — `logLevel: 'warn',` line removed from the Quick Start example.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Tasks 1 and 2 combined into a single commit**
- **Found during:** Task 1 commit attempt
- **Issue:** The pre-commit hook runs `pnpm tsc --noEmit`. After deleting `src/logger.ts` and cleaning `src/types.ts`, `src/client.ts` and `src/worker.ts` still imported from `'./logger'` and referenced `LogLevel` — causing tsc to fail and the commit to be rejected.
- **Fix:** Completed all source file cleanups (Tasks 1 and 2) before committing, then committed everything in one atomic commit. Task 3 (README) committed separately as planned.
- **Files modified:** src/logger.ts, tests/unit/logger.test.ts, src/types.ts, package.json, src/worker.ts, src/client.ts
- **Commit:** f3cae4a

## Verification Results

```
grep -rn "@lalex/console|logLevel|shouldLog|currentLogLevel|makeConsoleShim|ScopedLogger|from './logger'" src/ tests/ README.md package.json
-> ALL CLEAN

pnpm tsc --noEmit
-> (no output — clean)

pnpm test
-> 57 tests pass, 3 files, 0 failures
```

## Known Stubs

None.

## Self-Check: PASSED

- `src/logger.ts`: DELETED (confirmed)
- `tests/unit/logger.test.ts`: DELETED (confirmed)
- Commit f3cae4a: EXISTS (confirmed via git log)
- Commit 98aeaf0: EXISTS (confirmed via git log)
- No residual references: ALL CLEAN (confirmed via grep)
