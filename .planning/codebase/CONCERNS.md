# CONCERNS.md — Technical Concerns

## Critical: Placeholder vs. Real API Mismatch

**Severity: HIGH**

`src/index.ts` exports from `src/client.ts` — the full SQLite API — but `tests/index.test.ts` imports
a function `squared()` that does not exist in `client.ts`. The test is a scaffolding placeholder that
was never updated to test the real API.

```typescript
// tests/index.test.ts — imports non-existent function
import { squared } from '../src/index';
```

This means the test suite passes with 0 coverage of the actual library. If this were published,
consumers would have no test safety net.

---

## Tech Debt

### @ts-expect-error Usage
`src/worker.ts` has multiple `@ts-expect-error` directives on all wa-sqlite imports and VFS imports.
The wa-sqlite package has no official TypeScript declarations. This suppresses real type errors
and makes refactoring risky.

```typescript
// @ts-expect-error
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
// @ts-expect-error
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
```
**Recommendation:** Create a `wa-sqlite.d.ts` ambient declaration file to restore type safety.

### Hardcoded Logger Levels
Logger levels are hardcoded in module scope and committed:
```typescript
// src/client.ts
LL.level = 'info';
LL.date = true;

// src/worker.ts
LL.level = 'debug';
LL.date = LL.level === 'debug';
```
Worker logs are at `debug` level but this setting is hardcoded. Consumers cannot control verbosity.
Production builds may be noisier than expected.

### Commented-Out Code
Multiple `console.log` lambda setups and `LL.wth()` calls are commented out in `src/client.ts`
and `src/worker.ts`. These suggest development debug paths not yet cleaned up.

### Pragma Bug in worker.ts
The `allQueryPragmas` logic in `src/worker.ts` has an inverted condition:
```typescript
const allQueryPragmas = Object.keys(pragmas).length
  ? ''  // ← empty string when there ARE pragmas
  : Object.entries(pragmas).map(...).join('');  // ← builds pragmas when length is 0
```
This is almost certainly a bug — pragmas are never actually applied.

---

## Performance Concerns

### Busy-Wait Lock in Worker
`WorkerOrchestrator.lock()` uses a busy-wait loop with `Atomics.wait()`:
```typescript
while (Atomics.compareExchange(...) !== WorkerLock.FREE) {
  Atomics.wait(this.flags, FlagsIndexes.INIT_LOCK, WorkerLock.LOCKED);
}
```
This blocks the worker thread during initialization. Acceptable for one-time startup but could
cause issues with many workers or slow WASM initialization.

### Writer Stickiness
The "current writer" designation (`currentWriterIndex`) is only cleared when a reader request
is pending. If there are no reader requests, the writer worker remains designated indefinitely
even after the write completes. This may prevent read-query load balancing.

---

## Security Concerns

### `any` Parameters
SQL parameters typed as `any[]`:
```typescript
| { type: 'sql'; sql: string; params?: any[]; options?: ... }
```
This bypasses TypeScript type checking for query parameters. Consumers could accidentally pass
objects or functions as SQL parameters.

### No Input Validation on SQL
`isWriteQuery()` uses a regex heuristic to classify queries. It could miss:
- `PRAGMA` statements that modify state
- `ATTACH DATABASE`
- Stored procedures / CTEs that contain DML

This affects which worker handles the query (read vs write pool), not SQL injection
(wa-sqlite uses parameterized queries properly).

---

## Missing Features (Implied by Code)

- `debug.ts` exports a `createClientDebug` and `createWorkerDebugState` infrastructure but
  it's only used in `client.ts` when `clientOptions.debug = true`. No documentation on the
  shape of debug state or how to use it.
- `RESERVED` worker status (value 49) is defined but has a comment: *(not used in current implementation)*
- Transaction support is mentioned in JSDoc comments but not implemented in the public API

---

## Dependency Risks

| Concern | Detail |
|---|---|
| `wa-sqlite` is a GitHub dependency | Not on npm — version pinned to `#v1.0.9` tag; no semver, no audit |
| `@lalex/console` is private/pre-release | `2.0.0-rc.1` — RC version; API may change |
| `@lalex/promises` | Not listed in `package.json` dependencies (used via transitive dep?) |

---

## Browser Compatibility Constraints
- **SharedArrayBuffer** requires `Cross-Origin-Isolation` headers (`COOP`/`COEP`) in the browser
- **OPFS** requires modern Chrome/Edge (Safari partial support as of 2024)
- **JSPI** (for `OPFSAdaptiveVFS`) is experimental — Chrome only
- No fallback or capability detection for incompatible environments
