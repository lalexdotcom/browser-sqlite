# Stack, build and CI

## Versions

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Node 24.13, pnpm 10.31.0.
- Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat, no `esm/` level). Two
  entries, `index` and `worker`, with opposite goals — see below. `.d.ts` via `tsgo`.
- Lint/format: **biome 2.5.8** (`biome.json`; it locally disables `noExplicitAny` and
  `noBannedTypes`). Run `pnpm check` after every modification.
  - **biome covers `src/**`, `tests/**` and, since 2026-09-24, `scripts/**`** (`files.includes`) — `.mjs` and the bench page's `index.html` included.
  - **biome ignores `rslib.config.ts`.** Neither `pnpm format` nor `biome ci .` in CI will
    touch it, so a hand-edit's formatting survives untouched and nothing flags it. That
    file's style is maintained by hand — verified 2026-08-27 after a `},{` survived a
    format run.
- Tests: **Vitest 5.0.3** with `@vitest/browser-webdriverio` 5.0.0 and webdriverio 10.0.2 on stock Chrome 153 and Firefox 155, pinned in `scripts/browsers.ts` (§ Test suites). Playwright and rstest are gone since 2026-10-10. Stock Firefox is the one users run; Playwright's was ~5× slower on nested `await`s (FF-PW-AWAIT, `mem:measurements/footprint`).
- **Runtime dependencies: none.** `wa-sqlite` is a devDependency only, vendored into
  `dist/worker/worker.js` at build time and pinned by commit SHA: the pin, the patch and how to
  regenerate it, and the fork's test suite are in `mem:stack-and-build/wa-sqlite`.

### TS 7 in the editor — known, do not re-diagnose

TS 7 ships **no `lib/tsserver.js`**; the language service is the native binary driven over
LSP. VS Code's "Select TypeScript Version" therefore **cannot see the workspace version** —
by design, not a broken install. The editor is served by the `TypeScriptTeam.native-preview`
extension, wired in `.devcontainer/devcontainer.json` via two machine-scoped settings:
`"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "node_modules/typescript/lib"`.
The setting is `js/ts.tsdk.path`, **not** the `typescript.native-preview.tsdk` the write-ups
still document — trust VS Code's in-editor schema warning over the blog posts.

**Probing what the editor offers needs a TypeScript with the JS API, and the repo's has none.**
TS 7's `typescript` package exposes neither `createLanguageService` nor `sys`. The VS Code server
bundles the classic one for its built-in features —
`/vscode/vscode-server/bin/<commit>/extensions/node_modules/typescript/lib/typescript.js`, 6.0.3
and 5.9.3 on 2026-09-15 — and a script that requires it by path can call
`getCompletionsAtPosition`. That is how D10 of the statement-errors spec was measured. The repo's
own `tsc` still gives the diagnostics, as `tsc --ignoreConfig --noEmit --strict <file>`: without
`--ignoreConfig` it refuses a file argument while `tsconfig.json` exists (TS5112).

### A TS 7 trap paid for in wave 1

`const x: (() => T) | undefined = undefined` narrows to `undefined`, and TS 7 then reports
"Type 'never' has no call signatures" at `x?.()`. Writing
`undefined as (() => T) | undefined` preserves the union. Expect it again wherever a
placeholder `undefined` must keep a callable union type.

## Test suites

**Vitest 5.0.3 with `@vitest/browser-webdriverio` 5.0.0 and webdriverio 10.0.2, on stock Chrome for Testing and Firefox, since 2026-10-10** (rstest and Playwright left the repository). The decisions are the user's and live in `docs/superpowers/specs/2026-10-10-vitest-webdriverio-design.md` (D1-D11); their principles are in `mem:conventions` (§ Testing in browsers). What follows is what the code will not tell you.

**The layout of `tests/` (user, 2026-10-14, `chore/tests-layout`): the first level says where a test runs, the second which suite.** Only the two configs and `vitest.d.ts` sit at its root.
- `vitest.config.ts` and `rslib.vitest.config.ts` (both at the repository root until 2026-10-14). Every Vitest call passes `--config tests/vitest.config.ts`; the config sets `root` to the repository, so its globs and setup paths stay repo-relative.
- `unit/` — Node: `lib/` tests `src/`, `tooling/` tests `scripts/` and the planner, `helpers/`. The `unit` project includes `tests/unit/**/*.test.ts` only: a Node test anywhere else does not run.
- `browser/` — everything a browser runs: `pairs/` (the suite each (vfs, build) pair runs, which the planner places), `conformance/`, `probe/`, `setup/` (the setup files: storage wipe, isolation check, need guard, trace), `helpers/` (`index.ts` the pair helpers, `environment.ts` the handle probe and `AVAILABLE_FEATURES`, `poolFor`, `missingHere`, `removeOpfsPath`… shared by all three suites, `realm.ts`).
- `harness/` — test infrastructure, no test: `build-setup.ts`, `testing.ts`, `target.ts`, `target-projects.ts`, `planner/` (`plan.ts`, `guard.ts`, `need.ts`).
- `consumers/` — the consumer smoke's fixtures; `build/` — generated, gitignored.

**The browsers are pinned in `scripts/browsers.ts`** (`PINNED`: Chrome `153.0.8010.52`, Firefox `stable_155.0.1`), read by `tests/vitest.config.ts`, `scripts/consumer-smoke.ts` and `scripts/bench/check.ts`; `BSQ_CHROME_VERSION` and `BSQ_FIREFOX_VERSION` override them (an empty value falls back to the pin). geckodriver is pinned there too (`GECKODRIVER_VERSION`, `0.37.1`, via `wdio:geckodriverOptions`), so the cache key describes what the cache holds. A Firefox version needs its channel prefix: `@puppeteer/browsers` reads a bare number or `latest` as a Nightly, so `browsers.ts` refuses one without. **`scripts/browsers.ts` is the only installer (since 2026-10-19, spec `docs/superpowers/specs/2026-10-19-browsers-installer-design.md`).** `resolveBrowsers(names)` returns the absolute browser and driver paths in `node_modules/.cache/wdio`, installing what is missing, and `browserCapabilities(name, binaries, extra)` hands the four binaries to WebdriverIO (`goog:chromeOptions.binary`, `wdio:chromedriverOptions.binary`, `moz:firefoxOptions.binary`, `wdio:geckodriverOptions.binary`), which then downloads nothing (checked in `@wdio/utils` 10.0.1); a caller passes its own `args`/`prefs` through `extra` and cannot drop a binary. Installs are serialized across processes by a local socket (`scripts/install-lock.ts`: a Unix socket in the temp dir, a named pipe on Windows, named from a hash of the cache dir; the OS releases it when its holder dies; the leader answers `ready` or `error <message>`, and before closing drains its accept queue, since a client the kernel queued but the leader had not accepted is otherwise dropped without an answer; macOS's `listen()` on a held socket returns `EEXIST` as well as `EADDRINUSE`, both mean busy (LOCK-MACOS, `mem:measurements/test-browsers`); a refusal is confirmed for ~100 ms, then the stale socket file is unlinked, and the double leader that can follow a crash is accepted by the user — it costs a duplicate download, never a damaged install). Each installation is built in `.staging/<pid>-<uuid>` and published by one atomic rename with `.bsq-complete` inside (`scripts/browser-cache.ts`): `@puppeteer/browsers` takes any folder holding the executable as installed, so a folder without the marker is reinstalled; the leader sweeps only staging entries whose pid is dead. Firefox gets `distribution/policies.json` (`DisableAppUpdate`) before it is published (2026-10-16: a Firefox of the cache launched by hand with a fresh profile updated itself in place from 155.0.1 to 158.0 within minutes; geckodriver's profiles disable updates, a hand launch's do not). geckodriver comes from the `geckodriver` package (devDependency, 7.0.0) into `geckodriver/<platform>-<version>/`. The Vitest browser projects resolve in a globalSetup (`tests/harness/browsers-setup.ts`), before Vitest's session-connect timer (60 s × `BSQ_TIME_SCALE`), which already counts when `openPage()` calls `openBrowser()`; Vitest runs no browser project's globalSetup under `--project unit`, so a unit run installs nothing (verified with the cache moved aside). `consumer-smoke`, `bench/check` and the CLI resolve before `remote()`; progress goes to stderr. `node scripts/browsers.ts install` resolves both and opens a session in each (it prints two `ok`); `node scripts/browsers.ts deps` lists the apt packages both need. `.devcontainer/post-create.sh` runs the two at creation; CI caches the folder, keyed on `scripts/browsers.ts`, and runs `install` before any test (§ CI and hooks). **webdriverio must stay on 10.x**: 9.x's `@puppeteer/browsers` 2.x fetches an x86-64 Chrome on linux-arm64, where 3.x maps `linux_arm` to `linux-arm64` from Chrome 153.0.8001.0. Safari, Windows and macOS are the next piece of work (spec § 8); WebKit is in no config (Playwright's Linux WebKit is no stand-in for Safari, `mem:conventions`).

**The tests run the library as rslib builds it.** `tests/rslib.vitest.config.ts` imports `rslib.config.ts` untouched, moves every `distPath` to `tests/build/` (gitignored) and adds a second `lib` item for `tests/harness/testing.ts` (the public surface plus the internals the white-box tests drive), so `testing.js` sits beside `index.js` and the worker under test is the shipped `worker/worker.js`. `tests/vitest.config.ts` aliases `browser-sqlite` to `tests/build/index.js` and `browser-sqlite/testing` to `tests/build/testing.js`; `tsconfig.json` maps the same names to the sources through `paths`, so the types need no build. `tests/harness/testing.ts` lives outside `src/` because `tsconfig.build.json` would emit it as `dist/testing.d.ts`. Every browser project declares `globalSetup: tests/harness/build-setup.ts`, which runs the build once per Vitest invocation (~9 s cold) in its own persistent cache, `node_modules/.cache/rspack-test`, so any command that touches a browser tests the current tree. **A test imports from ONE bundle**: two bundles are two copies of the code, and `instanceof` and module singletons do not cross. The unit project runs on `src/` with no build.

| Project | Where | What |
|---|---|---|
| `unit` | `tests/unit/` | Node: `lib/` the pure logic of `src/`, `tooling/` the scripts' and the planner's own tests |
| `chrome · <vfs>/<build>`, `firefox · <vfs>/<build>` | `tests/browser/pairs/*.test.ts` | Stock Chrome / Firefox, one project per DECLARED pair whatever the environment (`allTargets()`, `tests/harness/target-projects.ts`); the planner chooses which run. `firefox/`, `isolated/` and the never-created `chromium/` are gone since `test/convert-needs` (2026-10-13): a directory decides nothing, tags do |
| `isolated chrome · …`, `isolated firefox · …` | `tests/browser/pairs/*.test.ts` | The same browsers with COOP/COEP; `tests/browser/setup/isolation-check.ts` (a setup file, before the guard) fails the file by name (`ISOLATION_MISSING`) if the page is not cross-origin isolated or a `SharedArrayBuffer` does not reach a worker |
| `conformance chrome`, `conformance firefox` | `tests/browser/conformance/` | Every VFS on its default build for the engine through seven invariants (`invariants.test.ts`), the VFS folders (`folders.test.ts`), and every declared (vfs, build) pair opening and serving a query (`builds.test.ts`); no target and no per-engine directory, deliberately — the value is the same invariants on both engines |
| `consumer` | `scripts/consumer-smoke.ts` | `pnpm test:consumer`, run by `pre-push` for a `v*` tag and by the release's `consumer-smoke` job (nowhere else since 2026-10-13): packs the tarball, lints it statically — publint 0.3.24 (`package.json` against the files shipped, `--strict`) and `@arethetypeswrong/cli` 0.18.5 (the published types under each resolution mode, `--profile esm-only`) — then installs it into temp app dirs **outside** the repo and drives dev and build for each — Vite, Vite 6 (pinned), rsbuild, webpack, Parcel — plus no-bundler static serve and a bare-specifier assertion over `dist/**/*.js`, with stock Chrome through WebdriverIO. Its console, page-error and failed-request listeners are WebDriver BiDi events |

**One `tests/vitest.config.ts`, one project per declared pair.** A target is a (vfs, build) pair, handed to the tests through Vitest's `provide` / `inject` (`bsqTarget`, `bsqEnvironment`). **Since `test/convert-needs` (plan C, 2026-10-13) a test runs on its cell's pair or not at all**: it states what it needs as literal tags (`requires:`/`excludes:<property>`, `vfs:`, `build:`, `browser:`, `isolated`, `not-isolated`, `standalone`; vocabulary in `tests/harness/planner/need.ts`, declared to Vitest by `declaredTags`) and the planner places it; pinning (`createTestClient({ vfs })`), `pairFor`'s fallback, `resolvePair` and `BSQ_TEST_NEEDS` are gone, down to the types. In a test: `TEST_TARGET` is the pair, read INSIDE a test or a helper a test calls (never at module/describe scope — it is counted, see the trace); `createTestClient(options?, pair = TEST_TARGET)` — `options` is everything but `vfs`/`build` (`name`, the client's log name, allowed), `pair` is passed only by the standalone sweeps (`statement-errors`, `vfs` › every wired VFS); `sharedDatabase()` → `{ name, open(options?, spelling?) }` opens several clients on ONE database of the pair, each when the test decides, and closes them and deletes the database after the test (one `cleanUp` with `createTestClient`: `deleteDatabase` on IndexedDB and on AccessHandlePoolVFS, files removed elsewhere); a standalone test reads its pair with `standalonePair(tags)`. **Standalone** = a test that opens no VFS, or whose subject is to sweep every VFS or every build so `pnpm test` catches it early; the matrix leaves those out on purpose (user, 2026-10-13). `BSQ_TEST_TARGETS` is an input of `scripts/test-plan.ts` alone (its start pairs, never substituted). **Project filters must be globs** (`--project 'chrome ·*'`) — and a direct `vitest run --project 'chrome ·*'` now starts all 22 Chrome pairs: target one project by its full name, or go through `node scripts/test-plan.ts --pair <vfs/build> <file>`. Each browser project builds its own `instances` array: Vitest renames an instance in place, and two projects sharing one fail at startup. **The trace**: `BSQ_TEST_TRACE=1` adds `tests/browser/setup/trace.ts` (last setup file) which records per test the reads of `TEST_TARGET`, the workers started and the tags in `task.meta.bsqTrace`; `node scripts/trace-diff.ts <before.json> <after.json>` (two `test-plan --json` reports) lists the tests that ran before and not after (only passed/failed count as a run), the new ones, and traced tests that read no pair and are not standalone.

**Commands.** Every vitest call carries `--config tests/vitest.config.ts` (the config is not at the root) and `--configLoader runner`: the default loader prints Vite's `configLoader: 'native'` warning (extensionless imports in `src/`, reached through `tests/harness/target-projects.ts`) eleven times per run. **The browser scripts go through the test planner since `feat/test-planner` (plan B, 2026-10-12)**: `node scripts/test-plan.ts [--unit] [--browser chrome|firefox|safari]… [--modes not-isolated,isolated] [--full] [--mode complement|all-pairs] [--pair vfs/build]… [--table] [--json f] [file…]`. It probes each environment (`probe [isolated ]<browser>` projects, `tests/browser/probe/features.test.ts`), parses the tests statically through Vitest's Node API (`scripts/plan-io.ts`, the planner loaded through Vite since `src/` imports carry no extension), plans with `tests/harness/planner/plan.ts`, prints the plan (cells, not-applicable per browser, not-runnable pairs), runs each non-empty cell as its own process (`scripts/run-cell.ts`, the cell's exact tests by `testIds`, its guard told what was planned) `BSQ_TEST_JOBS` at a time, a cell sharded by files when there are more processes than cells, then merges the blobs into one report; a red job's last 60 log lines are printed. **Every test skipped with a reason (`ctx.skip(note)`) is listed after the merged report** (and after `--table`'s table, through a merge that runs only that reporter): `scripts/skip-notes.ts`, a reporter added to `--merge-reports`, groups them by reason, then by test, with "on every cell that ran it (N)" or the cells it skipped on. Vitest 5.0.3's default reporter prints a skip's `[note]` only on a test line, and a merge of several files prints test lines only for a failed module; its JSON reporter carries no note (2026-10-12). `pnpm test` = `--unit`, both browsers, both modes, complement mode (start pairs: `RECOMMENDED_VFS` on their default build per browser, every other test once per browser on its first eligible canonical pair); `test:chrome`/`test:firefox` the same for one browser; `test:<browser>:not-isolated`/`:isolated` and `test:isolated` that mode `--full` (isolated contexts run every eligible test, not only those isolation makes eligible). `BSQ_TEST_TARGETS` (or `--pair`) gives the start pairs, never substituted. A file named on the command line that matches no test file exits 2. `pnpm test:matrix` = `scripts/test-matrix.ts` → `test-plan.ts --mode all-pairs --table`: only cells with tests start (46 on 2026-10-12; 52 since the conversion on 2026-10-13, the isolated cells now one per `sync` pair and browser; 88 before the planner), each cell's JSON report as `<column>__<vfs>__<build>.json` under `.matrix/<run>/` (never pruned) for `scripts/matrix-triage.ts`, its console under `logs/`, plan.json too; `--engine` and `--pair` keep their meaning (`matrix.yaml` takes its pairs from `--plan-only --pairs-out` since 2026-10-13). A test eligible on no pair (dead) fails an all-pairs run over every pair, browser and mode, and warns elsewhere. In every target project `tests/browser/setup/need-guard.ts` skips, with the need, a test its pair cannot run when the project runs directly, and fails by name (`PLAN_GUARD`, `PLAN_FEATURES`) a planned test that runs against the plan; `run-cell` fails a planned id never collected (`PLAN_MISSING`); the planner refuses a test declared dynamically (`PLAN_DYNAMIC`), and `tests/unit/tooling/static-tests.test.ts` refuses the constructs static parsing cannot see. `test:conformance*` still go through `scripts/test-parallel.ts`. **Safari (`feat/safari-suite`, 2026-10-22) is opt-in everywhere, macOS included**: no default names it (`DEFAULT_BROWSERS`, `scripts/browser-names.ts` — a module with no import, because `need.ts` runs in the browser too; `test:conformance` lists Chrome's and Firefox's projects; `test:matrix`'s `DEFAULT_COLUMNS`); `test:safari`, `test:safari:not-isolated`/`:isolated`, `test:conformance:safari`, `test:matrix --engine safari --engine isolated-safari` name it. Off macOS it fails before the build (`assertBrowserAvailable`); on macOS the run prints `Safari <version>` (`Info.plist`), never downloads it (`resolveBrowsers` returns `/Applications/Safari.app` and `/usr/bin/safaridriver`), runs its projects windowed (no headless), one at a time and unsharded (`runPool`'s serial key, `allocateShards`' `unsharded`: one safaridriver session per machine), a free Safari job taken before any other so its chain runs beside the others instead of alone at the end, and adds a remote-automation hint to a refused session. **One safaridriver per Node process:** WebdriverIO kills it at session end but the `safaridriver` package keeps it as its instance and refuses a second start, so the planner calls `releaseSafaridriver()` (the package's `stop()`) after each Safari probe; `safaridriver` is a devDependency pinned to WebdriverIO's version, and `browsers.test.ts` checks the two resolve to one file. Vitest's JSON reporter carries no project name: a cell is one project run alone. `abandon-gc.test.ts` needs V8's `gc`: `BSQ_EXPOSE_GC=1` adds `--js-flags=--expose-gc` to Chrome, and without it the file skips.

**Provider facts that cost time (2026-10-10).**
- **The WebdriverIO provider runs the files of a project one at a time** (`supportsParallelism = false`) where rstest ran them in parallel pages: one Vitest invocation cannot use the machine, and projects run one after another in it. Parallelism is therefore several Vitest PROCESSES (next bullet); the figures are in `mem:measurements/suite-and-matrix`, PARALLEL-RUNS.
- **Parallel runs: `scripts/test-parallel.ts` (user-approved 2026-10-10).** `node scripts/test-parallel.ts --project <glob>… [-- <args for the merge>]` resolves the globs (Vitest's `*`, whole name, any case) against `vitest list --filesOnly --json`, builds `tests/build/` ONCE and gives every child `BSQ_TEST_BUILT=1` (each browser project's globalSetup builds it otherwise, and N builds race on the directory), then runs `vitest run --project <name> [--shard=i/N] --reporter=blob` as a pool of processes: `BSQ_TEST_JOBS` (a positive integer, else an error) or `min(6, CPUs - 1)`, at least 1 — 6 here, 3 on a 4-vCPU runner (the cap was 12 until 2026-10-13; lowered by the user so the machine stays usable beside other projects, measured in `mem:measurements/suite-and-matrix`, PARALLEL-CAP). Each browser project gets `max(1, min(files, round(jobs × files / browser files)))` shards; `unit` is one job. Each job is bounded at 900 s (`runBounded`, kills the process group; shared with the matrix in `scripts/parallel.ts`), logs to `<run>/logs/`, and writes its blob to `<run>/blobs/` — **a directory of its own: `--merge-reports` reads every file in it**. `vitest --merge-reports <run>/blobs --reporter=default` then gives ONE report, identical test by test to an unsharded run. A job that ends without its blob (crash, kill, timeout) fails the launcher, which names it with the last 60 lines of its log; the merged report lacks its tests, so never read the merge alone. Each process has its own WebDriver session, hence its own browser profile and port, so the per-file storage wipe never reaches another process. **Each job has its own Vite cache since 2026-10-13** (`jobEnv` in `scripts/parallel.ts`, used by `test-parallel.ts` and `test-plan.ts`: `BSQ_VITE_CACHE_DIR=node_modules/.vite/jobs/<job id>`, read by `tests/vitest.config.ts` as `cacheDir`): processes sharing a project's dep-optimizer cache raced when they committed it on a cold or stale cache (`ENOENT` on a `rename`, a `deps_temp_*` orphan; `mem:follow-ups/notes`). A cache holds Vitest's browser runtime pre-bundled (vitest, chai, expect-type…, ~2.4 MB), never the library; the job id is stable, so it stays warm across runs. A direct `vitest run` keeps Vite's default `node_modules/.vite/vitest/`. Each run has a timestamped directory under `.work/test-parallel/` (gitignored, newest 10 kept; `.test-parallel/` at the root until 2026-10-13) holding `blobs/` and `logs/`; the matrix keeps its runs in `.matrix/`. A Node script cannot import `tests/harness/target-projects.ts` (extensionless imports in `src/`): project names come from `vitest list`. Ctrl-C and a CI cancellation kill the jobs' groups (they are detached, so `bounded.ts`'s group kill alone would not).
- **Storage is shared across the files of a PROJECT** (one browser profile per project: each project is its own WebDriver session, and projects run one after another, so the wipe never reaches another project's storage; the shards of a parallel run are separate processes, so separate profiles too), where rstest gave each file a fresh context. `AccessHandlePoolVFS` has six fixed OPFS slots, freed only by `xDelete`, so a test that only closed its database exhausted them for the files after it ("unable to open database file"). **Every browser project therefore registers `tests/browser/setup/storage-wipe.ts` as a setup file (user, 2026-10-10: "un clean efficace et vérifié à la fin de chaque VFS+build")**: after each test file's own cleanups its `afterAll` removes every OPFS root entry and every IndexedDB database, then checks that OPFS is empty and `indexedDB.databases()` is empty. A handle still held, or a database still open, fails THAT file with the entry's name (after a 3 s settle, for a worker that has just closed). Falsified with a scratch file that leaked an open `createWritable()` and an open IndexedDB connection: red on Chrome and Firefox. A failure that appears in a full run and not in its file alone is read with this first.
- **`onTestFinished` hooks run in reverse under Vitest.** A test that intercepts workers registers its restore before `createTestClient`'s cleanup, so the cleanup ran first, with the test's broken `Worker`; `deleteDatabase` on `AccessHandlePoolVFS` spawns a worker, failed, and left the slots taken. The cleanup now deletes through the browser's own `Worker` (`withNativeWorker`, `tests/browser/helpers/index.ts`).
- **`screenshotFailures: false`**: on BiDi the provider cannot switch frames, and every failure printed a stack trace for the screenshot it tried.
- `realm.test.ts` and `cross-tab.test.ts` create their own iframe inside Vitest's.

**Every browser script runs under a deadline since 2026-09-16** — `node scripts/bounded.ts <seconds> <command>` wraps `test`, `test:browser`, `test:chrome`, `test:firefox`, `test:isolated` and the conformance scripts, and exits 124 when it kills one, the code `test:matrix` already uses. It exists because a run CAN hang where `testTimeout` and `hookTimeout` cannot reach (`mem:follow-ups`). `timeout(1)` is absent from a stock macOS, hence a script rather than a shell word; `tests/unit/tooling/bounded.test.ts` proves the deadline actually kills. **Since 2026-10-02 it kills the whole process group** (`detached`, then `process.kill(-pid)`, and a `SIGKILL` to the group once the command exits): signalling the direct child alone left `pnpm exec <runner>`'s real pnpm, the runner and its browser running under init. The command gets no stdin, since a background group that read the terminal would be stopped; on Windows it falls back to the direct child. **It also keeps every run's output in `.work/test-runs/` (gitignored; `.test-runs/` at the root until 2026-10-13, user), the newest 30, so a failure seen once survives a green rerun** (open-retry, `mem:follow-ups`); the command writes to a pipe as a result, as in CI, and `close` (or `exit` plus 2 s, should something it started hold the pipe) ends the wait. `BOUNDED_RUNS_DIR` moves the folder, for the script's own unit test.

**No test file enumerates VFS** since 2026-09-16, and **no test body names a VFS or a build** since 2026-10-13 (user): a VFS that is the subject is a `vfs:` tag, one that stands for a capability is the property, and reading `VFS_CAPABILITIES[pair.vfs]` to compute an expectation or a setup value is allowed (`database-pragmas`' `busy_timeout`, `second-client`'s refused message).

**COOP/COEP live in ONE place: the `isolated` projects of `tests/vitest.config.ts`**, through `server.headers` (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). They include every browser test file; the planner gives an isolated cell only the tests isolation makes eligible (in practice `requires:interruptible` on the `sync` pairs, whose abort channel needs a `SharedArrayBuffer`), unless a mode is asked for in full (`--full`); they run on Chrome and Firefox (spec D3, D8). Every other project stays un-isolated ON PURPOSE: that is what most consumers deploy, and the degraded path has to be asserted somewhere.

**Characterization-test convention.** A known bug is pinned with `it.fails(...)`: the test
asserts the *correct* behaviour and `.fails` asserts the bug is still there. When the bug
is fixed the test starts passing, which makes `it.fails` fail — **that red is the signal
to drop `.fails`, not a regression.** No `it.fails` anywhere since wave 2.

## Build output

```
dist/
  index.js          client-facing entry; keeps new URL('./worker/worker.js', …) literal
  *.d.ts            one per src module
  worker/
    worker.js             monolithic: 3 Emscripten glues + the VFS modules inlined
    wa-sqlite.wasm  wa-sqlite-async.wasm  wa-sqlite-jspi.wasm
```

**Both entries are minified and ship `.js.map` since 2026-08-27.** Sizes live in
`mem:measurements` and nowhere else. (The figure that stood here, "worker.js 117 KB gzip",
was stale even before minification — it measured 125.)

Only the VFS the consumer selects is fetched at runtime; the others are tarball weight
only. Source maps are never fetched unless devtools are open.

`dist/` also carries `LICENSE` beside `NOTICE`: `dist/NOTICE` says "see LICENSE", and
`dist/` is routinely separated from its package. Same reasoning as the inlined worker
banner — a pointer to a file that may not travel is no use.

**`package.json` declares `main` as well as `exports`.** Not redundant: Parcel's default
resolver does not read `exports` and falls back to `main`, so without it Parcel cannot
resolve the package at any version. The Parcel fixture in the consumer smoke is what stops
this field being deleted as dead weight.

### Build facts — not re-derivable without reading rslib source

**rslib's `esm` preset disables four parser behaviours unconditionally**
(`@rslib/core/dist/index.js:2880-2895`): `importMeta: false`, `importDynamic: false`,
`commonjs: { exports: 'skipInEsm' }`, `worker: false`; and adds `parser({ url: false })`
on the JS rule (`:2909`). This is deliberate — rslib contracts that a library entry leaves
`import.meta`, `import()`, `new Worker(new URL())` and `new URL()` intact for the
consumer's bundler. The `index` entry honours this; the `worker` entry overrides it.

**Why the worker entry uses `url: false`, not `true`:** `url: true` makes rspack emit the
wasm as content-hashed `asset/resource` files and rewrite
`new URL("wa-sqlite.wasm", import.meta.url)` into the webpack runtime expression
`__webpack_require__.p + "…"`, anchored by `__webpack_require__.b`. Neither Rollup (which
Vite uses for `format=iife` worker re-bundling) nor a consumer's own rspack can follow
that. With `url: false` the Emscripten glue keeps a literal, portable
`new URL("wa-sqlite.wasm", import.meta.url)`, and the three `.wasm` are placed beside
`worker.js` via `output.copy` — plain names, no content hash. Found through consumer smoke
testing, not by reading the docs.

**`distPath.wasm` (not `assets`) governs wasm output when `url: true`.** `output.assets`
and `output.webassemblyModuleFilename` have no effect on them. (Under `url: false` no
asset rule fires and `distPath.wasm` is irrelevant.)

**rslib forces the persistent build cache on** (`:2836`). Its digest tracks the config's
resolved *values* but not its *key structure*: changing `distPath.wasm: 'a'` to `'b'`
invalidates correctly, but swapping `distPath.assets` for `distPath.wasm` silently reuses
the old output. Fixed by `performance.buildCache.buildDependencies: [import.meta.filename]`
in `rslib.config.ts`, which hashes the config file itself. `pnpm build` is therefore always
correct; no manual `dist/` deletion is ever needed.

### Traps, each paid for once

- **`BannerPlugin`'s `stage`, once the output is minified.** Its default,
  `PROCESS_ASSETS_STAGE_ADDITIONS` (-100), runs *before* the minifier at `OPTIMIZE_SIZE`
  (400), so minification hoists declarations in front of the banner
  (`let e,t,r,…;/*! browser-sqlite …`). The notice still travels, but it is no longer the
  first bytes. The obvious fix is worse: a late stage such as `OPTIMIZE_INLINE` (700) puts
  the banner first **and silently breaks the source map**, because `DEV_TOOLING` (500) has
  already written it — the map then has no leading `;` for the banner's nine lines and
  every mapping is off by nine. The window is `OPTIMIZE_SIZE + 1`. **How to check:** the
  `mappings` field must open with as many `;` as the banner has lines.


- **Never put `/* webpackIgnore: true */` on the `new Worker(new URL(...))` call in
  `client.ts`.** rslib strips it from `dist/index.js` so it never reaches a consumer — but
  **rstest's own rspack honoured it** (the tests now run the rslib build): no worker chunk
  was emitted at test time, the worker never loaded, and the suite hung forever with no
  error. The same
  applies to `/* @vite-ignore */`, which survives into `dist/` but only suppresses the
  `?worker_file` query, not the `import.meta.url` rewrite it was added to fight. Both were
  tried, both removed.
- **rsbuild has no `preview` config key** — only `server`, and `server.headers` **does**
  apply to `rsbuild preview`. Verified by probe. Vite is the one that splits `server` and
  `preview`; do not copy Vite's shape into an rsbuild config.
- **A chunked worker is impossible while Vite is a supported consumer.** Vite re-bundles
  worker entries through Rollup with `format=iife`, and Rollup refuses code-splitting in
  that format. Structural, not tuning. The monolithic worker is the permanent shipped
  shape — re-litigated and re-closed 2026-08-24.

**rsbuild renames the emitted worker chunk** (`webpackChunkName: "browser-sqlite"`), so no
test may assert a `worker/worker.js` substring in an error message. The lifecycle test
asserts the stable wording (`'could not load its worker from'`, `'Bundler Configuration'`)
instead.

### The consumer smoke's five fixtures — why each exists

Under `tests/consumers/` (`tests/consumer*` until 2026-10-14): `vite`, `vite6`, `rsbuild`,
`webpack`, `parcel`, plus `nobundler`.

- **`vite6` is not redundant with `vite`.** The latter's range resolves to the
  newest Vite, where `optimizeDeps.exclude` is a no-op — so the one line of configuration
  the README asks a consumer to write was verified by nothing. The pinned fixture is where
  that line decides whether dev works. **Falsified 2026-08-27**: delete the line and
  "Vite 6 dev server" reddens, alone.
- **`parcel` guards the `main` field** — the only resolver here that ignores
  `exports`.
- **`webpack` needs `scriptLoading: 'module'` on `HtmlWebpackPlugin`.** The output
  is ESM (`experiments.outputModule`), and the plugin's default `<script src>` has no
  `type="module"`, giving `Cannot use 'import.meta' outside a module` at runtime while the
  build passes.
- webpack and Parcel fixtures are **plain JS on purpose**: a TS loader is not what they are
  there to prove.
- `tsconfig.json` excludes them as one folder, `"tests/consumers"`, not one by one — a new
  fixture must not redden `tsc --noEmit` for a resolution that is correct where it runs.
- `scaffoldApp` returns false rather than throwing: one bundler failing to install must not
  cancel the other four.

## Devcontainer

Ported from `lalexdotcom/claude-scaffold` on 2026-09-28 (identity, `gh`, lifecycle split), not
aligned with it wholesale: the image, the stock browsers (`post-create.sh` installs their system libraries, then the pinned browsers) and the Serena prerelease flag are ours.

- **Agent tooling in `on-create.sh`, project setup in `post-create.sh`.** The Claude Code
  extension starts its MCPs and hooks when VS Code attaches, which is after `onCreateCommand`;
  `waitFor: "postCreateCommand"` holds the window until the project is set up.
- **Commit identity comes from `initializeCommand`, on the host.** VS Code copies the host
  `~/.gitconfig` into the container **once, at creation** — later starts only rewrite its
  `credential.helper` (seen 2026-09-28: a container built 2026-08-17 still held the host file of
  that date). The host file now carries no identity, sets `useConfigOnly`, and delegates through
  `includeIf "gitdir:~/Perso/Workspaces/"`, whose host path never matches in here. So
  `initializeCommand` resolves `user.name`, `user.email` and `credential.https://github.com.username`
  on the host and writes them to this clone's `.git/config`. Commits are `Alexandre LEGOUT`
  since then; the older `my-lalex` ones stay as they are.
- **`gh` gets no credential relay from VS Code; git does.** `post-attach.sh` asks
  `git credential fill` for that account's token and pipes it to `gh auth login --with-token`, at
  every attach, non-fatal. Logged in as `lalexdotcom` since 2026-09-28 (scopes `repo`, `read:org`,
  `workflow`, `gist`, `user`). Anything outward-facing through `gh` — a fork, a comment, a PR —
  waits for the user's go. **`gh` cannot re-request a review upstream** (2026-09-30):
  `requested_reviewers` answers 404 and `gh pr edit --add-reviewer` is refused for lack of
  permission, so that click is the user's.
- **`mempalace init` needs `--auto-mine`: `--yes` answers the entity questions only**, and init
  still asks "Mine this directory now?". During a rebuild stdin is a terminal, so the build waited
  on a prompt that `2>/dev/null` hid. `--no-llm`: there is no Ollama here.
- **There is no `serena index`, only `serena project index`.** The old line ran a missing command
  behind `2>/dev/null || true` and indexed nothing.

## CI and hooks

- **The GitHub workflows** (`ci.yaml`, `release-and-publish.yaml` and its `prior` job, `matrix.yaml`, `pages.yaml` and its bench check), actionlint, and what bites in each: `mem:stack-and-build/ci`.
- Local hooks (simple-git-hooks): `pre-commit`, `pre-merge-commit`, `pre-push` (and `post-checkout`); since 2026-10-13 each runs what its change calls for, through `node scripts/hook-gate.ts <hook> --run` — `mem:git-hooks`. The render of `pnpm docs:vfs` rewrites `VFS.md`'s generated spans in the working tree, so an UNCOMMITTED hand edit inside one is overwritten silently by the docs check. All bypassable with `--no-verify`. The agent's own verification at delivery is the gate (user), CI the independent one.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath`. Without it the root tsconfig pushes the common
  source root to the repo root: declarations would land in `dist/src/` while
  `package.json` points at `dist/index.d.ts`, and `dist/tests/` would ship inside the
  package.
- `tsconfig.json` `include` is `["src", "tests", "scripts", "rslib.config.ts"]` — `scripts` since 2026-09-24; the test configs are under `tests/` since 2026-10-14. **`.mjs` files are still not type-checked**: there is no `allowJs`/`checkJs` (`mem:follow-ups`).
  Only `strict` is on.

## The benchmark page

`scripts/bench/html/index.html`, one self-contained file served beside a **verbatim** copy
of `dist/`, so it exercises the library exactly as a bundler-free consumer would. Scripts:
`scripts/bench/{assemble,check,dev}.ts`. **`check.ts [chrome|firefox] [--all] [--dir <path>]`** serves `_site` (or `--dir`, e.g. `_site/preview`) and drives the page; since 2026-10-13 `pages.yaml` runs it (Chrome, `--all`) on the half a run builds anew — the root when a release calls it, `/preview/` on a push of `preview`, nothing on `delete` — before uploading, so a red page stops the deployment (not the npm publication, which comes before); and `pre-merge-commit` runs it when a merge moves `scripts/bench/`. A `src/` change that breaks the page is seen only at the next deployment (accepted, spec § 8). `pnpm bench:dev` / `bench:serve` / `bench:build`.
`http://127.0.0.1` is a secure context, so OPFS works with no certificate. A phone on the
LAN is not, so a tunnel is needed there. `.bench/` holds device exports and is gitignored —
read, never committed.

The page's layout under `scripts/bench/` was the user's call over a reasoned objection.
Do not relitigate it.
