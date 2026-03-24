# Phase 5: @lalex/console Optional — Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Make `@lalex/console` an optional dependency. If the package is not installed, wsqlite falls back to native `console` methods. This is purely a refactor of the logging infrastructure — no public API changes, no new features.

</domain>

<decisions>
## Implementation Decisions

### Architecture — Centralized Client-Side Logging

- **D-01:** Remove all `@lalex/console` usage from `worker.ts`. Workers no longer call `LL.*` directly.
- **D-02:** Workers send a new `{ type: 'log', level, scope, args }` message to the client via `postMessage` instead of logging locally.
- **D-03:** The `WorkerOrchestrator` in `client.ts` handles `type: 'log'` messages and dispatches them through the single logger instance (which uses @lalex/console if present, native console fallback if not).
- **D-04:** `src/types.ts` — add `{ type: 'log'; level: LogLevel; scope: string; args: unknown[] }` to the `WorkerMessageData` union.

### Level Filtering — Worker Side Only

- **D-05:** Workers filter by `logLevel` before posting. If the log level would be suppressed (e.g., `logLevel='warn'` and calling verb/debug), the `postMessage` is skipped entirely — zero serialization overhead, zero thread-crossing.
- **D-06:** Worker stores `logLevel` as a module-level variable set during the `open` message handler (already done via `LL.level` today). Replace `LL.level = logLevel` with a local `let currentLogLevel: LogLevel = logLevel ?? 'warn'`.
- **D-07:** A small pure function `shouldLog(messageLevel, currentLevel): boolean` is added in `worker.ts` (or a shared utility). Level order: `debug < info < warn < error`. Non-standard levels (`verb`, `wth`) are treated as `debug`.

### @lalex/console Detection — Runtime, Client Only

- **D-08:** Move `@lalex/console` from `dependencies` to `optionalDependencies` in `package.json`.
- **D-09:** In `client.ts`, detect @lalex/console at module initialization via a dynamic import wrapped in try/catch (or conditional static import). If import fails → use native console shim. If it succeeds → use `Logger.scope('sqlite/client')` as today.
- **D-10:** The logger instance (either `@lalex/console` or the shim) is stored as a module-level `LL` variable, same as today. No change to call sites in `client.ts`.

### Native Console Fallback Shim

- **D-11:** The fallback shim wraps native `console` with the same interface as `@lalex/console`'s scoped logger:
  - `debug(...args)` → `console.debug(...args)`
  - `info(...args)` → `console.info(...args)`
  - `warn(...args)` → `console.warn(...args)`
  - `error(...args)` → `console.error(...args)`
  - `verb(...args)` → `console.debug(...args)` (no native equivalent, collapsed to debug)
  - `wth(...args)` → `console.debug(...args)` (no native equivalent, collapsed to debug)
  - `success(...args)` → `console.log(...args)` (no native equivalent, collapsed to log)
  - `level` setter → store current level (no-op for actual filtering since workers pre-filter)
  - `date` setter → no-op (native console handles timestamps itself)
  - `scope(name)` → returns a new shim instance (prefix can be included in logged output)
- **D-12:** The shim does not need to re-implement level filtering for log calls that originate in `client.ts` itself (lines 300, 531, 572, 579, 593, 1021, 1023). Those calls are infrequent and low-stakes. If desired, the shim can also check `level` — but this is Claude's discretion.

### Claude's Discretion

- Exact placement of the shim (inline in `client.ts` vs separate `src/logger.ts` utility)
- Whether to add a `scope` prefix to native console output (e.g., `[sqlite/client]` or `[sqlite/worker]`)
- Whether worker log messages include a worker index in the `scope` field or as part of `args`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source files

- `src/types.ts` — `WorkerMessageData` union to extend with `type: 'log'`; `ClientMessageData` `open` variant (logLevel field already present)
- `src/client.ts` lines 1, 8-9, 300, 531, 572, 579, 593, 1021, 1023 — all current `@lalex/console` import and `LL.*` usage
- `src/worker.ts` lines 12, 20-21, 106, 108, 124, 130, 139, 143, 146, 148, 151, 161, 165, 167, 231, 243, 248, 256, 265, 268, 295 — all current `@lalex/console` import and `LL.*` usage in worker
- `src/orchestrator.ts` — `onmessage` handler where new `type: 'log'` branch must be added
- `package.json` — `dependencies` section (move @lalex/console to optionalDependencies)

### No external specs

Requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `ClientMessageData['open'].logLevel` — already typed as `'debug' | 'info' | 'warn' | 'error'`; worker already receives and stores this value via `LL.level = logLevel ?? 'warn'` at line 295 of `worker.ts`
- `WorkerMessageData` union (types.ts:48-52) — extend here with the log message type

### Established Patterns

- All inter-thread communication goes through `postMessage` with a discriminated `type` field — the log message follows the same pattern as `chunk`, `done`, `error`
- Module-level `LL` with `LL.date = true` and `LL.level = ...` on init — same structure stays, just replacing the source of the logger object
- `callId` is present on all current WorkerMessageData members; log messages don't need a callId (fire-and-forget)

### Integration Points

- `WorkerOrchestrator.onmessage` in `orchestrator.ts` — add `if (data.type === 'log') { LL[data.level](...data.args) }` branch (or equivalent)
- `worker.ts` top-level `self.onmessage` handler — remove `LL` import, replace each `LL.X(...)` with either a `shouldLog(level, currentLogLevel) && self.postMessage({ type: 'log', ... })` pattern or a thin local `log(level, ...args)` helper that wraps that check

</code_context>

<specifics>
## Specific Ideas

- User explicitly chose the centralized client-side logging architecture over the simpler in-place shim approach
- Worker-side level filtering is deliberate: prevents serialization of debug args in production (where logLevel=warn)
- `verb` and `wth` → `console.debug`, `success` → `console.log` for the native fallback

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 05-avant-la-reaction-de-la-documentation-rendre-le-package-lalex-console-optionnel*
*Context gathered: 2026-03-24*
