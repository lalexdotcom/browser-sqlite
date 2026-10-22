# Safari in the library's test suite, on macOS

Date: 2026-10-22. Branch: `feat/safari-suite`. Background: `mem:follow-ups/safari-suite` (brainstorming of 2026-10-20, resumed 2026-10-22), measurements in `mem:measurements/test-browsers` (SAFARI-LIB-SPIKE, SAFARI-IDB-LIB), the throwaway branch `spike/safari`.

## Why

The suite drives Chrome and Firefox. Safari is the third engine the library ships for, and every Safari defect found so far (the stranded IndexedDB connection, the held file on restart, SAFARI26-DATAVIEW-RACE) was found by a spike or a device campaign, never by the suite. The spike showed Safari can be driven through the same Vitest + WebdriverIO projects on a GitHub macOS runner. This piece makes that permanent and symmetric with the other two browsers.

## Scope (user, 2026-10-22)

This piece is **the wiring and a first measurement**, not the fixes. It makes Safari selectable everywhere a browser is, runs the whole suite on Safari on macOS 26 and 27 once, and records what fails. Each defect that run finds is its own later piece, one branch each — starting with the two already known: WebKit's `InvalidStateError` for a held file, which neither open retry matches (`mem:follow-ups/lifecycle-restart-held`), and `lifecycle.test.ts` "fails the client permanently once the restart budget is spent" timing out on Safari.

## Goals

1. **Safari is opt-in everywhere, macOS included (user, 2026-10-22; replaces the 2026-10-20 decision to include it by default on a Mac).** No default browser list gains Safari: `pnpm test`, `test:browser`, `test:isolated`, `test:conformance`, `test:matrix`, `browsers.ts install` with no list, the pre-push hook — all stay `chrome,firefox` on every platform. Safari runs only when named: `--browser safari`, `install safari`, or a `*:safari*` script.
2. **Symmetry with the other browsers (user, 2026-10-20).** Every command family gets its Safari variant: `test:safari`, `test:safari:not-isolated`, `test:safari:isolated`, `test:conformance:safari`, and Safari's two columns (`safari`, `isolated-safari`) in `test:matrix` when asked for. Safari runs both modes, not isolated and cross-origin isolated (the isolated probe passes, SAFARI-LIB-SPIKE).
3. **A clear error, before any test, when Safari cannot run:**
   - **On Linux or Windows**, naming Safari (`--browser safari`, `install safari`, a Safari project) fails at once with a message saying Safari runs on macOS only. Never a silent skip (user, 2026-10-21).
   - **On macOS with remote automation off**, the run fails with a message giving both ways to turn it on: Safari's setting (Settings > Developer > "Allow remote automation") and `sudo safaridriver --enable` (user, 2026-10-22). The exact text `safaridriver` answers with is not recorded and cannot be reproduced here or on CI (the workflow enables it first). So **any failure to open a Safari session other than `already paired` keeps its original error and gets that message appended** (my call, 2026-10-22). No preference file is read, since its location could move. The text is refined if a real one is ever captured.
4. **Every run prints the Safari version it tested** (user, 2026-10-20: the OS fixes Safari's version, it is a constraint, not a choice). At least once per run in the run's output, and in `install safari`'s `ok` line as for the others (`safari <version>: ok`).
5. **Every test applies or is skipped with its reason.** Nothing is declared for Safari in the planner or the capability tables: they read probed features (`readwrite-unsafe`, JSPI, sync access handles), so Safari falls where its features put it. Tags gain `browser:safari` because the vocabulary is closed and derived from the browser list.
6. **CI:** at the merge, `tests-macos-26.yaml` and `tests-macos-27.yaml` pass `browsers: chrome,firefox,safari` explicitly; `tests.yaml` and the setup action enable `safaridriver` (`sudo safaridriver --enable`) when the list names Safari. `tests.yaml`'s steps are otherwise unchanged. `ci.yaml`, `tests-ubuntu.yaml`, `tests-windows.yaml`, `matrix.yaml` and the release are unchanged.
   - **While the branch is being tuned, both macOS workflows pass `browsers: safari` alone (user, 2026-10-22)**, and get `chrome,firefox,safari` back before the merge. A Safari-only run keeps Safari's failures apart from Chrome and Firefox, which `main`'s runs already judge. Later fix branches may do the same.
   - **Known and accepted:** in a three-browser run, a red Safari `Test` step skips the `Conformance` step for every browser, because the steps run in sequence on `if: success()`. To be revisited once Safari is stable, if it still bites.
7. **A first full run on GitHub, macOS 26 and 27**, whose results go into `mem:measurements/test-browsers` (durations, counts, the "Skipped with a reason" list, the not-applicable counts per browser) and whose failures each get one entry in `mem:follow-ups`.

## Non-goals

- **Fixing what the first run finds.** Later pieces, one each.
- **Headless Safari.** It does not exist; `@vitest/browser-webdriverio` throws on `headless` for Safari. Safari windows are visible.
- **Minimizing or hiding Safari's windows.** Deferred until the tests are stable (user, 2026-10-20). A hidden page's timers are throttled by Safari, which may change what tests see; unmeasured.
- **Safari in the iOS simulator**, Safari Technology Preview, or any Safari other than the one at `/Applications/Safari.app`.
- **A macOS job in `matrix.yaml`**, or Safari in any workflow triggered automatically. `test:matrix` takes Safari locally on a Mac; a CI matrix on macOS is not asked for (my call).
- **Safari in `bench/check.ts` and `consumer-smoke.ts`.** Both stay Chrome (and Firefox for the bench); neither is a test command family (my call).
- **Pinning or installing Safari.** Nothing is downloaded; Safari's version is whatever the OS ships.

## Anti-goals — a failure even if Safari runs

- **Any change to a Linux or Windows run**: their plans, cells, counts, durations, the dead-test rule. The 2026-10-13 baseline must hold unchanged where Safari is not named.
- **Two Safari sessions at once.** `safaridriver` accepts one session per machine and refuses a second (`already paired`, SAFARI-LIB-SPIKE). A design that relies on retrying a refused session is a failure: Safari's jobs are serialised by construction.
- **A test skipped on Safari to make a run green**, for a defect in this repository's code. A defect of ours stays red until its own piece fixes it. A skip keyed on Safari's version is allowed only for a WebKit defect, with its reason (user, 2026-10-22). Since Safari is never run by default and the macOS workflows are dispatched by hand, a red Safari run blocks nothing else.
- **A Safari test reported as passed that did not run on Safari.**

## Constraints and facts the design rests on

- **One `safaridriver` session per machine**; Safari can run beside Chrome and Firefox jobs; sessions chain cleanly one after another, and one killed with `kill -9` does not block the next (SAFARI-LIB-SPIKE). So: one lane for Safari, any number for the others.
- **`conformance safari` takes 34-57 s alone** on the runner, like Chrome (SAFARI-LIB-SPIKE). The rest of the suite on Safari is unmeasured. On `macos-latest`/`macos-26`: 3 cores, macOS 26.6.2, Safari 26.6.2, no JSPI (JSPI from Safari 27).
- **Bounds.** `pnpm test` is bounded at 2400 s and `tests.yaml` at 90 min, both scaled by `BSQ_TIME_SCALE` (macOS runs at `'1'`). Safari serialised on a 3-core runner may not fit; the first run tells. If it does not, the run fails on the bound by name and the bound is the user's call — not raised pre-emptively.
- **The planner probes each selected environment** (`probe safari`, `probe isolated safari`) one after another before any cell. The first probe must leave no Safari session behind, or the second is refused.
- **What the code assumes today** (survey of 2026-10-20, re-checked 2026-10-22):
  - Engine lists written as `chrome`/`firefox`: `BrowserName`, `PINNED`, `ENV_VAR` and `NAMES` in `scripts/browsers.ts` (`parseBrowserList`'s default is `NAMES`); `ENGINES` in `tests/vitest.config.ts`; `BROWSERS` in `tests/harness/planner/need.ts`; the guard in `tests/harness/browsers-setup.ts`; `--browser`'s check and default in `scripts/test-plan.ts`, and its `--table` columns; `COLUMNS` in `scripts/test-matrix.ts`; `deadIsFatal` in `scripts/plan-report.ts` (`browsers === 2`, i.e. "every browser"); the `"conformance *"` glob of `test:conformance`, which would select Safari.
  - `scripts/browsers.ts` assumes a downloaded browser and driver: `cacheItems` and `browserCapabilities` fall through to Firefox for any non-Chrome name; `resolveBrowsers` returns a browser and a driver path per name; `installAll` passes a headless argument.
  - `browserProject` sets `headless: true` for every project.
  - `runPool` (`scripts/parallel.ts`) has one global limit (`BSQ_TEST_JOBS`, default `min(6, cpus - 1)`), and `allocateShards` cuts any project into shards. Both are shared by `test-plan.ts` and `test-parallel.ts`.

## Decided

- **Safari's WebDriver capabilities are `browserName: 'safari'` only**: no `browserVersion`, no binary, no driver path, no headless argument. WebdriverIO starts `/usr/bin/safaridriver` itself (as in the spike).
- **"Resolving" Safari** means: check the platform (macOS, else the error of goal 3), and find no cache item. `browsers.ts install safari` opens and closes one session, which is where a disabled remote automation shows first, and prints `safari <version>: ok`.
- **The dead-test rule (`deadIsFatal`)** keeps its meaning: fatal on a full run over the default browsers. "Every browser" becomes "at least Chrome and Firefox", so adding Safari to a full CI run keeps a dead test fatal, and a Linux run is unchanged.
- **Safari's projects exist in the Vitest config on every platform**, so naming one off macOS reaches the clear error rather than "no project matches".

## Left to the builder

- Where the per-browser lane limit lives (`runPool`, `planJobs`, or the callers) and how Safari's projects avoid being sharded — as long as no two Safari sessions ever overlap, in `test-plan.ts` and `test-parallel.ts` alike, and Chrome/Firefox parallelism is unchanged.
- Where the remote-automation error is recognised (the provider wrapper in `tests/harness/browser-provider.ts`, the probe step, `installAll`), as long as every entry point that opens a Safari session gives the goal-3 message and none reaches a test first.
- How the Safari version is read (the session's `browserVersion` capability, or `Safari.app`'s `CFBundleShortVersionString`) and where it is printed.
- Whether the `safaridriver --enable` step sits in `tests.yaml` or in the setup action, conditioned on the list naming Safari.
- The unit tests: every function whose behaviour changes (`parseBrowserList`, `browserCapabilities`, `deadIsFatal`, the lane limit, the off-macOS error, the remote-automation message) gets one, in the style of the existing `tests/unit/` files. The off-macOS error is testable on Linux; the rest of Safari's path is proven only by the GitHub runs.

## Done

- On Linux, in this container: `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, `pnpm lint` (0 warnings), `pnpm test:unit`, `pnpm test` and `pnpm test:conformance` green, with the plan, cells and not-applicable counts of `pnpm test` unchanged from `main`; `pnpm test --browser safari` and `node scripts/browsers.ts install safari` fail at once with the off-macOS message.
- On GitHub (pushes allowed for this piece, user, 2026-10-22): `ci.yaml` green on the branch; `tests-macos-26.yaml` and `tests-macos-27.yaml` dispatched on the branch with Safari alone. For those runs only, `tests.yaml`'s `Conformance` step carries `if: ${{ !cancelled() }}`, so a red `Test` does not hide Safari's conformance; it goes back to `if: success()` with the browser lists before the merge (my call, 2026-10-22). Each Safari failure is recorded, none hidden. Then one dispatch of each with `chrome,firefox,safari` restored, in which Chrome and Firefox pass as on `main`.
- `CHANGELOG.md` has no entry: nothing user-visible in the package changes (the suite is not shipped).
- Serena memories updated: `mem:follow-ups/safari-suite` closed into `mem:history`, the first run in `mem:measurements/test-browsers`, one `mem:follow-ups` entry per failure, `mem:stack-and-build/ci` for the workflows.
