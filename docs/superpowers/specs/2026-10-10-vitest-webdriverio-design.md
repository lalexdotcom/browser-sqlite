# The test suite on Vitest and stock browsers — design

**Date:** 2026-10-10 · **Status:** approved in chat, spec under review · **Target:** no CHANGELOG entry (nothing a consumer sees changes) · **Branch:** `test/vitest-webdriverio`

Every browser test today runs under rstest 0.11.8, in Playwright's own Chromium and Firefox builds, against `src/` compiled by rstest's rsbuild in dev mode. Two things are wrong with that. The browsers are not the ones users run — Playwright's Firefox is a patched build, and its timings and defects are its own (FF-PW-AWAIT, WORKER-LEAK, GETDIR-HANG in `mem:measurements`). And the library under test is not the one npm ships: `withRslibConfig()` takes the top level of `rslib.config.ts` but not its `lib` items, so neither the `esm` preset nor the worker item (`url: false`, `asyncChunks: false`, the copied `.wasm`) nor minification apply, and the worker the tests exercise is a chunk rspack derives from `pool.ts`, not `dist/worker/worker.js`. rstest offers no way out: 0.12.3's `BROWSER_PROVIDERS` holds `playwright` alone.

A spike on 2026-10-09 ran six of the library's browser test files, unchanged except for their imports, on Vitest 5 with `@vitest/browser-webdriverio`, against the library as rslib builds it, in stock Chrome 153 and Firefox 155: 41/41 on both, the same 40 tests rstest runs on those files plus a probe (LIB-VITEST-SPIKE, `mem:measurements/test-browsers`). This spec moves the whole suite there and takes Playwright out of the repository. It is the first half of the direction in `mem:conventions` (§ Testing in browsers); Windows, macOS and Safari in CI are the second, and a separate piece of work.

---

## 1. Decisions (user, 2026-10-09 and 2026-10-10)

- **D1 — The browser tests exercise the library as the npm package ships it, built by rslib.** Moving the build to Vite was weighed and dropped: the build tool of `dist/` does not matter to Vitest, and rslib's settled facts would have to be paid for again (Vite emits no `.d.ts`; `vite-plugin-dts` needs TypeScript's JS API, which TS 7 lacks).
- **D2 — `rslib.test.config.ts` builds `rslib.config.ts`, untouched, into `tests/build/`, plus a test-only entry.** It imports the published config, moves every `distPath` from `./dist` to `./tests/build`, and appends a separate `lib` item — a clone of `index`'s, `dts: false`, no `copy` — for `tests/testing.ts`. Separate, because inside `index`'s item rspack could factor shared code into a chunk and change `index.js`. `testing.js` lands beside `index.js`, so its `new URL('./worker/worker.js', import.meta.url)` reaches the worker built with it. The spike measured `tests/build/index.js`, `worker/worker.js` and the three `.wasm` byte-identical to `dist/`.
- **D3 — `tests/testing.ts` lives outside `src/`.** `tsconfig.build.json` includes all of `src/` and the published build emits one `.d.ts` per module, so a `src/testing.ts` would ship as `dist/testing.d.ts`. Outside `src/`, neither the build nor its config changes; `tsconfig.json` already type-checks `tests/`.
- **D4 — A test takes the library from one bundle.** Public-API tests import `browser-sqlite` (aliased to `tests/build/index.js`); white-box tests import `browser-sqlite/testing` (aliased to `tests/build/testing.js`), which re-exports the public surface and the internals they drive. Two bundles are two copies of the code: an `instanceof` or a module singleton does not cross between them. Pure constants and calculations (`VFS_CAPABILITIES`, `databasePath`, lock names) may still come from `src/` — they compute names and capabilities, and the build comes from the same tree. No browser test imports `src/worker/` (only unit tests do), so the worker under test is always the shipped one.
- **D5 — Everything moves to Vitest, and rstest leaves the repository**, the unit project included. Unit tests run on `src/` with no build under either tool.
- **D6 — Playwright leaves the repository too.** `scripts/consumer-smoke.ts` and `scripts/bench/check.ts`, which drive Playwright's Chromium directly, move to WebdriverIO and stock browsers.
- **D7 — Coverage and browsers do not change**: `pnpm test` runs Chrome and Firefox (now stock) and the isolated project, the matrix keeps its pairs, the hooks run what they ran. Whether to change that — a Chrome-only default, parallelism — is a later decision.
- **D8 — One extension: the isolated tests run on Chrome and Firefox.** They ran on Chromium only, by an unjustified "keep Chromium" in `docs/superpowers/plans/2026-09-04-query-interruption.md`, not a decision. The spike ran them green on Firefox 155.
- **D9 — Pinned browsers: Chrome `153.0.8010.52`, Firefox `stable_155.0.1`.** Chrome a few majors behind the newest (its last 153 patch), and the Firefox release current on Chrome 153's stable date (2026-09-08) — distance from the newest, and two browsers of one age (`mem:conventions`). Safari, later, is whatever the OS ships.
- **D10 — CI is adapted minimally in this work** — same jobs, triggers and runner — **and its warnings are cleared** (§ 6).
- **D11 — Parallelism is left at Vitest's defaults**, to be adjusted once the suite's duration is measured (§ 7).

## 2. The build under test

`rslib.test.config.ts` as the spike wrote it, with its own persistent cache (`cacheDirectory: node_modules/.cache/rspack-test`, the config file and `rslib.config.ts` in `buildDependencies`): rslib forces the cache on, and a shared one has served a stale output before (`mem:stack-and-build/wa-sqlite`).

Every browser project of `vitest.config.ts` declares a `globalSetup` that runs that build once per Vitest invocation, so any command touching a browser — `pnpm test`, one file, watch mode — tests a build of the current tree. ~9 s cold. The unit project declares none.

`tests/build/` is gitignored, which keeps it out of biome (`vcs.useIgnoreFile`). `tsconfig.json` maps `browser-sqlite` to `./src/index.ts` and `browser-sqlite/testing` to `./tests/testing.ts` through `paths`, so the types come from the sources and do not need a build.

`tests/testing.ts` re-exports `../src/index` and exactly the internals the white-box tests use — today `createLogger`, `createPoolWorker`, `createLocks`, `encodeParams`, `resolveRealmId` and the lock-name helpers; the list is read off the ported files.

## 3. The tests

**Files stay where they are** — `tests/unit/`, `tests/browser/` with `firefox/` and `isolated/`, `tests/conformance/` — rewritten in place. The spike's `tests/vitest/` is not carried over.

**Imports:** `@rstest/core` → `vitest`; `rstest.fn` / `rstest.spyOn` → `vi.*`; public API → `browser-sqlite`, the helpers (`createTestClient`, the conformance helpers) included; white-box files → `browser-sqlite/testing` — about eight (`abandon`, `params`, `pool-savepoint`, `pool-death`, `inspect-realm`, `inspect-marker`, `write-lock-reclaim`, and `target.ts`'s `sharesStorage`, which is pure and may stay on `src/`).

**Mixed files are checked one by one.** A white-box file that also uses `createTestClient` holds both bundles. Web Locks are origin-wide, so lock names agree; an `instanceof` does not, so `SQLiteError` must come from the bundle whose code threw. Each such file is read for it when ported.

**Test API differences** are settled where they appear: `ctx.skip()` exists in both; `onTestFinished` and `afterEach` exist in both; rstest has no `it.each` and the suite does not use Vitest's.

## 4. Projects, targets, browsers and commands

**One `vitest.config.ts`.** Projects:

| Project | Environment | Files |
|---|---|---|
| `unit` | Node, `testTimeout` 10 s | `tests/unit/**` |
| `chrome · <vfs>/<build>` | Chrome | `tests/browser/*.test.ts`, `tests/browser/chromium/**` |
| `firefox · <vfs>/<build>` | Firefox | `tests/browser/*.test.ts`, `tests/browser/firefox/**` |
| `isolated chrome · …`, `isolated firefox · …` | the browser, COOP/COEP through `server.headers` | `tests/browser/isolated/**` |
| `conformance chrome`, `conformance firefox` | the browser, `testTimeout` 60 s | `tests/conformance/**` — no target: the files iterate every VFS themselves, as today |

Browser projects keep today's `testTimeout` 30 s and `hookTimeout` 60 s. Each project builds its own `instances` object: Vitest renames instances in place, and two projects sharing one array fail at startup (LIB-VITEST-SPIKE).

**Targets keep their meaning.** `tests/target-projects.ts` stays the source of the pairs; `BSQ_TEST_TARGETS` (unset, `all`, or a comma list) and `BSQ_TEST_NEEDS` (`fallback` / `skip`) read as today. The target reaches the tests through Vitest's `provide` / `inject` — per-project values, the mechanism Vitest has for this — instead of `define` and the `__BSQ_TEST_TARGET__` / `__BSQ_TEST_NEEDS__` globals. The spike injected one target at the root only, so **a project per target receiving its own value is the first thing the implementation checks**.

**Browsers.** The pins (D9) live in one module, read by `vitest.config.ts`, `consumer-smoke` and `bench/check`. `BSQ_CHROME_VERSION` and `BSQ_FIREFOX_VERSION` override them — two variables, since both engines run in one invocation. Firefox takes a channel prefix: no `browserVersion`, `latest` or a bare number resolve to a Nightly (LIB-VITEST-SPIKE). WebdriverIO downloads browsers and drivers into `node_modules/.cache/wdio` (`cacheDir`). webdriverio is 10.x: 9.x fetches an x86-64 Chrome on linux-arm64.

**`abandon-gc.test.ts`** needs V8's `gc`. Today it is passed by hand on rstest's command line; `BSQ_EXPOSE_GC=1` adds `--js-flags=--expose-gc` to Chrome's arguments, and without it the file skips as it does today.

**Commands**, every browser leg under `scripts/bounded.ts`:

| Script | Runs |
|---|---|
| `test` | `unit`, the `chrome`, `firefox` and `isolated` projects, in **one** invocation bounded at 2400 s (today 900 + 900 + 600) |
| `test:unit`, `test:watch` | as today |
| `test:chrome`, `test:firefox`, `test:isolated`, `test:browser` | `--project` filters; `test:chromium` becomes `test:chrome` |
| `test:conformance`, `:chrome`, `:firefox` | both engines / one |
| `test:matrix`, `test:consumer` | § 5, § 6 |

One invocation is the one behavioural change, and it removes a trap: today's `&&` chain stops at the first red config, so a Chromium failure silenced Firefox and read as green (`mem:lessons`).

## 5. The matrix and its reports

`scripts/test-matrix.ts` keeps its shape: a cell is a pair and a column, one Vitest invocation bounded at 600 s with `BSQ_TEST_TARGETS=<pair>` and `BSQ_TEST_NEEDS=skip`, raw reports under `.matrix/<run>/`, a non-zero exit on any red or timed-out cell.

- **Four columns:** `chrome`, `firefox`, `isolated chrome`, `isolated firefox` — 88 cells where there were 66.
- **Reports are Vitest's JSON reporter** (`--reporter=json --outputFile`), not rstest's markdown, which the script parsed as text.
- `scripts/matrix-triage.ts` reads the same JSON; `tests/unit/test-matrix.test.ts` and `target-projects.test.ts` get Vitest JSON fixtures.
- The release's `cells` job keeps one pair per job (`test-matrix.ts --pair`), now four columns per job.

`scripts/bounded.ts` does not change: it bounds any command, and keeps the newest 30 runs in `.test-runs/`.

## 6. Playwright out; devcontainer and CI

**`scripts/consumer-smoke.ts`** drives stock Chrome at the pin through WebdriverIO, Chrome only as today. `goto` / `evaluate` → `url` / `execute`; `waitForFunction` → `waitUntil` over `execute`; its `console`, `pageerror`, `requestfailed` and `response` listeners → WebDriver BiDi events (`log.entryAdded`, the network events), on by default in WebdriverIO 10 for Chrome and Firefox. This is the one real adaptation, and it is checked first.

**`scripts/bench/check.ts`** (run by hand) drives stock Chrome or Firefox (`[chrome|firefox]`). Its export, caught by Playwright's `waitForEvent('download')`, is caught through a download directory set in the browser's preferences and a wait for the file.

**`.devcontainer/post-create.sh`** drops `playwright install --with-deps` and instead installs the system libraries stock Chrome and Firefox need — Chrome for Testing ships its Debian list as `deb.deps` in the archive — and pre-downloads the two pinned browsers. `~/.cache/ms-playwright` on existing machines is left alone.

**CI** (`ci.yaml`, and `release-and-publish.yaml`'s `cells` job) keeps its jobs and triggers on `ubuntu-latest`. The "Cache Playwright browsers" and "Install browsers" steps become a cache of `node_modules/.cache/wdio` keyed on the pins module; GitHub's Ubuntu images carry Chrome's and Firefox's system libraries. The comment on the browser list is rewritten for what is true now.

**Warnings cleared** (read 2026-10-10 on the rc.10 CI and release runs):
- Node 20 deprecation — `actions/cache@v4` → v6, `pnpm/action-setup@v4` → v6, `actions/upload-artifact@v4` → v7, `actions/deploy-pages@v4` → v5, and `actions/upload-pages-artifact@v3` → v5 beside it; each major's release notes read before the bump.
- biome — `noNonNullAssertion` at `src/worker/worker.ts:1013`, `tests/browser/tx-write.test.ts:139`, `tests/unit/scheduler.test.ts:418`; `noUnusedFunctionParameters` at `tests/browser/concurrency.test.ts:191`; `useTemplate` at `tests/unit/utils.test.ts:194`.
- A notice only, nothing to fix: `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19 (actions/runner-images#14748).

**Removed:** `playwright`, `@rstest/core`, `@rstest/browser`, `@rstest/adapter-rslib`; the five `rstest*.config.ts`; `pluginSilenceWorkerHmrLogs`. Mentions of Playwright and rstest in docs, comments and memories are brought up to date.

## 7. Order, verification, risks

**Order** — every commit on a green tree:

0. **Record the rstest baseline before touching anything:** per cell — the two recommended pairs × chromium / firefox / isolated, then the full matrix — the passed and skipped tests by full name. Once imports are rewritten rstest cannot run the files, so it is taken first.
1. The `unit` project on Vitest; rstest's `unit` project removed; the hooks' `test:unit` follows.
2. Browser infrastructure — the build `globalSetup`, the pins module, projects per target with `provide` / `inject` — then `tests/browser/`, `firefox/` and `isolated/` included.
3. Conformance.
4. `test-matrix.ts`, `matrix-triage.ts` and their tests.
5. `consumer-smoke` and `bench/check` on WebdriverIO; Playwright removed.
6. `post-create.sh`, CI, the warnings.
7. rstest removed (configs, dependencies); docs, comments, memories — `mem:follow-ups`' entry shrinks to this spec and what stays open after it.

**Verification:**
- **Parity by test name** against step 0, cell by cell. The only expected difference is the new `isolated firefox` column; any other is explained before going on.
- **Falsifiers:** a `throw` at the **top** of `tests/build/index.js` and of `testing.js` fails the files that import them (at the end it lands in the `//# sourceMappingURL` comment and does nothing — LIB-VITEST-SPIKE); a deliberately broken consumer app turns `consumer-smoke` red; `abandon-gc` runs with `BSQ_EXPOSE_GC=1` and skips without.
- **One full matrix** (88 cells), then `pnpm test`, `tsc --noEmit` and `biome ci`, every report read.
- **CI is verified only once the branch is pushed** — the user's call.

**Risks:**
- **Duration.** Inside a browser project the WebdriverIO provider runs one file at a time (`supportsParallelism = false`), where rstest ran files in parallel pages. `pnpm test` is measured early; the 2400 s bound, the matrix's 600 s and the CI `timeout-minutes` are set from that measurement; parallelism is revisited after (D11).
- **Bounds calibrated on Playwright's Firefox.** Stock Firefox times differently (FF-PW-AWAIT). A bound that breaks is re-measured, not loosened blind.
- **Nested iframes.** Vitest runs each test file in an iframe of its orchestrator page; `realm.test.ts` and `cross-tab.test.ts` create their own same-origin iframe inside it.
- **Storage shared across files.** rstest opens a fresh browser context per test file, so OPFS and IndexedDB start empty in each; under Vitest every file of a session shares one profile and one origin. Tests already use unique names and clean up after themselves (`createTestClient`), but a file that leaks — an `AccessHandlePoolVFS` slot never freed, a database never deleted — now reaches the files after it. A failure that appears only in a full run and not in its file alone is read with that in mind first.
- **BiDi events in `consumer-smoke`** (§ 6).

## 8. Out of scope

- Windows and macOS runners, Safari and the iOS simulator, per-platform triggers, the WASM built once and shared — the next piece of work (`mem:conventions`, § Testing in browsers).
- Changing what `pnpm test` covers by default, or its parallelism (D7, D11).
- The unmeasured exposure of `IDBMirrorVFS` with several connections on Safari 26 (SAFARI26-IDBMIRROR-KILL) — it needs Safari.
