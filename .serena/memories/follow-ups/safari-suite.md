# Safari in the library's test suite, on macOS — brainstorming started, spec not written (user, 2026-10-20)

Part of `mem:follow-ups`. **Comes after `mem:follow-ups/safari-idb-stranded`** (user, 2026-10-20). Resume the brainstorming from here (superpowers:brainstorming, then a spec on a feature branch).

## Decided by the user (2026-10-20)

- **The goal: everything passes on Safari.** Every test that applies to Safari runs there and passes; what cannot is skipped explicitly, with its reason, and shows in the report, as on Chrome and Firefox.
- **macOS only.** Safari in the iOS simulator comes later.
- **On a Mac, `pnpm test` includes Safari by default**, as it includes Firefox; Linux and Windows unchanged.
- **Symmetry with the other browsers**: every command family gets its Safari variant — `test:safari`, `test:safari:isolated`, `test:safari:not-isolated`, `test:conformance:safari`, Safari in the matrix on macOS.
- **Safari windows are visible** (Safari has no headless; `@vitest/browser-webdriverio` throws on `headless` for Safari). **Minimizing them: deferred until the tests are stable** (user). Not measured: Safari throttles a hidden page's timers, which might change what the tests see.
- **The OS fixes Safari's version** (the user's correction: it is a constraint, not a choice) — Safari can be neither installed nor updated on its own. So every run prints the Safari version it tested, and skips keyed on the Safari version are the rule for a version's defect. Nothing is downloaded; `safaridriver` must be enabled once per machine (`sudo safaridriver --enable`, a CI step).

## Measured (SAFARI-LIB-SPIKE, `mem:measurements/test-browsers`)

One safaridriver session per machine (a second is refused, `already paired`): Safari jobs need a lane of their own. That lane can run beside Chrome and Firefox. Sessions chain cleanly, and a session killed with `kill -9` does not block the next. The isolated (COOP/COEP) probe passes. `conformance safari` takes 34-57 s alone, like Chrome.

## What the code needs (survey of 2026-10-20, not re-verified since)

- **Engine lists written as `chrome`/`firefox`:** `BrowserName` and the `PINNED`/`ENV_VAR` records (`scripts/browsers.ts`; `parseBrowserList`'s default comes from `PINNED`, so `install` would try Safari everywhere), `ENGINES` (`tests/vitest.config.ts`), `BROWSERS` (`tests/harness/planner/need.ts`, the closed tag vocabulary), the guard in `tests/harness/browsers-setup.ts`, `--browser` and its default in `scripts/test-plan.ts`, `COLUMNS` in `scripts/test-matrix.ts`, `deadIsFatal` in `scripts/plan-report.ts` (`browsers === 2`), the engine of `scripts/bench/check.ts`, the `"conformance *"` glob (it would select Safari off macOS). The default browser list must depend on the platform without changing Linux (`ci.yaml`, `matrix.yaml`).
- **`scripts/browsers.ts` assumes a downloaded browser:** `cacheItems` and `browserCapabilities` fall through to Firefox's model for any non-Chrome name, `resolveBrowsers` expects a browser and a driver per name. Safari: no cache item, `browserName: 'safari'` only, no `browserVersion`, no headless args.
- **Parallelism:** `runPool` (`scripts/parallel.ts`) has no per-browser limit, nor does `test-parallel.ts`; Safari cells need one lane and one shard; the planning probes run one after another, check that the first leaves no session behind.
- **Nothing to declare for Safari in the planner or the capability tables:** they read probed features (`readwrite-unsafe`, JSPI, sync handles), so Safari falls on Firefox's side by itself (no `readwrite-unsafe`; JSPI only from Safari 27).
- **CI:** `tests.yaml` and the setup action know only `chrome,firefox`; a `safaridriver --enable` step; the pre-push hook runs `pnpm test`, so Safari on a Mac.

## The runner

`macos-latest` on 2026-10-20: macOS 26.6.2, Safari 26.6.2, 3 cores — no JSPI there. Safari 26.6.2's known defects: SAFARI26-DATAVIEW-RACE, SAFARI26-IDBMIRROR-KILL (wa-sqlite's harness), and the stranded IndexedDB connection above.
