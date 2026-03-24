---
phase: 4
slug: documentation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rstest 0.9.x |
| **Config file** | `rstest.config.ts` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && pnpm test:browser` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm exec tsc --noEmit` (catch accidental JSDoc breakage)
- **After every plan wave:** Run `pnpm test` (regression check — no source logic changed)
- **Before `/gsd:verify-work`:** Full suite green + human review of JSDoc hover output
- **Max feedback latency:** ~5 seconds (tsc --noEmit)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 04-01-01 | 01 | 1 | DOC-01 | manual | `pnpm exec tsc --noEmit` | ⬜ pending |
| 04-01-02 | 01 | 1 | DOC-02 | manual | `pnpm exec tsc --noEmit` | ⬜ pending |
| 04-01-03 | 01 | 1 | DOC-03 | manual | `pnpm exec tsc --noEmit` | ⬜ pending |
| 04-02-01 | 02 | 1 | DOC-04 | manual | `pnpm exec tsc --noEmit` | ⬜ pending |
| 04-03-01 | 03 | 2 | DOC-05 | manual | `pnpm exec tsc --noEmit` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test files needed — documentation changes do not require test stubs.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `createSQLiteClient` JSDoc complete | DOC-01 | IDE hover verification | Hover over `createSQLiteClient` in VS Code — confirm all @param, @throws, @example visible |
| All 8 SQLiteDB methods have JSDoc | DOC-02 | IDE hover verification | Hover over each method in SQLiteDB type — confirm @param + @returns present |
| Each CreateSQLiteClientOptions field has JSDoc | DOC-03 | IDE hover verification | Hover over `name`, `poolSize`, `vfs`, `pragmas`, `logLevel` fields |
| WorkerOrchestrator + state machine documented | DOC-04 | Source review | Read orchestrator.ts + worker.ts; state machine sequence EMPTY→READY→RUNNING→DONE must be visible |
| README covers required sections | DOC-05 | Document review | Check: COOP/COEP first, install, VFS table with link, usage examples, limitations |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
