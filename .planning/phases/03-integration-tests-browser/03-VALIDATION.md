---
phase: 3
slug: integration-tests-browser
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rstest browser mode (`@rstest/browser` + Playwright) |
| **Config file** | `rstest.browser.config.ts` — Wave 0 creates this |
| **Quick run command** | `pnpm rstest --config rstest.browser.config.ts --reporter=dot` |
| **Full suite command** | `pnpm rstest --config rstest.browser.config.ts` |
| **Estimated runtime** | ~30–60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm rstest --config rstest.browser.config.ts --reporter=dot`
- **After every plan wave:** Run `pnpm rstest --config rstest.browser.config.ts`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 0 | INT-01 | infra | `pnpm rstest --config rstest.browser.config.ts --reporter=dot` | ❌ W0 | ⬜ pending |
| 3-01-02 | 01 | 0 | INT-01 | infra | `ls tests/browser/helpers.ts` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 1 | INT-02 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-02-02 | 02 | 1 | INT-03 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-02-03 | 02 | 1 | INT-04 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-02-04 | 02 | 1 | INT-05 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-02-05 | 02 | 1 | INT-06 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-03-01 | 03 | 1 | INT-07 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-03-02 | 03 | 1 | INT-08 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-03-03 | 03 | 1 | INT-09 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |
| 3-03-04 | 03 | 1 | INT-10 | browser | `pnpm rstest --config rstest.browser.config.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `rstest.browser.config.ts` — browser-mode Rstest config with Playwright Chromium + COOP/COEP headers
- [ ] `tests/browser/helpers.ts` — `createTestClient()` helper with OPFS/IDB isolation (UUID-based DB names + afterEach cleanup)
- [ ] `@rstest/browser` + `playwright` — install via `pnpm add -D @rstest/browser playwright`
- [ ] `playwright install chromium` — Chromium browser binary

*Wave 0 must complete before any browser tests can run.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| COOP/COEP headers actually served | INT-01 | Requires inspecting browser network tab | Open Rstest dev server, check response headers for `Cross-Origin-Opener-Policy: same-origin` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
