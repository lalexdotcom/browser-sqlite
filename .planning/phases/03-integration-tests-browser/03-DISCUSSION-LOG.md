# Phase 3: Integration Tests (Browser) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the discussion.

**Date:** 2026-03-24
**Phase:** 03-integration-tests-browser
**Mode:** discuss
**Areas discussed:** VFS for test database, Database cleanup strategy, COOP/COEP header setup

## Gray Areas Presented

| Area | Description |
|------|-------------|
| VFS for test database | IDBBatchAtomicVFS vs OPFSPermutedVFS vs both |
| Database cleanup strategy | Unique name only vs unique + afterEach vs fixed name + beforeEach |
| COOP/COEP header setup | Rsbuild server.headers vs custom plugin vs Playwright context options |

## Decisions Made

### VFS for test database
- **User chose:** OPFSPermutedVFS
- **Reason:** Tests the real default production path end-to-end

### Database cleanup strategy
- **User chose:** Unique name per test + afterEach cleanup
- **Reason:** Belt-and-suspenders — no leftover OPFS state even if a test crashes

### COOP/COEP header setup
- **User chose:** Rsbuild server.headers config (Recommended)
- **Reason:** Clean and declarative — Rstest's dev server inherits Rsbuild server options

## Additional Context from User

- User specified Rstest browser mode (not standalone Playwright) — handles headless browser
  installation automatically, keeping the toolchain unified around Rstest.

## Corrections Made

No corrections — all recommended options were accepted or user provided alternatives directly.
