# Safari in the library's test suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safari becomes a third, opt-in browser of the suite on macOS, symmetric with Chrome and Firefox, and a first full Safari run on macOS 26 and 27 is measured.

**Architecture:** `scripts/browsers.ts` learns a browser that is neither downloaded nor pinned (`safari`), with a platform check and a session-error hint. Every list written as `chrome`/`firefox` derives from two constants, `ALL_BROWSERS` (what exists) and `DEFAULT_BROWSERS` (what runs unless named). `runPool` gains a serial key so no two Safari jobs ever overlap, and Safari projects are never sharded. CI enables `safaridriver` when the list names Safari.

**Tech Stack:** Node 24 (TypeScript run natively), Vitest 5 browser mode with `@vitest/browser-webdriverio`, WebdriverIO 10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-22-safari-suite-design.md`

## Global Constraints

- Safari is opt-in everywhere: `DEFAULT_BROWSERS` is `['chrome', 'firefox']`; no default (no `--browser`, `install` with no list, `test:matrix` with no `--engine`, `test:conformance`, the hooks) ever adds Safari.
- Linux and Windows runs unchanged: same plan, same cells, same not-applicable counts as `main`.
- No two Safari WebDriver sessions ever overlap, by construction (no retry on `already paired`).
- Safari capabilities: `{ browserName: 'safari' }` only — no `browserVersion`, no binary, no driver path, no headless.
- No Safari skip for a defect of this repository's code; a Safari-version skip only for a WebKit defect.
- Serena tools for code (AGENTS.md). Commits: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- Every subagent prompt that touches code carries AGENTS.md's Serena rule.

## Review Focus

1. **The two Safari probes of one plan.** `probe safari` then `probe isolated safari` run in one Vitest instance; if the first session stays open, the second is refused `already paired`. Expected: the plan probes both and goes on. Pinned by Task 4 Step 6 (close the probe's browser) and proven by Task 6's GitHub run.
2. **Two Safari projects in one `test-parallel` or `test-plan` run** (both modes; `conformance safari` beside nothing else, cut in shards). Expected: never two at once. Pinned by Task 3's `runPool` serial-key tests and the unsharded test.
3. **`--browser safari` off macOS.** Expected: exit before any build, probe or Vitest start, with the macOS-only message. Pinned by Task 1's `assertBrowserAvailable` tests and Task 4 Step 8's command.
4. **A session error on Safari.** Expected: the original error is kept and the remote-automation hint appended, except for `already paired`, which passes through unchanged. Pinned by Task 1's `withSafariHint` tests and Task 2's provider test.
5. **A Linux run after the change.** Expected: the same plan as `main`. Pinned by Task 4 Step 1 (plan captured on `main`) and Step 9 (compared).

---

### Task 1: Safari in `scripts/browsers.ts`

**Files:**
- Modify: `scripts/browsers.ts`
- Test: `tests/unit/tooling/browsers.test.ts`

**Interfaces:**
- Produces:
  - `type BrowserName = 'chrome' | 'firefox' | 'safari'`
  - `type DownloadedBrowser = Exclude<BrowserName, 'safari'>` — the key type of `PINNED`, `ENV_VAR`, and the parameter of `browserVersion` and `cacheItems`
  - `const ALL_BROWSERS: readonly BrowserName[] = ['chrome', 'firefox', 'safari']`
  - `const DEFAULT_BROWSERS: readonly BrowserName[] = ['chrome', 'firefox']`
  - `isBrowserName(name: string): name is BrowserName`
  - `assertBrowserAvailable(name: BrowserName, platform: NodeJS.Platform = process.platform): void`
  - `withSafariHint(error: unknown): unknown`
  - `safariVersion(): string`
  - `const SAFARI_AUTOMATION_HINT: string`
  - `parseBrowserList(arg)`, `browserCapabilities(name, binaries, extra?, env?)`, `resolveBrowsers(names, options?)` keep their signatures with the widened `BrowserName`.

- [ ] **Step 0: Capture `main`'s plans, before any code change** (the branch holds only docs at this point): `node scripts/test-plan.ts --unit --plan-only > $SCRATCH/plan-main.txt` and `node scripts/test-plan.ts --mode all-pairs --plan-only > $SCRATCH/plan-main-all.txt` (`$SCRATCH` = the session scratchpad). Task 4 Step 9 compares against them.

- [ ] **Step 1: Write the failing tests** in `browsers.test.ts`, in the file's style:
  - `parseBrowserList`: `'is Chrome and Firefox when no list is given, never Safari'` → `parseBrowserList(undefined)` equals `['chrome', 'firefox']`; `'takes safari when named'` → `parseBrowserList('safari,chrome')` equals `['safari', 'chrome']`; the unknown-name test now expects the message to name `chrome, firefox, safari`.
  - `describe('assertBrowserAvailable')`: `'refuses Safari off macOS, naming the platform'` → for `'linux'` and `'win32'`, throws `'browsers: Safari runs on macOS only, not on linux'` (resp. `win32`); `'lets Safari through on macOS and every browser elsewhere'` → no throw for `('safari', 'darwin')`, `('chrome', 'linux')`, `('firefox', 'win32')`.
  - `browserCapabilities`: `'gives Safari its name and nothing else'` → `browserCapabilities('safari', { browser: 'x', driver: 'y' }, { args: ['-headless'] })` toEqual `{ browserName: 'safari' }`.
  - `describe('withSafariHint')`: `'appends the remote-automation hint and keeps the original message'` → for `new Error('Could not create a session: boom')`, the result is an `Error` whose message starts with `'Could not create a session: boom'` and contains `SAFARI_AUTOMATION_HINT`, and whose `cause` is the original; `'leaves already paired untouched'` → the same object comes back for `new Error('Session not created: already paired')`; `'wraps a non-Error'` → `withSafariHint('x')` is an `Error` containing the hint.
  - `resolveBrowsers`: `'installs nothing for Safari, on macOS'` → with an `items` seam that throws, `resolveBrowsers(['safari'], { …, platform: 'darwin' })` resolves to `{ safari: { browser: '/Applications/Safari.app', driver: '/usr/bin/safaridriver' } }`; `'refuses Safari off macOS before installing anything'` → with `platform: 'linux'`, rejects with the macOS-only message and the `items` seam never called. (`ResolveOptions` gains a `platform?: NodeJS.Platform` test seam.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browsers.test.ts`
Expected: FAIL (`assertBrowserAvailable` / `withSafariHint` not exported, Safari capabilities wrong).

- [ ] **Step 3: Implement in `scripts/browsers.ts`**
  - The types and constants above; `NAMES` goes, replaced by `ALL_BROWSERS` (validation) and `DEFAULT_BROWSERS` (`parseBrowserList`'s default).
  - `assertBrowserAvailable`: throws `` `browsers: Safari runs on macOS only, not on ${platform}` `` for `safari` when `platform !== 'darwin'`.
  - `SAFARI_AUTOMATION_HINT` copy, verbatim: `Safari refused the WebDriver session. Turn on remote automation, once per machine: in Safari, Settings > Advanced > "Show features for web developers", then Settings > Developer > "Allow remote automation"; or run \`sudo safaridriver --enable\`.`
  - `withSafariHint`: returns `error` unchanged when its message contains `already paired`; otherwise a new `Error(`${message}\n${SAFARI_AUTOMATION_HINT}`, { cause: error })`.
  - `browserCapabilities`: `safari` → `{ browserName: 'safari' }` before any other branch.
  - `resolveBrowsers`: `assertBrowserAvailable` on every name first (with the `platform` seam), Safari takes no cache item and maps to the two fixed paths `/Applications/Safari.app` and `/usr/bin/safaridriver`; only downloaded browsers go through `runOnce`.
  - `safariVersion()`: `execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', '/Applications/Safari.app/Contents/Info.plist'])`, trimmed.
  - `installAll`: Safari gets no `args`; the `remote()` call for Safari is wrapped so a failure rethrows `withSafariHint(error)`; the `ok` line stays `` `${name} ${version}: ok` ``. The usage line and header comment say `[chrome,firefox,safari]`, Chrome and Firefox by default.

- [ ] **Step 4: Run the tests to see them pass**, then `pnpm exec tsc --noEmit`. Expected: PASS; tsc clean. (`bench/check.ts` keeps its own `chrome`/`firefox` guard; `consumer-smoke.ts` passes `'chrome'`. If tsc flags `browserVersion`/`cacheItems` callers, narrow them to `DownloadedBrowser`.)

- [ ] **Step 5: Commit** — `feat(browsers): Safari as an opt-in browser, macOS only`

---

### Task 2: Safari in the Vitest harness

**Files:**
- Modify: `tests/vitest.config.ts`, `tests/harness/browsers-setup.ts`, `tests/harness/browser-provider.ts`, `tests/harness/planner/need.ts`
- Test: `tests/unit/tooling/browsers-setup.test.ts`, `tests/unit/tooling/browser-provider.test.ts`, `tests/unit/tooling/need.test.ts`

**Interfaces:**
- Consumes: `ALL_BROWSERS`, `isBrowserName`, `withSafariHint`, `resolveBrowsers` (Task 1).
- Produces: Vitest projects `safari · <vfs>/<build>`, `isolated safari · <vfs>/<build>`, `conformance safari`, `probe safari`, `probe isolated safari`, on every platform; the tag `browser:safari`.

- [ ] **Step 1: Write the failing tests**
  - `browsers-setup.test.ts`: `'refuses a browser it cannot install'` uses `project('edge')` and expects `'not chrome, firefox or safari'`; new `'resolves Safari like the others'` → `setup(project('safari'), resolve)` asks `[['safari']]`.
  - `browser-provider.test.ts`: `'appends the remote-automation hint when Safari refuses the session'` → a fake provider whose `openBrowser` rejects with `new Error('boom')`, wrapped for `'safari'` with a `resolve` stub; `openBrowser()` rejects with a message containing `'boom'` and `'Allow remote automation'`. And `'passes a Chrome session error through untouched'` → the same for `'chrome'` rejects with exactly the original error object.
  - `need.test.ts` `'declare every tag the vocabulary can spell, once'`: expect `browser:safari` among the tags (adapt the existing expectation if it lists browsers).

- [ ] **Step 2: Run them to see them fail** — same command as Task 1 Step 2 on the three files. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `browsers-setup.ts`: guard with `isBrowserName`, message `` `…targets "${name}", not chrome, firefox or safari` ``; then `resolve([name])` (which throws the macOS-only error off macOS).
  - `browser-provider.ts`, `withResolvedCapabilities`: for `browser === 'safari'`, `open()` is awaited in a `try` and a rejection rethrows `withSafariHint(error)`.
  - `vitest.config.ts`: `ENGINES = ALL_BROWSERS`; `headless: browser !== 'safari'`, with a one-line comment (Safari has no headless; the provider throws on it).
  - `need.ts`: `BROWSERS = ALL_BROWSERS`.

- [ ] **Step 4: Run them to see them pass**, then `pnpm test:unit` and `pnpm exec tsc --noEmit`. Expected: all green.

- [ ] **Step 5: Commit** — `feat(test): Safari projects in the Vitest config`

---

### Task 3: One lane for Safari in the job pool

**Files:**
- Modify: `scripts/parallel.ts`
- Test: `tests/unit/tooling/parallel.test.ts`

**Interfaces:**
- Produces:
  - `runPool<T, R>(items, concurrency, worker, serialKey?: (item: T) => string | undefined)` — items with the same defined key never run at once; others as before.
  - `browserOfProject(name: string): BrowserName | undefined` — the browser a project name targets (`'safari · X/y'`, `'isolated safari · X/y'`, `'conformance safari'`, `'probe isolated safari'` → `'safari'`; `'unit'` → `undefined`).
  - `allocateShards(projects, concurrency, unsharded?: (name: string) => boolean)` — an unsharded project gets exactly 1 shard and is left out of the proportional split.
  - `planJobs` passes `(name) => browserOfProject(name) === 'safari'` as `unsharded`.

- [ ] **Step 1: Write the failing tests**
  - `runPool`: `'never runs two items of one serial key at once, and keeps the others parallel'` → 6 items, keys `s,s,s,undefined,undefined,undefined`, concurrency 4, workers that record the live count per key: max live for `s` is 1; max live overall reaches 4 at some point; all 6 results fulfilled in item order. `'skips a blocked item for a free one rather than idling'` → items `[s, s, x]`, concurrency 2, the first `s` takes 50 ms: `x` starts before the second `s`.
  - `browserOfProject`: the five names above.
  - `allocateShards`: `'never cuts an unsharded project'` → `[{name:'safari · A/b', files: 40}, {name:'chrome · A/b', files: 40}]`, concurrency 6, unsharded = Safari: Safari gets 1, Chrome gets 6.
  - `planJobs`: `'gives a Safari project one job'` → `conformance safari` with 6 files at concurrency 6 yields one job with `shard: null`.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement.** `runPool`: a lane takes the first not-yet-started item whose key is not busy; when every remaining item is blocked, it waits for the next release (one promise resolved on each completion), and lanes stop when no item remains. `browserOfProject`: the first word of the name that is one of `ALL_BROWSERS`. Existing calls compile unchanged (the new parameters are optional).

- [ ] **Step 4: Run them to see them pass**; the existing `runPool`/`allocateShards`/`planJobs` tests stay green.

- [ ] **Step 5: Commit** — `feat(parallel): a serial lane for Safari, never sharded`

---

### Task 4: The planner, the matrix and the scripts take Safari

**Files:**
- Modify: `scripts/test-plan.ts`, `scripts/plan-report.ts`, `scripts/plan-io.ts`, `scripts/test-parallel.ts`, `scripts/test-matrix.ts`, `package.json`
- Test: `tests/unit/tooling/plan-report.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `deadIsFatal(run: { mode; explicitPairs: boolean; browsers: readonly BrowserName[]; modes: number }, ci: boolean)`; `COLUMNS` with `safari`, `isolated-safari`; `DEFAULT_COLUMNS` (the four Chrome/Firefox ones).

- [ ] **Step 1: Check the capture** of Task 1 Step 0 exists (`$SCRATCH/plan-main*.txt`); if lost, recreate it from a worktree of `main`.

- [ ] **Step 2: Write the failing tests** in `plan-report.test.ts`, `deadIsFatal` taking `browsers` as a list: the three existing tests rewritten with `['chrome', 'firefox']` / `['chrome']`; new `'stays fatal on a full run that adds Safari'` → `{ mode: 'all-pairs', explicitPairs: false, browsers: ['chrome', 'firefox', 'safari'], modes: 2 }` is fatal locally; new `'is not fatal on Safari alone'` → `['safari']`, CI true, complement: false.

- [ ] **Step 3: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 4: Implement `deadIsFatal`**: fatal when `browsers` includes both `chrome` and `firefox` (rest unchanged). Run the tests: PASS.

- [ ] **Step 5: `test-plan.ts`**
  - `--browser` validated with `isBrowserName`; message `` `test-plan: --browser "${browser}" is not chrome, firefox or safari` ``; default `[...DEFAULT_BROWSERS]`; header comment `[--browser chrome|firefox|safari]…`.
  - First thing in `main()`, before `buildOnce`: `assertBrowserAvailable` for every selected browser (exit code 2 with the message, no stack); then, when Safari is selected, print `` `Safari ${safariVersion()}` `` on its own line.
  - `deadIsFatal(..., browsers: options.browsers, ...)`.
  - The `--table` column list: `ALL_BROWSERS` then their `isolated-` forms, filtered as today.
  - Shards: `allocateShards(..., (name) => browserOfProject(name) === 'safari')`; `runPool(jobs, concurrency, worker, (job) => job.cell !== null && browserOfProject(cells[job.cell].project) === 'safari' ? 'safari' : undefined)`.

- [ ] **Step 6: `plan-io.ts`, `probeFeatures`**: when `family.browser === 'safari'`, close that probe project's browser once its result is read (the Vitest 5 `TestProject` API for it — check `project.browser` in `node_modules/vitest` types; if no public close exists, run each Safari probe in its own `openVitest()` and close it). One comment line: one Safari session per machine.

- [ ] **Step 7: `test-parallel.ts`**: `assertBrowserAvailable` + the Safari version line for every browser `browserOfProject` finds among the matched names (before any job); `runPool(..., (job) => browserOfProject(job.project) === 'safari' ? 'safari' : undefined)`. `test-matrix.ts`: `COLUMNS` gains `safari` and `isolated-safari`; `DEFAULT_COLUMNS` = the four others, used when no `--engine`; the doc comment names Safari as opt-in. `package.json`:
  - `"test:safari": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser safari"`
  - `"test:safari:not-isolated": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser safari --modes not-isolated --full"`
  - `"test:safari:isolated": "node scripts/bounded.ts 600 node scripts/test-plan.ts --browser safari --modes isolated --full"`
  - `"test:conformance": "node scripts/bounded.ts 1800 node scripts/test-parallel.ts --project \"conformance chrome\" --project \"conformance firefox\""`
  - `"test:conformance:safari": "node scripts/bounded.ts 900 node scripts/test-parallel.ts --project \"conformance safari\""`
  (`test:browser` and `test:isolated` need no change: their default list is `DEFAULT_BROWSERS`.)

- [ ] **Step 8: Off-macOS check, in this container**

Run: `pnpm test:safari; echo $?` and `node scripts/browsers.ts install safari; echo $?` and `pnpm test:conformance:safari; echo $?`
Expected: each exits non-zero within seconds, printing `browsers: Safari runs on macOS only, not on linux`, with no build and no Vitest output before it.

- [ ] **Step 9: Linux unchanged**

Run: the two commands of Step 1 into `plan-branch*.txt`, then `diff` each pair.
Expected: no difference in cells, reasons or not-applicable lists (timing lines aside).

- [ ] **Step 10: Full local gate**: `pnpm exec biome ci .`, `pnpm lint` (0 warnings), `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm test:conformance` — all green; `pnpm test`'s "Skipped with a reason" list and not-applicable counts as on `main`.

- [ ] **Step 11: Commit** — `feat(test): --browser safari in the planner, the matrix and the scripts`

---

### Task 5: CI enables Safari; temporary Safari-only macOS runs

**Files:**
- Modify: `.github/actions/setup/action.yaml`, `.github/workflows/tests.yaml`, `.github/workflows/tests-macos-26.yaml`, `.github/workflows/tests-macos-27.yaml`

- [ ] **Step 1: Setup action.** The `browsers` input description says `chrome,firefox,safari`. Before "Install browsers", a step `if: contains(format(',{0},', inputs.browsers), ',safari,')` named "Enable safaridriver", `run: sudo safaridriver --enable` (with a comment: one session per machine; remote automation is what this turns on). Off macOS the install step then fails with the macOS-only message, which is the point.

- [ ] **Step 2: `tests.yaml`.** `browsers` description mentions Safari, opt-in. **Temporary, for the tuning runs:** the `Conformance` step gets `if: ${{ !cancelled() }}` with a comment `# TEMPORARY (feat/safari-suite): back to success() before the merge.`

- [ ] **Step 3: macOS callers, temporary.** Both set `browsers: safari` with the same `TEMPORARY` comment (final value `chrome,firefox,safari`).

- [ ] **Step 4: Lint** — `node scripts/actionlint.ts`. Expected: clean.

- [ ] **Step 5: Commit** — `ci(macos): enable safaridriver; Safari-only macOS runs while tuning`

---

### Task 6: First run on GitHub, measured

- [ ] **Step 1: Push the branch** (allowed for this piece): `git push -u origin feat/safari-suite`. `ci.yaml` does not run on a branch push (it runs on `main` and PRs, and opening a PR is not authorised), so Linux is proven by dispatching `tests-ubuntu.yaml` on the branch — the same `tests.yaml` as `ci.yaml`'s `linux` job; the `checks` job's content is Task 4 Step 10's local gate.
- [ ] **Step 2: Dispatch** `gh workflow run tests-ubuntu.yaml --ref feat/safari-suite` (expected green, as on `main`), `gh workflow run tests-macos-26.yaml --ref feat/safari-suite` and the same for `tests-macos-27.yaml`; wait with `gh run watch <id> --exit-status` in the background.
- [ ] **Step 3: Read both runs**: the Safari version line, `pnpm test`'s plan (cells, not-applicable counts for `safari` and `isolated safari`), "Skipped with a reason", every failure (test, file, message), durations of `Test` and `Conformance`, and whether the plan's two probes passed (Review Focus 1). On a red run, download `test-logs-macOS`.
- [ ] **Step 4: Fix only the wiring.** A failure caused by this branch's code (a refused second session, a shard overlap, a missing hint, the bound) is fixed here, with a test where one can be written, and the dispatch repeated. A failure of a test on Safari is not fixed here: it is recorded (Task 7).
- [ ] **Step 5:** stop when both runs reach the end of both steps with no wiring failure.

---

### Task 7: Record, restore, close

- [ ] **Step 1: Memories (Serena).** `mem:measurements/test-browsers`: the run (date, runner image, macOS and Safari versions, counts, durations, the not-applicable counts per Safari family, the reasoned skips). `mem:follow-ups`: one entry per distinct Safari failure, the two known ones included if they reappear. `mem:stack-and-build/ci`: the Safari step and the browser lists. `mem:follow-ups/safari-suite` closed into `mem:history/2026-10-19-to-25`; `mem:state` updated.
- [ ] **Step 2: Restore.** `tests.yaml`'s `Conformance` back to its previous condition (no `if:`), the macOS callers to `browsers: chrome,firefox,safari`, the `TEMPORARY` comments gone. `node scripts/actionlint.ts` clean. Commit `ci(macos): Chrome, Firefox and Safari on macOS`.
- [ ] **Step 3: One dispatch of each macOS workflow** with the three browsers: Chrome and Firefox steps' results as on `main`; Safari's failures are the recorded ones.
- [ ] **Step 4: Close** per AGENTS.md: format, lint, typecheck, tests green; whole-branch review; `git merge --no-ff` into `main`; branch deleted (local and remote). No `CHANGELOG.md` entry (nothing shipped changes).
