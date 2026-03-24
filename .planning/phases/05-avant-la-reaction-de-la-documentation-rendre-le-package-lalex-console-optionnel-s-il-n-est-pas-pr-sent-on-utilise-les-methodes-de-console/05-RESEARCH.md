# Phase 5: @lalex/console Optional — Research

**Researched:** 2026-03-24
**Domain:** TypeScript logging refactor — optional dependency pattern, worker-to-client message bridging
**Confidence:** HIGH (all findings from direct source inspection)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Remove all `@lalex/console` usage from `worker.ts`. Workers no longer call `LL.*` directly.
- **D-02:** Workers send a new `{ type: 'log', level, scope, args }` message to the client via `postMessage` instead of logging locally.
- **D-03:** The `WorkerOrchestrator` in `client.ts` handles `type: 'log'` messages and dispatches them through the single logger instance (which uses @lalex/console if present, native console fallback if not).
- **D-04:** `src/types.ts` — add `{ type: 'log'; level: LogLevel; scope: string; args: unknown[] }` to the `WorkerMessageData` union.
- **D-05:** Workers filter by `logLevel` before posting. If the log level would be suppressed (e.g., `logLevel='warn'` and calling verb/debug), the `postMessage` is skipped entirely — zero serialization overhead, zero thread-crossing.
- **D-06:** Worker stores `logLevel` as a module-level variable set during the `open` message handler (already done via `LL.level = logLevel` today). Replace `LL.level = logLevel` with a local `let currentLogLevel: LogLevel = logLevel ?? 'warn'`.
- **D-07:** A small pure function `shouldLog(messageLevel, currentLevel): boolean` is added in `worker.ts` (or a shared utility). Level order: `debug < info < warn < error`. Non-standard levels (`verb`, `wth`) are treated as `debug`.
- **D-08:** Move `@lalex/console` from `dependencies` to `optionalDependencies` in `package.json`.
- **D-09:** In `client.ts`, detect @lalex/console at module initialization via a dynamic import wrapped in try/catch (or conditional static import). If import fails → use native console shim. If it succeeds → use `Logger.scope('sqlite/client')` as today.
- **D-10:** The logger instance (either `@lalex/console` or the shim) is stored as a module-level `LL` variable, same as today. No change to call sites in `client.ts`.
- **D-11:** The fallback shim wraps native `console` with the same interface as `@lalex/console`'s scoped logger:
  - `debug(...args)` → `console.debug(...args)`
  - `info(...args)` → `console.info(...args)`
  - `warn(...args)` → `console.warn(...args)`
  - `error(...args)` → `console.error(...args)`
  - `verb(...args)` → `console.debug(...args)`
  - `wth(...args)` → `console.debug(...args)`
  - `success(...args)` → `console.log(...args)`
  - `level` setter → store current level (no-op for actual filtering since workers pre-filter)
  - `date` setter → no-op
  - `scope(name)` → returns a new shim instance
- **D-12:** The shim does not need to re-implement level filtering for log calls that originate in `client.ts` itself. Those calls are infrequent and low-stakes. If desired, the shim can also check `level` — but this is Claude's discretion.

### Claude's Discretion

- Exact placement of the shim (inline in `client.ts` vs separate `src/logger.ts` utility)
- Whether to add a `scope` prefix to native console output (e.g., `[sqlite/client]` or `[sqlite/worker]`)
- Whether worker log messages include a worker index in the `scope` field or as part of `args`

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Remove @lalex/console import and LL.* calls from worker.ts | Worker.ts lines 12, 20–21, 106–295 fully catalogued below |
| D-02 | Workers post `{ type: 'log', level, scope, args }` via postMessage | Discriminated union pattern already used for chunk/done/error |
| D-03 | WorkerOrchestrator (client.ts) dispatches worker log messages through LL | worker.onmessage handler at line 368 is the correct insertion point |
| D-04 | Add log variant to WorkerMessageData union in types.ts | WorkerMessageData at types.ts:48–52 — no callId needed |
| D-05 | Worker-side level filtering before postMessage | shouldLog() pure function — LEVEL_METHODS numeric map from @lalex/console verified |
| D-06 | Replace LL.level assignment with module-level currentLogLevel variable | Single assignment at worker.ts:295 |
| D-07 | shouldLog(messageLevel, currentLevel): boolean utility | Level order: verb/wth=debug(9)<info(7)<warn(4)<error(3); lower number = higher severity |
| D-08 | Move @lalex/console to optionalDependencies in package.json | Currently in dependencies at version 2.0.0 |
| D-09 | Dynamic import of @lalex/console in client.ts with try/catch | Top-level await needed; module is ESM-only |
| D-10 | Module-level LL variable stores either real logger or shim | Pattern already exists: `const LL = Logger.scope('sqlite/client')` at line 8 |
| D-11 | Native console fallback shim with exact interface match | ScopeLogger interface verified from @lalex/console dist types |
| D-12 | Shim level filtering: Claude's discretion | Low call volume in client.ts justifies simple implementation |
</phase_requirements>

---

## Summary

Phase 5 is a self-contained logging infrastructure refactor with no public API changes. The work splits cleanly into four areas: (1) add a `type: 'log'` variant to the `WorkerMessageData` union in `types.ts`; (2) gut `@lalex/console` from `worker.ts` and replace every `LL.*` call with a conditional `postMessage`; (3) add a `type: 'log'` branch to the worker `onmessage` handler in `client.ts` and update the module initializer to detect `@lalex/console` at runtime; (4) move the package to `optionalDependencies`.

The critical technical constraint is the `@lalex/console` detection strategy. The package is ESM-only (`"type": "module"` in its package.json, single `import` export condition). A top-level `await import('@lalex/console')` inside a `try/catch` is the right approach — it runs at module initialization time before any client is created, and naturally falls back to the shim if the package is absent. The shim must satisfy the `ScopeLogger` interface shape used at all `LL.*` call sites: the 11 log-method names, a settable `level`, a settable `date`, and a `scope(name)` factory.

The `shouldLog` utility in `worker.ts` must implement the numeric severity ordering from `@lalex/console`'s `LEVEL_METHODS` (lower number = higher severity: `emerg=0 … wth=10`). The `ClientMessageData['open'].logLevel` type is already restricted to `'debug' | 'info' | 'warn' | 'error'`, so the worker only needs to compare those four levels, but `shouldLog` should also handle the full 11-level set for robustness since worker code uses `verb` and `wth`.

**Primary recommendation:** Use a separate `src/logger.ts` module for the shim + detection logic. This keeps `client.ts` clean and makes the shim independently testable.

---

## Standard Stack

### Core (no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@lalex/console` | 2.0.0 | Enhanced logger (optional) | Already in project; moved to optionalDependencies |
| Native `console` | Browser built-in | Fallback logger | Zero-dependency, always available in browser |

No new packages are added in this phase.

### Moving

| Package | From | To | Why |
|---------|------|----|-----|
| `@lalex/console` | `dependencies` | `optionalDependencies` | Makes it truly optional — bundlers/consumers do not fail if absent |

**Note on `optionalDependencies` semantics (verified from npm docs):** When a package is listed under `optionalDependencies`, `npm install` / `pnpm install` will still install it if it resolves. The "optional" means the install does not fail if the package is unavailable (missing from registry or install error). For consumers of wsqlite who want to exclude it, they must explicitly exclude it — it does not auto-exclude. The runtime check via dynamic import remains the correct mechanism for detecting absence.

**Note on pnpm and optional deps:** pnpm honors `optionalDependencies` identically to npm. No pnpm-specific config required.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── types.ts         # Add WorkerMessageData log variant + LogLevel re-export
├── logger.ts        # NEW: shim definition + @lalex/console detection + LL export
├── worker.ts        # Remove @lalex/console; add shouldLog(); replace LL.* with postMessage
├── client.ts        # Import LL from logger.ts; add type:'log' branch in onmessage
└── orchestrator.ts  # No changes needed (WorkerOrchestrator has no logging)
```

### Pattern 1: Runtime Optional Dependency Detection (ESM)

**What:** Use a top-level `await` dynamic import inside `try/catch` at module init time.
**When to use:** ESM-only optional package that may not be installed; must know at module load whether it's available.

```typescript
// src/logger.ts
// Source: direct inspection of @lalex/console dist/index.d.ts

type ScopedLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  verb: (...args: unknown[]) => void;
  wth: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  set level(l: string);
  set date(d: boolean);
  scope: (name: string) => ScopedLogger;
};

function makeConsoleShim(scopeName?: string): ScopedLogger {
  const prefix = scopeName ? `[${scopeName}] ` : '';
  const shim: ScopedLogger = {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    verb: (...args) => console.debug(prefix, ...args),
    wth: (...args) => console.debug(prefix, ...args),
    success: (...args) => console.log(prefix, ...args),
    set level(_: string) { /* no-op: workers pre-filter */ },
    set date(_: boolean) { /* no-op: native console handles timestamps */ },
    scope: (name) => makeConsoleShim(name),
  };
  return shim;
}

let LL: ScopedLogger;
try {
  const { Logger } = await import('@lalex/console');
  const rootLL = Logger.scope('sqlite/client');
  rootLL.date = true;
  LL = rootLL;
} catch {
  LL = makeConsoleShim('sqlite/client');
}

export { LL };
```

**Important:** The file exporting `LL` must be an ES module with top-level `await`. The build target (Rslib/Vite) must support top-level await in ESM output — Rslib does (it targets ESNext by default).

**Alternative if top-level await is not viable:** Initialize `LL` synchronously with the shim, then attempt import asynchronously and swap it out. The downside is a race condition during module init — messages logged before the swap use the shim even if `@lalex/console` is present. Given that `createSQLiteClient` is the first call, this race is acceptable.

### Pattern 2: Worker-Side Level Filtering

**What:** A pure `shouldLog` function checks whether a message level passes the current threshold before serializing and posting.
**When to use:** Before every `postMessage` call in worker.ts.

```typescript
// src/worker.ts — verified level numeric ordering from @lalex/console dist/levels.d.ts
// LEVEL_METHODS: emerg=0, alert=1, crit=2, error=3, warn=4, notice=5, success=6, info=7, verb=8, debug=9, wth=10
// Lower number = higher severity (more critical).
// "should log" means: message severity <= configured threshold severity.

const LEVEL_NUMERIC: Record<string, number> = {
  emerg: 0, alert: 1, crit: 2, error: 3,
  warn: 4, notice: 5, success: 6, info: 7,
  verb: 8, debug: 9, wth: 10,
};

function shouldLog(messageLevel: string, currentLevel: string): boolean {
  // Lower number = higher severity. Message is emitted if its severity <= threshold.
  // Example: currentLevel='warn' (4). messageLevel='debug' (9). 9 > 4 → false (suppressed).
  // Example: currentLevel='warn' (4). messageLevel='error' (3). 3 <= 4 → true (emitted).
  const msg = LEVEL_NUMERIC[messageLevel] ?? LEVEL_NUMERIC.debug;
  const cur = LEVEL_NUMERIC[currentLevel] ?? LEVEL_NUMERIC.warn;
  return msg <= cur;
}
```

### Pattern 3: Discriminated Union Log Message

**What:** Extend `WorkerMessageData` with a `log` variant following the existing pattern.
**When to use:** Any worker-to-client communication.

```typescript
// src/types.ts — following existing pattern for chunk/done/error (all have callId)
// Log messages are fire-and-forget: no callId needed.

export type LogLevel = 'emerg' | 'alert' | 'crit' | 'error' | 'warn' | 'notice' | 'success' | 'info' | 'verb' | 'debug' | 'wth';

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  | { type: 'chunk'; callId: number; data: any[] }
  | { type: 'done'; callId: number; affected: number }
  | { type: 'error'; callId: number; message: string; cause?: unknown }
  | { type: 'log'; level: LogLevel; scope: string; args: unknown[] };
  // Note: no callId on log — fire-and-forget from worker
```

**TypeScript discriminant:** The `type` field is a string literal in each variant. TypeScript narrows correctly in switch statements on `data.type`.

### Pattern 4: Log Dispatch in client.ts onmessage

**What:** Add a `type: 'log'` branch early in the `worker.onmessage` handler before the `callId` check.

```typescript
// src/client.ts — worker.onmessage handler at line 368
// Source: direct inspection of client.ts

worker.onmessage = ({ data }: MessageEvent<WorkerMessageData>) => {
  const { type } = data;

  // Handle log messages from worker (fire-and-forget, no callId)
  if (type === 'log') {
    // LL is the module-level scoped logger (real or shim)
    // data.level is a LogLevel; LL[data.level] must exist on both real logger and shim
    (LL as Record<string, (...a: unknown[]) => void>)[data.level]?.(...data.args);
    return;
  }

  const { callId } = data;
  // ... rest of existing handler unchanged
};
```

**Note on scope:** The `data.scope` field can be included in `args` as a prefix string (e.g., `[sqlite/worker 1]`) — this is simpler than creating a new scoped logger per message. See Claude's Discretion section.

### Anti-Patterns to Avoid

- **Static import of @lalex/console at top of client.ts:** A static import cannot be conditional — if the package is absent, the module fails to load entirely. Must use dynamic import.
- **Importing @lalex/console in worker.ts at all:** After this refactor, worker.ts has zero knowledge of @lalex/console. Any import there reintroduces the hard dependency in the worker bundle.
- **Sending all log messages regardless of level:** Workers must call `shouldLog` before `postMessage`. Without this filter, verbose debug messages cross the thread boundary even in production (where `logLevel='warn'`).
- **Using the log variant callId field:** Log messages are fire-and-forget. Adding a callId would confuse the existing handler logic which pairs callId with pending deferred promises.
- **Forgetting the `type: 'log'` branch must be checked BEFORE the `callId` check:** The log variant has no `callId` field. TypeScript will infer this correctly with narrowing, but placement matters to avoid runtime errors accessing `data.callId` on a log message.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Level numeric ordering | Custom severity mapping | Copy LEVEL_METHODS from @lalex/console (already installed) | Single source of truth; keeps shouldLog consistent with the real logger |
| Module-load detection | Complex feature detection | Dynamic import try/catch | Standard ESM pattern; zero complexity |
| Worker message typing | Loose `any` | Discriminated union in WorkerMessageData | TypeScript narrows type correctly in switch; catch mistakes at compile time |

---

## Runtime State Inventory

> This is a code-only refactor — no datastores, external services, or OS registrations involved.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — wsqlite stores no logger config in any DB or datastore | None |
| Live service config | None — no external services reference @lalex/console usage | None |
| OS-registered state | None | None |
| Secrets/env vars | None — @lalex/console uses `LLOGER_FORCE_CONSOLE` and `LLOGGER_ENABLED` env vars, but wsqlite does not set them | None |
| Build artifacts | `dist/` outputs from previous builds may import the old static @lalex/console — rebuilt by CI/build step | Rebuild clears this automatically |

---

## Common Pitfalls

### Pitfall 1: Top-Level Await in Non-ESM Context
**What goes wrong:** `await import('@lalex/console')` at module top level causes a syntax error if the output format is CommonJS (CJS does not support top-level await).
**Why it happens:** Rslib builds both ESM and CJS targets (see package.json exports). CJS output cannot contain top-level await.
**How to avoid:** Keep the logger detection in a file that is only imported by `client.ts` (which is bundled as part of the worker entry, not the CJS export). Alternatively, use an async IIFE or wrap detection in a function called before the first use. The safest approach: initialize `LL` synchronously with the shim, then swap asynchronously if @lalex/console is available.
**Warning signs:** Build error `Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022', 'esnext', 'system', 'node16', 'node18', 'nodenext', or 'preserve'`.

### Pitfall 2: TypeScript Narrowing on WorkerMessageData Log Variant
**What goes wrong:** Accessing `data.callId` before narrowing causes a TypeScript error because the `log` variant has no `callId`.
**Why it happens:** `WorkerMessageData` is a discriminated union; after adding the `log` variant, `data.callId` is only present on `ready | chunk | done | error` variants.
**How to avoid:** The `type: 'log'` branch must `return` early. Check `type === 'log'` first, return, then destructure `callId` safely.
**Warning signs:** TS error `Property 'callId' does not exist on type '{ type: "log"; level: LogLevel; scope: string; args: unknown[] }'`.

### Pitfall 3: shouldLog Severity Direction Confusion
**What goes wrong:** Filtering inverted — `debug` messages pass when they should be suppressed at `warn` level.
**Why it happens:** In @lalex/console, **lower** numeric value = **higher** severity. `error=3`, `warn=4`, `debug=9`. To suppress debug at warn: `9 > 4` → suppress. The comparison is `messageLevel <= currentLevel` in numeric terms.
**How to avoid:** Add a comment in `shouldLog` that explains the direction. Write a unit test: `shouldLog('debug', 'warn') === false` and `shouldLog('error', 'warn') === true`.
**Warning signs:** Verbose messages appearing in production (logLevel='warn') — or conversely, error messages being silenced.

### Pitfall 4: Shim Missing Methods Used at Call Sites
**What goes wrong:** Runtime error `LL.success is not a function` (or `LL.verb`, `LL.wth`).
**Why it happens:** The shim only implements methods named identically to @lalex/console. If a method is omitted from the shim, the call site throws.
**How to avoid:** Enumerate ALL methods called at client.ts LL.* sites: `debug` (line 531), `debug` (572), `verb` (579), `verb` (593), `success` (1021), `error` (1023). Also `level` setter (line 300) and `date` setter (line 9). The shim must implement all of these.
**Warning signs:** TypeScript error if shim type does not include the method — ensure the shim type covers all used methods.

### Pitfall 5: Worker Bundle Includes @lalex/console Despite Removal
**What goes wrong:** Tree-shaking does not eliminate @lalex/console from the worker bundle because it is still a resolved dependency.
**Why it happens:** Moving to `optionalDependencies` does not affect bundling — the bundler includes whatever is imported. Only removing the import from worker.ts eliminates it from the worker bundle.
**How to avoid:** Verify with `pnpm build` and inspect the worker chunk output — @lalex/console should not appear. This is automatically correct if the import is removed from worker.ts.

---

## Code Examples

### Current @lalex/console interface used in client.ts (verified by source inspection)

```typescript
// Lines 1, 8–9 — import + initialization
import { Logger } from '@lalex/console';
const LL = Logger.scope('sqlite/client');
LL.date = true;

// Line 300 — level setter
LL.level = clientOptions?.logLevel ?? 'warn';

// Lines 531, 572 — debug calls
LL.debug(`Acquire ${write ? 'writer' : 'reader'} worker ${availableWorker.index + 1}`);
LL.debug(`Releasing worker ${worker.index + 1}`);

// Lines 579, 593 — verb calls
LL.verb('Give', worker.index + 1, 'to next writer request');
LL.verb('Give', worker.index + 1, 'to next reader request');

// Lines 1021, 1023 — success + error calls
LL.success('SQLite worker pool initialized');
LL.error('Error initializing SQLite worker pool:', e);
```

### All LL.* call sites in worker.ts (verified by source inspection)

```typescript
// Lines 12, 20–21 — import + initialization (to be removed entirely)
import { Logger } from '@lalex/console';
const LL = Logger.scope('sqlite/worker');
LL.date = true;

// Line 295 — level assignment (replace with: currentLogLevel = logLevel ?? 'warn')
LL.level = logLevel ?? 'warn';

// Lines 106, 108 — debug calls in open()
LL.debug(`[Worker ${index + 1}] open() called with file:`, file);
LL.error(`[Worker ${index + 1}] Error: DB already opened`);

// Lines 124, 130, 139, 143, 146, 148, 151, 161, 165, 167 — debug/verb/warn in open() promise chain
// Lines 231, 243, 248, 256, 265, 268 — verb/wth/warn in query handler
// Line 295 — level setter in top-level onmessage
```

### postMessage log helper pattern for worker.ts

```typescript
// Replace all LL.X(...) in worker.ts with this pattern:
let currentLogLevel = 'warn';

function log(level: LogLevel, scope: string, ...args: unknown[]): void {
  if (shouldLog(level, currentLogLevel)) {
    self.postMessage({ type: 'log', level, scope, args });
  }
}

// Usage (replaces LL.debug(...)):
log('debug', `sqlite/worker ${index + 1}`, `open() called with file:`, file);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@lalex/console` in `dependencies` | `@lalex/console` in `optionalDependencies` | This phase | Consumers can install wsqlite without @lalex/console |
| Worker logs directly via LL.* | Worker posts `{ type: 'log' }` to client | This phase | All logging centralized on client thread |
| Static import of @lalex/console | Dynamic import with try/catch fallback | This phase | Bundle does not hard-require @lalex/console |

---

## Open Questions

1. **Top-level await in Rslib CJS output**
   - What we know: Rslib builds both ESM (`dist/esm/`) and CJS (`dist/cjs/`) targets per package.json exports. `client.ts` contains browser-only code that goes through the bundler at consumer build time, not directly into the CJS dist.
   - What's unclear: Whether `src/logger.ts` (if it uses top-level await) appears in the CJS distribution path. If `client.ts` is not exported directly (only `index.ts` is), the CJS issue may not apply.
   - Recommendation: Check `src/index.ts` exports — if client.ts is not exported standalone, top-level await in logger.ts is safe (only consumed by bundlers that support it). If in doubt, use the synchronous-init + async-swap pattern.

2. **Scope string in log messages from worker**
   - What we know: D-02 specifies `scope` as a field. Claude's discretion on whether worker index is in `scope` or `args`.
   - What's unclear: Exact format preferred.
   - Recommendation: Include worker index in the scope string: `scope: \`sqlite/worker ${index + 1}\``. This makes log output readable without changing args format.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — this is a pure code/config refactor with no new CLI tools, services, or runtimes required).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rstest 0.9.x (via @rstest/core + @rstest/adapter-rslib) |
| Config file | `rstest.config.ts` (unit); `rstest.browser.config.ts` (browser/integration) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test && pnpm test:browser` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-05 / D-07 | `shouldLog('debug', 'warn')` returns false | unit | `pnpm test -- --testNamePattern shouldLog` | ❌ Wave 0 |
| D-07 | `shouldLog('error', 'warn')` returns true | unit | `pnpm test -- --testNamePattern shouldLog` | ❌ Wave 0 |
| D-07 | `shouldLog('verb', 'warn')` returns false (verb treated as debug) | unit | `pnpm test -- --testNamePattern shouldLog` | ❌ Wave 0 |
| D-11 | Shim implements all methods (debug/info/warn/error/verb/wth/success/scope) | unit | `pnpm test -- --testNamePattern shim` | ❌ Wave 0 |
| D-04 | WorkerMessageData union accepts `type: 'log'` (TypeScript compile check) | type | `pnpm tsc --noEmit` | ✅ existing |
| D-08 | package.json optionalDependencies contains @lalex/console | manual / grep | `grep optionalDependencies package.json` | ✅ after edit |
| D-09 + D-10 | When @lalex/console available, LL uses real logger | integration (browser) | `pnpm test:browser` | existing infra |
| D-01–D-03 | Worker log messages appear in client console during integration tests | integration (browser) | `pnpm test:browser` | existing infra |

### Sampling Rate

- **Per task commit:** `pnpm test` (unit tests only, fast)
- **Per wave merge:** `pnpm test && pnpm tsc --noEmit`
- **Phase gate:** `pnpm test && pnpm test:browser && pnpm tsc --noEmit` before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/logger.test.ts` — covers `shouldLog` (D-05, D-07) and shim interface (D-11)

*(No framework install needed — existing Rstest infrastructure covers unit tests)*

---

## Sources

### Primary (HIGH confidence)

- Direct source inspection of `/workspaces/wsqlite/src/types.ts` — WorkerMessageData union shape
- Direct source inspection of `/workspaces/wsqlite/src/client.ts` — all LL.* call sites, onmessage handler
- Direct source inspection of `/workspaces/wsqlite/src/worker.ts` — all LL.* call sites, logLevel handling
- Direct source inspection of `/workspaces/wsqlite/src/orchestrator.ts` — confirms no LL usage
- Direct source inspection of `/workspaces/wsqlite/node_modules/@lalex/console/dist/types.d.ts` — Logger/ScopeLogger interface
- Direct source inspection of `/workspaces/wsqlite/node_modules/@lalex/console/dist/levels.d.ts` — LEVEL_METHODS numeric ordering
- Direct source inspection of `/workspaces/wsqlite/package.json` — current dependencies, build scripts
- Direct source inspection of `/workspaces/wsqlite/rstest.config.ts` — test framework configuration

### Secondary (MEDIUM confidence)

- npm documentation on `optionalDependencies` semantics — pnpm honors the same spec; install does not fail if package absent but does not auto-exclude either

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all findings from direct source inspection
- Architecture: HIGH — patterns derived from existing codebase patterns + verified type interfaces
- Pitfalls: HIGH — derived from TypeScript type constraints and build system inspection

**Research date:** 2026-03-24
**Valid until:** 2026-04-24 (stable codebase; no upstream library churn expected)
