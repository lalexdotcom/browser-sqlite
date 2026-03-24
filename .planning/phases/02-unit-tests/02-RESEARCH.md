# Phase 2: Unit Tests - Research

**Researched:** 2026-03-24
**Domain:** Rstest (rspack ecosystem), Node.js SharedArrayBuffer/Atomics, pure function testing
**Confidence:** HIGH — all findings verified by live execution against the actual installed packages

## Summary

Phase 2 adds the first real test suite to this project. The `tests/` directory is currently empty. Rstest 0.9.4 with `@rstest/adapter-rslib` 0.2.1 is already installed and configured. The `rstest.config.ts` already has `include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts']` and `passWithNoTests: true`, so adding `tests/unit/*.test.ts` files is sufficient — no configuration changes are required.

All test APIs (`describe`, `it`, `test`, `expect`, `beforeAll`, `afterAll`, etc.) are exported from `@rstest/core` and confirmed working with explicit import syntax. The `@rstest/adapter-rslib` bridge reads `rslib.config.ts`, and since no `target: 'web'` is set in rslib, the adapter automatically sets `testEnvironment: 'node'` — Node globals (`Buffer`, `process`, `SharedArrayBuffer`, `Atomics`) are available in test files with no extra configuration.

`SharedArrayBuffer` and all `Atomics` operations work correctly in Node 24 without any flags. The only constraint is `Atomics.wait()` called with a matching value on the main thread will block indefinitely (it does not throw) — which is why CONTEXT.md D2 restricts unit tests to the non-blocking lock case only. The non-blocking path (CAS when lock is FREE) was verified to work correctly in Node. All source module imports — `../../src/utils`, `../../src/debug`, `../../src/orchestrator` — resolve and execute correctly in rstest.

**Primary recommendation:** Create `tests/unit/utils.test.ts`, `tests/unit/debug.test.ts`, and `tests/unit/orchestrator.test.ts`. Import test APIs from `@rstest/core`. No config changes needed. Run with `pnpm test`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D1 — Test file naming convention**
`*.test.ts` files inside `tests/unit/` directory.
Files: `tests/unit/utils.test.ts`, `tests/unit/debug.test.ts`, `tests/unit/orchestrator.test.ts`
The existing rstest `include` pattern (`tests/**/*.test.ts`) already covers this. No change to `rstest.config.ts` needed for the include pattern.

**D2 — WorkerOrchestrator lock/unlock testing strategy**
Test the non-blocking case only in Node unit tests; defer blocking behavior to Phase 3 browser integration tests.
What to test in Phase 2 (Node-safe):
- `lock()` when the lock is already free — acquires immediately (no `Atomics.wait` called, CAS succeeds on first try)
- `unlock()` after acquiring — releases the lock (state returns to FREE, notify is called)
- `setStatus()` unconditional exchange — sets new status, returns true if value changed
- `setStatus()` CAS variant — only updates when `from` matches current status
- `getStatus()` — reads correct status for each worker index
- SAB sharing — two `WorkerOrchestrator` instances sharing the same `SharedArrayBuffer` observe each other's status changes

What is deferred to Phase 3:
- `lock()` blocking behavior when lock is already held (requires two concurrent threads)

**D3 — `isWriteQuery` regex extension**
Extend the regex to include `PRAGMA` and `ATTACH`/`DETACH`.
New regex target: `/(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP|PRAGMA|ATTACH|DETACH)\s/gim`
Tests validate the extended behavior — standard DML, DDL, extended keywords, read-only, CTE write, lowercase variants.
Note: All PRAGMAs treated as writes (conservative routing, no per-pragma discrimination).

### Claude's Discretion

None captured during this discussion.

### Deferred Ideas (OUT OF SCOPE)

None captured during this discussion.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-01 | Remove placeholder `squared()` test — replace `tests/index.test.ts` with real test infrastructure | tests/ directory is empty (placeholder already gone per CONTEXT.md note); creating `tests/unit/` with real tests satisfies this |
| TEST-02 | Unit tests for `isWriteQuery()` — covers standard DML, DDL, edge cases (PRAGMA, CTEs, WITH...INSERT, ATTACH) | Regex extension pattern confirmed; all cases documented in D3; import from `../../src/utils` verified working |
| TEST-03 | Unit tests for `sqlParams()` — parameter deduplication logic, positional and named variants | `sqlParams()` factory confirmed importable and functional; Map-based deduplication and `?001` format verified |
| TEST-04 | Unit tests for `debugSQLQuery()` — parameter interpolation correctness | `debugSQLQuery` import confirmed working; Buffer path tested; string literal skipping confirmed; all value types reachable |
| TEST-05 | Unit tests for `WorkerOrchestrator` — lock/unlock, setStatus/getStatus, compareExchangeStatus, state transitions (testable in Node via native SharedArrayBuffer) | All patterns confirmed working in Node 24; non-blocking lock, SAB sharing, CAS all verified live |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@rstest/core` | 0.9.4 (installed) | Test runner, provides `describe`/`it`/`test`/`expect` etc. | Project's chosen test framework; consistent with Rspack build pipeline |
| `@rstest/adapter-rslib` | 0.2.1 (installed) | Bridges rslib config into rstest | Already in rstest.config.ts; auto-detects Node environment |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/node` | ^24.12.0 (installed) | TypeScript types for `Buffer`, `process`, `SharedArrayBuffer` | Available for test files; needed for Buffer type annotations |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@rstest/core` explicit imports | `globals: true` in rstest config | Globals avoids per-file imports but requires tsconfig `/// <reference types="@rstest/core/globals" />` in test files; explicit imports are cleaner and verified working |

**Installation:** Nothing to install — all dependencies are already present.

**Version verification:** Confirmed via `node_modules/@rstest/core/package.json` and `node_modules/@rstest/adapter-rslib/package.json`.

## Architecture Patterns

### Recommended Project Structure

```
tests/
└── unit/
    ├── utils.test.ts        # isWriteQuery, sqlParams
    ├── debug.test.ts        # debugSQLQuery
    └── orchestrator.test.ts # WorkerOrchestrator
```

No `tests/index.test.ts` — the placeholder file no longer exists (tests/ directory is empty per CONTEXT.md).

### Pattern 1: Explicit Import of Test APIs

**What:** Import `describe`, `it`, `expect` explicitly from `@rstest/core` in every test file.

**When to use:** Always — confirmed working pattern, no globals config needed.

**Example:**
```typescript
// Source: verified live against @rstest/core@0.9.4
import { describe, it, expect } from '@rstest/core';
import { isWriteQuery, sqlParams } from '../../src/utils';

describe('isWriteQuery', () => {
  it('returns true for INSERT', () => {
    expect(isWriteQuery('INSERT INTO t VALUES (?)')).toBe(true);
  });
});
```

### Pattern 2: Two-Instance SAB Sharing for WorkerOrchestrator

**What:** Create a primary orchestrator with pool size (allocates SAB), then pass its `sharedArrayBuffer` to a second instance. Status changes on one are visible on the other.

**When to use:** Testing cross-thread visibility semantics without actual threads.

**Example:**
```typescript
// Source: verified live against src/orchestrator.ts
import { describe, it, expect } from '@rstest/core';
import { WorkerOrchestrator, WorkerStatuses } from '../../src/orchestrator';

describe('WorkerOrchestrator SAB sharing', () => {
  it('two instances sharing same SAB observe each other\'s status changes', () => {
    const orch1 = new WorkerOrchestrator(2);
    const orch2 = new WorkerOrchestrator(orch1.sharedArrayBuffer);
    orch1.setStatus(0, WorkerStatuses.READY);
    expect(orch2.getStatus(0)).toBe(WorkerStatuses.READY);
  });
});
```

### Pattern 3: Non-blocking lock/unlock Test

**What:** Call `lock()` when the orchestrator is freshly initialized (lock is FREE). The CAS succeeds immediately, so `Atomics.wait` is never reached.

**When to use:** Testing lock acquisition and release in Node main thread (D2 constraint).

**Example:**
```typescript
// Source: verified live — lock() only calls Atomics.wait if CAS fails
it('lock() acquires when FREE, unlock() releases', () => {
  const orch = new WorkerOrchestrator(1);
  orch.lock();   // CAS FREE→LOCKED succeeds immediately, no wait
  orch.unlock(); // CAS LOCKED→FREE + notify
  orch.lock();   // acquirable again
  orch.unlock();
});
```

### Pattern 4: CAS setStatus

**What:** `setStatus(index, newStatus, fromStatus)` uses `Atomics.compareExchange` — returns `true` only if the current value matched `from`. The unconditional variant (`setStatus(index, newStatus)`) uses `Atomics.exchange` and returns `true` if the value changed.

**Example:**
```typescript
it('setStatus CAS: returns false when from does not match', () => {
  const orch = new WorkerOrchestrator(2);
  // Initial status is EMPTY
  const ok = orch.setStatus(0, WorkerStatuses.NEW, WorkerStatuses.EMPTY); // EMPTY→NEW: ok
  expect(ok).toBe(true);
  const fail = orch.setStatus(0, WorkerStatuses.READY, WorkerStatuses.EMPTY); // wrong from
  expect(fail).toBe(false);
  expect(orch.getStatus(0)).toBe(WorkerStatuses.NEW); // unchanged
});
```

### Pattern 5: debugSQLQuery Buffer Path

**What:** `debugSQLQuery` checks `Buffer.isBuffer(value) || value instanceof Uint8Array` and formats as `X'<hex>'`. `Buffer` is a Node.js built-in, available in the rstest Node environment.

**Example:**
```typescript
it('formats Buffer as hex literal', () => {
  const buf = Buffer.from([0x41, 0x42]);
  expect(debugSQLQuery('SELECT ?001', [buf])).toBe("SELECT X'4142'");
});
```

### Anti-Patterns to Avoid

- **Calling `Atomics.wait` with a matching value on the main thread:** The Node.js main thread IS allowed to call `Atomics.wait` (unlike browsers), but if the value matches and no other thread notifies, it blocks indefinitely. The lock/unlock tests avoid this by only testing the FREE→LOCKED path (value always mismatches the wait condition).
- **Using `globals: true` without tsconfig reference:** If globals mode is enabled, test files need `/// <reference types="@rstest/core/globals" />` for TypeScript to recognize `describe`/`it` etc. Explicit imports are simpler.
- **Importing `src/debug.ts` without `src/types.ts` being resolvable:** `debug.ts` has `import type` from `./client` and `./types` — these are type-only imports and do not cause runtime issues. Verified working in probe tests.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test matchers | Custom assertion helpers | `expect(...).toBe()`, `.toEqual()`, `.toThrow()` from `@rstest/core` | Already available, handles deep equality, error messages |
| Spy / mock utilities | Manual function wrapping | `rs.fn()` / `rs.spyOn()` from `@rstest/core` (`rs` is the utilities namespace) | Phase 2 doesn't need mocks, but they exist if needed |
| SAB simulation | Fake SharedArrayBuffer | Native `new SharedArrayBuffer(n)` in Node 24 | SAB works natively, no flag needed |

**Key insight:** The test runner already compiles TypeScript via Rspack — no separate `ts-node` or `tsx` compilation is needed. Tests import `../../src/utils` directly as TypeScript source.

## Common Pitfalls

### Pitfall 1: Atomics.wait blocks the main thread silently

**What goes wrong:** A test that inadvertently acquires the lock first and then calls `lock()` again (or calls `lock()` when the lock is LOCKED) will hang indefinitely. `pnpm test` appears to freeze with no output.

**Why it happens:** Node.js allows `Atomics.wait` on the main thread (unlike browsers). When the value matches, it blocks. There is no timeout unless one is explicitly passed as the 4th argument.

**How to avoid:** Only test `lock()` when the orchestrator is freshly created (lock is FREE). Never hold the lock and call `lock()` again in the same test. Per D2, blocking behavior is deferred to Phase 3.

**Warning signs:** `pnpm test` hangs after building. Use `Ctrl+C` and review which test is running.

### Pitfall 2: Regex stateful `g` flag between tests

**What goes wrong:** The `isWriteQuery` regex uses the `g` flag: `/(INSERT|...)\s/gim.test(sql)`. In JavaScript, a regex literal with `g` is stateless when created inline (as it is in `utils.ts` — a new regex is created each call). However, if a test stores the regex in a variable and reuses it, `lastIndex` carries over between `.test()` calls, causing alternating true/false results.

**Why it happens:** `RegExp.prototype.test()` advances `lastIndex` when the `g` flag is set and the regex is reused.

**How to avoid:** Always call `isWriteQuery(sql)` — don't extract or reuse the regex object across calls. The current implementation creates a new regex literal per call, so this is not a problem in production code, only in tests that might try to access the regex directly.

**Warning signs:** A test passes in isolation but fails when run alongside others, or alternates pass/fail on repeated calls.

### Pitfall 3: `setStatus` return value for unchanged unconditional exchange

**What goes wrong:** The unconditional `setStatus(index, status)` (no `from`) returns `false` when the old value equals the new value (i.e., no change). A test that checks `expect(result).toBe(true)` after setting the same status twice will fail on the second call.

**Why it happens:** The implementation: `if (oldStatus !== status) oldValue = oldStatus as WorkerStatus`. If the value is already the target, `oldValue` stays `undefined`, and `success = false`.

**How to avoid:** When testing the unconditional path, use a different status from the current one to ensure a change occurs.

### Pitfall 4: `debug.ts` imports cause TypeScript errors in tests

**What goes wrong:** `debug.ts` imports `type { CreateSQLiteClientOptions }` from `./client` and `type { SQLiteVFS }` from `./types`. If TypeScript in test compilation cannot resolve these, it errors. However, since these are `import type` (erased at runtime), rstest can still execute the module — but `tsc --noEmit` (run in pre-commit) may complain if `tests/` is not in tsconfig scope.

**Why it happens:** `tsconfig.json` only includes `src`, not `tests/`.

**How to avoid:** Tests import only `debugSQLQuery` from `debug.ts` — this works at runtime. For TypeScript checking of test files, either extend tsconfig to include `tests/` or add a `tsconfig.test.json` with `{ "extends": "./tsconfig.json", "include": ["src", "tests"] }`. Note: the pre-commit hook runs `pnpm exec tsc --noEmit` which uses the root `tsconfig.json` — if tests import from `src/`, TypeScript will not check those imports unless `tests/` is included.

**Warning signs:** `pnpm test` passes but `pnpm exec tsc --noEmit` reports errors on test files.

**Resolution:** Either add a `tsconfig.test.json` that extends root tsconfig with `"include": ["src", "tests"]` and point rstest at it (via `source.tsconfigPath`), or accept that test files are not typecheck-validated by the pre-commit hook (tests are compiled by rstest/Rspack, not tsc). Given the pre-commit hook runs `pnpm exec tsc --noEmit` with no explicit config flag, it uses the root tsconfig which excludes `tests/` — test files are out of tsc scope already, so no action needed unless typecheck coverage of tests is desired.

### Pitfall 5: `isWriteQuery` regex requires PRAGMA/ATTACH/DETACH extension before tests

**What goes wrong:** Running `isWriteQuery('PRAGMA journal_mode = WAL')` against the current code returns `false`. TEST-02 tests require the extended regex, but the regex extension (D3) is code work that must happen in the same phase.

**Why it happens:** The current implementation only covers `INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP`.

**How to avoid:** Plan 2 must include both the regex extension in `src/utils.ts` AND the test that verifies it. The tests for PRAGMA/ATTACH/DETACH will fail if written before the source is updated.

## Code Examples

Verified patterns from live execution:

### isWriteQuery — current and post-extension behavior

```typescript
// Current (failing for PRAGMA):
/(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP)\s/gim.test('PRAGMA journal_mode = WAL')
// → false

// After D3 extension:
/(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP|PRAGMA|ATTACH|DETACH)\s/gim.test('PRAGMA journal_mode = WAL')
// → true
```

### sqlParams — deduplication and positional format

```typescript
// Source: verified against src/utils.ts
const p = sqlParams();
p.addParam('alice'); // → '?001'
p.addParam('bob');   // → '?002'
p.addParam('alice'); // → '?001' (deduplicated via Map)
p.params;            // → ['alice', 'bob'] (length 2, not 3)
```

### debugSQLQuery — all value types

```typescript
// Source: verified against src/debug.ts
debugSQLQuery('SELECT ?001', ['Alice'])          // → "SELECT 'Alice'"
debugSQLQuery('SELECT ?001', [42])               // → "SELECT 42"
debugSQLQuery('SELECT ?001', [true])             // → "SELECT true"
debugSQLQuery('SELECT ?001', [null])             // → "SELECT NULL"
debugSQLQuery('SELECT ?001', [undefined])        // → "SELECT NULL"
debugSQLQuery('SELECT ?001', [new Date('2024-01-15T00:00:00.000Z')])
                                                 // → "SELECT '2024-01-15T00:00:00.000Z'"
debugSQLQuery('SELECT ?001', [Buffer.from([0x41, 0x42])])
                                                 // → "SELECT X'4142'"

// Positional vs bare ?
debugSQLQuery('SELECT ?, ?', ['a', 'b'])         // → "SELECT 'a', 'b'"
debugSQLQuery('SELECT ?001, ?001', ['x'])        // → "SELECT 'x', 'x'"  (same index, same value)

// String literal with embedded ? is skipped
debugSQLQuery("SELECT '?' FROM t", [])           // → "SELECT '?' FROM t"

// String escaping
debugSQLQuery('SELECT ?001', ["it's a test"])    // → "SELECT 'it''s a test'"
```

### WorkerOrchestrator initial state

```typescript
// Source: verified against src/orchestrator.ts
const orch = new WorkerOrchestrator(3); // size=3
orch.getStatus(0); // → WorkerStatuses.EMPTY (-3)
orch.getStatus(1); // → WorkerStatuses.EMPTY (-3)
orch.getStatus(2); // → WorkerStatuses.EMPTY (-3)
// flags[0] = WorkerLock.FREE (0) — INIT_LOCK slot
// flags[1..3] = WorkerStatuses.EMPTY (-3) — per-worker status
```

### WorkerStatuses constants (for test assertions)

```typescript
// From src/orchestrator.ts
WorkerStatuses.EMPTY        // -3
WorkerStatuses.NEW          // -2
WorkerStatuses.INITIALIZING // -1
WorkerStatuses.INITIALIZED  //  0
WorkerStatuses.READY        // 10
WorkerStatuses.RESERVED     // 49
WorkerStatuses.RUNNING      // 50
WorkerStatuses.ABORTING     // 99
WorkerStatuses.DONE         // 100
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `tests/index.test.ts` with `squared()` placeholder | Empty `tests/` directory | Phase 1 cleanup | Plan 1 needs to create `tests/unit/` directory and populate it |
| Jest for unit tests | Rstest (Rspack ecosystem) | Project decision (see STATE.md) | Different import path (`@rstest/core` not `jest`) |

**Deprecated/outdated:**
- `tests/index.test.ts`: Already deleted. No action needed to remove it.

## Open Questions

1. **TypeScript coverage of test files**
   - What we know: `tsconfig.json` only `include: ["src"]`. The pre-commit hook runs `tsc --noEmit` which respects this tsconfig. Test files are compiled by rstest/Rspack, not tsc.
   - What's unclear: Whether the team wants `tsc --noEmit` to type-check test files as well.
   - Recommendation: Leave as-is for Phase 2. Test compilation errors will surface via `pnpm test`. If type-checking tests is desired, add `tsconfig.test.json` in a future phase.

2. **`defer` unused import in orchestrator.ts**
   - What we know: `import { defer } from '@lalex/promises'` is in `orchestrator.ts` but `defer` is never used in the file.
   - What's unclear: Whether this will cause a lint/typecheck warning that blocks the pre-commit hook.
   - Recommendation: Not a blocker — Biome is the linter and it warns on unused imports, but the pre-commit only runs `biome check --write` on staged files. As long as `orchestrator.ts` is not re-staged, it won't be rechecked. Document as a tech-debt note.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Test execution | Yes | v24.14.0 | — |
| `@rstest/core` | Test runner | Yes | 0.9.4 | — |
| `@rstest/adapter-rslib` | Rslib config bridge | Yes | 0.2.1 | — |
| `@types/node` | Buffer types in tests | Yes | ^24.12.0 | — |
| `@lalex/promises` | `orchestrator.ts` import chain | Yes | ^1.2.0 | — |
| `SharedArrayBuffer` (Node) | WorkerOrchestrator tests | Yes | native Node 24 | — |
| `Atomics` (Node) | lock/unlock/CAS tests | Yes | native Node 24 | — |
| `Buffer` (Node) | debugSQLQuery Buffer tests | Yes | native Node 24 | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | @rstest/core 0.9.4 |
| Config file | `rstest.config.ts` (root) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 | Real tests run (no squared placeholder) | structural | `pnpm test` | No — Wave 0: create `tests/unit/` |
| TEST-02 | `isWriteQuery` covers DML, DDL, PRAGMA, ATTACH, CTEs, lowercase | unit | `pnpm test` | No — Wave 0 |
| TEST-03 | `sqlParams` deduplication, positional format, array variant | unit | `pnpm test` | No — Wave 0 |
| TEST-04 | `debugSQLQuery` interpolation: positional, bare ?, Buffer, Date, null, string escaping, literal skipping | unit | `pnpm test` | No — Wave 0 |
| TEST-05 | `WorkerOrchestrator` lock/unlock (non-blocking), setStatus/getStatus, CAS, SAB sharing | unit | `pnpm test` | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/utils.test.ts` — covers TEST-01, TEST-02, TEST-03
- [ ] `tests/unit/debug.test.ts` — covers TEST-01, TEST-04
- [ ] `tests/unit/orchestrator.test.ts` — covers TEST-01, TEST-05
- [ ] `tests/unit/` directory (mkdir) — required before any test files can be placed

*(No framework install needed — rstest is already installed and configured.)*

## Sources

### Primary (HIGH confidence)

- Direct inspection of `node_modules/@rstest/core/dist/index.js` and `index.d.ts` — confirmed `describe`, `it`, `test`, `expect`, `beforeAll`, `afterAll` all exported from `@rstest/core`
- Direct inspection of `node_modules/@rstest/adapter-rslib/dist/index.js` — confirmed `testEnvironment: 'node'` when rslib target is not `'web'`
- Live probe execution: 12 test cases run and passed against the actual rstest 0.9.4 environment
- Direct reading of `src/utils.ts`, `src/debug.ts`, `src/orchestrator.ts` — source of truth for all function signatures and behavior
- Node.js 24.14.0 live execution: SAB, Atomics.compareExchange, Atomics.notify, Atomics.wait (non-blocking), Buffer all confirmed working in main thread

### Secondary (MEDIUM confidence)

- rstest.rs official docs (https://rstest.rs/guide/start/quick-start) — confirmed `import { expect, test } from '@rstest/core'` pattern; limited detail on describe/it (confirmed via package inspection instead)

### Tertiary (LOW confidence)

None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified installed versions, confirmed all imports and test execution live
- Architecture: HIGH — probe tests executed and passed; all patterns verified against actual source
- Pitfalls: HIGH — Atomics.wait blocking behavior verified empirically; regex g-flag issue is documented JavaScript spec behavior

**Research date:** 2026-03-24
**Valid until:** 2026-06-24 (stable ecosystem — rstest is pre-1.0 but minor version upgrades unlikely to break patterns)
