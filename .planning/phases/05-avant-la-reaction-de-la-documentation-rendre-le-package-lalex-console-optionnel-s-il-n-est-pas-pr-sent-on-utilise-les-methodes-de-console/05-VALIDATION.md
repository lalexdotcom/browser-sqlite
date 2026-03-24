---
phase: 5
slug: 05-lalex-console-optional
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rstest 0.9.x (via @rstest/core + @rstest/adapter-rslib) |
| **Config file** | `rstest.config.ts` (unit); `rstest.browser.config.ts` (browser) |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && pnpm test:browser && pnpm tsc --noEmit` |
| **Estimated runtime** | ~15 seconds (unit); ~60 seconds (full) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test && pnpm tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green (`pnpm test && pnpm test:browser && pnpm tsc --noEmit`)
- **Max feedback latency:** 15 seconds (unit run)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 5-W0-01 | W0 | 0 | D-05, D-07, D-11 | unit stub | `pnpm test` | ❌ Wave 0 | ⬜ pending |
| 5-01-01 | 01 | 1 | D-08 | grep | `grep optionalDependencies package.json` | ✅ after edit | ⬜ pending |
| 5-01-02 | 01 | 1 | D-04 | type | `pnpm tsc --noEmit` | ✅ existing | ⬜ pending |
| 5-02-01 | 02 | 1 | D-07 | unit | `pnpm test -- --testNamePattern shouldLog` | ❌ Wave 0 | ⬜ pending |
| 5-02-02 | 02 | 1 | D-11 | unit | `pnpm test -- --testNamePattern shim` | ❌ Wave 0 | ⬜ pending |
| 5-03-01 | 03 | 2 | D-01–D-03 | integration | `pnpm test:browser` | ✅ existing infra | ⬜ pending |
| 5-03-02 | 03 | 2 | D-09, D-10 | integration | `pnpm test:browser` | ✅ existing infra | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/logger.test.ts` — stubs for `shouldLog` (D-05, D-07) and shim interface (D-11)

*Existing Rstest infrastructure covers all other phase requirements — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| @lalex/console absent → native console used | D-09 | Cannot easily simulate missing optionalDep in unit tests | Run with `@lalex/console` removed from node_modules; observe console output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
