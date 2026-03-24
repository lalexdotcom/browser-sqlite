# Phase 5: @lalex/console Optional — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the discussion.

**Date:** 2026-03-24
**Phase:** 05 — avant-la-reaction-de-la-documentation-rendre-le-package-lalex-console-optionnel
**Mode:** discuss
**Areas discussed:** Package.json change, Fallback log methods, Level filtering, Architecture

## Gray Areas Presented

| Area | Presented as |
|------|-------------|
| Fallback log methods | verb/wth/success have no native console equivalent |
| Level filtering | LL.level='warn' suppresses debug/verbose logs; native console has no filtering |
| Package.json change | Currently a regular dependency — remove, optional, or peer? |

## Decisions Made

### Package.json
- **Decision:** Move to `optionalDependencies`. Use @lalex/console only if installed.
- **User input:** "Should be an optional dependency. Use only if user installed it."

### Architecture — Centralized logging (user-initiated)
- **Original question:** How should the fallback behave?
- **User correction:** Remove @lalex/console from worker entirely. Workers send log messages to client via postMessage. Client handles all logging (and @lalex/console fallback).
- **Reason:** Cleaner separation — worker has zero logger dependency; all logging centralized.

### Level filtering
- **Question:** Filter on worker side or client side?
- **User input:** Asked Claude's opinion.
- **Claude recommendation:** Worker-side filtering — prevents serialization of debug args when logLevel=warn (hot path concern).
- **Decision:** Filter on worker side only. `shouldLog(level, currentLogLevel)` check before `postMessage`.

### Fallback log methods
- **Decision:** `verb` → `console.debug`, `wth` → `console.debug`, `success` → `console.log`
- **User input:** Explicit mapping provided.

### Architecture confirmed
- **Decision:** Worker sends `{ type: 'log', level, scope, args }` via postMessage; client WorkerOrchestrator receives and dispatches to LL.
- **User confirmed:** "Confirmed (Recommended)"

## No Corrections to Prior Assumptions

This was a freeform discuss session — no assumptions were pre-generated to correct.
