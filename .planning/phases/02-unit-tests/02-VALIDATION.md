---
phase: 2
slug: unit-tests
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rstest 0.9.4 (`@rstest/core`) with `@rstest/adapter-rslib` |
| **Config file** | `rstest.config.ts` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | TEST-01 | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 2-02-01 | 02 | 1 | TEST-02, TEST-03 | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 2-02-02 | 02 | 1 | TEST-04 | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 2-03-01 | 03 | 2 | TEST-05 | unit | `pnpm test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/utils.test.ts` — stubs for TEST-02, TEST-03
- [ ] `tests/unit/debug.test.ts` — stubs for TEST-04
- [ ] `tests/unit/orchestrator.test.ts` — stubs for TEST-05

*These files don't exist yet — the executor creates them as part of Wave 1.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
