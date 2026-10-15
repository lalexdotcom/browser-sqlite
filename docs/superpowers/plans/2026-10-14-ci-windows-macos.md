# The library's tests on Windows and macOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `pnpm build`, `pnpm test` and `pnpm test:conformance` on GitHub's Windows and macOS runners, dispatched by hand, with one shared setup procedure for every workflow.

**Architecture:** A composite action (`.github/actions/setup`) installs Node, pnpm, the dependencies and the browsers a job names; every browser job uses it, with the Linux-only AppArmor step behind `runner.os`. A reusable workflow (`tests.yaml`) runs the suites on a runner given as input; `tests-windows.yaml` and `tests-macos.yaml` call it and carry only their triggers. The Node scripts become portable: Vitest and rslib start through Node on their package's bin (no `.cmd`, no shell), and a `killTree` kills a process tree with `taskkill /T` on Windows and a process-group signal elsewhere.

**Tech Stack:** GitHub Actions (composite actions, reusable workflows), Node 24 (type stripping), Vitest 5, WebdriverIO, `@puppeteer/browsers`, actionlint 1.7.12.

**Spec:** `docs/superpowers/specs/2026-10-14-ci-windows-macos-design.md`

## Global Constraints

- Node 24 everywhere (`actions/setup-node` with `node-version: 24`); scripts are `.ts` run directly by Node (type stripping, no build step).
- Browser pins unchanged: Chrome `153.0.8010.52`, Firefox `stable_155.0.1`, geckodriver `0.37.1` (`scripts/browsers.ts`).
- Lists are comma-separated: the action's `browsers` input, `browsers.ts install`'s argument and the cache key (`chrome,firefox`).
- Runners: `ubuntu-latest` for every existing job, `windows-latest` and `macos-latest` for the new ones.
- The new workflows are `workflow_dispatch` only once merged; a temporary `push` trigger on `ci/windows-macos` exists only on the branch (spec § 3.5) and is removed before the merge.
- Every `run:` step of the composite action declares `shell: bash`.
- Workflow comments state the fact and never cite a memory (`mem:conventions`).
- Code files are read and edited through Serena's symbolic tools (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`); built-in Read/Edit only for YAML, Markdown and JSON, or when Serena fails. Every subagent prompt carries this rule.
- After every modification: `pnpm exec biome check --write <files>`; workflows and the action: `node scripts/actionlint.ts`.
- Commits: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; check the branch in the same command: `test "$(git branch --show-current)" = ci/windows-macos && git commit …`.
- Never push without the user's explicit go.

## Review Focus

1. **A job killed at its deadline on Windows leaves its browser and driver running** — `taskkill` without `/T` kills only `node`; geckodriver and Firefox then hold the profile and the port for the next job. Pinned in Task 1: `killTree` on `win32` runs exactly `taskkill /T /F /PID <pid>`.
2. **An argument with spaces and `·` reaches Vitest split in two** — a project name like `chrome · OPFSAdaptiveVFS/jspi`. Pinned in Task 1: a child started through `packageBin`-style `[process.execPath, script]` receives such an argument intact.
3. **A cache saved by a Chrome-only job is restored for a job that needs Firefox** — Firefox is then downloaded on every run and never saved. Pinned in Task 4 by construction (the list is in the key) and checked by actionlint plus a reading of the key in the step's review.
4. **`browsers.ts install` given a misspelled name silently installs nothing for it** — Pinned in Task 3: an unknown name throws naming the valid ones.
5. **`hook-gate` on Windows splits an argv entry through `shell: true`** — Pinned in Task 2: no `COMMANDS` argv entry contains whitespace or a quote.

---

### Task 1: `scripts/processes.ts` — start a package's CLI and kill a process tree, on every OS

**Files:**
- Create: `scripts/processes.ts`
- Test: `tests/unit/tooling/processes.test.ts`

**Interfaces:**
- Produces:
  - `export const DETACHED: boolean` — `true` except on `win32`.
  - `export function packageBin(pkg: string, bin: string, root?: string): [node: string, script: string]`
  - `export function killTree(pid: number, signal?: NodeJS.Signals, deps?: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => void }): void`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/tooling/processes.test.ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { killTree, packageBin } from '../../../scripts/processes.ts';

describe('packageBin', () => {
  it('starts a package CLI with this Node, on the file its manifest names', () => {
    const [node, script] = packageBin('vitest', 'vitest');
    expect(node).toBe(process.execPath);
    expect(script).toMatch(/[\\/]vitest[\\/]vitest\.mjs$/);
    expect(existsSync(script)).toBe(true);
    expect(packageBin('@rslib/core', 'rslib')[1]).toMatch(/rslib\.js$/);
  });

  it('refuses a bin the package does not declare', () => {
    expect(() => packageBin('vitest', 'nope')).toThrow(/vitest declares no bin "nope"/);
  });

  // Falsifiable: route the call through a shell — the argument splits at its spaces.
  it('hands an argument with spaces and a middle dot over intact', async () => {
    const name = 'chrome · OPFSAdaptiveVFS/jspi';
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', name],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    await new Promise((resolve) => child.on('close', resolve));
    expect(JSON.parse(out)).toEqual([name]);
  });
});

describe('killTree', () => {
  // Falsifiable: drop /T — taskkill then leaves the browser and its driver alive.
  it('kills the whole tree with taskkill on Windows', () => {
    const calls: [string, string[]][] = [];
    killTree(1234, 'SIGKILL', {
      platform: 'win32',
      run: (command, args) => calls.push([command, args]),
    });
    expect(calls).toEqual([['taskkill', ['/T', '/F', '/PID', '1234']]]);
  });

  it.skipIf(process.platform === 'win32')(
    'signals the process group elsewhere',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on('exit', (_code, signal) => resolve(signal)),
      );
      killTree(child.pid as number, 'SIGKILL', { platform: 'linux' });
      expect(await exited).toBe('SIGKILL');
    },
  );

  it('ignores a group that is already gone', () => {
    expect(() => killTree(2 ** 22 - 1, 'SIGKILL', { platform: 'linux' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/processes.test.ts`
Expected: FAIL — `Cannot find module '../../../scripts/processes.ts'`.

- [ ] **Step 3: Write `scripts/processes.ts`**

```ts
/**
 * Starting and stopping child processes the same way on Linux, macOS and
 * Windows: what `scripts/parallel.ts`, `scripts/bounded.ts` and the test
 * harness share.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * POSIX: the child leads its own process group, so `killTree` reaches what it
 * started. Windows has no process groups; there a detached child only gets a
 * console of its own.
 */
export const DETACHED = process.platform !== 'win32';

/**
 * `[node, <the package's bin script>]`: a package's CLI started with this Node.
 * `pnpm exec <cli>` goes through `pnpm.cmd` on Windows, which Node spawns only
 * with a shell, and a shell splits the project names Vitest is given
 * (`chrome · OPFSAdaptiveVFS/jspi`) at their spaces.
 */
export function packageBin(
  pkg: string,
  bin: string,
  root: string = ROOT,
): [node: string, script: string] {
  const dir = join(root, 'node_modules', pkg);
  const manifest = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as { bin?: string | Record<string, string> };
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (relative === undefined) {
    throw new Error(`${pkg} declares no bin "${bin}"`);
  }
  return [process.execPath, join(dir, relative)];
}

/**
 * Kills `pid` and everything it started. POSIX: signals the process group
 * (the child must have been spawned with `detached: DETACHED`). Windows:
 * `taskkill /T /F`, the tree by parentage — Windows has no signals, so
 * `signal` is ignored there and every kill is forced. A tree already gone is
 * fine.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  {
    platform = process.platform,
    run = (command, args) => {
      spawnSync(command, args, { stdio: 'ignore' });
    },
  }: {
    platform?: NodeJS.Platform;
    run?: (command: string, args: string[]) => void;
  } = {},
): void {
  if (platform === 'win32') {
    run('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/processes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Falsify the Windows branch**

Temporarily remove `'/T', ` from `killTree`: the Windows test goes red; restore it and see it green. Report both outcomes. (The POSIX group kill of a grandchild is already falsified by `bounded.test.ts`, which Task 2 routes through `killTree`.)

- [ ] **Step 6: Format, typecheck, commit**

```bash
pnpm exec biome check --write scripts/processes.ts tests/unit/tooling/processes.test.ts
pnpm exec tsc --noEmit
test "$(git branch --show-current)" = ci/windows-macos && git add scripts/processes.ts tests/unit/tooling/processes.test.ts && git commit -m "feat(scripts): start a package CLI and kill a process tree on every OS

pnpm exec needs a shell on Windows, which splits Vitest's project
names; process groups do not exist there, so a kill must walk the tree.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The scripts start Vitest and rslib through Node, and kill through `killTree`

**Files:**
- Modify: `scripts/parallel.ts` (`killLive`, `runBounded`, `buildOnce`)
- Modify: `scripts/bounded.ts` (the `grouped` spawn and `killAll`)
- Modify: `scripts/test-parallel.ts` (`listProjects`, the `runBounded('pnpm', …)` call, the merge `spawnSync('pnpm', …)`)
- Modify: `scripts/test-plan.ts` (the unit job's `runBounded('pnpm', …)`, `mergeBlobs`)
- Modify: `tests/harness/build-setup.ts` (both spawns and the watcher's kill)
- Modify: `scripts/hook-gate.ts` (the `spawnSync` in the step runner)
- Test: `tests/unit/tooling/hook-gate.test.ts`

**Interfaces:**
- Consumes: `DETACHED`, `packageBin`, `killTree` from Task 1.
- Produces: no new exports; `runBounded`'s signature is unchanged (callers now pass `process.execPath` and a script path as `command` and first argument).

- [ ] **Step 1: Write the failing hook-gate test**

Add to `tests/unit/tooling/hook-gate.test.ts` (import `COMMANDS` from `../../../scripts/hook-gate.ts` if not already imported):

```ts
describe('COMMANDS on Windows', () => {
  // Under shell: true (win32, for the pnpm/npx .cmd shims) cmd.exe would
  // split such an entry. Falsifiable: add an argv entry with a space.
  it('has no argv entry a shell could split or unquote', () => {
    for (const steps of Object.values(COMMANDS)) {
      for (const step of steps) {
        for (const arg of step.argv) expect(arg).not.toMatch(/[\s"'^&|<>%]/);
      }
    }
  });
});
```

Run: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/hook-gate.test.ts`
Expected: PASS already (today's argv are clean) — this test is a guard, not a red-first test; confirm it goes RED by temporarily adding `'a b'` to one argv, then restore.

- [ ] **Step 2: `scripts/hook-gate.ts` — a shell for the `.cmd` shims on Windows**

In the step runner's `spawnSync(command, args, { cwd, stdio: …, env: … })`, add:

```ts
        // pnpm and npx are .cmd shims on Windows, which Node starts only
        // through a shell; COMMANDS holds no argument a shell could split.
        shell: process.platform === 'win32',
```

- [ ] **Step 3: `scripts/parallel.ts`**

Import `{ DETACHED, killTree, packageBin }` from `./processes.ts`. Then:

`killLive` body becomes:

```ts
export function killLive(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const pid of live) killTree(pid, signal);
}
```

(update its doc comment: "Kills every run in flight and what each started; a run already gone is fine.")

In `runBounded`: `detached: true` → `detached: DETACHED`; the timer body becomes:

```ts
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) child.kill('SIGKILL');
      else killTree(child.pid);
    }, timeoutMs);
```

and in its doc comment replace "`detached: true` + `process.kill(-pid, 'SIGKILL')`" by "`killTree`, from `scripts/processes.ts`".

In `buildOnce`:

```ts
    const [node, rslib] = packageBin('@rslib/core', 'rslib');
    const built = spawnSync(
      node,
      [rslib, 'build', '-c', 'tests/rslib.vitest.config.ts'],
      { cwd: ROOT, env, stdio: 'inherit' },
    );
```

- [ ] **Step 4: `scripts/test-parallel.ts` and `scripts/test-plan.ts`**

Import `{ packageBin }` from `./processes.ts` in both. At module scope of each: `const [NODE, VITEST] = packageBin('vitest', 'vitest');`. Then every `'pnpm', ['exec', 'vitest', …rest]` becomes `NODE, [VITEST, …rest]`, at these five sites:
- `test-parallel.ts` `listProjects`: `spawnSync(NODE, [VITEST, 'list', '--config', …], {…})`
- `test-parallel.ts` the job: `runBounded(NODE, [VITEST, 'run', '--config', …], {…})`
- `test-parallel.ts` the merge: `spawnSync(NODE, [VITEST, '--config', …, '--merge-reports', …], {…})`
- `test-plan.ts` the unit job: `runBounded(NODE, [VITEST, 'run', '--config', …, '--project', 'unit', …], {…})`
- `test-plan.ts` `mergeBlobs`: `spawnSync(NODE, [VITEST, '--config', …], {…})`

(`grep -n "'pnpm'" scripts/test-parallel.ts scripts/test-plan.ts` must print nothing afterwards.)

- [ ] **Step 5: `scripts/bounded.ts`**

Import `{ DETACHED, killTree }` from `./processes.ts`. Replace

```ts
const grouped = process.platform !== 'win32';
```

by `const grouped = DETACHED;` (its comment: drop "POSIX only."; add "On Windows the tree is killed by parentage instead (`killTree`)."). Replace `killAll` by:

```ts
/** Signals the command and everything it started; a tree already gone is fine. */
const killAll = (signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  killTree(child.pid, signal);
};
```

- [ ] **Step 6: `tests/harness/build-setup.ts`**

Import `{ DETACHED, killTree, packageBin }` from `../../scripts/processes.ts`. Replace `const BUILD = ['exec', 'rslib', 'build', '-c', 'tests/rslib.vitest.config.ts'];` by:

```ts
const [NODE, RSLIB] = packageBin('@rslib/core', 'rslib');
const BUILD = [RSLIB, 'build', '-c', 'tests/rslib.vitest.config.ts'];
```

`spawnSync('pnpm', BUILD, …)` → `spawnSync(NODE, BUILD, …)`; `spawn('pnpm', [...BUILD, '--watch'], { …, detached: true })` → `spawn(NODE, [...BUILD, '--watch'], { …, detached: DETACHED })`; `if (started.pid) process.kill(-started.pid, 'SIGTERM');` → `if (started.pid) killTree(started.pid, 'SIGTERM');`.

- [ ] **Step 7: Check no `.cmd` shim remains on the CI path**

Run: `grep -n "'pnpm'\|'npx'" scripts/parallel.ts scripts/test-parallel.ts scripts/test-plan.ts scripts/bounded.ts scripts/run-cell.ts tests/harness/*.ts`
Expected: no output.

- [ ] **Step 8: Verify on Linux**

```bash
pnpm exec biome check --write scripts/parallel.ts scripts/bounded.ts scripts/test-parallel.ts scripts/test-plan.ts scripts/hook-gate.ts tests/harness/build-setup.ts tests/unit/tooling/hook-gate.test.ts
pnpm exec tsc --noEmit
pnpm test:unit
pnpm test > .work/task2-test.log 2>&1; echo "exit $?"; tail -5 .work/task2-test.log
pnpm test:conformance > .work/task2-conf.log 2>&1; echo "exit $?"; tail -5 .work/task2-conf.log
```

Expected: tsc clean; unit green (`bounded.test.ts` included — it exercises the POSIX group kill through `killTree`); `pnpm test` exit 0 with `Test Files … passed`, 0 failed, the same counts as the baseline in `mem:state` (2494 passed / 490 skipped at the time of writing); conformance exit 0, 162 passed / 32 skipped. Report progress every two minutes while they run.

- [ ] **Step 9: Commit**

```bash
test "$(git branch --show-current)" = ci/windows-macos && git add scripts/parallel.ts scripts/bounded.ts scripts/test-parallel.ts scripts/test-plan.ts scripts/hook-gate.ts tests/harness/build-setup.ts tests/unit/tooling/hook-gate.test.ts && git commit -m "fix(scripts): run Vitest and rslib through Node, kill through killTree

On Windows pnpm exec needs a shell that splits Vitest's project names,
and process.kill(-pid) does not exist: a deadline killed node and left
the browser and its driver running.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `browsers.ts install` takes the list of browsers to install

**Files:**
- Modify: `scripts/browsers.ts` (`installAll`, the CLI block, `deps`)
- Test: `tests/unit/tooling/browsers.test.ts`

**Interfaces:**
- Produces: `export function parseBrowserList(arg: string | undefined): BrowserName[]`; `installAll(names: readonly BrowserName[])`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/tooling/browsers.test.ts` (extend its import with `parseBrowserList`):

```ts
describe('parseBrowserList', () => {
  it('is both browsers when no list is given', () => {
    expect(parseBrowserList(undefined)).toEqual(['chrome', 'firefox']);
  });

  it('takes one name or a comma-separated list, in the given order', () => {
    expect(parseBrowserList('chrome')).toEqual(['chrome']);
    expect(parseBrowserList('firefox,chrome')).toEqual(['firefox', 'chrome']);
  });

  it('ignores empty entries and repeats', () => {
    expect(parseBrowserList('chrome,,chrome')).toEqual(['chrome']);
  });

  // Falsifiable: filter unknown names out instead of throwing — a typo then
  // installs nothing for it, and the job fails much later at launch.
  it('refuses an unknown name, naming the valid ones', () => {
    expect(() => parseBrowserList('chrome,safari')).toThrow(
      'browsers: unknown browser "safari" — expected chrome, firefox',
    );
  });

  it('refuses a list that names nothing', () => {
    expect(() => parseBrowserList(',')).toThrow(/names no browser/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browsers.test.ts`
Expected: FAIL — `parseBrowserList` is not exported.

- [ ] **Step 3: Implement**

In `scripts/browsers.ts`, after `PINNED`:

```ts
const NAMES = Object.keys(PINNED) as BrowserName[];

/** `chrome,firefox` → the browsers to install, in that order; both when omitted. */
export function parseBrowserList(arg: string | undefined): BrowserName[] {
  if (arg === undefined) return [...NAMES];
  const names: BrowserName[] = [];
  for (const entry of arg.split(',').map((s) => s.trim())) {
    if (entry === '') continue;
    if (!NAMES.includes(entry as BrowserName)) {
      throw new Error(
        `browsers: unknown browser "${entry}" — expected ${NAMES.join(', ')}`,
      );
    }
    if (!names.includes(entry as BrowserName)) names.push(entry as BrowserName);
  }
  if (names.length === 0) throw new Error(`browsers: "${arg}" names no browser`);
  return names;
}
```

`installAll()` → `installAll(names: readonly BrowserName[])`, looping over `names` instead of `['chrome', 'firefox'] as const`. The usage line in the file's header comment:

```
 *   node scripts/browsers.ts deps            apt packages both need, on one line (Linux)
 *   node scripts/browsers.ts install [list]  download the browsers in list (chrome,firefox by
 *                                            default), open and close a session with each
```

The CLI block:

```ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'deps') {
    if (process.platform !== 'linux') {
      console.error('browsers deps: Linux only (apt packages)');
      process.exit(2);
    }
    console.log((await deps()).join(' '));
  } else if (command === 'install') {
    await installAll(parseBrowserList(process.argv[3]));
  } else {
    console.error('usage: node scripts/browsers.ts deps | install [chrome,firefox]');
    process.exit(2);
  }
}
```

- [ ] **Step 4: Run the tests and the command**

```bash
pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browsers.test.ts
node scripts/browsers.ts install chrome
node scripts/browsers.ts install
node scripts/browsers.ts install chrom; echo "exit $?"
```

Expected: tests PASS; `chrome 153.0.8010.52: ok` alone; then both lines; then the error naming `chrom` and exit 1.

- [ ] **Step 5: Format, typecheck, commit**

```bash
pnpm exec biome check --write scripts/browsers.ts tests/unit/tooling/browsers.test.ts
pnpm exec tsc --noEmit
test "$(git branch --show-current)" = ci/windows-macos && git add scripts/browsers.ts tests/unit/tooling/browsers.test.ts && git commit -m "feat(scripts): browsers.ts install takes the browsers to install

The bench check and the consumer smoke drive Chrome alone, yet every
job downloaded both browsers and opened a session with each.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The composite action, and the four workflows on it

**Files:**
- Create: `.github/actions/setup/action.yaml`
- Modify: `.github/workflows/ci.yaml` (job `verify`)
- Modify: `.github/workflows/matrix.yaml` (jobs `plan`, `cells`)
- Modify: `.github/workflows/release-and-publish.yaml` (job `consumer-smoke`)
- Modify: `.github/workflows/pages.yaml` (the browser block before "Check the bench page")

**Interfaces:**
- Consumes: `node scripts/browsers.ts install <list>` (Task 3).
- Produces: `uses: ./.github/actions/setup` with inputs `browsers` (default `chrome,firefox`, empty for none) and `node-setup` (default `'true'`).

- [ ] **Step 1: Write the action**

```yaml
# .github/actions/setup/action.yaml
name: Setup
description: >-
  Node 24, pnpm and the dependencies, then the browsers a job drives at the
  versions scripts/browsers.ts pins, with their drivers.

inputs:
  browsers:
    description: Browsers to install, comma-separated (chrome,firefox); empty for none.
    default: chrome,firefox
  node-setup:
    description: Set up pnpm and Node, and install the dependencies.
    default: 'true'

runs:
  using: composite
  steps:
    - if: inputs.node-setup == 'true'
      uses: pnpm/action-setup@v6

    - if: inputs.node-setup == 'true'
      uses: actions/setup-node@v6
      with:
        node-version: 24
        cache: pnpm

    - if: inputs.node-setup == 'true'
      shell: bash
      run: pnpm install --frozen-lockfile

    # The list is in the key: a cache saved by a Chrome-only job and restored
    # for one that also needs Firefox would download Firefox on every run, a
    # hit being never written back. scripts/browsers.ts holds the pins.
    - if: inputs.browsers != ''
      uses: actions/cache@v6
      with:
        path: node_modules/.cache/wdio
        key: wdio-${{ runner.os }}-${{ runner.arch }}-${{ inputs.browsers }}-${{ hashFiles('scripts/browsers.ts') }}

    # Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor.
    # Chrome's sandbox needs them, and only the system Chrome has a profile
    # that allows them: the Chrome for Testing WebdriverIO downloads exits at
    # launch ("Chrome instance exited"). Lifting the restriction keeps the
    # sandbox, where --no-sandbox would drop it. Windows and macOS have no
    # such restriction.
    - if: inputs.browsers != '' && runner.os == 'Linux'
      name: Let Chrome's sandbox create user namespaces
      shell: bash
      run: |
        sysctl kernel.apparmor_restrict_unprivileged_userns
        sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

    # One download per browser and driver, before anything runs in parallel:
    # on a cold cache, parallel Vitest jobs fetched the same chromedriver at
    # once, and one spawned it before it was executable (EACCES).
    - if: inputs.browsers != ''
      name: Install browsers
      shell: bash
      run: node scripts/browsers.ts install "$BROWSERS"
      env:
        BROWSERS: ${{ inputs.browsers }}
```

- [ ] **Step 2: Migrate `ci.yaml`, `matrix.yaml`, the release**

In `ci.yaml` `verify`, `matrix.yaml` `plan` and `cells`, and `release-and-publish.yaml` `consumer-smoke`: delete the steps from `- uses: pnpm/action-setup@v6` through `- name: Install browsers … run: node scripts/browsers.ts install` inclusive (pnpm, setup-node, `pnpm install`, the cache with its comment, the AppArmor step with its comment, the install with its comment), and put in their place, right after `- uses: actions/checkout@v6`:

```yaml
      - uses: ./.github/actions/setup
```

— in `consumer-smoke` with:

```yaml
      # The smoke drives Chrome alone.
      - uses: ./.github/actions/setup
        with:
          browsers: chrome
```

In `ci.yaml`, the "Lint the workflows" step sits between `pnpm install` and the cache today: keep it, after the action.

- [ ] **Step 3: Migrate `pages.yaml`**

Replace its three steps "Cache WebdriverIO browsers", "Let Chrome's sandbox create user namespaces" and "Install browsers" (all `if: steps.bench.outputs.dir != ''`) by:

```yaml
      # pnpm and Node are set up above, for the tag checkouts; the bench check
      # drives Chrome alone.
      - if: steps.bench.outputs.dir != ''
        uses: ./.github/actions/setup
        with:
          browsers: chrome
          node-setup: 'false'
```

Keep "Install the workspace tooling" (`pnpm install --frozen-lockfile`) before it.

- [ ] **Step 4: Lint**

Run: `node scripts/actionlint.ts; echo "exit $?"`
Expected: exit 0, no finding. Then `grep -n "browsers.ts install\|apparmor" .github/workflows/*.yaml` — expected: no output (both live only in the action now).

- [ ] **Step 5: Commit**

```bash
test "$(git branch --show-current)" = ci/windows-macos && git add .github/actions/setup/action.yaml .github/workflows/ci.yaml .github/workflows/matrix.yaml .github/workflows/release-and-publish.yaml .github/workflows/pages.yaml && git commit -m "ci: one setup action for every job that drives a browser

The same seven steps sat in five jobs; the AppArmor step, Linux-only,
now sits behind runner.os, so the action serves Windows and macOS too.
The bench check and the consumer smoke install Chrome alone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The test workflow and its Windows and macOS callers

**Files:**
- Create: `.github/workflows/tests.yaml`
- Create: `.github/workflows/tests-windows.yaml`
- Create: `.github/workflows/tests-macos.yaml`

**Interfaces:**
- Consumes: `./.github/actions/setup` (Task 4).
- Produces: `tests.yaml` with `on.workflow_call.inputs.runs-on` (string, required).

- [ ] **Step 1: Write the three files**

```yaml
# .github/workflows/tests.yaml
name: Tests

# The suites a platform runs: what ci.yaml's verify tests on Linux, without
# the checks that do not depend on the OS (lint, docs, typecheck), which
# ci.yaml runs. Each platform's workflow calls this with its runner.
on:
  workflow_call:
    inputs:
      runs-on:
        description: The runner label, e.g. windows-latest.
        required: true
        type: string

jobs:
  test:
    runs-on: ${{ inputs.runs-on }}
    timeout-minutes: 90
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup
      - run: pnpm build
      - run: pnpm test
      - run: pnpm test:conformance
```

```yaml
# .github/workflows/tests-windows.yaml
name: Tests (Windows)

on:
  workflow_dispatch:
  # TEMPORARY: runs the workflow from its branch before it exists on main.
  # Removed before the merge.
  push:
    branches:
      - ci/windows-macos

concurrency:
  group: tests-windows-${{ github.ref }}
  cancel-in-progress: true

jobs:
  windows:
    uses: ./.github/workflows/tests.yaml
    with:
      runs-on: windows-latest
```

```yaml
# .github/workflows/tests-macos.yaml
name: Tests (macOS)

on:
  workflow_dispatch:
  # TEMPORARY: runs the workflow from its branch before it exists on main.
  # Removed before the merge.
  push:
    branches:
      - ci/windows-macos

concurrency:
  group: tests-macos-${{ github.ref }}
  cancel-in-progress: true

jobs:
  macos:
    uses: ./.github/workflows/tests.yaml
    with:
      runs-on: macos-latest
```

- [ ] **Step 2: Lint**

Run: `node scripts/actionlint.ts; echo "exit $?"`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
test "$(git branch --show-current)" = ci/windows-macos && git add .github/workflows/tests.yaml .github/workflows/tests-windows.yaml .github/workflows/tests-macos.yaml && git commit -m "ci: the suites on Windows and macOS, one workflow per platform

Each platform carries its own triggers; tests.yaml holds the steps.
A push trigger on this branch runs them before they exist on main.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: First runs on GitHub, and what Windows and macOS show

This task cannot be scripted in advance: it reads what the runners report and fixes it. Each fix is its own commit, with the failing log line quoted in the body.

- [ ] **Step 1: Ask the user's go to push `ci/windows-macos`.** Nothing is pushed before it.

- [ ] **Step 2: Push and watch**

```bash
git push -u origin ci/windows-macos
gh run list --branch ci/windows-macos --limit 5
gh run watch <run-id> --exit-status
```

Report at launch and every two minutes: elapsed, which step, any failure. `ci.yaml` and `matrix.yaml` trigger on pushes of `main` (and PRs for `ci.yaml`), so only the two new workflows start.

- [ ] **Step 3: For each red run** — `gh run view <run-id> --log-failed`, then the systematic-debugging skill: root cause before any change, a fix as a separate commit (`fix(scripts): …` or `ci: …`), biome + tsc + `pnpm test:unit` locally, push (the user's go covers re-pushes of this branch for this task — confirm when asking in Step 1), watch again.

- [ ] **Step 4: Three green runs per platform.** Re-run with `gh run rerun <run-id>` once both are green, until each platform has three. For each run record: the `pnpm test` summary lines (`Test Files`, `Tests`), the "Skipped with a reason" list, the plan's "Not applicable" counts, the conformance summary, and each step's duration (`gh run view <run-id> --json jobs`). Compare the counts with Linux's (`mem:state`): any difference is reported and examined before going on.

---

### Task 7: Remove the temporary triggers, document, close

**Files:**
- Modify: `.github/workflows/tests-windows.yaml`, `.github/workflows/tests-macos.yaml` (remove the `push` trigger and its comment)
- Modify: `README.md` (§ Development)
- Modify (Serena memories): `stack-and-build/ci`, `conventions` (§ What runs where), `measurements` (a new entry or sub-memory for the runs), `state`, `history/2026-10-12-to-18`

- [ ] **Step 1: Remove the temporary triggers** — delete the four lines `# TEMPORARY: …`, `# Removed before the merge.`, `push:`, `branches:`, `- ci/windows-macos` from both files, leaving `workflow_dispatch:` alone. `node scripts/actionlint.ts` exit 0. Commit `ci: the Windows and macOS workflows run on demand only`.

- [ ] **Step 2: README** — in § Development, after the `pnpm test` code block's lines, change the `pnpm test` comment to `# unit (Node) + browser (Vitest on WebdriverIO: Chrome, Firefox) — Linux, Windows, macOS` and add one paragraph after the "These suites run on demand" block:

```markdown
CI runs the suites on Linux for every pull request and push of `main`. The Windows and macOS runs are started by hand, from the Actions tab or with `gh workflow run tests-windows.yaml --ref <branch>` (`tests-macos.yaml` likewise); a workflow can be started this way once it exists on `main`.
```

`pnpm docs:vfs && git diff --exit-code VFS.md README.md` must stay clean (the generated spans are elsewhere in README). Commit `docs(readme): the suites on Windows and macOS`.

- [ ] **Step 3: Memories** — through Serena's `edit_memory`:
  - `stack-and-build/ci`: the action (inputs, what it holds, the Linux-only step), `tests.yaml` and its two callers, `workflow_dispatch` only, dispatchable once on `main`; open: `pages.yaml` on the next push of `preview`, `consumer-smoke` at the next release.
  - `conventions` § What runs where: Windows and macOS on demand.
  - `measurements`: the runs of Task 6 Step 4 (counts, durations, any divergence from Linux), under a new ID.
  - `state`: the piece done; next is putting the two workflows in the release (user, 2026-10-14), then chantier 2 (Safari).
  - `history/2026-10-12-to-18`: one row.
  Commit `docs(memory): …` on the branch.

- [ ] **Step 4: Delivery**

```bash
node scripts/hook-gate.ts delivery --run > .work/delivery.log 2>&1; echo "exit $?"
```

Expected: exit 0. Report progress every two minutes. Then report to the user and wait for their approval before `git merge --no-ff ci/windows-macos` into `main` (`mem:conventions`: never merge before the report has been approved). After the merge and the user's go to push `main`, the push proves `ci.yaml` and `matrix.yaml` on the action; delete the remote branch.
