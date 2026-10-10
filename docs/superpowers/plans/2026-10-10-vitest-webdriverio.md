# The test suite on Vitest and stock browsers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every test of the repository from rstest + Playwright to Vitest 5 + WebdriverIO 10 on stock Chrome and Firefox, against the library as rslib builds it, and take Playwright and rstest out of the repository.

**Architecture:** `rslib.test.config.ts` builds the published config into `tests/build/` plus a test-only entry `tests/testing.ts`; `vitest.config.ts` declares a Node `unit` project and one browser project per (engine, target), each aliasing `browser-sqlite` to that build and receiving its target through `provide`/`inject`. `scripts/browsers.ts` holds the browser pins for the tests, `consumer-smoke` and `bench/check`. The matrix script reads Vitest's JSON reporter.

**Tech Stack:** Vitest 5.0.3, `@vitest/browser-webdriverio` 5.0.0, webdriverio 10.0.2, Vite 8.3.4, `@puppeteer/browsers` 3.x, rslib 0.23.2, TypeScript 7, biome 2.5.8, pnpm 10.31, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-10-vitest-webdriverio-design.md` — read it whole before starting. The spike it cites is on branch `spike/vitest-webdriverio` (commit `1b75cfb`): `vitest.config.ts`, `rslib.test.config.ts`, `tests/testing.ts` there are working references.

## Global Constraints

- Branch `test/vitest-webdriverio`, in the main checkout `/workspaces/wsqlite` — **no git worktree** (`mem:conventions`). Check the branch in the same command as every commit: `test "$(git branch --show-current)" = test/vitest-webdriverio && git commit …`.
- Every commit lands on a green tree: `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, and the test command the task names.
- **Never** `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm store prune` or a bare `pnpm install` beyond the `pnpm add`/`pnpm remove` a step names. If a hook fails, stop and report its output verbatim. After each commit: `git log --oneline -1` and `git show --stat HEAD`.
- Never push. Never delete anything outside the repository (`~/.cache/ms-playwright` stays).
- Code files are read and edited through Serena's symbolic tools (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `replace_content`); built-in Read/Edit only for non-code files (`.md`, `.json`, `.yaml`, `.sh`) or when Serena fails. Every subagent prompt that touches code carries this rule.
- Pinned browsers: Chrome `153.0.8010.52`, Firefox `stable_155.0.1`. Firefox **must** carry a channel prefix: a bare number or `latest` resolves to a Nightly.
- webdriverio `10.0.2` (9.x downloads an x86-64 Chrome on linux-arm64). Vitest `5.0.3`, `@vitest/browser-webdriverio` `5.0.0`, Vite `8.3.4`.
- Coverage and browsers do not change (spec D7), except the isolated tests also run on Firefox (D8).
- A test takes the library from ONE bundle: `browser-sqlite` or `browser-sqlite/testing` (spec D4).
- Comments state the fact in one or two lines; no hard wrap in Markdown prose; no counts of VFS in docs or comments (`mem:conventions`).
- No CHANGELOG entry (nothing a consumer sees changes).
- Probes, baselines and throwaway scripts go in `.scratchpad/vitest-migration/` (gitignored); nothing committed may depend on them.
- Every run past ~2 minutes: a progress line to the user at launch and every 2 minutes (`mem:conventions`).

## Review Focus

- **A stale build under test.** A Vitest run after an edit to `src/` must test the edited code, in a single-file run and in watch mode, not a `tests/build/` left by an earlier run — Task 3 Step 7 pins it.
- **A project receiving another project's target.** With one browser project per target, each must inject its own pair; a leak would make every cell test the same pair and still pass — Task 3 Step 6 pins it.
- **A Firefox version without its channel prefix** (`BSQ_FIREFOX_VERSION=156.0`) silently runs a Nightly or fails to download — Task 2 pins it with a unit test: `browsers.ts` refuses it.
- **A matrix cell that crashed with no failed test** must not read as green, and a cell whose failures are all `TARGET_NOT_RUNNABLE` must read as not runnable — Task 6 pins both with Vitest JSON fixtures.
- **A consumer-smoke page error that the driver no longer sees.** After the move to BiDi events, a broken consumer app must still fail its stage and print the browser's error — Task 7 Step 4 pins it with a deliberately broken tarball.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/browsers.ts` (new) | Browser pins, env overrides, WebdriverIO capabilities, cache dir; CLI `install` and `deps` for the devcontainer | 2 |
| `tests/unit/browsers.test.ts` (new) | Unit tests of `browsers.ts`'s version resolution | 2 |
| `rslib.test.config.ts` (new) | `rslib.config.ts` into `tests/build/` + the `testing` entry | 3 |
| `tests/testing.ts` (new) | Public surface + internals for white-box tests | 3 |
| `tests/build-setup.ts` (new) | Vitest `globalSetup`: builds `tests/build/` once per run, rebuilds in watch mode | 3 |
| `vitest.config.ts` (new) | All projects | 1, 3, 5 |
| `tests/vitest.d.ts` (new) | `ProvidedContext` augmentation for `bsqTarget` / `bsqNeeds` | 3 |
| `tests/target-projects.ts` | Targets from the environment (unchanged logic, comments updated) | 3, 9 |
| `tests/browser/helpers.ts` | `TEST_TARGET` / `ON_UNMET_NEED` from `inject` | 3 |
| `tests/**/*.test.ts`, `tests/browser/**`, `tests/conformance/**` | Imports ported | 1, 4, 5 |
| `scripts/test-matrix.ts`, `scripts/matrix-triage.ts`, `tests/unit/test-matrix.test.ts` | Four columns, Vitest JSON | 6 |
| `scripts/consumer-smoke.ts`, `scripts/bench/check.ts` | WebdriverIO | 7 |
| `.devcontainer/post-create.sh` | System libraries + browser pre-download | 8 |
| `.github/workflows/ci.yaml`, `release-and-publish.yaml`, `pages.yaml` | WebdriverIO cache, action bumps | 8 |
| `package.json`, `tsconfig.json`, `.gitignore` | Scripts, dependencies, paths | 1–9 |
| `rstest*.config.ts` (deleted) | — | 4, 5, 9 |

---

### Task 0: Record the rstest baseline

Nothing is committed. Once imports are rewritten rstest can no longer run the files, so the baseline is taken first, on the branch as it is.

**Files:** none committed; output in `.scratchpad/vitest-migration/baseline/`.

**Interfaces:** Produces the baseline files Task 5's parity step reads: one rstest markdown report per cell, each listing `### Passed` and `### Skipped` test names as `- <file> :: <describe> > <test>`.

- [ ] **Step 1: Baseline of `pnpm test`'s cells (fallback mode)**

```bash
mkdir -p .scratchpad/vitest-migration/baseline
cd /workspaces/wsqlite
pnpm exec rstest --project 'chromium*' --reporter md run > .scratchpad/vitest-migration/baseline/test-chromium.md 2>&1; echo chromium=$?
pnpm exec rstest --config rstest.firefox.config.ts --reporter md run > .scratchpad/vitest-migration/baseline/test-firefox.md 2>&1; echo firefox=$?
pnpm exec rstest --config rstest.isolated.config.ts --reporter md run > .scratchpad/vitest-migration/baseline/test-isolated.md 2>&1; echo isolated=$?
pnpm exec rstest --project unit --reporter md run > .scratchpad/vitest-migration/baseline/test-unit.md 2>&1; echo unit=$?
pnpm exec rstest --config rstest.conformance.config.ts --reporter md run > .scratchpad/vitest-migration/baseline/conformance-chromium.md 2>&1; echo cc=$?
pnpm exec rstest --config rstest.conformance.firefox.config.ts --reporter md run > .scratchpad/vitest-migration/baseline/conformance-firefox.md 2>&1; echo cf=$?
grep -h '"status"\|passedTests\|skippedTests' .scratchpad/vitest-migration/baseline/*.md
```

Expected: every exit code 0, every status `pass`. A red baseline is reported to the user before anything else — it is not this work's to fix.

- [ ] **Step 2: Baseline of the full matrix (skip mode)** — ~45 min, run in the background with progress lines every 2 minutes.

```bash
pnpm test:matrix > .scratchpad/vitest-migration/baseline/matrix.log 2>&1; echo matrix=$?
ls -d .matrix/*/ | tail -1   # note this run's directory in .scratchpad/vitest-migration/baseline/MATRIX_RUN
```

Expected: 66 cells, all green (the matrix reads 66/66 since 2026-09-21). Write the `.matrix/<run>/` path into `.scratchpad/vitest-migration/baseline/MATRIX_RUN`.

---

### Task 1: The unit project on Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (devDependencies, `test:unit`), `rstest.config.ts` (drop the `unit` project), every file under `tests/unit/`, `tsconfig.json` (`include`)

**Interfaces:**
- Produces: `vitest.config.ts` with a `unit` project; `pnpm test:unit` = `vitest run --project unit`. Later tasks append projects to the same `projects` array.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm add -D vitest@5.0.3 vite@8.3.4 @vitest/browser-webdriverio@5.0.0 webdriverio@10.0.2
```

- [ ] **Step 2: Write `vitest.config.ts` with the unit project**

```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
          // configDefaults.exclude keeps node_modules out: the consumer
          // fixtures under tests/ install their own.
          exclude: [
            ...configDefaults.exclude,
            'tests/browser/**',
            'tests/conformance/**',
            'tests/consumer*/**',
          ],
          passWithNoTests: true,
          // Pure Node tests with no I/O: anything near this bound is a deadlock.
          testTimeout: 10_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 3: Port the unit tests' imports**

```bash
cd /workspaces/wsqlite
grep -rl "@rstest/core" tests/unit | xargs sed -i "s#from '@rstest/core'#from 'vitest'#"
grep -rln "\brstest\b" tests/unit | xargs sed -i -E "s/\brstest\.(spyOn|fn|useFakeTimers|useRealTimers|advanceTimersByTimeAsync)\b/vi.\1/g; s/(import \{[^}]*)\brstest\b([^}]*\} from 'vitest')/\1vi\2/"
grep -rn "rstest" tests/unit
```

Expected from the last grep: comments only (they are updated in Task 9). Any code reference left is fixed by hand.

- [ ] **Step 4: Remove the unit project from `rstest.config.ts`, switch the script**

In `rstest.config.ts`, delete the `{ name: 'unit', … }` entry of `projects` (Serena `replace_content`, regex `\{\s*name: 'unit',.*?testTimeout: 10000,\s*\},\s*` → empty). In `package.json`: `"test:unit": "vitest run --project unit"`. The `test` script's first leg (`rstest`) now runs the chromium projects only, which is what it ran besides unit; prepend the unit project so `pnpm test` keeps it:

```json
"test": "node scripts/bounded.ts 300 vitest run --project unit && node scripts/bounded.ts 900 rstest && node scripts/bounded.ts 900 rstest --config rstest.firefox.config.ts && node scripts/bounded.ts 600 rstest --config rstest.isolated.config.ts",
```

Add `"vitest.config.ts"` to `tsconfig.json`'s `include`.

- [ ] **Step 5: Run and compare with the baseline**

```bash
pnpm test:unit 2>&1 | tail -6
grep -h "passedTests" .scratchpad/vitest-migration/baseline/test-unit.md
pnpm exec tsc --noEmit && pnpm exec biome check --write tests/unit vitest.config.ts && pnpm exec biome ci .
```

Expected: Vitest's passed count equals the baseline's `passedTests` (731 on 2026-10-09), 0 failed.

- [ ] **Step 6: Commit**

```bash
test "$(git branch --show-current)" = test/vitest-webdriverio && git add -A tests/unit vitest.config.ts rstest.config.ts package.json pnpm-lock.yaml tsconfig.json && git commit -m "test(unit): run the unit project on Vitest

rstest has no WebDriver provider, and the suite moves to Vitest
(spec 2026-10-10). The unit project goes first: it runs on src/ under
Node with no build, so only its imports change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD | tail -5
```

---

### Task 2: Browser pins — `scripts/browsers.ts`

**Files:**
- Create: `scripts/browsers.ts`, `tests/unit/browsers.test.ts`
- Modify: `package.json` (`@puppeteer/browsers`)

**Interfaces:**
- Produces:
  - `type BrowserName = 'chrome' | 'firefox'`
  - `PINNED: Readonly<Record<BrowserName, string>>` = `{ chrome: '153.0.8010.52', firefox: 'stable_155.0.1' }`
  - `browserVersion(name: BrowserName, env?: NodeJS.ProcessEnv): string` — `BSQ_CHROME_VERSION` / `BSQ_FIREFOX_VERSION`, else the pin; throws on a Firefox version without a channel prefix.
  - `browserCapabilities(name: BrowserName, env?: NodeJS.ProcessEnv): WebdriverIO.Capabilities` — `browserVersion`, plus `goog:chromeOptions.args: ['--js-flags=--expose-gc']` when `BSQ_EXPOSE_GC=1` and `name === 'chrome'`.
  - `WDIO_CACHE_DIR: string` — absolute path of `node_modules/.cache/wdio`.
  - CLI: `node scripts/browsers.ts deps` prints the apt packages both browsers need, one line; `node scripts/browsers.ts install` downloads both browsers and their drivers and opens and closes a session in each.

- [ ] **Step 1: Write the failing test**

`tests/unit/browsers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  browserCapabilities,
  browserVersion,
  PINNED,
} from '../../scripts/browsers.ts';

describe('browserVersion', () => {
  it('returns the pins when nothing overrides them', () => {
    expect(browserVersion('chrome', {})).toBe(PINNED.chrome);
    expect(browserVersion('firefox', {})).toBe(PINNED.firefox);
  });

  it('takes BSQ_CHROME_VERSION and BSQ_FIREFOX_VERSION', () => {
    expect(browserVersion('chrome', { BSQ_CHROME_VERSION: '155.0.8059.39' })).toBe('155.0.8059.39');
    expect(browserVersion('firefox', { BSQ_FIREFOX_VERSION: 'stable_157.0.1' })).toBe('stable_157.0.1');
  });

  // A bare number or `latest` makes @puppeteer/browsers resolve a Nightly.
  it('refuses a Firefox version without a channel prefix', () => {
    for (const bad of ['156.0', 'latest', '157.0.1']) {
      expect(() => browserVersion('firefox', { BSQ_FIREFOX_VERSION: bad })).toThrow(/channel prefix/);
    }
  });
});

describe('browserCapabilities', () => {
  it('adds --expose-gc to Chrome only under BSQ_EXPOSE_GC=1', () => {
    expect(browserCapabilities('chrome', {})['goog:chromeOptions']).toBeUndefined();
    expect(browserCapabilities('chrome', { BSQ_EXPOSE_GC: '1' })['goog:chromeOptions']?.args).toEqual(['--js-flags=--expose-gc']);
    expect(browserCapabilities('firefox', { BSQ_EXPOSE_GC: '1' })['goog:chromeOptions']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — expected FAIL** (`Cannot find module '../../scripts/browsers.ts'`)

```bash
pnpm exec vitest run --project unit tests/unit/browsers.test.ts
```

- [ ] **Step 3: Write `scripts/browsers.ts`**

```bash
pnpm add -D @puppeteer/browsers@^3.2.4
```

```ts
/**
 * The browsers every harness of this repository drives: the Vitest projects,
 * `consumer-smoke` and `bench/check`. Chrome a few majors behind the newest
 * and the Firefox release current on that Chrome's stable date (2026-09-08),
 * so the two are of one age (mem:conventions).
 *
 *   node scripts/browsers.ts deps      apt packages both need, on one line
 *   node scripts/browsers.ts install   download both, open and close a session
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from '@puppeteer/browsers';

export type BrowserName = 'chrome' | 'firefox';

export const PINNED: Readonly<Record<BrowserName, string>> = {
  chrome: '153.0.8010.52',
  firefox: 'stable_155.0.1',
};

/** Where WebdriverIO keeps the browsers and drivers it downloads. */
export const WDIO_CACHE_DIR = fileURLToPath(
  new URL('../node_modules/.cache/wdio', import.meta.url),
);

const ENV_VAR: Record<BrowserName, string> = {
  chrome: 'BSQ_CHROME_VERSION',
  firefox: 'BSQ_FIREFOX_VERSION',
};

const FIREFOX_CHANNELS = /^(stable|beta|devedition|esr|nightly)_/;

export const browserVersion = (
  name: BrowserName,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const version = env[ENV_VAR[name]] ?? PINNED[name];
  // @puppeteer/browsers reads a bare Firefox number, or `latest`, as a Nightly.
  if (name === 'firefox' && !FIREFOX_CHANNELS.test(version)) {
    throw new Error(
      `${ENV_VAR.firefox}="${version}" needs a channel prefix, e.g. stable_${version}`,
    );
  }
  return version;
};

export const browserCapabilities = (
  name: BrowserName,
  env: NodeJS.ProcessEnv = process.env,
): WebdriverIO.Capabilities => ({
  browserName: name,
  browserVersion: browserVersion(name, env),
  ...(name === 'chrome' && env.BSQ_EXPOSE_GC === '1'
    ? { 'goog:chromeOptions': { args: ['--js-flags=--expose-gc'] } }
    : {}),
});

/** `libfoo (>= 1)` / `liba | libb` → `libfoo`, `liba`: the first alternative, no version. */
const firstAlternative = (line: string) =>
  line.split('|')[0]?.replace(/\(.*\)/, '').trim() ?? '';

/** Chrome for Testing ships its Debian dependencies as `deb.deps`; Firefox's are Debian's `firefox-esr`'s. */
async function deps(): Promise<string[]> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('browsers: unsupported platform');
  const buildId = browserVersion('chrome');
  await install({ browser: Browser.CHROME, buildId, cacheDir: WDIO_CACHE_DIR });
  const chromeDir = join(
    computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: WDIO_CACHE_DIR, platform }),
    '..',
  );
  const chrome = readFileSync(join(chromeDir, 'deb.deps'), 'utf8')
    .split('\n')
    .map(firstAlternative)
    .filter(Boolean);
  const firefox = execFileSync(
    'apt-cache',
    ['depends', '--no-recommends', '--no-suggests', '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances', 'firefox-esr'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => /^\s*Depends: lib/.test(l))
    .map((l) => l.replace(/^\s*Depends:\s*/, '').replace(/[<>]/g, '').trim());
  return [...new Set([...chrome, ...firefox])].sort();
}

async function installAll() {
  const { remote } = await import('webdriverio');
  for (const name of ['chrome', 'firefox'] as const) {
    const browser = await remote({
      logLevel: 'warn',
      cacheDir: WDIO_CACHE_DIR,
      capabilities: {
        ...browserCapabilities(name),
        ...(name === 'chrome'
          ? { 'goog:chromeOptions': { args: ['--headless=new'] } }
          : { 'moz:firefoxOptions': { args: ['-headless'] } }),
      },
    });
    const version = (browser.capabilities as { browserVersion?: string }).browserVersion;
    await browser.deleteSession();
    console.log(`${name} ${version}: ok`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'deps') console.log((await deps()).join(' '));
  else if (command === 'install') await installAll();
  else {
    console.error('usage: node scripts/browsers.ts deps|install');
    process.exit(2);
  }
}
```

If `computeExecutablePath`'s directory is not the one holding `deb.deps` (it is `chrome-linux-arm64/chrome`'s parent on arm64, `chrome-linux64/` on x86-64), adjust to the directory that holds it — read it off `ls node_modules/.cache/wdio/chrome/*/`.

- [ ] **Step 4: Run — expected PASS**, then try the CLI

```bash
pnpm exec vitest run --project unit tests/unit/browsers.test.ts
node scripts/browsers.ts deps | wc -w
node scripts/browsers.ts install
```

Expected: tests pass; `deps` prints ~30-60 package names; `install` prints `chrome 153.0.8010.52: ok` and `firefox 155.0.1: ok`.

- [ ] **Step 5: Commit** (`pnpm exec tsc --noEmit`, `biome check --write scripts/browsers.ts tests/unit/browsers.test.ts`, `biome ci .` first)

```bash
test "$(git branch --show-current)" = test/vitest-webdriverio && git add scripts/browsers.ts tests/unit/browsers.test.ts package.json pnpm-lock.yaml && git commit -m "test(browsers): pin Chrome 153 and Firefox 155 in one module

Chrome a few majors behind the newest and the Firefox release of that
Chrome's stable date. A Firefox version without its channel prefix is
refused: @puppeteer/browsers reads a bare number as a Nightly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The build under test, the browser projects, target injection

**Files:**
- Create: `rslib.test.config.ts`, `tests/testing.ts`, `tests/build-setup.ts`, `tests/vitest.d.ts`
- Modify: `vitest.config.ts`, `tsconfig.json` (`paths`, `include`), `.gitignore`

No test file changes here: `tests/browser/helpers.ts` is imported by every rstest browser file, so porting it would turn rstest red before Task 4 moves the rest. The infrastructure is checked with throwaway probes.

**Interfaces:**
- Consumes: `browserCapabilities`, `WDIO_CACHE_DIR`, `BrowserName` (Task 2); `targetsFromEnv`, `onUnmetFromEnv`, `targetLabel`, `CHROMIUM_FEATURES`, `FIREFOX_FEATURES` (`tests/target-projects.ts`, unchanged).
- Produces:
  - `browser-sqlite` → `tests/build/index.js`, `browser-sqlite/testing` → `tests/build/testing.js` (Vite aliases; `tsconfig.json` `paths` to `./src/index.ts` and `./tests/testing.ts`).
  - Provided values `bsqTarget: TestTarget` and `bsqNeeds: OnUnmetNeed`, read with `inject('bsqTarget')` / `inject('bsqNeeds')`.
  - Project names `chrome · <vfs>/<build>`, `firefox · <vfs>/<build>`, `isolated chrome · <vfs>/<build>`, `isolated firefox · <vfs>/<build>`, `conformance chrome`, `conformance firefox` — the browser instance carries the same `name`, so `--project` globs match them.
  - `tests/build-setup.ts` default export `setup(project: TestProject)`.

- [ ] **Step 1: `rslib.test.config.ts` and `tests/testing.ts`**

Copy `rslib.test.config.ts` from the spike verbatim: `git show spike/vitest-webdriverio:rslib.test.config.ts > rslib.test.config.ts`. `tests/testing.ts`:

```ts
// Test-only entry, built by rslib.test.config.ts beside index.js in
// tests/build/. It re-exports the public surface AND the internals the
// white-box tests drive, so such a test takes everything from one bundle —
// two bundles are two copies of the code, and an `instanceof` or a module
// singleton does not cross between them. Never part of the published package.
export * from '../src/index';
export { encodeParams } from '../src/binary';
export { resolveRealmId } from '../src/inspect';
export { createLocks } from '../src/locks';
export { createLogger } from '../src/logger';
export { createPoolWorker, type PoolWorker } from '../src/pool';
```

Append to `.gitignore`:

```
# Built by rslib.test.config.ts for the Vitest browser projects: the published
# build plus the test-only entry tests/testing.ts.
tests/build/
```

Run `pnpm build && pnpm exec rslib build -c rslib.test.config.ts && for f in index.js worker/worker.js worker/wa-sqlite.wasm worker/wa-sqlite-async.wasm worker/wa-sqlite-jspi.wasm; do cmp dist/$f tests/build/$f && echo "same $f"; done; ls dist | grep -c testing`. Expected: five `same`, then `0`.

- [ ] **Step 2: `tests/build-setup.ts`**

```ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = ['exec', 'rslib', 'build', '-c', 'rslib.test.config.ts'];

/**
 * Every browser project declares this; the build runs once per Vitest run.
 * spawnSync blocks the event loop, so a second project's setup cannot start
 * before the flag is set. In watch mode a `--watch` build follows, so an edit
 * to src/ reaches tests/build/ and Vite's watcher reruns the tests.
 */
let watcher: ChildProcess | undefined;

export default function setup(project: TestProject) {
  if (process.env.BSQ_TEST_BUILT === '1') return;
  process.env.BSQ_TEST_BUILT = '1';
  const built = spawnSync('pnpm', BUILD, { cwd: ROOT, stdio: 'inherit' });
  if (built.status !== 0) {
    throw new Error(`rslib.test.config.ts: the build failed (exit ${built.status})`);
  }
  if (!project.vitest.config.watch) return;
  watcher = spawn('pnpm', [...BUILD, '--watch'], { cwd: ROOT, stdio: 'ignore', detached: true });
  return () => {
    if (watcher?.pid) process.kill(-watcher.pid, 'SIGTERM');
  };
}
```

- [ ] **Step 3: `tests/vitest.d.ts` and `tsconfig.json`**

```ts
import type { OnUnmetNeed, TestTarget } from './browser/target';

declare module 'vitest' {
  export interface ProvidedContext {
    bsqTarget: TestTarget;
    bsqNeeds: OnUnmetNeed;
  }
}
```

`tsconfig.json`: add to `compilerOptions`

```jsonc
    // The Vitest tests import the library by name; vitest.config.ts aliases
    // both to tests/build/, and the types come from the sources they build.
    "paths": {
      "browser-sqlite": ["./src/index.ts"],
      "browser-sqlite/testing": ["./tests/testing.ts"]
    }
```

and `"rslib.test.config.ts"` to `include`.

- [ ] **Step 4: The browser projects in `vitest.config.ts`**

Replace `vitest.config.ts` with:

```ts
import { fileURLToPath } from 'node:url';
import { webdriverio } from '@vitest/browser-webdriverio';
import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import { type BrowserName, browserCapabilities, WDIO_CACHE_DIR } from './scripts/browsers.ts';
import type { TestTarget } from './tests/browser/target.ts';
import { CHROMIUM_FEATURES, FIREFOX_FEATURES, onUnmetFromEnv, targetLabel, targetsFromEnv } from './tests/target-projects.ts';

const ENGINES: readonly BrowserName[] = ['chrome', 'firefox'];
const FEATURES = { chrome: CHROMIUM_FEATURES, firefox: FIREFOX_FEATURES };
/** The engine-only directory each project adds to the shared, non-recursive glob. */
const ENGINE_DIR = { chrome: 'chromium', firefox: 'firefox' };
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const onUnmet = onUnmetFromEnv(process.env.BSQ_TEST_NEEDS);
const built = (file: string) => fileURLToPath(new URL(`./tests/build/${file}`, import.meta.url));

/**
 * One browser project. Each builds its own `instances` array: Vitest renames
 * an instance in place, and two projects sharing one fail at startup.
 */
const browserProject = (
  name: string,
  browser: BrowserName,
  include: string[],
  options: { target?: TestTarget; isolated?: boolean; testTimeout: number },
): TestProjectInlineConfiguration => ({
  extends: true,
  ...(options.isolated ? { server: { headers: ISOLATION } } : {}),
  test: {
    name,
    include,
    globalSetup: ['tests/build-setup.ts'],
    testTimeout: options.testTimeout,
    // A teardown closes a client that may still be draining an abandoned
    // statement, and close() waits up to drainTimeout (60 s by default).
    hookTimeout: 60_000,
    ...(options.target ? { provide: { bsqTarget: options.target, bsqNeeds: onUnmet } } : {}),
    browser: {
      enabled: true,
      headless: true,
      provider: webdriverio({ cacheDir: WDIO_CACHE_DIR, capabilities: browserCapabilities(browser) }),
      instances: [{ browser, name }],
    },
  },
});

export default defineConfig({
  resolve: {
    alias: [
      { find: /^browser-sqlite$/, replacement: built('index.js') },
      { find: /^browser-sqlite\/testing$/, replacement: built('testing.js') },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, 'tests/browser/**', 'tests/conformance/**', 'tests/consumer*/**'],
          passWithNoTests: true,
          testTimeout: 10_000,
        },
      },
      ...ENGINES.flatMap((browser) =>
        targetsFromEnv(process.env.BSQ_TEST_TARGETS, FEATURES[browser]).flatMap((target) => [
          browserProject(`${browser} · ${targetLabel(target)}`, browser, ['tests/browser/*.test.ts', `tests/browser/${ENGINE_DIR[browser]}/**/*.test.ts`], { target, testTimeout: 30_000 }),
          browserProject(`isolated ${browser} · ${targetLabel(target)}`, browser, ['tests/browser/isolated/**/*.test.ts'], { target, isolated: true, testTimeout: 30_000 }),
        ]),
      ),
      ...ENGINES.map((browser) =>
        browserProject(`conformance ${browser}`, browser, ['tests/conformance/**/*.test.ts'], { testTimeout: 60_000 }),
      ),
    ],
  },
});
```

If Vitest refuses `instances: [{ browser, name }]` or a project-level `globalSetup`, report it before working around it: both are load-bearing (filters, one build).

- [ ] **Step 5: Check that each project receives its own target** (Review Focus). A throwaway probe, not committed:

```bash
cat > tests/browser/zz-target-probe.test.ts <<'EOF2'
import { inject, it } from 'vitest';
it('reports its target', () => {
  const t = inject('bsqTarget');
  console.log(`PROBE ${t.vfs}/${t.build}`);
});
EOF2
BSQ_TEST_TARGETS='OPFSWriteAheadVFS/sync,MemoryVFS/async' pnpm exec vitest run --project 'chrome ·*' --silent=false --reporter=verbose tests/browser/zz-target-probe.test.ts 2>&1 | grep -E "PROBE|✓"
rm tests/browser/zz-target-probe.test.ts
```

Expected: `✓ |chrome · OPFSWriteAheadVFS/sync| …` and `✓ |chrome · MemoryVFS/async| …`, each with the `PROBE` line naming **its own** pair. Identical PROBE lines mean `provide` leaks across projects — stop and report.

- [ ] **Step 6: Check the build is fresh** (Review Focus). Edit a string in `src/`, run any browser probe, check `tests/build/` has it, revert:

```bash
cp src/client.ts .scratchpad/vitest-migration/client.ts.bak
# Serena replace_content on src/client.ts: append " FRESHNESS" to the message
# of the INVALID_OPTION thrown for an unsupported vfs/build combination.
cat > tests/browser/zz-fresh-probe.test.ts <<'EOF2'
import { createSQLiteClient } from 'browser-sqlite';
import { expect, it } from 'vitest';
it('runs the edited source', () => {
  expect(() => createSQLiteClient({ name: 'x', vfs: 'MemoryVFS', build: 'jspi-nope' as never })).toThrow(/FRESHNESS/);
});
EOF2
pnpm exec vitest run --project 'chrome · OPFSWriteAheadVFS/sync' tests/browser/zz-fresh-probe.test.ts 2>&1 | grep -E "Tests "
cp .scratchpad/vitest-migration/client.ts.bak src/client.ts
rm tests/browser/zz-fresh-probe.test.ts
```

Read `createSQLiteClient`'s guard first and use an option combination that reaches that exact `INVALID_OPTION` (the probe above guesses one). Expected: `1 passed` — the edit reached `tests/build/` and the browser ran it. Then `pnpm exec rslib build -c rslib.test.config.ts` after the revert.

- [ ] **Step 7: Commit** (`tsc`, `biome check --write` on touched files, `biome ci .`, `pnpm test:unit`; `pnpm test` still runs rstest for the browser and stays green)

```bash
test "$(git branch --show-current)" = test/vitest-webdriverio && git add -A rslib.test.config.ts tests/testing.ts tests/build-setup.ts tests/vitest.d.ts vitest.config.ts tsconfig.json .gitignore && git commit -m "test(browser): Vitest browser projects against the rslib build

rslib.test.config.ts builds rslib.config.ts, untouched, into
tests/build/, plus tests/testing.ts for white-box tests. One project per
engine and target receives its pair through provide/inject. No test file
moves yet: rstest still runs them all.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Port every browser and conformance file

**Files:**
- Modify: every file under `tests/browser/` and `tests/conformance/` still importing `@rstest/core` or a runtime value of `src/`
- Throwaway: `.scratchpad/vitest-migration/codemod.ts`

**Interfaces:**
- Consumes: the aliases, `inject` helpers and projects of Task 3.
- Produces: no file under `tests/browser/` or `tests/conformance/` imports `@rstest/core`; runtime values of the public surface come from `browser-sqlite`, or from `browser-sqlite/testing` in a white-box file.

- [ ] **Step 1: `TEST_TARGET` and `ON_UNMET_NEED` from `inject`**

In `tests/browser/helpers.ts` (Serena `replace_content`), replace the two `declare const __BSQ_TEST_…__` lines and the two IIFEs:

```ts
/**
 * The target this project provides (vitest.config.ts, one project per target,
 * tests/target-projects.ts). A browser project without one is a configuration
 * error, not a default, so this throws rather than choose a VFS. It lives
 * here, not in `./target`, because the resolver there is imported by a Node
 * unit test, where no project provides anything.
 */
export const TEST_TARGET: TestTarget = (() => {
  const target = inject('bsqTarget');
  if (target === undefined) {
    throw new Error('TEST_TARGET: this project provides no bsqTarget — a browser project needs a target (tests/target-projects.ts)');
  }
  return target;
})();

/** `fallback` unless `BSQ_TEST_NEEDS` says `skip`, as `pnpm test:matrix` does (spec 2026-09-15, A7). */
const ON_UNMET_NEED: OnUnmetNeed = (() => {
  const needs = inject('bsqNeeds');
  if (needs === undefined) {
    throw new Error('ON_UNMET_NEED: this project provides no bsqNeeds (tests/target-projects.ts)');
  }
  return needs;
})();
```

and add `inject` to its `vitest` import (Task 4 rewrites `@rstest/core` → `vitest` in this file; do that line now for this file).

- [ ] **Step 1b: Write the codemod** — `.scratchpad/vitest-migration/codemod.ts`:

```ts
// Rewrites the imports of tests/browser/** and tests/conformance/** (spec 2026-10-10 § 3).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Public runtime values, by src module. */
const PUBLIC: Record<string, string[]> = {
  client: ['createSQLiteClient'],
  delete: ['deleteDatabase'],
  inspect: ['inspectDatabase'],
  'types/errors': ['SQLiteError'],
  index: ['sql', 'createSQLiteClient', 'deleteDatabase', 'inspectDatabase', 'SQLiteError', 'detectFeatures', 'missingFeature', 'SQLITE_CODES', 'SQLITE_EXTENDED_CODES'],
  sql: ['sql'],
  capabilities: ['detectFeatures', 'missingFeature'],
  'const/sqlite': ['SQLITE_CODES', 'SQLITE_EXTENDED_CODES'],
};
/** Internal runtime values a white-box test drives — exported by tests/testing.ts. */
const INTERNAL: Record<string, string[]> = {
  pool: ['createPoolWorker'],
  locks: ['createLocks'],
  logger: ['createLogger'],
  binary: ['encodeParams'],
  inspect: ['resolveRealmId'],
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'((?:\.\.\/)+src\/([^']+))';\n/g;

for (const file of [...files('tests/browser'), ...files('tests/conformance')]) {
  let text = readFileSync(file, 'utf8');
  const before = text;
  text = text.replace("from '@rstest/core'", "from 'vitest'");
  text = text.replace(/\brstest\.(spyOn|fn|useFakeTimers|useRealTimers|advanceTimersByTimeAsync)\b/g, 'vi.$1');
  text = text.replace(/(import \{[^}]*)\brstest\b([^}]*\} from 'vitest')/, '$1vi$2');

  const whiteBox = [...text.matchAll(IMPORT)].some(([, typeOnly, names, , mod]) =>
    !typeOnly && names.split(',').some((n) => INTERNAL[mod]?.includes(n.trim().replace(/^type\s+/, '').split(' as ')[0])),
  );
  const target = whiteBox ? 'browser-sqlite/testing' : 'browser-sqlite';
  const moved: string[] = [];
  text = text.replace(IMPORT, (whole, typeOnly, names: string, path: string, mod: string) => {
    if (typeOnly) return whole;
    const keep: string[] = [];
    for (const raw of names.split(',').map((n) => n.trim()).filter(Boolean)) {
      const bare = raw.replace(/^type\s+/, '').split(' as ')[0];
      const isValue = !raw.startsWith('type ');
      if (isValue && (PUBLIC[mod]?.includes(bare) || (whiteBox && INTERNAL[mod]?.includes(bare)))) moved.push(raw);
      else keep.push(raw);
    }
    return keep.length ? `import { ${keep.join(', ')} } from '${path}';\n` : '';
  });
  if (moved.length) {
    const firstImport = text.indexOf('import ');
    text = `${text.slice(0, firstImport)}import { ${[...new Set(moved)].join(', ')} } from '${target}';\n${text.slice(firstImport)}`;
  }
  if (text !== before) {
    writeFileSync(file, text);
    console.log(`${whiteBox ? 'WHITE-BOX ' : ''}${file}`);
  }
}
```

- [ ] **Step 2: Run it, format, list what it did**

```bash
node .scratchpad/vitest-migration/codemod.ts | tee .scratchpad/vitest-migration/codemod.log
pnpm exec biome check --write tests/browser tests/conformance
grep -c WHITE-BOX .scratchpad/vitest-migration/codemod.log
grep -rln "@rstest/core\|\brstest\." tests/browser tests/conformance   # comments only may remain
grep -rnE "from '(\.\./)+src/(client|delete|types/errors|sql|index)'" tests/browser tests/conformance | grep -v "import type"
```

Expected: the white-box list is the files the spec names (`abandon`, `params`, `pool-savepoint`, `pool-death`, `inspect-realm`, `inspect-marker`, `write-lock-reclaim`, possibly others found by the codemod — list them in the commit body); the last grep prints nothing. Multi-line imports the regex missed are fixed by hand: `grep -rn "createSQLiteClient\|deleteDatabase\|SQLiteError" tests/browser tests/conformance | grep "src/"`.

- [ ] **Step 3: Read every white-box file for mixed bundles.** For each, check whether it also uses `createTestClient` or another helper whose client comes from `browser-sqlite`, and whether it tests `instanceof SQLiteError` (or `toBeInstanceOf(SQLiteError)`) on an error thrown by that client. Where it does, do not import the index's class beside the testing bundle's (that breaks the one-bundle rule): assert on `error.code` / `error.name` for errors thrown by the helper's client, and keep `instanceof` for errors thrown by the testing bundle's code. Record each such change in the commit body.

- [ ] **Step 4: Remove the rstest browser and conformance configs, switch the scripts**

Delete `rstest.firefox.config.ts`, `rstest.isolated.config.ts`, `rstest.conformance.config.ts`, `rstest.conformance.firefox.config.ts`; in `rstest.config.ts` delete the target projects and `pluginSilenceWorkerHmrLogs` (the file then has no project left: delete it too, and `@rstest/*` stays in `package.json` until Task 9 only if something still imports it — `grep -rn "@rstest" --include=*.ts . | grep -v node_modules`). `package.json` scripts:

```json
"test": "node scripts/bounded.ts 2400 vitest run --project unit --project 'chrome ·*' --project 'firefox ·*' --project 'isolated *'",
"test:watch": "vitest --project unit --project 'chrome ·*'",
"test:unit": "vitest run --project unit",
"test:browser": "node scripts/bounded.ts 1800 vitest run --project 'chrome ·*' --project 'firefox ·*'",
"test:chrome": "node scripts/bounded.ts 900 vitest run --project 'chrome ·*'",
"test:firefox": "node scripts/bounded.ts 900 vitest run --project 'firefox ·*'",
"test:isolated": "node scripts/bounded.ts 600 vitest run --project 'isolated *'",
"test:conformance": "node scripts/bounded.ts 1800 vitest run --project 'conformance *'",
"test:conformance:chrome": "node scripts/bounded.ts 900 vitest run --project 'conformance chrome'",
"test:conformance:firefox": "node scripts/bounded.ts 900 vitest run --project 'conformance firefox'",
```

(`test:chromium`, `test:conformance:chromium` are removed.) Check the globs select what they claim: `pnpm exec vitest list --project 'chrome ·*' --filesOnly | head` must list only `tests/browser/` files of chrome projects.

- [ ] **Step 5: Run each leg once, read every report** — progress lines every 2 min.

```bash
pnpm test:chrome > .scratchpad/vitest-migration/run-chrome.log 2>&1; echo chrome=$?
pnpm test:firefox > .scratchpad/vitest-migration/run-firefox.log 2>&1; echo firefox=$?
pnpm test:isolated > .scratchpad/vitest-migration/run-isolated.log 2>&1; echo isolated=$?
pnpm test:conformance > .scratchpad/vitest-migration/run-conformance.log 2>&1; echo conformance=$?
grep -hE "Test Files|Tests |Duration" .scratchpad/vitest-migration/run-*.log
```

Each failure is diagnosed (`superpowers:systematic-debugging`) before anything changes: run its file alone first (storage shared across files, spec § 7); a timing bound is re-measured, not loosened blind; the cause goes in the commit body. `realm.test.ts` and `cross-tab.test.ts` (iframe inside Vitest's iframe) are read first if they fail.

- [ ] **Step 6: Commit**

```bash
test "$(git branch --show-current)" = test/vitest-webdriverio && git add -A tests package.json pnpm-lock.yaml rstest*.config.ts && git commit -m "test: every browser and conformance file on Vitest

…list the white-box files, the mixed-bundle fixes and every failure's cause…

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Parity with the baseline, duration, `abandon-gc`

**Files:**
- Modify: `package.json` (bounds from the measurement), `tests/browser/abandon-gc.test.ts` (header comment)
- Throwaway: `.scratchpad/vitest-migration/parity.ts`

**Interfaces:** Consumes the Task 0 baseline and Vitest's JSON reporter (`testResults[].name` = absolute file path, `testResults[].assertionResults[]` with `ancestorTitles`, `title`, `status` ∈ `passed|failed|skipped|pending|todo`).

- [ ] **Step 1: Write the parity script** — `.scratchpad/vitest-migration/parity.ts`:

```ts
// node parity.ts <rstest-md> <vitest-json> → names in one and not the other, per status.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [md, json] = process.argv.slice(2);
const section = (text: string, title: string) => {
  const start = text.indexOf(`### ${title}`);
  if (start === -1) return [];
  const end = text.indexOf('\n### ', start + 4);
  return text.slice(start, end === -1 ? undefined : end).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
};
const r = readFileSync(md, 'utf8');
const rstest = { passed: new Set(section(r, 'Passed')), skipped: new Set(section(r, 'Skipped')) };
const v = JSON.parse(readFileSync(json, 'utf8'));
const vitest = { passed: new Set<string>(), skipped: new Set<string>() };
for (const file of v.testResults) {
  for (const a of file.assertionResults) {
    const name = `${relative(process.cwd(), file.name)} :: ${[...a.ancestorTitles, a.title].join(' > ')}`;
    if (a.status === 'passed') vitest.passed.add(name);
    else if (a.status === 'skipped' || a.status === 'pending') vitest.skipped.add(name);
  }
}
for (const status of ['passed', 'skipped'] as const) {
  const onlyR = [...rstest[status]].filter((n) => !vitest[status].has(n));
  const onlyV = [...vitest[status]].filter((n) => !rstest[status].has(n));
  console.log(`${status}: rstest ${rstest[status].size}, vitest ${vitest[status].size}`);
  for (const n of onlyR) console.log(`  only rstest: ${n}`);
  for (const n of onlyV) console.log(`  only vitest: ${n}`);
}
```

- [ ] **Step 2: Compare `pnpm test`'s cells.** Run the chrome, firefox and isolated legs with `--reporter=json --outputFile=.scratchpad/vitest-migration/<leg>.json` (one invocation per leg, as Task 4 Step 5), then:

```bash
for leg in chrome:test-chromium firefox:test-firefox isolated:test-isolated; do
  node .scratchpad/vitest-migration/parity.ts .scratchpad/vitest-migration/baseline/${leg#*:}.md .scratchpad/vitest-migration/${leg%%:*}.json
done
```

rstest's names differ in their project prefix only if its md report carries one — strip it in `section()` if so. Expected: no `only` lines for chrome and firefox; for `isolated`, the Firefox projects' names appear as `only vitest` (the new column) and nothing else. Every other difference is explained in the commit body or fixed.

- [ ] **Step 3: Measure `pnpm test`** and set the bounds

```bash
/usr/bin/time -v pnpm test > .scratchpad/vitest-migration/pnpm-test.log 2>&1; echo exit=$?
grep -E "Elapsed|Test Files|Tests " .scratchpad/vitest-migration/pnpm-test.log
```

Set `test`'s bound to twice the measured wall clock, rounded up to the next 300 s (keep 2400 if that is larger); the legs likewise. Report the measurement to the user (it decides the parallelism question, spec D11).

- [ ] **Step 4: `abandon-gc` with and without `BSQ_EXPOSE_GC`**

```bash
pnpm exec vitest run --project 'chrome · OPFSWriteAheadVFS/sync' tests/browser/abandon-gc.test.ts 2>&1 | grep -E "Tests |skipped"
BSQ_EXPOSE_GC=1 pnpm exec vitest run --project 'chrome · OPFSWriteAheadVFS/sync' tests/browser/abandon-gc.test.ts 2>&1 | grep -E "Tests "
```

Expected: skipped without, passing with. Replace the file's header comment (lines 1-20: the rstest command line and why) with: run it with `BSQ_EXPOSE_GC=1 pnpm exec vitest run --project 'chrome ·*' tests/browser/abandon-gc.test.ts`; without that variable `globalThis.gc` is undefined and the test skips itself.

- [ ] **Step 5: Falsifier — one bundle per file.** `throw` at the TOP of each bundle (at the end it lands in the `//# sourceMappingURL` comment and does nothing):

```bash
pnpm exec rslib build -c rslib.test.config.ts >/dev/null
sed -i "1i throw new Error('FALSIFIER index.js');" tests/build/index.js
sed -i "1i throw new Error('FALSIFIER testing.js');" tests/build/testing.js
BSQ_TEST_BUILT=1 pnpm exec vitest run --project 'chrome · OPFSWriteAheadVFS/sync' tests/browser/queries.test.ts tests/browser/pool-death.test.ts 2>&1 | grep -oE "FALSIFIER [a-z.]+" | sort | uniq -c
pnpm exec rslib build -c rslib.test.config.ts >/dev/null && cmp dist/index.js tests/build/index.js && echo restored
```

(`BSQ_TEST_BUILT=1` stops `build-setup.ts` from rebuilding over the falsified files.) Expected: `FALSIFIER index.js` and `FALSIFIER testing.js` each once, then `restored`.

- [ ] **Step 6: Commit** the bounds and the comment.

---

### Task 6: The matrix on Vitest

**Files:**
- Modify: `scripts/test-matrix.ts`, `scripts/matrix-triage.ts`, `tests/unit/test-matrix.test.ts`

**Interfaces:**
- Consumes: project names of Task 3.
- Produces: `ENGINES` (exported as `COLUMNS`) = `chrome` (`--project 'chrome ·*'`), `firefox` (`--project 'firefox ·*'`), `isolated-chrome` (`--project 'isolated chrome ·*'`), `isolated-firefox` (`--project 'isolated firefox ·*'`); `parseMatrixReport(json: string): MatrixResult` reading Vitest's JSON report; cell files `.matrix/<run>/<column>__<vfs>__<build>.json` (report) and `.log` (console); `MatrixResult` unchanged.

- [ ] **Step 1: Write the failing tests.** In `tests/unit/test-matrix.test.ts`, replace the rstest markdown fixtures with Vitest JSON reports and keep the four cases. Minimal fixtures (fields `parseMatrixReport` reads only):

```ts
const report = (files: object[], success: boolean) =>
  JSON.stringify({ success, startTime: 1_000, numTotalTests: 0, testResults: files });
const file = (name: string, tests: { title: string; status: string; failureMessages?: string[] }[], extra: object = {}) => ({
  name: `/workspaces/wsqlite/${name}`,
  startTime: 1_000,
  endTime: 53_000,
  status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
  message: '',
  assertionResults: tests.map((t) => ({ ancestorTitles: ['d'], title: t.title, status: t.status, failureMessages: t.failureMessages ?? [] })),
  ...extra,
});

const PASSING = report([file('tests/browser/a.test.ts', [{ title: 'x', status: 'passed' }, { title: 'y', status: 'skipped' }])], true);
const FAILING = report([file('tests/browser/a.test.ts', [{ title: 'x', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'] }])], false);
const NOT_RUNNABLE = report([file('tests/browser/a.test.ts', [{ title: 'x', status: 'failed', failureMessages: ['TARGET_NOT_RUNNABLE: needs opfs'] }])], false);
// A page crash: the file failed with no failed test, the reason in `message`.
const CRASHED = report([file('tests/browser/a.test.ts', [{ title: 'x', status: 'passed' }], { status: 'failed', message: 'Browser connection was closed while running tests' })], false);
```

Assertions: `PASSING` → `{ status: 'passed', tests: 2, passed: 1, failed: 0, skipped: 1, files: 1, seconds: 52 }`; `FAILING` → `status: 'failed', failed: 1`; `NOT_RUNNABLE` → `{ status: 'not-runnable', seconds: 52 }`; a mix of `TARGET_NOT_RUNNABLE` and another failure → `failed`; `CRASHED` → `status: 'failed', failed: 0, unhandled: ['tests/browser/a.test.ts: Browser connection was closed while running tests']`, and `formatCell` of it contains `FAIL: tests/browser/a.test.ts: Browser connection`; `parseMatrixReport('')` and `parseMatrixReport('{')` → `{ status: 'timed-out' }`. The `runBounded` and `formatCell` tests stay as they are.

- [ ] **Step 2: Run — expected FAIL** (`pnpm test:unit -- tests/unit/test-matrix.test.ts`).

- [ ] **Step 3: Implement.** `parseMatrixReport`:

```ts
/**
 * Reads one Vitest JSON report (`--reporter=json --outputFile`) into a matrix
 * cell. No report, or one that does not parse: the run never finished —
 * killed by this script's timer or crashed first — so `timed-out`. Failures
 * that are ALL `TARGET_NOT_RUNNABLE`: `not-runnable`, never hiding a real one.
 * A file that failed with no failed test (a page crash) carries its reason in
 * `message`: reported in `unhandled`, so the cell reads FAIL with that reason.
 */
export function parseMatrixReport(json: string): MatrixResult {
  let report: VitestReport;
  try {
    report = JSON.parse(json);
  } catch {
    return { status: 'timed-out' };
  }
  const tests = report.testResults.flatMap((f) => f.assertionResults);
  const failures = tests.filter((t) => t.status === 'failed');
  const end = Math.max(report.startTime, ...report.testResults.map((f) => f.endTime));
  const seconds = Math.round((end - report.startTime) / 1000);
  const messages = failures.flatMap((t) => t.failureMessages);
  if (messages.length > 0 && messages.every((m) => m.startsWith('TARGET_NOT_RUNNABLE'))) {
    return { status: 'not-runnable', seconds };
  }
  const unhandled = report.testResults
    .filter((f) => f.status === 'failed' && f.message)
    .map((f) => `${relative(ROOT, f.name)}: ${f.message}`);
  return {
    status: report.success ? 'passed' : 'failed',
    tests: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: failures.length,
    skipped: tests.filter((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo').length,
    files: report.testResults.length,
    seconds,
    ...(unhandled.length > 0 ? { unhandled } : {}),
  };
}

type VitestReport = {
  success: boolean;
  startTime: number;
  testResults: {
    name: string;
    status: string;
    message: string;
    endTime: number;
    assertionResults: { status: string; failureMessages: string[] }[];
  }[];
};
```

`ROOT` must end without a slash for `relative` (it is `fileURLToPath(new URL('..', import.meta.url))`, which ends with one — `relative` handles it). `runOne` runs `pnpm exec vitest run <column args> --reporter=default --reporter=json --outputFile=<cell>.json`, writes the console to `<cell>.log`, and parses the JSON file (`existsSync` false → `''` → `timed-out`); the 600 s bound and `BSQ_TEST_TARGETS` / `BSQ_TEST_NEEDS=skip` stay. Cell base name `${column}__${vfs}__${build}`. The tail printed on a red cell comes from the `.log`. The header comment and the `runBounded` comment's mention of rstest are updated (the process group it kills is Vitest's and its browsers').

`scripts/matrix-triage.ts`: read `*.json` cell files; `cellOf` splits the base name on `__`; failures come from `assertionResults` with `status === 'failed'`: `file` = `relative` path, `name` = `[...ancestorTitles, title].join(' > ')`, `type` = the text before the first `:` of `failureMessages[0]`, `message` = the rest; a cell file that does not parse is `NO REPORT (killed or never started)`. Its table and groups stay as they are.

- [ ] **Step 4: Run the unit tests — PASS — then one real cell per column**

```bash
pnpm test:unit
node scripts/test-matrix.ts --pair OPFSWriteAheadVFS/sync 2>&1 | tail -8
node scripts/matrix-triage.ts "$(ls -d .matrix/*/ | tail -1)" | head -12
```

Expected: four green cells; the triage lists them.

- [ ] **Step 5: Commit.**

---

### Task 7: `consumer-smoke` and `bench/check` on WebdriverIO; Playwright out

**Files:**
- Modify: `scripts/consumer-smoke.ts` (`driveBrowser`, header comment), `scripts/bench/check.ts`, `package.json` (remove `playwright`), `README.md` (line 146: `bench/check.ts [chrome|firefox]`, "under WebdriverIO")

**Interfaces:** Consumes `browserCapabilities`, `WDIO_CACHE_DIR` (Task 2).

- [ ] **Step 1: `driveBrowser` on WebdriverIO**

```ts
/** Loads the fixture and returns what `window.__SMOKE__` ended up holding. */
async function driveBrowser(url: string) {
  const browser = await remote({
    logLevel: 'warn',
    cacheDir: WDIO_CACHE_DIR,
    capabilities: {
      ...browserCapabilities('chrome'),
      'goog:chromeOptions': { args: ['--headless=new'] },
    },
  });
  const noise: string[] = [];
  try {
    // WebDriver BiDi, on by default in WebdriverIO 10: what Playwright's
    // console / pageerror / requestfailed / response listeners caught.
    await browser.sessionSubscribe({
      events: ['log.entryAdded', 'network.fetchError', 'network.responseCompleted'],
    });
    browser.on('log.entryAdded', (entry) => {
      if (entry.type === 'javascript') noise.push(`pageerror: ${entry.text}`);
      else if (entry.level === 'error') noise.push(`console.error: ${entry.text}`);
    });
    browser.on('network.fetchError', (event) =>
      noise.push(`requestfailed: ${event.request.url} (${event.errorText})`),
    );
    browser.on('network.responseCompleted', (event) => {
      if (event.response.status >= 400) noise.push(`http ${event.response.status}: ${event.response.url}`);
    });

    await browser.url(url);
    await browser.waitUntil(
      () => browser.execute(() => (window as SmokeWindow).__SMOKE__ !== undefined),
      { timeout: 45_000, interval: 100 },
    );
    const smoke = await browser.execute(() => (window as SmokeWindow).__SMOKE__);
    return { smoke, noise };
  } catch (error) {
    return { smoke: undefined, noise: [...noise, `driver: ${(error as Error).message}`] };
  } finally {
    await browser.deleteSession();
  }
}
```

Imports: `import { remote } from 'webdriverio';` and `import { browserCapabilities, WDIO_CACHE_DIR } from './browsers.ts';` replace `import { chromium } from 'playwright';`. If the BiDi event payload types differ (`entry.type`, `entry.level`, `event.errorText`), read them off `node_modules/webdriver-bidi-protocol` / WebdriverIO's `local` types and adapt the field names — not the events.

- [ ] **Step 2: Run the smoke** — `pnpm build && pnpm test:consumer 2>&1 | tail -30`. Expected: the same stages as before (24), all PASS.

- [ ] **Step 3: `bench/check.ts`** — engine argument `chrome|firefox` (default `chrome`); `remote()` with `browserCapabilities(engine)` plus headless args and a download directory (`mkdtempSync(join(tmpdir(), 'bench-dl-'))`): Chrome `'goog:chromeOptions': { args: ['--headless=new'], prefs: { 'download.default_directory': dir, 'download.prompt_for_download': false } }`; Firefox `'moz:firefoxOptions': { args: ['-headless'], prefs: { 'browser.download.folderList': 2, 'browser.download.dir': dir, 'browser.download.useDownloadDir': true, 'browser.helperApps.neverAsk.saveToDisk': 'application/json' } }`. Translate: `page.goto` → `browser.url`; `waitForFunction` → `waitUntil(() => browser.execute(…))`; `page.evaluate` → `browser.execute`; `$$eval` / `$eval` → `browser.execute(() => …document.querySelectorAll…)`; `page.click(sel)` → `$(sel).click()`; `page.check(sel)` → `$(sel).click()` when not selected; `textContent` → `$(sel).getText()`; the download: click `#download`, then `waitUntil` a `.json` file appears in `dir` (and no `.crdownload` / `.part` remains), read it, remove `dir`. The filename regex and payload checks stay.

Run: `node scripts/bench/check.ts chrome && node scripts/bench/check.ts firefox` (it serves the page itself — read its header for the port). Expected: both end with their success line.

- [ ] **Step 4: Falsifier — a broken consumer still fails, and says why** (Review Focus):

```bash
pnpm build
cp dist/worker/worker.js .scratchpad/vitest-migration/worker.js.bak
sed -i '1i throw new Error("FALSIFIER worker");' dist/worker/worker.js
pnpm test:consumer 2>&1 | grep -E "FAIL|FALSIFIER|pageerror|console.error|requestfailed" | head
cp .scratchpad/vitest-migration/worker.js.bak dist/worker/worker.js
```

Expected: stages FAIL, and their detail carries a line from the browser (`console.error:` or `pageerror:` naming the worker error). A FAIL with only `the page never set window.__SMOKE__` and no browser line means the BiDi listeners see nothing — fix before going on. (`test:consumer` packs `dist/` itself; read `scripts/consumer-smoke.ts`'s pack stage — if it rebuilds `dist/`, falsify after its build step instead, e.g. by an env-gated hook, and say so.)

- [ ] **Step 5: Playwright out**

```bash
pnpm remove playwright
grep -rn "playwright" --include=*.ts --include=*.json --include=*.yaml --include=*.sh . | grep -v node_modules | grep -v "docs/superpowers\|docs/upstream\|\.serena"
```

Expected: only `.github/workflows/*` and `.devcontainer/post-create.sh` (Task 8). Update `README.md` lines 123 and 146.

- [ ] **Step 6: Commit.**

---

### Task 8: Devcontainer and CI

**Files:**
- Modify: `.devcontainer/post-create.sh`, `.github/workflows/ci.yaml`, `.github/workflows/release-and-publish.yaml`, `.github/workflows/pages.yaml`, `src/worker/worker.ts:1013`, `tests/browser/tx-write.test.ts:139`, `tests/unit/scheduler.test.ts:418`, `tests/browser/concurrency.test.ts:191`, `tests/unit/utils.test.ts:194`

- [ ] **Step 1: `post-create.sh`** — replace the Playwright block (its comment included) with:

```bash
# Stock Chrome and Firefox at the versions scripts/browsers.ts pins, driven by
# WebdriverIO. Their system libraries first — Chrome for Testing lists its
# Debian ones in deb.deps, Firefox's are Debian's firefox-esr's — then one
# session in each, which downloads browsers and drivers into
# node_modules/.cache/wdio.
# shellcheck disable=SC2046
sudo apt-get update && sudo apt-get install -y --no-install-recommends $(node scripts/browsers.ts deps)
node scripts/browsers.ts install
```

Run the two commands here (sudo may need the user's approval — ask): the install of already-present packages is a no-op, and `install` prints two `ok`. The fresh-container check happens after delivery, on the user's rebuild (decided 2026-10-10).

- [ ] **Step 2: Read the release notes of each action major** — `gh release view v6.1.0 -R actions/cache`, `v6.1.0 -R pnpm/action-setup`, `v7.0.2 -R actions/upload-artifact`, `v5.0.1 -R actions/deploy-pages`, `v5.0.0 -R actions/upload-pages-artifact`, plus every major between ours and those. Note every breaking change that touches an input this repository passes (`include-hidden-files`, `if-no-files-found`, `retention-days`, the pnpm version source — `packageManager` in `package.json`).

- [ ] **Step 3: Edit the workflows.** In `ci.yaml` (`verify`, `consumer-smoke`) and `release-and-publish.yaml` (`cells`), replace "Cache Playwright browsers" + "Install browsers" (and the long comment above them in `verify`) with:

```yaml
      # Stock Chrome and Firefox at the versions scripts/browsers.ts pins, and
      # their drivers, downloaded by WebdriverIO on first use. The key is that
      # file: a new pin is a new cache. GitHub's Ubuntu images carry both
      # browsers' system libraries.
      - name: Cache WebdriverIO browsers
        uses: actions/cache@v6
        with:
          path: node_modules/.cache/wdio
          key: wdio-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/browsers.ts') }}
```

`ci.yaml`'s "Conformance (both engines)" step keeps `pnpm test:conformance`. Bump every `actions/cache@v4` → `@v6`, `pnpm/action-setup@v4` → `@v6`, `actions/upload-artifact@v4` → `@v7`, `actions/deploy-pages@v4` → `@v5`, `actions/upload-pages-artifact@v3` → `@v5`, applying Step 2's breaking changes. Raise `cells`' `timeout-minutes` if Task 6's four-column cell measured past 15 min.

Validate the YAML locally: `node -e "for (const f of ['ci','release-and-publish','pages']) require('yaml').parse(require('fs').readFileSync('.github/workflows/'+f+'.yaml','utf8'))"` (`yaml` is in `node_modules` through biome/lint-staged — if not, `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yaml`).

- [ ] **Step 4: biome warnings.** `src/worker/worker.ts:1013` — `await openedDB!` inside the close path:

```ts
// close() runs only after the open completed or failed; no open, nothing to close.
if (!openedDB) return;
const { sqlite, db } = await openedDB;
```

Read the surrounding function first (Serena `find_symbol` with `include_body`) and put the guard where `openedDB` is known — if `undefined` is impossible there by construction, say so in the comment instead and narrow with an explicit check that throws. Then `tests/browser/tx-write.test.ts:139`, `tests/unit/scheduler.test.ts:418` (replace `x!` by `expect(x).toBeDefined()` followed by a narrowing `if (!x) throw …` or `as`), `tests/browser/concurrency.test.ts:191` (drop the unused `receiver` parameter: `get(target, prop) {` and `Reflect.get(target, prop)` if it was passed on), `tests/unit/utils.test.ts:194` (template literal). Then `pnpm exec biome ci . 2>&1 | grep -cE "warning|notice"` → `0`.

- [ ] **Step 5: Run** `pnpm exec tsc --noEmit && pnpm exec biome ci . && pnpm test` (progress lines) — green — and commit.

---

### Task 9: rstest out; docs, comments, memories; the full matrix

**Files:**
- Modify: `package.json` (remove `@rstest/core`, `@rstest/browser`, `@rstest/adapter-rslib`), `tsconfig.json` (`include`: drop `rstest.config.ts`), `tests/target-projects.ts` (comments), `scripts/bounded.ts` (comments), every comment naming rstest or Playwright (`grep -rn "rstest\|Playwright\|playwright" src tests scripts .github .devcontainer --include=*.ts --include=*.yaml --include=*.sh | grep -v node_modules`), `.claude/skills/review-codebase/SKILL.md` if it names rstest as the runner
- Memories (Serena `edit_memory` / `write_memory`): `stack-and-build` (§ Versions' test line, § Test suites rewritten for Vitest, the browsers and `tests/build/`), `conventions` (§ When to run the full matrix: 88 cells; § Testing in browsers: the framework line), `measurements/suite-and-matrix` (a new entry: the parity, `pnpm test`'s duration, the first Vitest matrix), `state` (baseline table re-measured whole — `pnpm test`, unit, conformance, `tsc`, `biome ci`, `pnpm docs:vfs` + `git diff --exit-code`, the matrix; the "In progress" entry), `follow-ups` (the stock-browsers entry shrinks to a pointer to the spec and what stays open: CI on Windows/macOS/Safari, parallelism, the post-delivery rebuild check), `history/2026-10` (one line)

- [ ] **Step 1: Remove rstest** — `pnpm remove @rstest/core @rstest/browser @rstest/adapter-rslib`; `grep -rn "@rstest" --include=*.ts --include=*.json . | grep -v node_modules` → nothing.

- [ ] **Step 2: Comments and docs** per the grep above. A comment the work made false is corrected (`mem:conventions`); old specs, plans and `docs/upstream/` are history and stay.

- [ ] **Step 3: The full matrix** — 88 cells, ~1 h or more, progress lines every 2 min:

```bash
pnpm test:matrix > .scratchpad/vitest-migration/matrix-vitest.log 2>&1; echo matrix=$?
```

Compare cell by cell with the baseline run (`MATRIX_RUN`): run `parity.ts` per cell (rstest `.txt` md report vs Vitest `.json`), in a loop over the cell names (`chromium-<vfs>-<build>.txt` ↔ `chrome__<vfs>__<build>.json`, `firefox-…` ↔ `firefox__…`, `isolated-…` ↔ `isolated-chrome__…`). Expected: no difference but the new `isolated-firefox` column. Red cells are diagnosed (`mem:conventions`: re-run the cell alone first, a timing failure may be load).

- [ ] **Step 4: Final verification** — `pnpm test`, `pnpm test:conformance`, `pnpm test:consumer`, `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, `pnpm docs:vfs && git diff --exit-code VFS.md README.md`; every report read.

- [ ] **Step 5: Memories**, then commit (memories in their own commit, `docs(memory): …`).

- [ ] **Step 6: Report to the user** — the parity, the durations, the matrix, what the rebuild after delivery must check (`post-create.sh` on a fresh container: `node scripts/browsers.ts install` prints two `ok`, `pnpm test` green), and that CI is verified only when the user pushes the branch.
