# Test planner, plan B — the planner, its cells and guard, the static test files

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver step 4 of the test-planner spec — a planner that gives every browser cell exactly the tests its pair should run, the cell guard, the reporting and the scripts — together with the part of step 5 the planner cannot work without: the test files that declare tests dynamically made static, and the `isolated/` files tagged.

**Architecture:** A pure planner (`tests/planner/plan.ts`) decides cells from each test's tags, the probed features and the pairs; Node scripts drive Vitest's API around it (`scripts/plan-io.ts`, the orchestrator `scripts/test-plan.ts`, one process per cell `scripts/run-cell.ts`), selecting each cell's tests by `testIds` from static parsing (measured 2026-10-12, `mem:measurements/suite-and-matrix` § TEST-IDS). A setup file in every target project (`tests/browser/need-guard.ts`) skips ineligible tests in a direct run and fails, by name, any test that runs against the plan in a planned one.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`, `exactOptionalPropertyTypes`), Biome, Vitest 5.0.3 Node API (`createVitest`, `standalone`, `parseSpecifications`, `runTestSpecifications`, `TestProject.import`, `TestProject.provide`, `experimental_getRunnerTask`), WebdriverIO with Chrome 153 and Firefox 155, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-12-test-planner-design.md` (§ 2-5; § 3 and § 8 for the files converted here). Decisions since the spec, binding here: `mem:follow-ups/test-planner-design` (§ "Selecting a cell's tests" and the per-file list under it).

## Global Constraints

- One branch, `feat/test-planner`, off `main`; every commit green (`pnpm exec tsc --noEmit`, Biome, the tests the task names). Closing = format, lint, typecheck, `pnpm test` and `pnpm test:matrix` green, memories updated, report to the user, **merge only on the user's approval** (`mem:conventions`), `git merge --no-ff`, branch deleted. Never push.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check the branch in the same command: `test "$(git branch --show-current)" = feat/test-planner && git commit …`.
- Code files are read and edited through Serena's symbolic tools (`AGENTS.md` § Tooling); built-in Read/Edit only on non-code files or when Serena fails.
- After every modification `pnpm exec biome check --write <files>`; before every commit `pnpm exec tsc --noEmit`.
- `$WS` in the commands is this plan's scratch directory, `WS=/workspaces/wsqlite/.superpowers/sdd/2026-10-12-test-planner-b` (git-ignored), created by the executor's setup; logs and throwaway files go there or under `.scratchpad/`, never in `tests/`.
- Any run past ~2 minutes (`pnpm test` ≈ 3 min, `pnpm test:matrix` ≈ 13-16 min, a merge whose hook runs the suite) goes to the background writing to a log, never through `| tail`, with a progress line to the user every 2 minutes from launch.
- Property names, verbatim, after this plan: `two-workers`, `interruptible`, `shared-second-client`, `exclusive-connection`, `shared-storage`, `opfs-file`, `in-place-file`, `capped-pool`, `env-capped-pool`, `default-pragmas`, `exclusive-file-handle`, `idb-storage`, `every-build`, `env-cappable`, `sync-handle`. Tag names: `requires:<property>`, `excludes:<property>`, `vfs:<VFS>`, `build:<build>`, `browser:<chrome|firefox>`, `isolated`, `not-isolated`, `standalone`.
- No VFS and no build written in a converted test's body: a VFS that is the subject is a `vfs:` tag, one that stands for a capability is the property, and the body follows its cell's pair (`TEST_TARGET`) — or, for a `standalone` test, the pair `standalonePair` resolves from its tags (user, 2026-10-12).
- A test that loops over cases (builds of its VFS, constraints, every VFS) runs every case whatever the others do and fails once at the end naming each failed case (`forEachCase`, user, 2026-10-12).
- No CHANGELOG entry: nothing here changes what a consumer gets.

## Review Focus

- A test created conditionally (`(cond ? it : it.skip)(…)`, an `if` around `it`) is invisible to static parsing and would silently never be planned. Pinned in Task 11, Step 5 (a unit test that refuses those constructs in `tests/browser/`).
- A file that declares tests dynamically shifts every later id, so a planned id would select another test. Pinned twice: the planner refuses a test the parser marks dynamic (Task 2), and the guard fails a test whose runtime name differs from the planned one (Task 3).
- An isolated context must keep only the tests isolation makes eligible, except where a mode was asked for explicitly (`--full`). Pinned in Task 1 (`dedupeIsolation`) and Task 2 (`fullIsolation`).
- A browser project run directly (`vitest run --project …`) must still run only the tests eligible on its own pair. Pinned in Task 3, Step 7.
- An explicit pair (`BSQ_TEST_TARGETS`, `--pair`) is never substituted: not runnable on a browser it is shown, not replaced. Pinned in Task 2.

## Decisions this plan takes (for the user's review)

1. **Static `testIds`, two-phase.** The planner parses one reference project per family (browser × isolated) to decide cells, then parses only the chosen cells' projects to get their ids, matching each test by its position in the file and checking its name (measured: all 88 projects parse in 7.2 s, a family in ~0.3 s).
2. **The guard skips in a direct run.** The spec's "a project started outside the plan prints that only the tests eligible on its own target run" becomes a `ctx.skip(reason)` per ineligible test, which also keeps the converted files correct under today's scripts until Task 12 switches them.
3. **`isolated/` files are tagged `vfs:OPFSWriteAheadVFS` + `build:sync` + `isolated`** — exactly the pair their bodies pin today, so they run in one isolated cell per browser instead of 44; un-pinning them, the isolated precondition and the directory flattening stay in step 5. `firefox/` files stay untagged (they are only in Firefox projects).
4. **`abandon-gc` skips with a reason** (`ctx.skip('… --expose-gc')` at the top of each test) rather than `it.skipIf`: same static ids, and the reason shows in every run as `mem:conventions` asks of browser-defect skips.
5. **The matrix goes through the planner** (`scripts/test-matrix.ts` keeps its arguments, `allPairs` and its per-cell JSON reports for `matrix-triage.ts`, and delegates to `scripts/test-plan.ts --table`).
6. **Pinning, `pairFor`'s fallback and `BSQ_TEST_NEEDS` stay** until step 5 (plan C): a pinned untagged test keeps running on every start pair, as today.

## File structure

| File | Responsibility |
|---|---|
| `tests/need.ts` (modify) | three new properties, `shouldTestRun`'s `dedupeIsolation`, `canonicalPairs`, `representative` |
| `tests/planner/plan.ts` (create) | the pure planner: cells, not-applicable, dead, not-runnable |
| `tests/planner/guard.ts` (create) | the pure guard verdict and the feature comparison |
| `tests/browser/need-guard.ts` (create) | the setup file of every target project |
| `tests/probe/features.test.ts` (create) | records `AVAILABLE_FEATURES` in a test's meta |
| `tests/vitest.d.ts` (modify) | `bsqEnvironment`, `bsqPlanned`, `TaskMeta.features` |
| `vitest.config.ts` (modify) | `bsqEnvironment`, the guard, the probe projects, `tests/probe/**` out of `unit` |
| `scripts/plan-io.ts` (create) | Vitest Node API: open, probe, collect a family, a cell's ids |
| `scripts/run-cell.ts` (create) | one cell (or one shard of it) as one process |
| `scripts/test-plan.ts` (create) | the orchestrator: plan, print, run, merge, report |
| `scripts/test-matrix.ts` (modify) | delegates to `test-plan.ts --mode all-pairs --table` |
| `tests/browser/helpers.ts` (modify) | `ENVIRONMENT`, `standalonePair`, `buildsHere`, `forEachCase` |
| 13 test files (modify) | tags, literal tests (Tasks 3, 7-11) |
| `package.json` (modify) | the scripts of spec § 5 |

---

### Task 0: Branch

- [ ] **Step 1:** `cd /workspaces/wsqlite && git switch main && git switch -c feat/test-planner`

### Task 1: the vocabulary grows; canonical pairs and the standalone representative

**Files:**
- Modify: `tests/need.ts`
- Modify: `tests/unit/need.test.ts`

**Interfaces:**
- Produces: `PROPERTIES` gains `'every-build'`, `'env-cappable'`, `'sync-handle'` (appended, in that order); `shouldTestRun(context, need?, options?: { readonly dedupeIsolation?: boolean })` (default `true`); `canonicalPairs(browser: BrowserName, isolated: boolean, features: ReadonlySet<PlatformFeature>): TestContext[]`; `representative(need: TestNeed, browser: BrowserName, features: ReadonlySet<PlatformFeature>): TestContext | null`.

- [ ] **Step 1: Write the failing tests** — in `tests/unit/need.test.ts`:

In the `table` of `describe('the properties, against the spec table (2026-10-12)')`, add three rows (the table's type requires every property but `interruptible`, so `tsc` fails until `tests/need.ts` has them too):

```ts
    'every-build': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'MemoryVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'MemoryVFS'],
    },
    'env-cappable': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
    },
    'sync-handle': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
    },
```

In `describe('shouldTestRun')`, after `honours isolated: false`:

```ts
  // Falsifiable: ignore dedupeIsolation in shouldTestRun.
  it('runs every eligible test in isolation when the mode was asked for in full', () => {
    expect(shouldTestRun(wa('chrome', true), {}, { dedupeIsolation: false })).toBe(true);
    expect(shouldTestRun(wa('chrome', true), { isolated: false }, { dedupeIsolation: false })).toBe(false);
  });
```

At the end of the file:

```ts
describe('canonicalPairs', () => {
  it('lists every runnable pair, VFS in declaration order, then builds as declared', () => {
    const pairs = canonicalPairs('chrome', false, CHROME);
    expect(pairs).toHaveLength(22);
    expect(pairs.slice(0, 4).map(({ vfs, build }) => `${vfs}/${build}`)).toEqual([
      'OPFSWriteAheadVFS/sync',
      'OPFSWriteAheadVFS/jspi',
      'OPFSWriteAheadVFS/async',
      'OPFSAdaptiveVFS/jspi',
    ]);
    expect(pairs.every((p) => p.browser === 'chrome' && !p.isolated)).toBe(true);
  });

  // Falsifiable: drop the runsIn filter.
  it('leaves out the pairs this environment cannot run', () => {
    const noJspi = new Set<PlatformFeature>([...FIREFOX].filter((f) => f !== 'jspi'));
    const pairs = canonicalPairs('firefox', false, noJspi);
    expect(pairs).toHaveLength(13);
    expect(pairs.some((p) => p.build === 'jspi')).toBe(false);
  });
});

describe('representative', () => {
  it('gives a standalone test the first pair its need admits', () => {
    const memory = representative({ excludes: ['shared-storage'], requires: ['every-build'] }, 'chrome', CHROME);
    expect(memory && `${memory.vfs}/${memory.build}`).toBe('MemoryVFS/sync');
    const capped = representative({ requires: ['env-capped-pool'] }, 'firefox', FIREFOX);
    expect(capped && `${capped.vfs}/${capped.build}`).toBe('OPFSWriteAheadVFS/sync');
  });

  it('says null where no pair admits the need', () => {
    expect(representative({ requires: ['env-capped-pool'] }, 'chrome', CHROME)).toBeNull();
  });

  it('never answers with an isolated pair', () => {
    expect(representative({}, 'chrome', isolatedOf(CHROME))?.isolated).toBe(false);
  });
});
```

and add `canonicalPairs` and `representative` to the import from `'../need'`.

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/need.test.ts
```
Expected: FAIL — `canonicalPairs` / `representative` are not exported (a `SyntaxError` on the import, or `is not a function`).

- [ ] **Step 3: Implement** — in `tests/need.ts`:

1. Append to `PROPERTIES`, after `'idb-storage'`: `'every-build', 'env-cappable', 'sync-handle',`.
2. Move `const VFS_NAMES …` and `const BUILD_NAMES …` from below `shouldTestRun` to just above `holds` (the new cases read `BUILD_NAMES`).
3. In `holds`'s `switch`, after `case 'idb-storage'`:

```ts
    case 'every-build':
      return BUILD_NAMES.every((build) =>
        (c.builds as readonly SQLiteBuild[]).includes(build),
      );
    case 'env-cappable':
      return c.singleConnectionWithout.length > 0;
    case 'sync-handle':
      return (c.requires as readonly PlatformFeature[]).includes(
        'sync-access-handle',
      );
```

4. Replace `shouldTestRun` with:

```ts
export const shouldTestRun = (
  context: TestContext,
  need: TestNeed = {},
  { dedupeIsolation = true }: { readonly dedupeIsolation?: boolean } = {},
): boolean => {
  if (!eligible(context, need)) return false;
  // A mode asked for explicitly runs in full (spec § 2, D3).
  if (!context.isolated || need.isolated === true || !dedupeIsolation)
    return true;
  const features = new Set(context.features);
  features.delete('cross-origin-isolated');
  return !eligible({ ...context, isolated: false, features }, need);
};
```

5. After `shouldTestRun`:

```ts
/**
 * Every pair this environment can run, in canonical order: `VFS_CAPABILITIES`
 * keys, then each VFS's builds as declared (spec § 4.4). The order is the
 * planner's complement rule, so it never depends on which tests exist.
 */
export const canonicalPairs = (
  browser: BrowserName,
  isolated: boolean,
  features: ReadonlySet<PlatformFeature>,
): TestContext[] =>
  VFS_NAMES.flatMap((vfs) =>
    (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map((build) => ({
      vfs,
      build,
      browser,
      isolated,
      features,
    })),
  ).filter(runsIn);

/**
 * The pair a standalone test takes here: the first non-isolated canonical
 * pair its need admits, or null — never a name written in the test (spec § 3).
 */
export const representative = (
  need: TestNeed,
  browser: BrowserName,
  features: ReadonlySet<PlatformFeature>,
): TestContext | null => {
  const here = new Set(features);
  here.delete('cross-origin-isolated');
  return (
    canonicalPairs(browser, false, here).find((context) =>
      shouldTestRun(context, need),
    ) ?? null
  );
};
```

- [ ] **Step 4: Run them to see them pass**

```bash
pnpm exec biome check --write tests/need.ts tests/unit/need.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/need.test.ts tests/unit/test-target.test.ts tests/unit/target-projects.test.ts
```
Expected: all pass (the six existing predicates of `tests/browser/target.ts` are untouched).

- [ ] **Step 5: Commit**

```bash
git add tests/need.ts tests/unit/need.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: three properties, the canonical pairs and a standalone test's pair

every-build, env-cappable and sync-handle are what statement-errors and
pool-cap need once they stop naming a VFS (user, 2026-10-12). The
canonical order is the planner's complement rule, and representative
gives a standalone test its VFS from its need. shouldTestRun learns that
an isolated mode asked for explicitly runs in full.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: the pure planner

**Files:**
- Create: `tests/planner/plan.ts`
- Create: `tests/unit/plan.test.ts`

**Interfaces:**
- Consumes: Task 1's `canonicalPairs`, `representative`, `shouldTestRun(…, { dedupeIsolation })`, plus `needFromTags`, `runsIn`, `TestContext` (plan A).
- Produces (Tasks 5, 6 rely on these exact names):
  - `type Family = { readonly browser: BrowserName; readonly isolated: boolean }`, `familyName(family): string` (`'chrome'`, `'isolated firefox'`)
  - `type Pair = { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild }`, `projectName(family, pair): string` — the project name `vitest.config.ts` gives that pair
  - `type CollectedTest = { file; position; name; tags; dynamic }`, `type FamilyInput = Family & { features: readonly PlatformFeature[]; tests: readonly CollectedTest[] }`
  - `type PlanOptions = { mode: 'complement' | 'all-pairs'; fullIsolation: boolean; recommended: readonly SQLiteVFS[]; pairs: readonly Pair[] | 'all' | null }`
  - `type CellTest`, `type Cell = Family & Pair & { project; reason: 'start' | 'complement' | 'pair'; tests: readonly CellTest[] }`, `type Unplaced`, `type Plan = { cells; notApplicable; dead; notRunnable }`
  - `plan(families: readonly FamilyInput[], options: PlanOptions): Plan`

- [ ] **Step 1: Write the failing tests** — `tests/unit/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PlatformFeature } from '../../src/const/platform';
import {
  type CollectedTest,
  type FamilyInput,
  type PlanOptions,
  plan,
} from '../planner/plan';

// The features the 2026-10-11 probe measured on the pinned browsers.
const BASE: PlatformFeature[] = ['jspi', 'opfs', 'sync-access-handle', 'web-locks', 'writable-stream', 'indexeddb'];
const CHROME: PlatformFeature[] = [...BASE, 'readwrite-unsafe'];
const FIREFOX: PlatformFeature[] = BASE;
const ISOLATED: PlatformFeature[] = ['cross-origin-isolated'];

let position = 0;
const test = (name: string, tags: string[] = [], file = 'tests/browser/a.test.ts'): CollectedTest => ({
  file,
  position: position++,
  name,
  tags,
  dynamic: false,
});
const families = (tests: CollectedTest[], isolatedTests: CollectedTest[] = []): FamilyInput[] => [
  { browser: 'chrome', isolated: false, features: CHROME, tests },
  { browser: 'firefox', isolated: false, features: FIREFOX, tests },
  { browser: 'chrome', isolated: true, features: [...CHROME, ...ISOLATED], tests: isolatedTests },
  { browser: 'firefox', isolated: true, features: [...FIREFOX, ...ISOLATED], tests: isolatedTests },
];
const COMPLEMENT: PlanOptions = {
  mode: 'complement',
  fullIsolation: false,
  recommended: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
  pairs: null,
};
const ALL_PAIRS: PlanOptions = { ...COMPLEMENT, mode: 'all-pairs' };
/** `project: name, name…` for every cell, sorted, for readable expectations. */
const layout = (p: ReturnType<typeof plan>) =>
  p.cells.map((c) => `${c.project} [${c.reason}]: ${c.tests.map((t) => t.name).join(', ')}`).sort();

describe('complement mode', () => {
  it('runs a test with no need on every start pair, and nowhere else', () => {
    expect(layout(plan(families([test('plain')]), COMPLEMENT))).toEqual([
      'chrome · OPFSAdaptiveVFS/jspi [start]: plain',
      'chrome · OPFSWriteAheadVFS/sync [start]: plain',
      'firefox · OPFSAdaptiveVFS/jspi [start]: plain',
      'firefox · OPFSWriteAheadVFS/sync [start]: plain',
    ]);
  });

  // Falsifiable: take the last eligible canonical pair instead of the first.
  it('runs a test no start pair can run once per browser, on the first canonical pair', () => {
    expect(layout(plan(families([test('idb', ['vfs:IDBBatchAtomicVFS'])]), COMPLEMENT))).toEqual([
      'chrome · IDBBatchAtomicVFS/jspi [complement]: idb',
      'firefox · IDBBatchAtomicVFS/jspi [complement]: idb',
    ]);
  });

  it('opens no cell where nothing runs: an isolated family with no isolated test is empty', () => {
    const p = plan(families([test('plain')], [test('plain isolated file')]), COMPLEMENT);
    expect(p.cells.some((c) => c.isolated)).toBe(false);
  });

  it('runs the slot-channel test in the isolated start cell of each browser', () => {
    const p = plan(families([], [test('slot', ['build:sync', 'requires:interruptible'])]), COMPLEMENT);
    expect(layout(p)).toEqual([
      'isolated chrome · OPFSWriteAheadVFS/sync [start]: slot',
      'isolated firefox · OPFSWriteAheadVFS/sync [start]: slot',
    ]);
  });

  it('lists a test as not applicable on a browser where no pair runs it, and runs it on the other', () => {
    const p = plan(families([test('capped', ['requires:env-capped-pool'])]), COMPLEMENT);
    expect(layout(p)).toEqual([
      'firefox · OPFSWriteAheadVFS/sync [start]: capped',
    ]);
    expect(p.notApplicable.map((u) => `${u.browser}: ${u.name}`)).toEqual(['chrome: capped']);
    expect(p.dead).toEqual([]);
  });

  // Falsifiable: compute `dead` from notApplicable alone.
  it('calls a test no pair of any browser runs dead', () => {
    const p = plan(families([test('nowhere', ['requires:idb-storage', 'requires:opfs-file'])]), COMPLEMENT);
    expect(p.cells).toEqual([]);
    expect(p.dead.map((d) => d.name)).toEqual(['nowhere']);
  });

  it('hosts a standalone test in the first start cell of each browser, once', () => {
    const p = plan(families([test('alone', ['standalone']), test('plain')]), COMPLEMENT);
    const hosts = p.cells.filter((c) => c.tests.some((t) => t.name === 'alone')).map((c) => c.project);
    expect(hosts).toEqual(['chrome · OPFSWriteAheadVFS/sync', 'firefox · OPFSWriteAheadVFS/sync']);
  });

  it('lists a standalone test whose need no pair admits as not applicable', () => {
    const p = plan(families([test('alone', ['standalone', 'requires:env-capped-pool'])]), COMPLEMENT);
    expect(p.notApplicable.map((u) => `${u.browser}: ${u.name}`)).toEqual(['chrome: alone']);
    expect(p.cells.map((c) => c.project)).toEqual(['firefox · OPFSWriteAheadVFS/sync']);
  });

  it('runs every eligible isolated test in isolation when the mode is asked for in full', () => {
    const p = plan(families([], [test('plain isolated file')]), { ...COMPLEMENT, fullIsolation: true });
    expect(p.cells.filter((c) => c.isolated).map((c) => c.project).sort()).toEqual([
      'isolated chrome · OPFSAdaptiveVFS/jspi',
      'isolated chrome · OPFSWriteAheadVFS/sync',
      'isolated firefox · OPFSAdaptiveVFS/jspi',
      'isolated firefox · OPFSWriteAheadVFS/sync',
    ]);
  });
});

describe('explicit pairs', () => {
  it('start from them instead of the recommended VFS, never substituted', () => {
    const p = plan(families([test('plain')]), { ...COMPLEMENT, pairs: [{ vfs: 'MemoryVFS', build: 'async' }] });
    expect(p.cells.map((c) => c.project).sort()).toEqual(['chrome · MemoryVFS/async', 'firefox · MemoryVFS/async']);
  });

  // Falsifiable: let an unrunnable explicit pair fall back to another one.
  it('show a pair a browser cannot run as not runnable there', () => {
    const noJspi = FIREFOX.filter((f) => f !== 'jspi');
    const p = plan(
      [
        { browser: 'chrome', isolated: false, features: CHROME, tests: [test('plain')] },
        { browser: 'firefox', isolated: false, features: noJspi, tests: [test('plain')] },
      ],
      { ...COMPLEMENT, pairs: [{ vfs: 'OPFSAdaptiveVFS', build: 'jspi' }] },
    );
    expect(p.notRunnable.map((n) => `${n.browser} ${n.vfs}/${n.build}`)).toEqual(['firefox OPFSAdaptiveVFS/jspi']);
    expect(p.cells.map((c) => c.project)).toContain('chrome · OPFSAdaptiveVFS/jspi');
  });

  it('refuse a pair the VFS does not declare', () => {
    expect(() =>
      plan(families([test('plain')]), { ...COMPLEMENT, pairs: [{ vfs: 'OPFSAdaptiveVFS', build: 'sync' }] }),
    ).toThrow(/PLAN_PAIR/);
  });
});

describe('all-pairs mode', () => {
  it('runs a test with no need on every runnable pair, never in isolation', () => {
    const p = plan(families([test('plain')], [test('isolated, untagged')]), ALL_PAIRS);
    expect(p.cells.filter((c) => c.browser === 'chrome')).toHaveLength(22);
    expect(p.cells.every((c) => !c.isolated && c.reason === 'pair')).toBe(true);
  });

  it('leaves standalone tests out', () => {
    const p = plan(families([test('alone', ['standalone'])]), ALL_PAIRS);
    expect(p.cells).toEqual([]);
    expect(p.dead).toEqual([]);
  });

  it('reports nothing dead or not applicable when only some pairs were asked for', () => {
    const p = plan(families([test('idb', ['vfs:IDBBatchAtomicVFS'])]), {
      ...ALL_PAIRS,
      pairs: [{ vfs: 'MemoryVFS', build: 'sync' }],
    });
    expect(p.cells).toEqual([]);
    expect(p.dead).toEqual([]);
    expect(p.notApplicable).toEqual([]);
  });
});

describe('what the planner refuses', () => {
  // Falsifiable: drop the dynamic check — its id would select another test.
  it('a test declared dynamically', () => {
    expect(() => plan(families([{ ...test('each %i'), dynamic: true }]), COMPLEMENT)).toThrow(/PLAN_DYNAMIC/);
  });

  it('a tag outside the vocabulary', () => {
    expect(() => plan(families([test('typo', ['requires:two-worker'])]), COMPLEMENT)).toThrow(/NEED_TAG/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/plan.test.ts
```
Expected: FAIL — `Cannot find module '../planner/plan'`.

- [ ] **Step 3: Implement** — `tests/planner/plan.ts`:

```ts
import type { BrowserName } from '../../scripts/browsers.ts';
import { defaultBuildFor } from '../../src/capabilities';
import type { SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import {
  canonicalPairs,
  needFromTags,
  representative,
  runsIn,
  shouldTestRun,
  type TestContext,
  type TestNeed,
} from '../need';

/**
 * Which cell runs which test (spec 2026-10-12, § 4). Pure: the orchestrator
 * feeds it what Vitest parsed and what the probes found, and runs what it
 * returns; the unit tests feed it by hand.
 */

export type Family = { readonly browser: BrowserName; readonly isolated: boolean };

/** A family's prefix in the project names of vitest.config.ts. */
export const familyName = ({ browser, isolated }: Family): string =>
  `${isolated ? 'isolated ' : ''}${browser}`;

export type Pair = { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild };

/** The browser project vitest.config.ts declares for this pair in this family. */
export const projectName = (family: Family, { vfs, build }: Pair): string =>
  `${familyName(family)} · ${vfs}/${build}`;

/** One test as its family's reference parse saw it. */
export type CollectedTest = {
  readonly file: string;
  /** Index among the file's tests in declaration order: what finds the test again in another project. */
  readonly position: number;
  readonly name: string;
  readonly tags: readonly string[];
  /** The parser could not read its name: its runtime id is not knowable in advance. */
  readonly dynamic: boolean;
};

export type FamilyInput = Family & {
  readonly features: readonly PlatformFeature[];
  readonly tests: readonly CollectedTest[];
};

export type PlanOptions = {
  readonly mode: 'complement' | 'all-pairs';
  /** Isolated contexts run every eligible test, not only those isolation makes eligible (a mode asked for explicitly). */
  readonly fullIsolation: boolean;
  /** Complement mode: the start contexts' VFS, each on its default build here. */
  readonly recommended: readonly SQLiteVFS[];
  /** `BSQ_TEST_TARGETS` or `--pair`: the start pairs (complement) or the only pairs (all-pairs); never substituted. */
  readonly pairs: readonly Pair[] | 'all' | null;
};

export type CellTest = Pick<CollectedTest, 'file' | 'position' | 'name'>;

export type Cell = Family &
  Pair & {
    readonly project: string;
    readonly reason: 'start' | 'complement' | 'pair';
    readonly tests: readonly CellTest[];
  };

export type Unplaced = Family & Pick<CollectedTest, 'file' | 'name' | 'tags'>;

export type Plan = {
  readonly cells: readonly Cell[];
  /** The situation the test needs does not exist on this browser (env-capped-pool on Chrome): listed, never a failure. */
  readonly notApplicable: readonly Unplaced[];
  /** Eligible on no pair of any family it belongs to. */
  readonly dead: readonly Pick<CollectedTest, 'file' | 'name' | 'tags'>[];
  /** An explicit pair a family cannot run: shown, never replaced. */
  readonly notRunnable: readonly (Family & Pair)[];
};

const pairKey = ({ vfs, build }: Pair) => `${vfs}/${build}`;

const uniquePairs = (pairs: readonly Pair[]): Pair[] => [
  ...new Map(pairs.map((pair) => [pairKey(pair), pair])).values(),
];

const assertDeclared = (pair: Pair): void => {
  const declared = VFS_CAPABILITIES[pair.vfs]?.builds as
    | readonly SQLiteBuild[]
    | undefined;
  if (!declared?.includes(pair.build)) {
    throw new Error(
      `PLAN_PAIR: ${pairKey(pair)} is not a declared vfs/build pair (VFS_CAPABILITIES)`,
    );
  }
};

export const plan = (
  families: readonly FamilyInput[],
  options: PlanOptions,
): Plan => {
  if (Array.isArray(options.pairs)) options.pairs.forEach(assertDeclared);
  // Dead and not-applicable mean something only when every pair was a candidate.
  const complete = options.mode === 'complement' || !Array.isArray(options.pairs);
  const cells = new Map<
    string,
    Family & Pair & { project: string; reason: Cell['reason']; tests: CellTest[] }
  >();
  const notApplicable: Unplaced[] = [];
  const notRunnable: (Family & Pair)[] = [];
  const seen = new Map<string, { test: CollectedTest; placed: boolean }>();

  for (const family of families) {
    const features = new Set(family.features);
    const context = (pair: Pair): TestContext => ({
      ...pair,
      browser: family.browser,
      isolated: family.isolated,
      features,
    });
    const canonical: Pair[] = canonicalPairs(
      family.browser,
      family.isolated,
      features,
    ).map(({ vfs, build }) => ({ vfs, build }));
    const explicit = Array.isArray(options.pairs)
      ? options.pairs.filter((pair) => {
          if (runsIn(context(pair))) return true;
          notRunnable.push({ ...family, ...pair });
          return false;
        })
      : null;
    const starts: Pair[] =
      explicit ??
      (options.mode === 'all-pairs' || options.pairs === 'all'
        ? canonical
        : uniquePairs(
            options.recommended.map((vfs) => ({
              vfs,
              build: defaultBuildFor(vfs, features),
            })),
          ).filter((pair) => runsIn(context(pair))));
    const runs = (pair: Pair, need: TestNeed) =>
      shouldTestRun(context(pair), need, {
        dedupeIsolation: !options.fullIsolation,
      });
    const add = (pair: Pair, reason: Cell['reason'], test: CollectedTest) => {
      const project = projectName(family, pair);
      let cell = cells.get(project);
      if (cell === undefined) {
        cell = { ...family, ...pair, project, reason, tests: [] };
        cells.set(project, cell);
      }
      cell.tests.push({ file: test.file, position: test.position, name: test.name });
    };

    for (const test of family.tests) {
      if (test.dynamic) {
        throw new Error(
          `PLAN_DYNAMIC: "${test.name}" (${test.file}) is declared dynamically, so its id is unknown before it runs — declare it with a literal name`,
        );
      }
      const key = `${test.file}#${test.position}`;
      const entry = seen.get(key) ?? { test, placed: false };
      seen.set(key, entry);
      const { standalone, need } = needFromTags(test.tags);
      let placed = false;
      if (standalone) {
        // Once per browser, non-isolated, outside the matrix (spec § 3).
        if (options.mode === 'all-pairs' || family.isolated) {
          entry.placed = true;
          continue;
        }
        const host = starts[0] ?? canonical[0];
        if (host && representative(need, family.browser, features)) {
          add(host, starts[0] ? 'start' : 'complement', test);
          placed = true;
        }
      } else if (options.mode === 'all-pairs') {
        for (const pair of starts) {
          if (runs(pair, need)) {
            add(pair, 'pair', test);
            placed = true;
          }
        }
      } else {
        for (const pair of starts) {
          if (runs(pair, need)) {
            add(pair, 'start', test);
            placed = true;
          }
        }
        if (!placed) {
          const first = canonical.find((pair) => runs(pair, need));
          if (first) {
            add(first, 'complement', test);
            placed = true;
          }
        }
      }
      if (placed) entry.placed = true;
      else if (complete) {
        notApplicable.push({ ...family, file: test.file, name: test.name, tags: test.tags });
      }
    }
  }

  const dead = complete
    ? [...seen.values()]
        .filter(({ placed }) => !placed)
        .map(({ test: { file, name, tags } }) => ({ file, name, tags }))
    : [];
  // A test not applicable on one browser and placed on the other is reported
  // there; one placed nowhere is dead, and listed once, as dead.
  const deadKeys = new Set(dead.map(({ file, name }) => `${file}#${name}`));
  return {
    cells: [...cells.values()].map((cell) => ({
      ...cell,
      tests: [...cell.tests].sort((a, b) =>
        a.file === b.file ? a.position - b.position : a.file < b.file ? -1 : 1,
      ),
    })),
    notApplicable: notApplicable.filter(
      ({ file, name }) => !deadKeys.has(`${file}#${name}`),
    ),
    dead,
    notRunnable,
  };
};
```

- [ ] **Step 4: Run to see them pass**

```bash
pnpm exec biome check --write tests/planner/plan.ts tests/unit/plan.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/plan.test.ts
```
Expected: all pass. A layout expectation that fails names the cell: re-derive it from `VFS_CAPABILITIES` and the features by hand before touching either side.

- [ ] **Step 5: Commit**

```bash
git add tests/planner/plan.ts tests/unit/plan.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: the planner that decides which cell runs which test

Pure, from each test's tags, the probed features and the pairs: start
pairs run what they can, every other test runs once per browser on its
first canonical pair, isolated cells keep what isolation changes, and
nothing is launched empty. A test the parser cannot name is refused,
since its id would select another test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: the guard in every target project; the isolated files tagged

**Files:**
- Create: `tests/planner/guard.ts`, `tests/unit/guard.test.ts`, `tests/browser/need-guard.ts`
- Modify: `tests/vitest.d.ts`, `vitest.config.ts`
- Modify: `tests/browser/isolated/abort-slot.test.ts`, `tests/browser/isolated/tx-savepoint.test.ts`, `tests/browser/isolated/environment.test.ts`

**Interfaces:**
- Consumes: `needFromTags`, `shouldTestRun` (Task 1).
- Produces: `type Planned = { readonly tests: Readonly<Record<string, string>>; readonly features: readonly PlatformFeature[]; readonly fullIsolation: boolean; readonly target: { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild } }` — what `scripts/run-cell.ts` provides as `bsqPlanned` (Task 5); `guardVerdict(input): Verdict`; `featureDifference(planned, here): string | null`; the provided key `bsqEnvironment: { browser: BrowserName; isolated: boolean }`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PlatformFeature } from '../../src/const/platform';
import { featureDifference, type GuardInput, guardVerdict } from '../planner/guard';

const CHROME = new Set<PlatformFeature>(['jspi', 'opfs', 'sync-access-handle', 'web-locks', 'writable-stream', 'indexeddb', 'readwrite-unsafe']);
const base: GuardInput = {
  tags: [],
  id: 'f_0_0',
  name: 'a > b',
  vfs: 'OPFSWriteAheadVFS',
  build: 'sync',
  browser: 'chrome',
  isolated: false,
  features: CHROME,
  planned: undefined,
};
const planned = { tests: { f_0_0: 'a > b' }, features: [...CHROME], fullIsolation: false, target: { vfs: 'OPFSWriteAheadVFS', build: 'sync' } } as const;

describe('outside a plan (a project run directly)', () => {
  it('runs an eligible test', () => {
    expect(guardVerdict(base)).toEqual({ kind: 'run' });
  });

  // Falsifiable: return run whatever the need.
  it('skips an ineligible one, saying what it needs', () => {
    const verdict = guardVerdict({ ...base, tags: ['vfs:IDBBatchAtomicVFS'] });
    expect(verdict.kind).toBe('skip');
    expect(verdict.kind === 'skip' && verdict.reason).toContain('vfs:IDBBatchAtomicVFS');
  });

  it('runs a standalone test wherever it lands', () => {
    expect(guardVerdict({ ...base, tags: ['standalone', 'excludes:shared-storage'] })).toEqual({ kind: 'run' });
  });

  it('lets a misspelt tag fail the test', () => {
    expect(() => guardVerdict({ ...base, tags: ['requires:two-worker'] })).toThrow(/NEED_TAG/);
  });
});

describe('inside a plan (a cell)', () => {
  it('runs a planned, eligible test', () => {
    expect(guardVerdict({ ...base, planned })).toEqual({ kind: 'run' });
  });

  // Falsifiable: drop the name comparison — a shifted id would run another test silently.
  it('fails a test whose runtime name is not the planned one', () => {
    const verdict = guardVerdict({ ...base, name: 'a > c', planned });
    expect(verdict.kind).toBe('fail');
    expect(verdict.kind === 'fail' && verdict.reason).toMatch(/PLAN_GUARD.*dynamically/);
  });

  it('reads the parser escapes of a planned name', () => {
    const escaped = { ...planned, tests: { f_0_0: 'a > says \\"closed\\"' } };
    expect(guardVerdict({ ...base, name: 'a > says "closed"', planned: escaped })).toEqual({ kind: 'run' });
  });

  it('fails a planned test whose tags do not run on this pair', () => {
    const verdict = guardVerdict({ ...base, tags: ['vfs:MemoryVFS'], planned });
    expect(verdict.kind).toBe('fail');
  });

  it('fails a test that ran without being planned', () => {
    expect(guardVerdict({ ...base, id: 'f_0_9', planned }).kind).toBe('fail');
  });

  it('fails when the cell is not on the planned pair', () => {
    expect(guardVerdict({ ...base, vfs: 'OPFSAdaptiveVFS', build: 'jspi', planned }).kind).toBe('fail');
  });

  it('runs a test isolation changes nothing for when the mode was asked for in full', () => {
    const full = { ...planned, fullIsolation: true };
    expect(guardVerdict({ ...base, isolated: true, features: new Set([...CHROME, 'cross-origin-isolated']), planned: full })).toEqual({ kind: 'run' });
  });
});

describe('featureDifference', () => {
  it('names what the probe saw and this page does not, and the reverse', () => {
    expect(featureDifference(['jspi', 'opfs'], new Set<PlatformFeature>(['jspi', 'indexeddb']))).toBe('planned for [opfs], missing here; here [indexeddb], not planned');
    expect(featureDifference(['jspi'], new Set<PlatformFeature>(['jspi']))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/guard.test.ts
```
Expected: FAIL — `Cannot find module '../planner/guard'`.

- [ ] **Step 3: Implement the pure guard** — `tests/planner/guard.ts`:

```ts
import type { BrowserName } from '../../scripts/browsers.ts';
import type { SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import type { SQLiteVFS } from '../../src/const/vfs';
import { needFromTags, shouldTestRun } from '../need';

/** What a cell's process provides as `bsqPlanned` (scripts/run-cell.ts). */
export type Planned = {
  /** Planned test ids, each with the name the parser gave it. */
  readonly tests: Readonly<Record<string, string>>;
  readonly features: readonly PlatformFeature[];
  readonly fullIsolation: boolean;
  readonly target: { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild };
};

export type GuardInput = {
  readonly tags: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly vfs: SQLiteVFS;
  readonly build: SQLiteBuild;
  readonly browser: BrowserName;
  readonly isolated: boolean;
  readonly features: ReadonlySet<PlatformFeature>;
  readonly planned: Planned | undefined;
};

export type Verdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string };

/** The static parser keeps a literal's escapes (`\"`); the runtime name does not. */
const unescapeName = (name: string) => name.replace(/\\(["'`\\])/g, '$1');

/**
 * Whether the running test may run here (spec § 4.6). Throws NEED_TAG on a
 * tag outside the vocabulary, which fails the test by name.
 */
export const guardVerdict = (input: GuardInput): Verdict => {
  const { standalone, need } = needFromTags(input.tags);
  const pair = `${input.vfs}/${input.build}${input.isolated ? ' isolated' : ''}`;
  const eligible =
    standalone ||
    shouldTestRun(
      {
        vfs: input.vfs,
        build: input.build,
        browser: input.browser,
        isolated: input.isolated,
        features: input.features,
      },
      need,
      { dedupeIsolation: !(input.planned?.fullIsolation ?? false) },
    );
  const { planned } = input;
  if (planned === undefined) {
    return eligible
      ? { kind: 'run' }
      : { kind: 'skip', reason: `not eligible on ${pair}: needs [${input.tags.join(', ')}]` };
  }
  if (planned.target.vfs !== input.vfs || planned.target.build !== input.build) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: this cell runs ${input.vfs}/${input.build}, planned ${planned.target.vfs}/${planned.target.build}`,
    };
  }
  const plannedName = planned.tests[input.id];
  if (plannedName === undefined) {
    return { kind: 'fail', reason: `PLAN_GUARD: "${input.name}" ran outside the plan` };
  }
  if (unescapeName(plannedName) !== input.name) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: id ${input.id} was planned as "${plannedName}" and ran as "${input.name}" — the file declares tests dynamically`,
    };
  }
  if (!eligible) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: "${input.name}" is planned on ${pair}, where its tags [${input.tags.join(', ')}] do not run`,
    };
  }
  return { kind: 'run' };
};

/** Null when this page has exactly the planned features; otherwise both differences. */
export const featureDifference = (
  planned: readonly PlatformFeature[],
  here: ReadonlySet<PlatformFeature>,
): string | null => {
  const missing = planned.filter((feature) => !here.has(feature));
  const extra = [...here].filter((feature) => !planned.includes(feature));
  if (missing.length === 0 && extra.length === 0) return null;
  return `planned for [${missing.join(', ')}], missing here; here [${extra.join(', ')}], not planned`;
};
```

Run Step 2's command again. Expected: all pass.

- [ ] **Step 4: The provided keys** — `tests/vitest.d.ts` becomes:

```ts
import type { BrowserName } from '../scripts/browsers';
import type { PlatformFeature } from '../src/const/platform';
import type { OnUnmetNeed, TestTarget } from './browser/target';
import type { Planned } from './planner/guard';

declare module 'vitest' {
  export interface ProvidedContext {
    bsqTarget: TestTarget;
    bsqNeeds: OnUnmetNeed;
    /** The family of this project: which browser, isolated or not. */
    bsqEnvironment: { browser: BrowserName; isolated: boolean };
    /** Set by a planned cell (scripts/run-cell.ts); absent in a direct run. */
    bsqPlanned?: Planned;
  }
  export interface TaskMeta {
    /** What tests/probe/features.test.ts found in its environment. */
    features?: PlatformFeature[];
  }
}
```

- [ ] **Step 5: The setup file** — `tests/browser/need-guard.ts`:

```ts
import { beforeAll, beforeEach, inject } from 'vitest';
import { AVAILABLE_FEATURES } from '../conformance/helpers';
import { featureDifference, guardVerdict } from '../planner/guard';
import { TEST_TARGET } from './helpers';

/**
 * Every target project's guard (spec § 4.6). In a planned cell it fails, by
 * name, a test that runs against the plan and a page whose features differ
 * from the probe's; in a project run directly it skips the tests its pair
 * cannot run, saying what they need.
 */
const environment = inject('bsqEnvironment');
const planned = inject('bsqPlanned');

beforeAll(() => {
  if (planned === undefined) return;
  const difference = featureDifference(planned.features, AVAILABLE_FEATURES);
  if (difference !== null) throw new Error(`PLAN_FEATURES: ${difference}`);
});

beforeEach(({ task, skip }) => {
  const verdict = guardVerdict({
    tags: task.tags ?? [],
    id: task.id,
    name: task.fullName,
    vfs: TEST_TARGET.vfs,
    build: TEST_TARGET.build,
    browser: environment.browser,
    isolated: environment.isolated,
    features: AVAILABLE_FEATURES,
    planned,
  });
  if (verdict.kind === 'skip') skip(verdict.reason);
  if (verdict.kind === 'fail') throw new Error(verdict.reason);
});
```

- [ ] **Step 6: Wire it** — `vitest.config.ts`:

1. In `browserProject`, replace the `setupFiles` and `provide` lines with:

```ts
    // The guard reads the project's target, so only target projects take it.
    setupFiles: [
      'tests/storage-wipe.ts',
      ...(options.target ? ['tests/browser/need-guard.ts'] : []),
    ],
```
```ts
    ...(options.target
      ? {
          provide: {
            bsqTarget: options.target,
            bsqNeeds: onUnmet,
            bsqEnvironment: { browser, isolated: options.isolated === true },
          },
        }
      : {}),
```

2. Nothing else changes in the projects: the `isolated/` files carry their tags from Step 7.

- [ ] **Step 7: Tag the isolated files.** Each of these `describe` calls gains `{ tags: ['vfs:OPFSWriteAheadVFS', 'build:sync', 'isolated'] }` as its second argument — the pair every test in them pins today:
  - `tests/browser/isolated/abort-slot.test.ts`: `describe('the sync build, isolated', …)` and `describe('statement cache, sync build isolated', …)`;
  - `tests/browser/isolated/tx-savepoint.test.ts`: `describe('a savepointed write on the sync isolated build (spec 2026-09-11)', …)`;
  - `tests/browser/isolated/environment.test.ts`: `describe('the isolated project', …)`.

  For example: `describe('the sync build, isolated', { tags: ['vfs:OPFSWriteAheadVFS', 'build:sync', 'isolated'] }, () => {`.

- [ ] **Step 8: Run the direct projects**

```bash
pnpm exec biome check --write tests/planner/guard.ts tests/unit/guard.test.ts tests/browser/need-guard.ts tests/vitest.d.ts vitest.config.ts tests/browser/isolated
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/guard.test.ts
pnpm exec vitest run --configLoader runner --project 'isolated chrome ·*' --project 'isolated firefox ·*' > "$WS/t3-isolated.log" 2>&1; grep -E "Test Files|Tests |skipped" "$WS/t3-isolated.log" | tail -5
```
Expected: unit green. Isolated: on `isolated * · OPFSWriteAheadVFS/sync` every test passes; on `isolated * · OPFSAdaptiveVFS/jspi` every test is skipped with `not eligible on OPFSAdaptiveVFS/jspi isolated: needs [vfs:OPFSWriteAheadVFS, build:sync, isolated]` (today they ran there, pinned to the same pair — identical repetitions). Then the whole suite, in the background with progress lines:

```bash
pnpm test > "$WS/t3-test.log" 2>&1
```
Expected: green; the total is the previous one (2680 passed) minus the isolated tests no longer repeated on the Adaptive projects, which now count as skipped.

- [ ] **Step 9: Commit**

```bash
git add tests/planner/guard.ts tests/unit/guard.test.ts tests/browser/need-guard.ts tests/vitest.d.ts vitest.config.ts tests/browser/isolated
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: a guard in every target project, and the isolated files tagged

Run directly, a project now skips the tests its pair cannot run and says
what they need; in a planned cell the guard will fail a test that runs
against the plan. The isolated files carry the pair their bodies pin, so
they run in one isolated project per browser instead of every one.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: the feature probe projects

**Files:**
- Create: `tests/probe/features.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: projects `probe chrome`, `probe firefox`, `probe isolated chrome`, `probe isolated firefox`; each runs one test whose `meta().features` is that environment's sorted `AVAILABLE_FEATURES` (Task 5 reads it).

- [ ] **Step 1: The probe** — `tests/probe/features.test.ts`:

```ts
import { it } from 'vitest';
import { AVAILABLE_FEATURES } from '../conformance/helpers';

// The planner's view of this environment (spec § 4.2): the library's own
// detectFeatures plus the worker probe for sync access handles and
// readwrite-unsafe, read back from this test's meta by scripts/plan-io.ts.
it('records the features of this environment', ({ task }) => {
  task.meta.features = [...AVAILABLE_FEATURES].sort();
});
```

- [ ] **Step 2: The projects** — `vitest.config.ts`: in the `unit` project's `exclude`, add `'tests/probe/**'`; in `projects`, after the conformance projects:

```ts
      // One probe per environment the planner can select (spec § 4.2).
      ...ENGINES.flatMap((browser) =>
        [false, true].map((isolated) =>
          browserProject(
            `probe ${isolated ? 'isolated ' : ''}${browser}`,
            browser,
            ['tests/probe/features.test.ts'],
            { isolated, testTimeout: 30_000 },
          ),
        ),
      ),
```

- [ ] **Step 3: Run it**

```bash
pnpm exec biome check --write tests/probe/features.test.ts vitest.config.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project 'probe *'
pnpm test:unit
```
Expected: 4 passed (one per probe project); `unit` unchanged (the probe is not in it).

- [ ] **Step 4: Commit**

```bash
git add tests/probe/features.test.ts vitest.config.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: one feature probe per environment the planner selects

The planner decides with the features each browser actually has,
isolated or not, read from a test's meta rather than from a static table
(spec 2026-10-12, D5).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Vitest's Node API around the planner; one process per cell

**Files:**
- Create: `scripts/plan-io.ts`, `scripts/run-cell.ts`

**Interfaces:**
- Consumes: `Family`, `familyName`, `Cell`, `CollectedTest` (Task 2, types only); `Planned` (Task 3, type only); the probe projects (Task 4).
- Produces:
  - `openVitest(options?: { readonly projects?: readonly string[]; readonly blob?: string; readonly json?: string }): Promise<Vitest>`
  - `projectNamed(vitest, name): TestProject`
  - `loadPlanner(vitest): Promise<typeof import('../tests/planner/plan.ts')>`
  - `probeFeatures(vitest, family): Promise<PlatformFeature[]>`
  - `collectFamily(vitest, family, files: readonly string[] | null): Promise<CollectedTest[]>`
  - `type CellSpec = { readonly file: string; readonly tests: readonly { readonly id: string; readonly name: string }[] }`, `cellSpecs(vitest, cell): Promise<CellSpec[]>`
  - `type PlannedCell = Pick<Cell, 'project' | 'vfs' | 'build'> & { readonly features: readonly PlatformFeature[]; readonly specs: readonly CellSpec[] }`, `type PlannedRun = { readonly fullIsolation: boolean; readonly cells: readonly PlannedCell[] }` — the plan file `run-cell.ts` reads
  - CLI: `node scripts/run-cell.ts <plan.json> <cell index> <shard> <shards> <blob file> <json file>`

- [ ] **Step 1: `scripts/plan-io.ts`**

```ts
import { relative, resolve } from 'node:path';
import {
  createVitest,
  experimental_getRunnerTask,
  type TestProject,
  type Vitest,
} from 'vitest/node';
import type { PlatformFeature } from '../src/const/platform.ts';
import type {
  Cell,
  CollectedTest,
  Family,
} from '../tests/planner/plan.ts';
import { ROOT } from './parallel.ts';

/**
 * The planner's side of Vitest's Node API (spec 2026-10-12, § 4; measured
 * in mem:measurements/suite-and-matrix § TEST-IDS). A plain `node` script
 * cannot import tests/planner/plan.ts — its src/ imports carry no
 * extension — so the planner is loaded through Vite (`loadPlanner`).
 */

export async function openVitest({
  projects,
  blob,
  json,
}: {
  readonly projects?: readonly string[];
  readonly blob?: string;
  readonly json?: string;
} = {}): Promise<Vitest> {
  // Every pair's projects exist, whatever the caller asked for: the plan
  // picks among them (vitest.config.ts reads this when it loads).
  process.env.BSQ_TEST_TARGETS = 'all';
  process.env.BSQ_TEST_BUILT = '1';
  const reporters = [...(blob ? ['blob'] : []), ...(json ? ['json'] : [])];
  const vitest = await createVitest('test', {
    config: resolve(ROOT, 'vitest.config.ts'),
    configLoader: 'runner',
    watch: false,
    reporters,
    ...(projects ? { project: [...projects] } : {}),
    ...(blob || json
      ? {
          outputFile: {
            ...(blob ? { blob } : {}),
            ...(json ? { json } : {}),
          },
        }
      : {}),
  });
  // Without it the reporters are never initialised: the blob reporter then
  // throws at the end of the run (measured 2026-10-12).
  await vitest.standalone();
  return vitest;
}

export const projectNamed = (vitest: Vitest, name: string): TestProject => {
  const project = vitest.projects.find((p) => p.name === name);
  if (project === undefined) {
    throw new Error(
      `PLAN_PROJECT: vitest.config.ts declares no project "${name}"`,
    );
  }
  return project;
};

export const loadPlanner = (vitest: Vitest) =>
  projectNamed(vitest, 'unit').import<
    typeof import('../tests/planner/plan.ts')
  >(resolve(ROOT, 'tests/planner/plan.ts'));

/** The family's probe project's view of its environment (tests/probe/features.test.ts). */
export async function probeFeatures(
  vitest: Vitest,
  family: Family,
): Promise<PlatformFeature[]> {
  const name = `probe ${family.isolated ? 'isolated ' : ''}${family.browser}`;
  const project = projectNamed(vitest, name);
  const result = await vitest.runTestSpecifications([
    project.createSpecification(resolve(ROOT, 'tests/probe/features.test.ts')),
  ]);
  const [test] = result.testModules.flatMap((m) => [...m.children.allTests()]);
  const features = test?.meta().features;
  if (!Array.isArray(features)) {
    throw new Error(
      `PLAN_PROBE: ${name} reported no features (${test?.result().state ?? 'no test'})`,
    );
  }
  return features;
}

/** Any project of the family: they share their files and how they parse. */
const referenceProject = (vitest: Vitest, family: Family): TestProject => {
  const prefix = `${family.isolated ? 'isolated ' : ''}${family.browser} · `;
  const project = vitest.projects.find((p) => p.name.startsWith(prefix));
  if (project === undefined) {
    throw new Error(`PLAN_PROJECT: no "${prefix}…" project`);
  }
  return project;
};

/** Every test of the family's files (or of `files`), with its tags, by static parsing. */
export async function collectFamily(
  vitest: Vitest,
  family: Family,
  files: readonly string[] | null,
): Promise<CollectedTest[]> {
  const project = referenceProject(vitest, family);
  const wanted = files?.map((file) => resolve(ROOT, file));
  const testFiles = (await project.globTestFiles()).testFiles.filter(
    (file) => wanted === undefined || wanted.includes(file),
  );
  const modules = await vitest.parseSpecifications(
    testFiles.map((file) => project.createSpecification(file)),
  );
  return modules.flatMap((module) =>
    [...module.children.allTests()].map((test, position) => ({
      file: relative(ROOT, module.moduleId),
      position,
      name: test.fullName,
      tags: [...test.tags],
      dynamic: experimental_getRunnerTask(test).dynamic === true,
    })),
  );
}

export type CellSpec = {
  readonly file: string;
  readonly tests: readonly { readonly id: string; readonly name: string }[];
};

/**
 * The cell's tests as ids of the cell's own project: ids hash the project
 * name, so they are parsed there, and found by position, name checked.
 */
export async function cellSpecs(
  vitest: Vitest,
  cell: Cell,
): Promise<CellSpec[]> {
  const project = projectNamed(vitest, cell.project);
  const files = [...new Set(cell.tests.map((t) => t.file))];
  const modules = await vitest.parseSpecifications(
    files.map((file) => project.createSpecification(resolve(ROOT, file))),
  );
  return files.map((file) => {
    const module = modules.find((m) => m.moduleId === resolve(ROOT, file));
    const parsed = module ? [...module.children.allTests()] : [];
    return {
      file,
      tests: cell.tests
        .filter((t) => t.file === file)
        .map((t) => {
          const test = parsed[t.position];
          if (test === undefined || test.fullName !== t.name) {
            throw new Error(
              `PLAN_ID: ${cell.project} parses "${test?.fullName}" at position ${t.position} of ${file}, the plan has "${t.name}"`,
            );
          }
          return { id: test.id, name: test.fullName };
        }),
    };
  });
}

export type PlannedCell = Pick<Cell, 'project' | 'vfs' | 'build'> & {
  readonly features: readonly PlatformFeature[];
  readonly specs: readonly CellSpec[];
};

export type PlannedRun = {
  readonly fullIsolation: boolean;
  readonly cells: readonly PlannedCell[];
};
```

If `tsc` refuses `reporters` or `outputFile` in `createVitest`'s options (its type is the CLI's), cast only that object literal with `as Parameters<typeof createVitest>[1]` and say so in the ledger.

- [ ] **Step 2: `scripts/run-cell.ts`**

```ts
#!/usr/bin/env node
/**
 * One planned cell, or one shard of it, as one process:
 *
 *   node scripts/run-cell.ts <plan.json> <cell index> <shard> <shards> <blob> <json>
 *
 * Its own process, as every Vitest run here: each has its own WebDriver
 * session, so its own browser profile (scripts/test-parallel.ts). The cell's
 * tests are given by id, which the CLI cannot do, hence the Node API.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Planned } from '../tests/planner/guard.ts';
import { ROOT } from './parallel.ts';
import { openVitest, type PlannedRun, projectNamed } from './plan-io.ts';

const [planFile, index, shard, shards, blob, json] = process.argv.slice(2);
if (json === undefined) {
  throw new Error(
    'usage: node scripts/run-cell.ts <plan.json> <cell index> <shard> <shards> <blob> <json>',
  );
}
const run = JSON.parse(readFileSync(planFile as string, 'utf8')) as PlannedRun;
const cell = run.cells[Number(index)];
if (cell === undefined) throw new Error(`run-cell: no cell ${index}`);
// Files go round-robin to the shards: each shard keeps whole files.
const specs = cell.specs.filter(
  (_, i) => i % Number(shards) === Number(shard) - 1,
);

const vitest = await openVitest({ projects: [cell.project], blob, json });
const project = projectNamed(vitest, cell.project);
const planned: Planned = {
  tests: Object.fromEntries(
    specs.flatMap((s) => s.tests.map((t) => [t.id, t.name] as const)),
  ),
  features: cell.features,
  fullIsolation: run.fullIsolation,
  target: { vfs: cell.vfs, build: cell.build },
};
project.provide('bsqPlanned', planned);
const result = await vitest.runTestSpecifications(
  specs.map((s) =>
    project.createSpecification(resolve(ROOT, s.file), {
      testIds: s.tests.map((t) => t.id),
    }),
  ),
);
const failed =
  result.unhandledErrors.length > 0 ||
  result.testModules.some((m) => !m.ok());
await vitest.close();
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 3: Prove both on one hand-made plan** — a throwaway script in `.scratchpad/plan-b/` (not committed) that opens Vitest, loads the planner, probes `chrome`, collects `tests/browser/realm.test.ts`, plans it in complement mode, resolves the cell specs and writes a `PlannedRun`, then runs the first cell:

```bash
mkdir -p .scratchpad/plan-b && cat > .scratchpad/plan-b/smoke.ts <<'EOF'
import { writeFileSync } from 'node:fs';
import { RECOMMENDED_VFS } from '../../scripts/recommended-vfs.ts';
import { cellSpecs, collectFamily, loadPlanner, openVitest, probeFeatures } from '../../scripts/plan-io.ts';
const vitest = await openVitest();
const planner = await loadPlanner(vitest);
const family = { browser: 'chrome', isolated: false } as const;
const features = await probeFeatures(vitest, family);
const tests = await collectFamily(vitest, family, ['tests/browser/realm.test.ts']);
const p = planner.plan([{ ...family, features, tests }], { mode: 'complement', fullIsolation: false, recommended: RECOMMENDED_VFS, pairs: null });
const cells = [];
for (const cell of p.cells) cells.push({ project: cell.project, vfs: cell.vfs, build: cell.build, features, specs: await cellSpecs(vitest, cell) });
await vitest.close();
writeFileSync('.scratchpad/plan-b/plan.json', JSON.stringify({ fullIsolation: false, cells }, null, 2));
console.log(features.join(','), p.cells.map((c) => `${c.project}: ${c.tests.length}`).join(' | '));
EOF
node .scratchpad/plan-b/smoke.ts
node scripts/run-cell.ts .scratchpad/plan-b/plan.json 0 1 1 .scratchpad/plan-b/cell.blob.json .scratchpad/plan-b/cell.json; echo "exit $?"
node -e "const r=require('./.scratchpad/plan-b/cell.json'); console.log(r.numPassedTests, r.numFailedTests, r.numPendingTests)"
```
Expected: the features line lists `indexeddb`, `jspi`, `opfs`, `readwrite-unsafe`, … (no `cross-origin-isolated`); two cells (`chrome · OPFSWriteAheadVFS/sync`, `chrome · OPFSAdaptiveVFS/jspi`) with realm's tests; `exit 0`; the JSON report counts realm's tests as passed and none failed. Then edit `plan.json` by hand to rename one test's `name` and run the cell again: expected `exit 1`, the report naming `PLAN_GUARD: … the file declares tests dynamically`.

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write scripts/plan-io.ts scripts/run-cell.ts
pnpm exec tsc --noEmit
git add scripts/plan-io.ts scripts/run-cell.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: the planner's Vitest side, and a process per planned cell

Probes, static collection and a cell's ids go through Vitest's Node API,
with the planner loaded through Vite since src/ imports carry no
extension. A cell runs its exact tests by id and tells its guard what was
planned, which the CLI cannot do.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: the orchestrator

**Files:**
- Create: `scripts/test-plan.ts`
- Modify: `scripts/test-matrix.ts` (export `printTable`; `formatCell` takes `undefined`)
- Modify: `tests/unit/test-matrix.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5; `parallel.ts` (`buildOnce`, `killLiveOnSignal`, `resolveConcurrency`, `allocateShards`, `runPool`, `runBounded`, `findFailedJobs`, `ROOT`); `test-matrix.ts` (`parseMatrixReport`, `printTable`, `MatrixResult`).
- Produces: `node scripts/test-plan.ts [--unit] [--browser <chrome|firefox>]… [--modes <not-isolated,isolated>] [--full] [--mode <complement|all-pairs>] [--pair <vfs/build>]… [--table] [file…]`. Defaults: both browsers, both modes, complement, no unit. Exit 1 on a failed job, a red merge, a dead test in all-pairs over every pair, or an explicit pair no selected browser runs.

- [ ] **Step 1: `formatCell` takes an absent cell — failing test.** In `tests/unit/test-matrix.test.ts`, inside the `describe` that tests `formatCell`:

```ts
  // An empty cell is never launched (spec § 4.5): the table shows it as such.
  it('shows a cell the plan did not launch as a dash', () => {
    expect(formatCell(undefined)).toBe('—');
  });
```
Run `pnpm exec vitest run --configLoader runner --project unit tests/unit/test-matrix.test.ts`. Expected: FAIL (a `TypeError` on `undefined.status`, or a type error under `tsc`).

- [ ] **Step 2: Implement** — in `scripts/test-matrix.ts`: `formatCell(result: MatrixResult | undefined)` returns `'—'` first when `result === undefined`; `printTable` gains `export` and passes `results.get(…)` without the `as MatrixResult` cast. Run Step 1's command: pass.

- [ ] **Step 3: `scripts/test-plan.ts`**

```ts
#!/usr/bin/env node
/**
 * The browser suite through the planner (spec 2026-10-12, § 4-5):
 *
 *   node scripts/test-plan.ts [--unit] [--browser chrome|firefox]…
 *     [--modes not-isolated,isolated] [--full] [--mode complement|all-pairs]
 *     [--pair vfs/build]… [--table] [file…]
 *
 * Probes each selected environment, parses the tests statically, plans
 * which cell runs which test, prints the plan, runs the cells
 * (`scripts/run-cell.ts`, `BSQ_TEST_JOBS` at a time, a cell cut in shards
 * by files when there are more processes than cells) and `unit`, then
 * merges their blobs as one report. `--table` prints the matrix table
 * instead and keeps each cell's JSON report under `.matrix/<run>/` for
 * `scripts/matrix-triage.ts`. `BSQ_TEST_TARGETS` and `--pair` give the
 * pairs, never substituted.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { SQLiteBuild } from '../src/const/builds.ts';
import type { SQLiteVFS } from '../src/const/vfs.ts';
import type { Family, FamilyInput, Pair, Plan } from '../tests/planner/plan.ts';
import type { BrowserName } from './browsers.ts';
import {
  allocateShards,
  type BlobState,
  buildOnce,
  findFailedJobs,
  killLiveOnSignal,
  ROOT,
  resolveConcurrency,
  runBounded,
  runPool,
} from './parallel.ts';
import {
  cellSpecs,
  collectFamily,
  loadPlanner,
  openVitest,
  type PlannedCell,
  type PlannedRun,
  probeFeatures,
} from './plan-io.ts';
import { RECOMMENDED_VFS } from './recommended-vfs.ts';
import { type MatrixResult, parseMatrixReport, printTable } from './test-matrix.ts';

const JOB_TIMEOUT_MS = 900_000;
const KEEP_RUNS = 10;
const TAIL_LINES = 60;

type Options = {
  unit: boolean;
  browsers: BrowserName[];
  isolatedModes: boolean[];
  full: boolean;
  mode: 'complement' | 'all-pairs';
  pairs: Pair[] | 'all' | null;
  table: boolean;
  /** Also write the merged report as Vitest JSON there (the coverage comparison of Task 12). */
  json: string | null;
  files: string[] | null;
};

const parsePair = (label: string): Pair => {
  const [vfs, build] = label.split('/');
  if (!vfs || !build) throw new Error(`test-plan: "${label}" is not vfs/build`);
  // Validated against the declarations by the planner (PLAN_PAIR).
  return { vfs: vfs as SQLiteVFS, build: build as SQLiteBuild };
};

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    unit: false,
    browsers: [],
    isolatedModes: [false, true],
    full: false,
    mode: 'complement',
    pairs: null,
    table: false,
    json: null,
    files: null,
  };
  const pairs: Pair[] = [];
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (arg === '--unit') options.unit = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--table') options.table = true;
    else if (arg === '--json') options.json = String(argv[++i]);
    else if (arg === '--browser') {
      const browser = argv[++i];
      if (browser !== 'chrome' && browser !== 'firefox') {
        throw new Error(`test-plan: --browser "${browser}" is not chrome or firefox`);
      }
      options.browsers.push(browser);
    } else if (arg === '--modes') {
      const modes = String(argv[++i]).split(',');
      if (modes.some((m) => m !== 'not-isolated' && m !== 'isolated')) {
        throw new Error(`test-plan: --modes takes not-isolated and/or isolated`);
      }
      options.isolatedModes = [
        ...(modes.includes('not-isolated') ? [false] : []),
        ...(modes.includes('isolated') ? [true] : []),
      ];
    } else if (arg === '--mode') {
      const mode = argv[++i];
      if (mode !== 'complement' && mode !== 'all-pairs') {
        throw new Error(`test-plan: --mode "${mode}" is not complement or all-pairs`);
      }
      options.mode = mode;
    } else if (arg === '--pair') pairs.push(parsePair(String(argv[++i])));
    else if (arg.startsWith('--')) throw new Error(`test-plan: unknown argument "${arg}"`);
    else files.push(arg);
  }
  if (options.browsers.length === 0) options.browsers = ['chrome', 'firefox'];
  const env = process.env.BSQ_TEST_TARGETS;
  options.pairs = pairs.length
    ? pairs
    : env === 'all'
      ? 'all'
      : env
        ? env.split(',').map((label) => parsePair(label.trim()))
        : null;
  options.files = files.length ? files : null;
  return options;
}

const describeTest = ({ file, name }: { file: string; name: string }) =>
  `${name} (${file})`;

function printPlan(plan: Plan, families: readonly FamilyInput[]) {
  console.log(`Plan: ${plan.cells.length} cells.`);
  for (const cell of plan.cells) {
    const files = new Set(cell.tests.map((t) => t.file)).size;
    console.log(
      `  ${cell.project.padEnd(44)} ${cell.reason.padEnd(10)} ${cell.tests.length} tests, ${files} files`,
    );
  }
  for (const family of families) {
    const missing = plan.notApplicable.filter(
      (u) => u.browser === family.browser && u.isolated === family.isolated,
    );
    if (missing.length === 0) continue;
    console.log(
      `Not applicable on ${family.isolated ? 'isolated ' : ''}${family.browser} (${missing.length}):`,
    );
    for (const u of missing) console.log(`  ${describeTest(u)} — needs [${u.tags.join(', ')}]`);
  }
  for (const n of plan.notRunnable) {
    console.log(`Not runnable on ${n.isolated ? 'isolated ' : ''}${n.browser}: ${n.vfs}/${n.build}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const concurrency = resolveConcurrency(process.env.BSQ_TEST_JOBS);
  const env = { ...buildOnce(process.env), BSQ_TEST_TARGETS: 'all' };
  killLiveOnSignal();

  // --- Plan -------------------------------------------------------------
  const vitest = await openVitest();
  const planner = await loadPlanner(vitest);
  const families: FamilyInput[] = [];
  for (const browser of options.browsers) {
    for (const isolated of options.isolatedModes) {
      const family: Family = { browser, isolated };
      families.push({
        ...family,
        features: await probeFeatures(vitest, family),
        tests: await collectFamily(vitest, family, options.files),
      });
    }
  }
  const plan = planner.plan(families, {
    mode: options.mode,
    fullIsolation: options.full,
    recommended: RECOMMENDED_VFS,
    pairs: options.pairs,
  });
  const cells: PlannedCell[] = [];
  for (const cell of plan.cells) {
    const features = families.find(
      (f) => f.browser === cell.browser && f.isolated === cell.isolated,
    )?.features as PlannedCell['features'];
    cells.push({
      project: cell.project,
      vfs: cell.vfs,
      build: cell.build,
      features,
      specs: await cellSpecs(vitest, cell),
    });
  }
  await vitest.close();
  printPlan(plan, families);

  const allNotRunnable =
    Array.isArray(options.pairs) &&
    options.pairs.some((pair) =>
      families.every((f) =>
        plan.notRunnable.some(
          (n) => n.browser === f.browser && n.isolated === f.isolated && n.vfs === pair.vfs && n.build === pair.build,
        ),
      ),
    );
  if (allNotRunnable) {
    console.error('test-plan: an explicit pair runs on no selected browser (above)');
    process.exitCode = 1;
    return;
  }

  // --- Run --------------------------------------------------------------
  const runsRoot = join(ROOT, options.table ? '.matrix' : '.test-parallel');
  const run = join(runsRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const blobs = join(run, 'blobs');
  const logs = join(run, 'logs');
  const reports = options.table ? run : join(run, 'reports');
  for (const dir of [blobs, logs, reports]) mkdirSync(dir, { recursive: true });
  for (const old of readdirSync(runsRoot).sort().slice(0, -KEEP_RUNS)) {
    rmSync(join(runsRoot, old), { recursive: true, force: true });
  }
  const planFile = join(run, 'plan.json');
  const planned: PlannedRun = { fullIsolation: options.full, cells };
  writeFileSync(planFile, JSON.stringify(planned, null, 2));

  // The matrix keeps one report per cell; elsewhere a cell may be sharded.
  const shards = options.table
    ? cells.map(() => 1)
    : allocateShards(
        cells.map((c) => ({ name: c.project, files: c.specs.length })),
        concurrency,
      ).map((s) => s.shards);
  // `isolated chrome · OPFSWriteAheadVFS/sync` → `isolated-chrome__OPFSWriteAheadVFS__sync`,
  // the name scripts/matrix-triage.ts parses.
  const slug = (name: string) =>
    name.replace(/ · /g, '__').replace(/\//g, '__').replace(/ /g, '-');
  type Job = { id: string; cell: number | null; shard: number; shards: number };
  const jobs: Job[] = [
    ...(options.unit ? [{ id: 'unit', cell: null, shard: 1, shards: 1 }] : []),
    ...cells.flatMap((cell, index) =>
      Array.from({ length: shards[index] as number }, (_, s) => ({
        id: (shards[index] as number) > 1 ? `${slug(cell.project)}.${s + 1}of${shards[index]}` : slug(cell.project),
        cell: index,
        shard: s + 1,
        shards: shards[index] as number,
      })),
    ),
  ];
  console.log(`\n${jobs.length} jobs, ${concurrency} at a time. Run under ${relative(ROOT, run)}.`);

  const start = Date.now();
  let done = 0;
  const results = new Map<string, MatrixResult>();
  const settled = await runPool(jobs, concurrency, async (job) => {
    const blob = join(blobs, `${job.id}.json`);
    const json = join(reports, `${job.id}.json`);
    const began = Date.now();
    const { output, timedOut, exitCode, error } =
      job.cell === null
        ? await runBounded(
            'pnpm',
            ['exec', 'vitest', 'run', '--configLoader', 'runner', '--project', 'unit', '--reporter=blob', `--outputFile=${blob}`],
            { cwd: ROOT, env, timeoutMs: JOB_TIMEOUT_MS },
          )
        : await runBounded(
            'node',
            ['scripts/run-cell.ts', planFile, String(job.cell), String(job.shard), String(job.shards), blob, json],
            { cwd: ROOT, env, timeoutMs: JOB_TIMEOUT_MS },
          );
    writeFileSync(join(logs, `${job.id}.log`), error ? `${output}\n${error.message}\n` : output);
    let state: BlobState = existsSync(blob) ? 'ok' : 'missing';
    if (state === 'ok') {
      try {
        JSON.parse(readFileSync(blob, 'utf8'));
      } catch {
        state = 'unparsable';
        rmSync(blob);
      }
    }
    if (job.cell !== null && options.table) {
      const cell = cells[job.cell] as PlannedCell;
      results.set(
        cell.project,
        timedOut
          ? { status: 'timed-out' }
          : error
            ? { status: 'error', message: error.message }
            : parseMatrixReport(existsSync(json) ? readFileSync(json, 'utf8') : ''),
      );
    }
    const ended = timedOut ? 'timed out' : error ? `error ${error.message}` : `exit ${exitCode}`;
    console.log(`[${++done}/${jobs.length}] ${job.id}: ${ended} in ${Math.round((Date.now() - began) / 1000)}s${state === 'ok' ? '' : ' (NO BLOB)'}`);
    return { job, timedOut, error, blob: state, exitCode };
  });
  const outcomes = settled.map((o, i) =>
    o.status === 'fulfilled'
      ? o.value
      : { job: jobs[i] as Job, timedOut: false, error: o.reason instanceof Error ? o.reason : new Error(String(o.reason)), blob: 'missing' as BlobState, exitCode: null },
  );
  const failed = findFailedJobs(outcomes);
  console.log(`Jobs done in ${Math.round((Date.now() - start) / 1000)}s.\n`);

  let status = failed.length > 0 || outcomes.some((o) => o.exitCode !== 0) ? 1 : 0;
  if (options.table) {
    const columns = ['chrome', 'firefox', 'isolated-chrome', 'isolated-firefox']
      .filter((name) =>
        families.some((f) => (f.isolated ? `isolated-${f.browser}` : f.browser) === name),
      )
      .map((name) => ({ name, args: [] as string[] }));
    const pairs = [
      ...new Map(
        cells.map((c) => [`${c.vfs}/${c.build}`, { vfs: c.vfs, build: c.build }]),
      ).values(),
    ];
    const keyed = new Map<string, MatrixResult>();
    for (const cell of cells) {
      const column = cell.project.startsWith('isolated ') ? `isolated-${cell.project.split(' ')[1]}` : cell.project.split(' ')[0];
      const result = results.get(cell.project);
      if (result) keyed.set(`${column}:${cell.vfs}/${cell.build}`, result);
    }
    printTable(pairs, columns, keyed);
  } else if (outcomes.some((o) => o.blob === 'ok')) {
    const merged = spawnSync(
      'pnpm',
      [
        'exec', 'vitest', '--configLoader', 'runner', '--merge-reports', blobs, '--reporter=default',
        ...(options.json ? ['--reporter=json', `--outputFile=${options.json}`] : []),
      ],
      { cwd: ROOT, env, stdio: 'inherit' },
    );
    if (merged.status !== 0) status = 1;
  }
  for (const { job, reason } of failed) {
    const log = join(logs, `${job.id}.log`);
    const tail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-TAIL_LINES).join('\n') : '(no log)';
    console.error(`\n--- ${job.id} failed (${reason}); last ${TAIL_LINES} lines of ${log} ---\n${tail}\n--- end ---`);
  }
  if (plan.dead.length > 0) {
    // Dead fails CI and the matrix; locally a browser may simply be absent.
    const fatal = options.mode === 'all-pairs' && options.pairs === null && options.browsers.length === 2;
    console[fatal ? 'error' : 'warn'](
      `\n${plan.dead.length} test(s) run on no pair of any selected browser:\n${plan.dead.map((d) => `  ${describeTest(d)} — needs [${d.tags.join(', ')}]`).join('\n')}`,
    );
    if (fatal) status = 1;
  }
  process.exitCode = status;
}

main().catch((error) => {
  console.error(`test-plan: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 2;
});
```

- [ ] **Step 4: Run it on clean files** (the 12 dynamic files would be refused until Tasks 7-11):

```bash
pnpm exec biome check --write scripts/test-plan.ts scripts/test-matrix.ts tests/unit/test-matrix.test.ts
pnpm exec tsc --noEmit
node scripts/test-plan.ts --unit tests/browser/realm.test.ts tests/browser/lifecycle.test.ts tests/browser/isolated/abort-slot.test.ts > "$WS/t6.log" 2>&1; echo "exit $?"; grep -E "^Plan|^  (isolated )?(chrome|firefox) ·|Test Files|Tests |exit" "$WS/t6.log"
node scripts/test-plan.ts tests/browser/vfs.test.ts; echo "exit $?"
```
Expected, first run: `exit 0`; the plan lists the two start cells per browser for `realm`/`lifecycle` and `isolated chrome · OPFSWriteAheadVFS/sync`, `isolated firefox · OPFSWriteAheadVFS/sync` for `abort-slot`; the merged report is green and includes `unit`. Second run: exit 2 with `PLAN_DYNAMIC: "newly wired VFS > ${vfs} opens and serves a round trip"` — the refusal working. If the merge cannot read a cell's blob because the project does not exist, the `env` passed to it lacks `BSQ_TEST_TARGETS=all`: fix that, not the blob.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-plan.ts scripts/test-matrix.ts tests/unit/test-matrix.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: the orchestrator that plans, runs and reports the browser suite

It probes each selected environment, parses the tests, prints the plan,
runs only the non-empty cells with their exact tests and merges their
reports, listing what is not applicable on a browser and failing the
matrix on a test no pair runs. Nothing calls it yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: standalone helpers; `statement-errors` and the newly wired VFS

**Files:**
- Modify: `tests/browser/helpers.ts`
- Modify: `tests/browser/statement-errors.test.ts`, `tests/browser/vfs.test.ts`

**Interfaces:**
- Consumes: `representative`, `runsIn`, `needFromTags` (Task 1, plan A), `bsqEnvironment` (Task 3).
- Produces (Tasks 8-11 use `forEachCase`): `ENVIRONMENT`, `standalonePair(tags): TestTarget`, `buildsHere(vfs): SQLiteBuild[]`, `forEachCase<T>(cases, label, run): Promise<void>`.

- [ ] **Step 1: Helpers** — in `tests/browser/helpers.ts`, imports gain `inject` (already there), `expect` from `vitest`, `type SQLiteBuild` from `'../../src/const/builds'`, `needFromTags, representative, runsIn` from `'../need'`; after `TEST_TARGET`:

```ts
/** This project's family (vitest.config.ts provides it beside the target). */
export const ENVIRONMENT = inject('bsqEnvironment');

/**
 * The pair a standalone test uses here: the first canonical pair its own
 * tags admit (spec § 3), never a name written in the test. Throws when none
 * does — the planner lists such a test as not applicable and never runs it.
 */
export const standalonePair = (tags: readonly string[]): TestTarget => {
  const pair = representative(
    needFromTags(tags).need,
    ENVIRONMENT.browser,
    AVAILABLE_FEATURES,
  );
  if (pair === null) {
    throw new Error(`STANDALONE: no pair here satisfies [${tags.join(', ')}]`);
  }
  return { vfs: pair.vfs, build: pair.build };
};

/** The builds of a VFS this browser can run, as declared. */
export const buildsHere = (vfs: SQLiteVFS): SQLiteBuild[] =>
  (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).filter((build) =>
    runsIn({
      vfs,
      build,
      browser: ENVIRONMENT.browser,
      isolated: false,
      features: AVAILABLE_FEATURES,
    }),
  );

/**
 * Runs every case whatever the others do, then fails once naming each case
 * that failed (user, 2026-10-12): a loop that stops at its first failure
 * hides how many cases share it.
 */
export const forEachCase = async <T>(
  cases: readonly T[],
  label: (item: T) => string,
  run: (item: T) => Promise<void>,
): Promise<void> => {
  const failures: string[] = [];
  for (const item of cases) {
    try {
      await run(item);
    } catch (error) {
      failures.push(
        `${label(item)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  expect(failures).toEqual([]);
};
```

- [ ] **Step 2: `statement-errors.test.ts`.**

1. Imports: drop `pairFor`, `type Skip`; add `buildsHere`, `forEachCase`, `standalonePair`, `TEST_TARGET` from `'./helpers'`; add `type SQLiteBuild` from `'../../src/const/builds'`.
2. Delete `const BUILDS`. `memoryClient` becomes:

```ts
const memoryClient = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  pragmas?: Record<string, string>,
) =>
  createTestClient({
    vfs,
    build,
    poolSize: 1,
    ...(pragmas ? { pragmas } : {}),
  });
```

3. The file docblock's second paragraph becomes: `Every build, because each has its own export of sqlite3_extended_errcode: the tests are standalone, take the VFS their tags name — a memory VFS that declares every build, MemoryVFS today — and loop over its builds. poolSize: 1 because a memory VFS's pages live in the worker that opened it.`
4. Replace `describe('a failed statement carries SQLite codes', () => { for (const build of BUILDS) { … } })` with a describe tagged `{ tags: ['standalone', 'excludes:shared-storage', 'requires:every-build'] }` holding five literal tests. Each keeps its comment block and its assertions verbatim; only its frame changes — the first:

```ts
  it('a constraint violation through write() carries its codes, on every build', async ({ task }) => {
    const { vfs } = standalonePair(task.tags ?? []);
    const cases = buildsHere(vfs).flatMap((build) =>
      CONSTRAINTS.map((c) => ({ build, c })),
    );
    await forEachCase(
      cases,
      ({ build, c }) => `${c.name} on ${build}`,
      async ({ build, c }) => {
        const db = await memoryClient(vfs, build, { foreign_keys: 'ON' });
        try {
          // today's body of `${c.name} through write() (${build})`, unchanged
        } finally {
          await db.close();
        }
      },
    );
  });
```

and the four others the same way over `buildsHere(vfs)` alone, labelled by build, with their bodies unchanged: `a missing collation through read(), the prepare path, on every build`; `a later statement's prepare failure, fresh then uncacheable, on every build`; `a syntax error has no subtype, on every build`; `SQLITE_FULL inside a transaction, on every build`. (The comment line `// today's body …` above stands for the existing statements, moved in as they are — it is not left in the file.)
5. `describe('bulkWrite', …)` gets `{ tags: ['standalone', 'excludes:shared-storage'] }`; its test takes `async ({ task }) => { const { vfs, build } = standalonePair(task.tags ?? []); const db = await memoryClient(vfs, build); …`.
6. `describe('a file that is not a database', …)` gets `{ tags: ['requires:opfs-file'] }`; delete `opfsPair`; both tests drop `{ skip }` and take `const pair = TEST_TARGET;` in place of `opfsPair(skip)`.

- [ ] **Step 3: `vfs.test.ts` › newly wired VFS.** Replace the describe (and its docblock) with:

```ts
/**
 * Every VFS this browser can run opens on its default build and serves a
 * round trip: the gate that keeps `pnpm test` honest about each loader in
 * the worker. Standalone, once per browser; a VFS added to VFS_CAPABILITIES
 * joins with no edit here.
 */
describe('every wired VFS', () => {
  // Falsifiable: delete any one loader from VFSConfigs in worker/worker.ts.
  it('opens on its default build and serves a round trip', { tags: ['standalone'] }, async () => {
    const runnable = (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter(
      (vfs) =>
        missingFeature(vfs, defaultBuildFor(vfs, AVAILABLE_FEATURES), AVAILABLE_FEATURES) === null,
    );
    await forEachCase(runnable, (vfs) => vfs, async (vfs) => {
      const db = await createTestClient({ vfs });
      try {
        await db.write('CREATE TABLE wired (id INTEGER, val TEXT)');
        await db.write("INSERT INTO wired VALUES (1, 'ok')");
        const rows = await db.read<{ id: number; val: string }>('SELECT * FROM wired');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.val).toBe('ok');
      } finally {
        await db.close();
      }
    });
  });
});
```

Imports: `missingFeature`, `defaultBuildFor` from `'../../src/capabilities'`, `type SQLiteVFS` from `'../../src/const/vfs'`, `AVAILABLE_FEATURES` from `'../conformance/helpers'`, `forEachCase` from `'./helpers'`.

- [ ] **Step 4: Prove the loops report every case.** The test's own falsifier: in a scratch edit of `src/worker/worker.ts`, drop the `sqliteExtendedCode` stamp in the worker's `run` (the edit its `Falsifiable:` comment names), rebuild through the run, and:

```bash
pnpm exec vitest run --configLoader runner --project 'chrome · OPFSWriteAheadVFS/sync' tests/browser/statement-errors.test.ts > "$WS/t7-mutant.log" 2>&1
grep -oE "(UNIQUE|FOREIGN KEY|NOT NULL) on (sync|async|jspi)" "$WS/t7-mutant.log" | sort -u
git checkout -- src/worker/worker.ts
```
Expected: one failed constraint test whose message lists all nine `<constraint> on <build>` cases — every case ran although the first failed. Restore before Step 5.

- [ ] **Step 5: Run**

```bash
pnpm exec biome check --write tests/browser/helpers.ts tests/browser/statement-errors.test.ts tests/browser/vfs.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project 'chrome ·*' --project 'firefox ·*' tests/browser/statement-errors.test.ts tests/browser/vfs.test.ts
node scripts/test-plan.ts tests/browser/statement-errors.test.ts tests/browser/vfs.test.ts
```
Expected: green in both. The plan hosts the standalone tests in `chrome · OPFSWriteAheadVFS/sync` and `firefox · OPFSWriteAheadVFS/sync` only, and `a file that is not a database` on the start pairs (both have `opfs-file`).

- [ ] **Step 6: Commit**

```bash
git add tests/browser/helpers.ts tests/browser/statement-errors.test.ts tests/browser/vfs.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: statement-errors and the wired-VFS gate become standalone tests

Both looped to create tests, so their ids were unknown before they ran.
They now run once per browser, take the VFS their need names, loop over
its builds or every runnable VFS inside one test, and report every
failing case at once (user, 2026-10-12).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: the VFS that is the subject — `coopsync-handover`, `idb-long-read`

**Files:**
- Modify: `tests/browser/coopsync-handover.test.ts`, `tests/browser/idb-long-read.test.ts`

- [ ] **Step 1: `coopsync-handover`.** Delete `BUILDS`; `open` becomes `const open = (file: string) => createSQLiteClient(file, { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build });`; `scrub` removes `removeDatabaseFiles(file, TEST_TARGET.vfs)`; import `TEST_TARGET` from `'./helpers'`. The describe gets `{ tags: ['vfs:OPFSCoopSyncVFS'] }` and loses its `for (const build of BUILDS)`; its two looped tests become literal — `it('two clients opened together fail no statement', …)` and `it("a write following another client's schema change does not fail", …)` — with `open(file)` in place of `open(file, build)`; bodies otherwise unchanged. The planner now runs them on each CoopSync build, `async` included, which the loop never covered: a failure there is new coverage, triaged on its own (spec § 8).
- [ ] **Step 2: `idb-long-read`.** The describe gets `{ tags: ['vfs:IDBBatchAtomicVFS'] }` and loses its loop; the test is `it('serves a read from another worker without a signal', async () => { const { vfs, build } = TEST_TARGET; …`, its body unchanged but for `const vfs = 'IDBBatchAtomicVFS';` (gone) and the 60 s timeout kept; import `TEST_TARGET` from `'./helpers'`.
- [ ] **Step 3: Run**

```bash
pnpm exec biome check --write tests/browser/coopsync-handover.test.ts tests/browser/idb-long-read.test.ts
pnpm exec tsc --noEmit
node scripts/test-plan.ts tests/browser/coopsync-handover.test.ts tests/browser/idb-long-read.test.ts
node scripts/test-plan.ts --mode all-pairs tests/browser/coopsync-handover.test.ts tests/browser/idb-long-read.test.ts
```
Expected: complement — `chrome · OPFSCoopSyncVFS/sync`, `chrome · IDBBatchAtomicVFS/jspi` and the Firefox twins, `complement`, green. All-pairs — CoopSync on `sync`, `jspi`, `async`, IDBBatchAtomic on `jspi`, `async`, per browser; a red `async` CoopSync cell is reported to the user before going on, not fixed in this task.
- [ ] **Step 4: Commit**

```bash
git add tests/browser/coopsync-handover.test.ts tests/browser/idb-long-read.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: the VFS a test is about is its tag, the planner gives its builds

Both files looped over builds to create tests, so their ids were unknown
before a run. The planner now runs each build the VFS declares,
OPFSCoopSyncVFS's async build for the first time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: shapes as literal tests — `second-client`, `transaction-begin`, `tx-handle`, `abandon-gc`

**Files:**
- Modify: the four files.

- [ ] **Step 1: `second-client`.** Inside the module-scope block, replace `for (const shape of ['together', 'after'] as const) { const title = …; it(title, async () => { BODY }); }` with:

```ts
    const scenario = (shape: 'together' | 'after') => async () => {
      // BODY, unchanged
    };
    it('built together', scenario('together'));
    it('built after the first write', scenario('after'));
```
(`BODY` is today's test body, lines from `const { file, open, losses } = oneDatabase(vfs, build);` to `expect(losses).toEqual([]);`, moved as it is.)
- [ ] **Step 2: `transaction-begin`.** `SHAPES`'s annotation becomes `satisfies Record<string, Shape>` with `type Shape = { run: (db: Db) => Promise<unknown>; after: string; rows: number };`, so its keys are literal; the loop becomes

```ts
  const check = (shape: keyof typeof SHAPES) => async () => {
    const { run, after, rows } = SHAPES[shape];
    const db = await fresh();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    await run(db);
    // The client is still usable: the failure left it broken for good.
    const [row] = await db.read<{ n: number }>(after);
    expect(row?.n).toBe(rows);
  };
  it('reads, then writes', check('reads, then writes'));
  it('runs a write that changes nothing, then writes', check('runs a write that changes nothing, then writes'));
  it('output() creates a table that does not exist yet', check('output() creates a table that does not exist yet'));
  it('a readOnly transaction still reads', check('a readOnly transaction still reads'));
```
- [ ] **Step 3: `tx-handle`.** Replace `it.each(['commit', 'rollback'] as const)('is refused after tx.%s() under autoCommit: false', async (end) => { BODY })` with `const refusedAfter = (end: 'commit' | 'rollback') => async () => { BODY };` and `it('is refused after tx.commit() under autoCommit: false', refusedAfter('commit'));`, `it('is refused after tx.rollback() under autoCommit: false', refusedAfter('rollback'));`.
- [ ] **Step 4: `abandon-gc`.** Delete the `if (!forceGC) { it.skip(…) } else {` frame; both tests are declared always and begin with

```ts
    async ({ skip }) => {
      if (forceGC === undefined) skip('this browser was not launched with --expose-gc');
      const gc = forceGC;
```
and call `gc()` where they called `forceGC()`. (Plan decision 4.)
- [ ] **Step 5: Run** — Biome, `tsc`, then `node scripts/test-plan.ts tests/browser/second-client.test.ts tests/browser/transaction-begin.test.ts tests/browser/tx-handle.test.ts tests/browser/abandon-gc.test.ts`. Expected: green; `abandon-gc`'s two tests reported skipped with the reason.
- [ ] **Step 6: Commit**

```bash
git add tests/browser/second-client.test.ts tests/browser/transaction-begin.test.ts tests/browser/tx-handle.test.ts tests/browser/abandon-gc.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: shapes become literal tests, so every id is known before a run

A loop, an it.each or an if around it declared these tests at run time,
shifting the ids the planner selects by. abandon-gc now declares both
tests always and skips them with the reason when gc is not exposed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: conditional tests become needs — `vfs-folders`, `delete`, `inspect-client`

**Files:**
- Modify: the three files.

- [ ] **Step 1: `vfs-folders`.** Delete `const persistent = …`; `describe('the name a consumer uses', …)` gets `{ tags: ['requires:shared-storage'] }`; its three `(persistent ? it : it.skip)(` become `it(`.
- [ ] **Step 2: `delete`.** In `describe('deleteDatabase on a database that is not there')`: delete `const opfsEntries = …`; the test becomes `it('leaves no OPFS entry named after the database', { tags: ['requires:opfs-file'] }, async () => { … })`, body unchanged (on `AccessHandlePoolVFS`, `storage: 'opfs'` without a folder, it searched the OPFS root for a name that VFS never writes there). In `describe('deleteDatabase under a live connection')`: delete `const shared = …`; the test becomes `it('refuses with DATABASE_IN_USE while a client is live', { tags: ['requires:shared-storage'] }, async () => { … })`.
- [ ] **Step 3: `inspect-client`.** `describes a lone client` splits in two:

```ts
  it('describes a lone client', { tags: ['requires:shared-storage'] }, async () => {
    const db = await createTestClient();
    onTestFinished(() => db.close().catch(() => {}));
    await db.read('SELECT 1');
    const view = await db.inspect();
    expect(view.self?.id).toBe(db.id);
    expect(view.siblings).toHaveLength(0);
    expect(view.tabs).toBe(1);
  });

  // A memory VFS keeps its database inside its own client: there is no realm
  // to inspect, and inspect() says so rather than inventing one.
  it('refuses to describe a lone client of a memory VFS', { tags: ['excludes:shared-storage'] }, async () => {
    const db = await createTestClient();
    onTestFinished(() => db.close().catch(() => {}));
    await db.read('SELECT 1');
    await expect(db.inspect()).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });
```
and `VFS_CAPABILITIES` leaves the imports if nothing else reads it.
- [ ] **Step 4: Run** — Biome, `tsc`, `node scripts/test-plan.ts tests/browser/vfs-folders.test.ts tests/browser/delete.test.ts tests/browser/inspect-client.test.ts`. Expected: green; `refuses to describe a lone client of a memory VFS` runs in a `complement` cell `* · MemoryVFS/sync`; the OPFS-entry test on both start pairs.
- [ ] **Step 5: Commit**

```bash
git add tests/browser/vfs-folders.test.ts tests/browser/delete.test.ts tests/browser/inspect-client.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: a test that skipped itself by condition now says what it needs

A test declared through (condition ? it : it.skip) is invisible to
static parsing; a branch on the target hid its need inside the body. Both
are tags now, and the OPFS-entry test no longer passes vacuously on
AccessHandlePoolVFS, which keeps no file at the database's name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: `pool-cap` follows its pair; the static-file check

**Files:**
- Modify: `tests/browser/pool-cap.test.ts`
- Create: `tests/unit/static-tests.test.ts`

- [ ] **Step 1: `pool-cap` header and imports.** Delete `const CAPPED = …` and the `HAS_UNSAFE_HANDLES` import; import `TEST_TARGET` from `'./helpers'`. The file docblock's second paragraph becomes: `The arbiter is the need: env-capped-pool holds where the probed engine lacks readwrite-unsafe for a VFS that declares the cap (env-cappable), so no engine and no VFS is named here, and the day Firefox ships readwrite-unsafe these tests follow it.`
- [ ] **Step 2: every test follows `TEST_TARGET`** — `createTestClient({ vfs: 'OPFSWriteAheadVFS', … })` and `createTestClient({ vfs: 'OPFSAdaptiveVFS', … })` lose `vfs`; `createSQLiteClient(file, { vfs: 'OPFSWriteAheadVFS', … })` takes `vfs: TEST_TARGET.vfs, build: TEST_TARGET.build`; `databasePath('OPFSWriteAheadVFS', file)` and `removeDatabaseFiles(file, 'OPFSWriteAheadVFS')` take `TEST_TARGET.vfs`; the `// One VFS: …` comment lines go.
- [ ] **Step 3: tags and splits**, test by test (bodies otherwise unchanged):
  - T1 → two tests. `it('runs on one worker without readwrite-unsafe, and warns once when poolSize was asked for', { tags: ['requires:env-capped-pool'] }, …)` keeps the body's capped branch (`poolSize` 1, one `pool capped` warning naming `without readwrite-unsafe` and `pool capped at 1 of 4`, the declines); `it('keeps every worker with readwrite-unsafe, and does not warn', { tags: ['requires:env-cappable', 'excludes:env-capped-pool'] }, …)` keeps the other (`poolSize` 4, no `pool capped` warning). Both keep `lost` empty and no ` lost;` warning.
  - T2 → `caps silently when poolSize was left to its default` (`requires:env-capped-pool`, `poolSize` 1) and `keeps the default pool when poolSize was left to it` (`requires:env-cappable`, `excludes:env-capped-pool`, `poolSize` 2); both expect no warning.
  - T3 (`caps OPFSAdaptiveVFS too …`) is deleted: T1 now runs on every `env-cappable` VFS.
  - T4, the retry-round test, the total-failure test: `(CAPPED ? it : it.skip)(` → `it(` with `{ tags: ['requires:env-capped-pool'] }` as second argument.
  - T5 (`reports the storage error behind a failed open`): `{ tags: ['requires:opfs-file', 'requires:sync-handle'] }` (probed 2026-10-12: OPFSAnyContextVFS opens a file held elsewhere and serves `SELECT 1`).
  - `close() during startup of a capped pool …`: `{ tags: ['requires:env-cappable'] }`.
  - `reports the capped size once db.ready resolves, before any query` → capped (`requires:env-capped-pool`, `poolSize` 1) and `reports the full size once db.ready resolves` (`requires:env-cappable`, `excludes:env-capped-pool`, `poolSize` 4).
- [ ] **Step 4: Run** — Biome, `tsc`, then `node scripts/test-plan.ts --mode all-pairs tests/browser/pool-cap.test.ts`. Expected: capped tests on Firefox's `OPFSWriteAheadVFS` and `OPFSAdaptiveVFS` pairs only, uncapped ones on Chrome's, T5 on WriteAhead/Adaptive/CoopSync pairs of both, all green. A red Adaptive cell (pinned to WriteAhead until now) is reported before going on.
- [ ] **Step 5: The static-file check — failing test first.** `tests/unit/static-tests.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BROWSER = fileURLToPath(new URL('../browser', import.meta.url));

/**
 * The planner selects a cell's tests by the ids static parsing gives them
 * (mem:measurements/suite-and-matrix § TEST-IDS): a test created in a loop,
 * an each or behind a condition shifts every later id or is never seen, and
 * would be run silently wrong. The parser flags the loops it sees (the
 * planner refuses them); these are the constructs it cannot see at all.
 */
// A `for` inside a test body is legitimate, and a loop that creates tests is
// flagged by the parser through its template name (PLAN_DYNAMIC).
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\?\s*(it|test|describe)\s*:\s*(it|test|describe)\.skip/, 'a conditional test: tag its need instead'],
  [/\b(it|test|describe)\.(each|for)\b/, 'an each: write one literal test per case, or loop inside one test'],
];

const files = readdirSync(BROWSER, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.ts'));

describe('browser test files declare their tests statically', () => {
  it('finds the browser test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('none creates a test the parser cannot see', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(BROWSER, file), 'utf8');
      return FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(
        ([, why]) => `${file}: ${why}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
```

Run it — `pnpm exec vitest run --configLoader runner --project unit tests/unit/static-tests.test.ts`, expected green — then put one conversion back in a scratch edit (`vfs-folders`' first `it(` → `(persistent ? it : it.skip)(`), run again — expected red, naming `vfs-folders.test.ts: a conditional test` — and restore with `git checkout -- tests/browser/vfs-folders.test.ts`. (One test over all files, not one per file: an `it.each` here would be the very construct the check forbids in the browser suite, and readable failures need nothing more.)
- [ ] **Step 6: Commit**

```bash
git add tests/browser/pool-cap.test.ts tests/unit/static-tests.test.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: pool-cap follows its pair, and conditional tests are refused

Its CAPPED oracle becomes the env-capped-pool and env-cappable needs, so
the capped and uncapped cases are tests of their own, on every VFS the
environment caps, and the test that only named a second VFS goes. A unit
test refuses the constructs static parsing cannot see.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: the scripts go through the planner; the matrix too

**Files:**
- Modify: `package.json`, `scripts/test-matrix.ts`

- [ ] **Step 1: Coverage before** (background, progress every 2 minutes) — the last `pnpm test` of the old scripts, kept as JSON:

```bash
node scripts/bounded.ts 2400 node scripts/test-parallel.ts --project unit --project 'chrome ·*' --project 'firefox ·*' --project 'isolated *' -- --reporter=json --outputFile="$WS/before.json" > "$WS/before.log" 2>&1
```
(Today's `pnpm test` command, called directly so that what follows `--` reaches `test-parallel.ts`'s merge whatever pnpm does with `--`.)
- [ ] **Step 2: `package.json`** — replace the browser test scripts:

```json
		"test": "node scripts/bounded.ts 2400 node scripts/test-plan.ts --unit",
		"test:browser": "node scripts/bounded.ts 1800 node scripts/test-plan.ts",
		"test:chrome": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser chrome",
		"test:firefox": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser firefox",
		"test:chrome:not-isolated": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser chrome --modes not-isolated --full",
		"test:chrome:isolated": "node scripts/bounded.ts 600 node scripts/test-plan.ts --browser chrome --modes isolated --full",
		"test:firefox:not-isolated": "node scripts/bounded.ts 900 node scripts/test-plan.ts --browser firefox --modes not-isolated --full",
		"test:firefox:isolated": "node scripts/bounded.ts 600 node scripts/test-plan.ts --browser firefox --modes isolated --full",
		"test:isolated": "node scripts/bounded.ts 600 node scripts/test-plan.ts --modes isolated --full",
```
`test:unit`, `test:conformance*`, `test:consumer`, `test:matrix` keep their commands.
- [ ] **Step 3: `test-matrix.ts` delegates.** `main` keeps `parseArgs` (`--engine`, `--pair`) and becomes:

```ts
async function main() {
  const { columns, pairs } = parseArgs(process.argv.slice(2));
  const browsers = [...new Set(columns.map((c) => c.name.replace('isolated-', '')))];
  const modes = [...new Set(columns.map((c) => (c.name.startsWith('isolated-') ? 'isolated' : 'not-isolated')))];
  // The plan selects browsers × modes: a mix such as chrome with isolated-firefox is not one.
  if (browsers.length * modes.length !== columns.length) {
    throw new Error(`test-matrix: --engine ${columns.map((c) => c.name).join(', ')} is not a product of browsers and modes`);
  }
  const explicit = process.argv.includes('--pair');
  const run = spawnSync(
    'node',
    [
      'scripts/test-plan.ts',
      '--mode', 'all-pairs', '--table',
      ...browsers.flatMap((b) => ['--browser', b]),
      '--modes', modes.join(','),
      ...(explicit ? pairs.flatMap((p) => ['--pair', `${p.vfs}/${p.build}`]) : []),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exitCode = run.status ?? 1;
}
```
with `spawnSync` from `node:child_process`; delete `runOne`, `RUN_TIMEOUT_MS` and the imports only they used (Biome names them). The docblock's second and third paragraphs become: `Since the test planner (spec 2026-10-12), a run is \`scripts/test-plan.ts --mode all-pairs --table\`: only the cells with tests to run start, each with exactly its tests, and the table shows a cell that did not start as —. Each cell leaves \`<column>__<vfs>__<build>.json\` (Vitest's JSON report) under \`.matrix/<run>/\`, which \`scripts/matrix-triage.ts\` reads.`
- [ ] **Step 4: Coverage after, and the comparison**

```bash
node scripts/bounded.ts 2400 node scripts/test-plan.ts --unit --json "$WS/after.json" > "$WS/after.log" 2>&1
node -e '
const load = (f) => new Set(require(f).testResults.flatMap((r) => r.assertionResults.filter((a) => a.status === "passed").map((a) => `${r.name.replace(/^.*\/tests\//, "tests/")} :: ${a.fullName}`)));
const before = load(process.argv[1]), after = load(process.argv[2]);
const lost = [...before].filter((t) => !after.has(t));
console.log(`before ${before.size} distinct passed, after ${after.size}; lost ${lost.length}`); for (const t of lost) console.log("  " + t);
' "$WS/before.json" "$WS/after.json"
```
Expected: every lost test is accounted for by a rename of Tasks 7-11 (the old looped names, `caps OPFSAdaptiveVFS too …`, the split tests' old names) — list them in the ledger, one line each with the test that replaces it. Any other lost test stops the task: find why the plan no longer runs it.
- [ ] **Step 5: The matrix** (background, progress every 2 minutes): `pnpm test:matrix > "$WS/matrix.log" 2>&1`. Expected: the table with `—` for isolated cells outside the four `sync` pairs, every launched cell green, `Not applicable` lists matching the spec's property table (`env-capped-pool` tests on Chrome, …), no dead test. Red cells are new coverage (spec § 8): triage each, report, do not widen this task.
- [ ] **Step 6: Commit**

```bash
git add package.json scripts/test-matrix.ts
test "$(git branch --show-current)" = feat/test-planner && git commit -m "test: the browser scripts and the matrix run through the planner

pnpm test now runs every test at least once per browser on the fewest
cells, and the matrix starts only the cells that have tests to run,
each with exactly its tests (spec 2026-10-12, D6). <the before/after
counts of Step 4 and the matrix's cells and time of Step 5>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(The bracketed line is replaced by the measured numbers before committing.)

### Task 13: verification, memories, report

- [ ] **Step 1:** `pnpm exec biome ci . && pnpm exec tsc --noEmit && pnpm test:unit`; `pnpm test` (background) — note its wall time against today's ~3 min.
- [ ] **Step 2: Memories** — `history/2026-10.md`: one row for `feat/test-planner` (what shipped, the cells of `pnpm test`, the matrix's cell count and time, new-coverage failures and their triage); `follow-ups/test-planner-design.md`: plan B done, **plan C next: the conversion of every other test (step 5: pinning, fallback and `BSQ_TEST_NEEDS` removed, the isolated precondition, the directories flattened) and CI (step 6)**, carrying what this plan left (its rulings, the Review Focus items still open); `stack-and-build.md`: the scripts of § 5 and what `test-plan.ts` does, replacing the `test-parallel.ts` description for browser projects.
- [ ] **Step 3: Commit** the memories; whole-branch review on the capable tier; report to the user; merge only on their approval.
