# TESTING.md — Testing

## Framework
- **Rstest** (`@rstest/core ^0.9.0`) — test runner compatible with Rslib projects
- **Rstest Rslib adapter** (`@rstest/adapter-rslib ^0.2.1`) — integrates build config

## Configuration
`rstest.config.ts`:
```typescript
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
});
```
The adapter ensures test files are compiled using the same Rslib/Rspack pipeline.

## Test Commands
```bash
pnpm run test          # Run all tests once
pnpm run test:watch    # Run tests in watch mode
```

## Current Test Coverage
**File:** `tests/index.test.ts`

```typescript
import { expect, test } from '@rstest/core';
import { squared } from '../src/index';

test('squared', () => {
  expect(squared(2)).toBe(4);
  expect(squared(12)).toBe(144);
});
```

**Coverage:** Minimal — only tests a `squared()` placeholder function which is **not part of the real API**.
The library's core functionality (`createSQLiteClient`, worker pool, VFS, streaming, etc.) has **no tests at all**.

## Real API Surface Needing Tests
The following are completely untested:
- `createSQLiteClient()` initialization and pool creation
- `db.read()` with various query types
- `db.write()` with INSERT/UPDATE/DELETE
- `db.stream()` streaming chunked results
- `db.one()` single row retrieval
- Worker pool: worker acquisition, queuing, release
- `WorkerOrchestrator`: lock/unlock, status transitions
- `isWriteQuery()` regex correctness edge cases
- `sqlParams()` parameter deduplication logic
- `debugSQLQuery()` parameter interpolation
- AbortSignal / query cancellation
- Error handling during worker init / query failure

## Test Infrastructure Gaps
- No mocking for `Web Workers` or `SharedArrayBuffer` (browser APIs not available in Node.js test environment)
- No test for VFS initialization or wa-sqlite integration
- No browser-based testing setup (Playwright, Vitest Browser Mode, etc.)
- No test fixtures or factories for database setup/teardown

## Testing Constraints
Since the library targets **browser-only APIs** (Web Workers, OPFS, SharedArrayBuffer), testing the full
stack requires a browser-like environment. Options to consider:
- **Rstest with JSDOM** — for main-thread logic only
- **Playwright / Puppeteer** — for full integration tests in a real browser
- **Vitest Browser Mode** — if migrating test runner
- **Unit tests for pure functions** — `isWriteQuery`, `sqlParams`, `debugSQLQuery` can be tested without browser APIs
