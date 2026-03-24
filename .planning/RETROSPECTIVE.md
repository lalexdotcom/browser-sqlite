# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Initial Release

**Shipped:** 2026-03-24
**Phases:** 5 | **Plans:** 17 | **Commits:** ~122

### What Was Built
- Bug-free, fully type-safe wsqlite with inverted-pragma fix, `@ts-expect-error`-free via handwritten `wa-sqlite.d.ts`
- Two-layer test suite: 57 unit tests (Node, fast) + 25 browser integration tests (Playwright/OPFS/SharedArrayBuffer)
- Complete public API documentation: JSDoc on all symbols, consumer README with COOP/COEP config and VFS selection guide
- ESM-only build with single unified `rstest.config.ts` (projects pattern: unit + browser)
- Clean, silent library — no logging infrastructure; consumers control their own observability

### What Worked
- **Bugs first, tests after**: fixing Phase 1 bugs before writing tests prevented validating wrong behavior — critical sequencing decision
- **Phase 05 was quickly reversed**: the @lalex/console optional logging implementation was completed then removed via quick tasks; the GSD workflow absorbed this well (quick tasks vs phases)
- **UUID-based OPFS isolation**: preventing inter-test collisions in parallel browser runs was discovered during planning and solved cleanly
- **`extends: withRslibConfig()`** in rstest: the adapter pattern for sharing build config across unit and browser projects worked cleanly
- **Wave 0 (RED phase) discipline**: writing failing stubs before implementation prevented skipping straight to GREEN

### What Was Inefficient
- **Phase 5 rework**: made @lalex/console optional → then removed all logging. Two contradictory milestones in the same session. Should have reached a logging decision before planning Phase 5.
- **Multiple quick tasks for window errors**: the `window is not defined` error required 3 passes (260324-qze, then still present, then 260324-rxw for the real fix via `dev.browserLogs: false`). Root cause diagnosis took longer than expected.
- **Worktree isolation misfired once**: executor for 260324-o2g ran in a worktree based on an old commit (before Phase 5 changes), requiring a second executor run without isolation.
- **ROADMAP.md was never fully updated**: progress table and phase check-marks drifted throughout the milestone. Metadata debt accumulated.

### Patterns Established
- `pluginCrossOriginIsolation` in rstest browser config as the canonical way to configure COOP/COEP for SharedArrayBuffer + OPFS tests
- `createTestClient()` helper with UUID-based OPFS isolation as the standard test fixture pattern
- `dev.browserLogs: false` in rsbuild browser test config to suppress HMR client noise in worker bundles
- Quick tasks for post-phase cleanup (ESM simplification, config unification, noise removal) — keeps phases focused on functional goals

### Key Lessons
1. **Decide on logging strategy before implementing it** — the Phase 5 / quick task reversal was expensive; logging architecture is a cross-cutting concern that needs a real decision upfront
2. **`window is not defined` in rstest browser = rsbuild HMR client in worker bundle** — `dev.browserLogs: false` is the targeted fix; `liveReload: false` breaks test startup, `hmr: false` breaks WebSocket coordination
3. **Verify executor worktree commits against expected HEAD** — check that the worktree was branched from the right commit before spawning an executor with isolation
4. **Rspack injects HMR client into worker bundles** — this is a known rspack/rsbuild behavior; any project using `new Worker(new URL(...))` with rstest browser mode needs `dev.browserLogs: false`

### Cost Observations
- Sessions: 1 (multi-hour)
- Model: Claude Sonnet 4.6 throughout
- Notable: the session ran long enough to require context compression mid-work; STATE.md and SUMMARY.md artifacts enabled clean resumption

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 1 | 5 | Initial GSD setup; established browser test infrastructure |

### Cumulative Quality

| Milestone | Tests | Notes |
|-----------|-------|-------|
| v1.0 | 82 (57 unit + 25 browser) | First real test coverage; previously only placeholder |

### Top Lessons (Verified Across Milestones)

1. **Fix correctness bugs before writing tests** — avoids validating wrong behavior
2. **Quick tasks handle post-phase cleanup well** — keeps phase scope focused on functional goals
