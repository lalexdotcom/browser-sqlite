---
phase: 05-lalex-console-optional
plan: "01"
subsystem: logging
tags: [typescript, logger, optional-dependency, console-shim, worker-messages]

# Dependency graph
requires:
  - phase: 04-documentation
    provides: stable public API surface and JSDoc
provides:
  - LogLevel type export in src/types.ts
  - log variant in WorkerMessageData discriminated union (fire-and-forget, no callId)
  - src/logger.ts with ScopedLogger type, makeConsoleShim(), shouldLog(), LL export
  - @lalex/console moved to optionalDependencies
affects:
  - 05-02 (worker.ts refactor — depends on shouldLog and LogLevel)
  - 05-03 (client.ts wiring — imports LL from logger.ts)
  - 05-04 (integration verification)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Async IIFE for optional dependency detection (avoids top-level await in CJS builds)"
    - "Synchronous shim init + async upgrade for module-level logger (acceptable race before first use)"
    - "Discriminated union extension with fire-and-forget log variant (no callId)"

key-files:
  created:
    - src/logger.ts
    - tests/unit/logger.test.ts
  modified:
    - package.json
    - src/types.ts
    - src/client.ts

key-decisions:
  - "Async IIFE pattern for @lalex/console detection — avoids top-level await incompatibility with CJS build output"
  - "LL exported as let (not const) to allow async upgrade from shim to real logger"
  - "type:'log' branch added to client.ts onmessage handler before callId destructuring — required by TypeScript narrowing (log variant has no callId)"
  - "LL cast through unknown for dynamic level dispatch in client.ts — ScopeLogger has no index signature"

patterns-established:
  - "Pattern: Optional dependency via async IIFE try/catch dynamic import, synchronous shim fallback"
  - "Pattern: shouldLog(messageLevel, currentLevel) using LEVEL_NUMERIC map from @lalex/console ordering"

requirements-completed: [D-04, D-08, D-09, D-10, D-11, D-12]

# Metrics
duration: 2min
completed: 2026-03-24
---

# Phase 05 Plan 01: Logging Foundation Summary

**Optional @lalex/console with native console shim fallback — LogLevel type, WorkerMessageData log variant, src/logger.ts with shouldLog/makeConsoleShim/LL, and @lalex/console moved to optionalDependencies**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-24T16:34:05Z
- **Completed:** 2026-03-24T16:36:16Z
- **Tasks:** 3 (+ TDD RED/GREEN commits)
- **Files modified:** 5

## Accomplishments

- Moved @lalex/console from `dependencies` to `optionalDependencies` in package.json
- Extended WorkerMessageData union with `{ type: 'log'; level: LogLevel; scope: string; args: unknown[] }` (no callId — fire-and-forget)
- Created src/logger.ts: ScopedLogger type, LEVEL_NUMERIC map, shouldLog(), makeConsoleShim(), async-upgraded LL export
- All 68 unit tests pass (11 new logger tests + 57 existing)
- TypeScript check clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Move @lalex/console to optionalDependencies** - `c6f48a5` (chore)
2. **Task 2: Add LogLevel type and log variant to WorkerMessageData** - `d3928a1` (feat)
3. **Task 3 RED: Failing logger tests** - `0fa5f5c` (test)
4. **Task 3 GREEN: Create src/logger.ts** - `215595c` (feat)

_Note: TDD task has separate RED (test) and GREEN (feat) commits._

## Files Created/Modified

- `package.json` — @lalex/console moved from dependencies to optionalDependencies
- `src/types.ts` — LogLevel union type added; WorkerMessageData extended with log variant
- `src/client.ts` — type:'log' early-return branch added to onmessage handler before callId destructure
- `src/logger.ts` — NEW: ScopedLogger, LEVEL_NUMERIC, shouldLog, makeConsoleShim, async LL
- `tests/unit/logger.test.ts` — NEW: 11 tests covering shouldLog (8 cases) and makeConsoleShim (3 cases)

## Decisions Made

- Async IIFE pattern (not top-level await) for @lalex/console detection — Rslib builds CJS output which cannot contain top-level await. The IIFE initializes LL synchronously with the shim and swaps asynchronously, with acceptable race window before first `createSQLiteClient` call.
- `LL` exported as `let` to permit the async upgrade from shim to real logger instance.
- `type:'log'` branch placed BEFORE `callId` destructure in client.ts onmessage — TypeScript correctly requires this since the log variant has no `callId` field (discriminated union narrowing).
- Cast `LL as unknown as Record<string, (...a) => void>` for dynamic level dispatch — the ScopeLogger type from @lalex/console has no index signature, so direct cast was rejected by TypeScript.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript narrowing error in client.ts onmessage handler**
- **Found during:** Task 2 (Add LogLevel type and log variant)
- **Issue:** Adding the log variant to WorkerMessageData (which has no `callId`) caused `pnpm tsc --noEmit` to fail: `Property 'callId' does not exist on type '{ type: "log"; ... }'` — the handler was destructuring `callId` from `data` before narrowing by type
- **Fix:** Added `if (data.type === 'log') { ... return; }` branch early in onmessage, before `const { callId, type } = data`. Also cast `LL as unknown as Record<...>` to satisfy TypeScript's type checker for dynamic method dispatch
- **Files modified:** src/client.ts
- **Verification:** `pnpm tsc --noEmit` exits 0 after fix
- **Committed in:** d3928a1 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug caused by adding the log variant)
**Impact on plan:** Fix was required for TypeScript correctness. The plan documented this pitfall in RESEARCH.md (Pitfall 2) and Pattern 4 — the fix was exactly as prescribed. No scope creep.

## Issues Encountered

None beyond the TypeScript narrowing deviation documented above.

## Known Stubs

None — all exports are fully implemented. LL is live (shim or real logger depending on @lalex/console availability).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- src/logger.ts is ready for import by worker.ts (Plan 05-02) and client.ts (Plan 05-03)
- shouldLog() and LogLevel are available for worker-side level filtering
- WorkerMessageData log variant is typed and handled on the client side
- Wave 0 unit tests are GREEN — logger foundation is validated

---
*Phase: 05-lalex-console-optional*
*Completed: 2026-03-24*
