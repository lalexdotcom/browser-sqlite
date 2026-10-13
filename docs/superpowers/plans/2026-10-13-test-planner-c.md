# Test planner, plan C — every browser test converted to tags, then CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver steps 5 and 6 of the test-planner spec: every browser test states what it needs as literal tags and follows its cell's pair, pinning and `pairFor`'s fallback disappear, `firefox/` and `isolated/` are flattened, and CI runs the plan — a dead test fails it once over the whole plan, and the matrix runs on every push of `main`.

**Architecture:** Branch 1 (`test/convert-needs`, step 5) first adds a trace (which tests read the pair, how many workers they start) and two helpers, takes the "before" trace, converts the files family by family while the old API still compiles, then removes the old API so any leftover fails `tsc`, runs the plan and the matrix, triages the new coverage, and compares the "after" trace. Branch 2 (`ci/test-planner`, step 6) adds `--plan-only` / `--pairs-out` to the planner and makes `matrix.yaml` plan first.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`, `exactOptionalPropertyTypes`), Biome, Vitest 5.0.3 (tags, `onTestFinished`, `task.meta`, the JSON reporter's `meta`), WebdriverIO with Chrome 153 and Firefox 155, GitHub Actions, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-12-test-planner-design.md` (§ 2, § 3, § 6, § 8, § 9). Binding decisions since the spec: `mem:follow-ups/test-planner-design`, and § "Decisions" below (user, 2026-10-13).

## Global Constraints

- Two branches, one after the other, each off `main`: `test/convert-needs` (Tasks 0-12), then `ci/test-planner` (Tasks 13-15) once the first is merged. Every commit green (`pnpm exec tsc --noEmit`, Biome, the tests the task names). Closing a branch = format, lint, typecheck, `pnpm test` green (and for branch 1 `pnpm test:matrix` green), memories updated, report to the user, **merge only on the user's approval** (`mem:conventions`), `git merge --no-ff`, branch deleted. Never push unless the user says so (Task 15 asks).
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check the branch in the same command: `test "$(git branch --show-current)" = test/convert-needs && git commit …`. Never `--no-verify`, never `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`; if a hook fails, stop and report its output verbatim; after committing, `git log --oneline -1` and `git show --stat HEAD`.
- Code files are read and edited through Serena's symbolic tools (`AGENTS.md` § Tooling); built-in Read/Edit only on non-code files or when Serena fails. Every subagent prompt that touches code carries this rule.
- After every modification `pnpm exec biome check --write <files>`; before every commit `pnpm exec tsc --noEmit`.
- `$WS` = `/workspaces/wsqlite/.superpowers/sdd/2026-10-13-test-planner-c` (git-ignored), created in Task 0; logs, traces and throwaway files go there or under `.scratchpad/`, never in `tests/`.
- Any run past ~2 minutes (`pnpm test` ≈ 3 min, `pnpm test:matrix` ≈ 14 min, a merge whose hook runs the suite) goes to the background writing to a log, never through `| tail`, with a progress line to the user every 2 minutes from launch.
- Property names, verbatim: `two-workers`, `interruptible`, `shared-second-client`, `exclusive-connection`, `shared-storage`, `opfs-file`, `in-place-file`, `capped-pool`, `env-capped-pool`, `default-pragmas`, `exclusive-file-handle`, `idb-storage`, `every-build`, `env-cappable`, `sync-handle`. Tag names: `requires:<property>`, `excludes:<property>`, `vfs:<VFS>`, `build:<build>`, `browser:<chrome|firefox>`, `isolated`, `not-isolated`, `standalone`. No new property in this plan.
- No VFS and no build written in a converted test's body (user, 2026-10-12): a VFS that is the subject is a `vfs:` tag, one that stands for a capability is the property, and the body follows its pair through `TEST_TARGET`, `createTestClient` or `sharedDatabase`. Reading `VFS_CAPABILITIES[pair.vfs]` to compute an expectation or a setup value is allowed (user, 2026-10-13).
- A tag goes in the test's options: `it(name, { tags: [...] }, fn)`; a timeout passed as the third argument today moves into the same object (`{ tags: [...], timeout: 30_000 }`); a tag shared by a whole `describe` goes on it (`describe(name, { tags: [...] }, () => …)`, inherited by its tests).
- No CHANGELOG entry: nothing here changes what a consumer gets.

## Decisions (user, 2026-10-13, unless marked otherwise)

1. **Translation, not re-assessment.** A test's existing `needs` become the same `requires:` tags; a test that declares no need today stays untagged. Re-judging a need (e.g. `abandon-transaction`'s blanket `two-workers`, `cross-tab`'s `shared-second-client`, `database-pragmas`' blanket need on its single-client tests, `tx-abort` R3) is out of scope (agent's decision under the user's "convert", listed for review).
2. **The pair a test touches.** `TEST_TARGET` stays the project's pair, read inside a test or a helper, never at module or describe scope. `pairFor`, `resolvePair`, `Need`, `OnUnmetNeed`, `Needing`, `Skip`, `bsqNeeds` and `BSQ_TEST_NEEDS` go.
3. **`createTestClient(options?, pair = TEST_TARGET)`.** `options` is everything `createSQLiteClient` accepts except `vfs` and `build` (now the second argument), plus the test-only `__unsafeTest*` options; `name` (the client's log name) is now allowed; `needs`/`skip` go. Only the two standalone files that sweep pairs (`statement-errors`, `vfs` › every wired VFS) pass `pair`.
4. **`sharedDatabase()`** returns `{ name, open(options?, spelling?) }` on the project's pair: every `open` is a client on the same database, opened when the test decides, with its own options; `spelling` is another spelling of the same name (`./name`). After the test every client is closed and the database deleted the way `createTestClient` deletes it (IndexedDB included).
5. **Standalone** = a test that opens no VFS, or whose subject is to sweep every VFS or every build so that `pnpm test` catches it early. Its tags stay (`standalone` + what it needs), so the planner knows ahead of time where it cannot run; its body reads its pair with `standalonePair(tags)`. The matrix leaves standalone tests out on purpose.
6. **`delete`'s four "representative" tests become pair tests** (`requires:shared-storage`), not standalone: their subject depends on the VFS that deletes. This departs from spec § 3, which listed the init-lock BUSY test as standalone.
7. **Duplicates merged:** `inspect-client` › "db.inspect on a memory VFS › throws INVALID_OPTION — two memory clients are two databases" is deleted (same assertion as "refuses to describe a lone client of a memory VFS"); `vfs`'s three pool guards become two `requires:capped-pool` tests; `vfs` › "accepts an explicitly declared combination and serves queries" is deleted (every `createTestClient` passes an explicit declared pair).
8. **A versioned trace** (`BSQ_TEST_TRACE=1`, `tests/browser/trace.ts`, `scripts/trace-diff.ts`), run before and after the conversion.
9. **Computed expectations from declarations:** `database-pragmas`' `busy_timeout` (set unless the pair refuses it) and `second-client`'s refused message suffix stay computed from `VFS_CAPABILITIES`.
10. **One project per declared pair, always** (agent's decision): `vitest.config.ts` builds every pair's projects whatever the environment says; `BSQ_TEST_TARGETS` becomes an input of `scripts/test-plan.ts` alone. The static `CHROMIUM_FEATURES` / `FIREFOX_FEATURES` tables, `targetsFromEnv` and `onUnmetFromEnv` go.
11. **`isolated/tx-savepoint.test.ts` becomes `tests/browser/tx-savepoint-cut.test.ts`** when flattened: its basename collides with `tx-savepoint.test.ts`. `isolated/environment.test.ts` becomes a setup file of the isolated projects (`tests/browser/isolation-check.ts`) that fails the file by name (spec § 3).

## Review Focus

- A formerly pinned test now reaches pairs it never ran on (`IDBMirrorVFS`, `MemoryAsyncVFS`, the `sync` pairs under isolation for every `requires:interruptible` test, OPFSWriteAheadVFS on Firefox for `exclusive-connection`). Spec § 8: each failure is triaged on its own and none widens the conversion. Pinned by Task 10's triage procedure.
- A test that loses its last run (a typo in a tag, a describe tag that excludes everything) would vanish silently from both modes. Pinned twice: the planner's dead list (Task 10, fatal in the matrix) and the trace diff (Task 11), whose expected lost/new lists are written in this plan.
- `sharedDatabase` must delete an IndexedDB database and give back an `AccessHandlePoolVFS` slot, or the per-file storage wipe fails the next file. Pinned in Task 2 (a test that checks the database is gone after its own cleanup).
- A test file reading `TEST_TARGET` at module or describe scope runs before the guard and outside any test. Pinned in Task 11: the after-trace flags a test with no pair read that is not standalone.
- A non-literal test name or an `if` around `it` defeats static parsing. Pinned in Task 9 (the static check grows two patterns).

## File structure

| File | Responsibility |
|---|---|
| `tests/browser/helpers.ts` (modify) | `TEST_TARGET` with counted reads, `takeTargetReads`, `createTestClient(options, pair)`, `sharedDatabase`, one cleanup for both; old API removed in Task 9 |
| `tests/browser/trace.ts` (create) | setup file under `BSQ_TEST_TRACE=1`: per test, pair reads, workers started, tags, into `task.meta.bsqTrace` |
| `scripts/trace-diff.ts` (create) | pure `diffTraces(before, after)` + CLI over two Vitest JSON reports |
| `tests/unit/trace-diff.test.ts` (create) | its unit tests |
| `tests/browser/shared-database.test.ts` (create) | `sharedDatabase`'s two tests |
| `tests/browser/isolation-check.ts` (create) | the isolated projects' precondition |
| `tests/vitest.d.ts` (modify) | `TaskMeta.bsqTrace`; `bsqNeeds` removed |
| `vitest.config.ts` (modify) | trace setup file, flattened includes, isolation check, all pairs always, no `bsqNeeds` |
| `tests/target-projects.ts` (modify) | `allTargets()` and `targetLabel` only |
| `tests/browser/target.ts` (modify) | `TestTarget` only |
| `tests/browser/helpers/vfs-contract.ts`, `tests/unit/test-target.test.ts` (delete) | unused once `second-client` is split and `resolvePair` gone |
| `tests/unit/target-projects.test.ts` (modify) | `allTargets` |
| `tests/unit/static-tests.test.ts` (modify) | two more refused constructs |
| `scripts/plan-io.ts`, `scripts/test-plan.ts` (modify) | no `BSQ_TEST_TARGETS=all` handed to children; branch 2: `--plan-only`, `--pairs-out`, dead fatal in CI |
| `scripts/plan-report.ts` (create, branch 2) | pure `deadIsFatal` |
| `.github/workflows/matrix.yaml`, `ci.yaml` (modify, branch 2) | plan job, push trigger, comments |
| ~45 test files (modify), 5 moved, 1 removed | tags and bodies (Tasks 3-8) |

---

### Task 0: Branch and workspace

- [ ] **Step 1:** `cd /workspaces/wsqlite && git switch test/convert-needs` (it exists, off `main`, holding this plan) and `mkdir -p .superpowers/sdd/2026-10-13-test-planner-c`.
- [ ] **Step 2:** Commit this plan: `test "$(git branch --show-current)" = test/convert-needs && git add docs/superpowers/plans/2026-10-13-test-planner-c.md && git commit -m "docs(plan): test planner plan C, the conversion and CI"` (with the co-author line).

### Task 1: the trace, and the "before" run

**Files:**
- Modify: `tests/browser/helpers.ts` (`TEST_TARGET`)
- Create: `tests/browser/trace.ts`, `scripts/trace-diff.ts`, `tests/unit/trace-diff.test.ts`
- Modify: `tests/vitest.d.ts`, `vitest.config.ts`

**Interfaces:**
- Produces: `takeTargetReads(): number` (helpers.ts); `TaskMeta.bsqTrace?: { targetReads: number; workers: number; tags: string[] }`; `type TracedTest = { key: string; targetReads: number; workers: number; tags: string[]; runs: number }`; `readTrace(json: string): Map<string, TracedTest>`; `diffTraces(before: Map<string, TracedTest>, after: Map<string, TracedTest>): { lost: string[]; added: string[]; unread: string[] }`. A key is `<file basename> › <describe titles and title joined by " > ">`.

- [ ] **Step 1: Write the failing unit test** — `tests/unit/trace-diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diffTraces, readTrace } from '../../scripts/trace-diff.ts';

/**
 * The conversion's proof (spec § 8): no test loses its last run, and every
 * test that reads no pair is standalone. Fixtures carry only the fields of
 * Vitest's JSON reporter that readTrace reads.
 */
const report = (
  tests: {
    file: string;
    ancestors: string[];
    title: string;
    trace?: { targetReads: number; workers: number; tags: string[] };
  }[],
) =>
  JSON.stringify({
    testResults: [...new Set(tests.map((t) => t.file))].map((file) => ({
      name: `/repo/tests/browser/${file}`,
      assertionResults: tests
        .filter((t) => t.file === file)
        .map((t) => ({
          ancestorTitles: t.ancestors,
          title: t.title,
          status: 'passed',
          meta: t.trace ? { bsqTrace: t.trace } : {},
        })),
    })),
  });

const traced = (targetReads: number, tags: string[] = []) => ({
  targetReads,
  workers: 1,
  tags,
});

describe('readTrace', () => {
  it('keys a test by its file basename and its titles, and sums its runs', () => {
    // Falsifiable: key by the full path and a moved file reads as lost.
    const trace = readTrace(
      report([
        { file: 'isolated/a.test.ts', ancestors: ['d'], title: 't', trace: traced(1) },
        { file: 'a.test.ts', ancestors: ['d'], title: 't', trace: traced(3) },
      ]),
    );
    expect([...trace.keys()]).toEqual(['a.test.ts › d > t']);
    expect(trace.get('a.test.ts › d > t')).toMatchObject({ runs: 2, targetReads: 3 });
  });
});

describe('diffTraces', () => {
  it('lists the tests that lost their last run and the new ones', () => {
    // Falsifiable: compare by count instead of by key and a rename passes.
    const before = readTrace(report([
      { file: 'a.test.ts', ancestors: ['d'], title: 'old', trace: traced(1) },
      { file: 'a.test.ts', ancestors: ['d'], title: 'kept', trace: traced(1) },
    ]));
    const after = readTrace(report([
      { file: 'a.test.ts', ancestors: ['d'], title: 'kept', trace: traced(1) },
      { file: 'a.test.ts', ancestors: ['d'], title: 'new', trace: traced(1) },
    ]));
    expect(diffTraces(before, after)).toMatchObject({
      lost: ['a.test.ts › d > old'],
      added: ['a.test.ts › d > new'],
    });
  });

  it('flags a test that reads no pair and is not standalone', () => {
    // Falsifiable: skip the tag check and a forgotten standalone passes.
    const after = readTrace(report([
      { file: 'a.test.ts', ancestors: ['d'], title: 'reads', trace: traced(2) },
      { file: 'a.test.ts', ancestors: ['d'], title: 'alone', trace: traced(0, ['standalone']) },
      { file: 'a.test.ts', ancestors: ['d'], title: 'forgot', trace: traced(0) },
    ]));
    expect(diffTraces(after, after).unread).toEqual(['a.test.ts › d > forgot']);
  });

  it('refuses a report with no trace in it', () => {
    // Falsifiable: a run without BSQ_TEST_TRACE=1 would compare as all-unread.
    expect(() =>
      readTrace(report([{ file: 'a.test.ts', ancestors: [], title: 't' }])),
    ).toThrow(/BSQ_TEST_TRACE/);
  });
});
```

- [ ] **Step 2: Run it, expect red** — `pnpm exec vitest run --configLoader runner --project unit tests/unit/trace-diff.test.ts` → FAIL, cannot find `../../scripts/trace-diff.ts`.

- [ ] **Step 3: Implement `scripts/trace-diff.ts`:**

```ts
#!/usr/bin/env node
/**
 * Compares two traced runs (`BSQ_TEST_TRACE=1 node scripts/test-plan.ts …
 * --json <file>`): the tests present before and absent after, the new ones,
 * and every test of the second run that read no pair and is not standalone
 * (spec 2026-10-12 § 8). A test is keyed by its file's basename, so a file
 * moved out of `isolated/` or `firefox/` keeps its tests.
 *
 *   node scripts/trace-diff.ts <before.json> <after.json>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export type TracedTest = {
  key: string;
  targetReads: number;
  workers: number;
  tags: string[];
  runs: number;
};

type Report = {
  testResults: {
    name: string;
    assertionResults: {
      ancestorTitles: string[];
      title: string;
      meta?: { bsqTrace?: { targetReads: number; workers: number; tags: string[] } };
    }[];
  }[];
};

export function readTrace(json: string): Map<string, TracedTest> {
  const report = JSON.parse(json) as Report;
  const tests = new Map<string, TracedTest>();
  let traced = 0;
  for (const file of report.testResults) {
    for (const result of file.assertionResults) {
      const key = `${basename(file.name)} › ${[...result.ancestorTitles, result.title].join(' > ')}`;
      const trace = result.meta?.bsqTrace;
      if (trace) traced++;
      const seen = tests.get(key);
      tests.set(key, {
        key,
        targetReads: Math.max(seen?.targetReads ?? 0, trace?.targetReads ?? 0),
        workers: Math.max(seen?.workers ?? 0, trace?.workers ?? 0),
        tags: trace?.tags ?? seen?.tags ?? [],
        runs: (seen?.runs ?? 0) + 1,
      });
    }
  }
  if (tests.size > 0 && traced === 0) {
    throw new Error('trace-diff: no test carries a trace — run with BSQ_TEST_TRACE=1');
  }
  return tests;
}

export function diffTraces(
  before: Map<string, TracedTest>,
  after: Map<string, TracedTest>,
): { lost: string[]; added: string[]; unread: string[] } {
  return {
    lost: [...before.keys()].filter((key) => !after.has(key)).sort(),
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    unread: [...after.values()]
      .filter((t) => t.targetReads === 0 && !t.tags.includes('standalone'))
      .map((t) => t.key)
      .sort(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error('usage: node scripts/trace-diff.ts <before.json> <after.json>');
    process.exit(2);
  }
  const { lost, added, unread } = diffTraces(
    readTrace(readFileSync(beforeFile, 'utf8')),
    readTrace(readFileSync(afterFile, 'utf8')),
  );
  for (const [title, keys] of [
    ['Lost (before, not after)', lost],
    ['Added (after, not before)', added],
    ['Read no pair and not standalone', unread],
  ] as const) {
    console.log(`${title} (${keys.length}):${keys.map((k) => `\n  ${k}`).join('')}`);
  }
}
```

- [ ] **Step 4: Run it, expect green** — same command as Step 2 → 4 passed.

- [ ] **Step 5: Count the pair's reads.** In `tests/browser/helpers.ts`, replace the body of `TEST_TARGET` (Serena `replace_symbol_body`) so every read of `vfs` or `build` is counted, and add `takeTargetReads` right after it:

```ts
export const TEST_TARGET: TestTarget = (() => {
  const target = inject('bsqTarget');
  if (target === undefined) {
    throw new Error(
      'TEST_TARGET: this project provides no bsqTarget — a browser project needs a target (tests/target-projects.ts)',
    );
  }
  // Getters, so the trace (tests/browser/trace.ts) can tell a test that
  // follows its pair from one that opens a VFS of its own.
  return Object.freeze({
    get vfs() {
      targetReads++;
      return target.vfs;
    },
    get build() {
      targetReads++;
      return target.build;
    },
  });
})();
```

and, above `TEST_TARGET`, `let targetReads = 0;`; below it:

```ts
/** The reads of `TEST_TARGET` since the last call (the trace's counter). */
export const takeTargetReads = (): number => {
  const reads = targetReads;
  targetReads = 0;
  return reads;
};
```

- [ ] **Step 6: The setup file** — `tests/browser/trace.ts`:

```ts
import { afterEach, beforeEach } from 'vitest';
import { takeTargetReads } from './helpers';

/**
 * Under `BSQ_TEST_TRACE=1` (vitest.config.ts), records for each test how
 * many times it read its pair and how many workers it started, in
 * `task.meta.bsqTrace`, which the JSON reporter keeps
 * (`scripts/trace-diff.ts`). Registered after the guard, whose own reads
 * of the pair the `beforeEach` below discards.
 */
let workers = 0;
const Traced = globalThis.Worker;
globalThis.Worker = class extends Traced {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers++;
  }
} as typeof Worker;

beforeEach(() => {
  takeTargetReads();
  workers = 0;
});

afterEach(({ task }) => {
  task.meta.bsqTrace = {
    targetReads: takeTargetReads(),
    workers,
    tags: [...(task.tags ?? [])],
  };
});
```

- [ ] **Step 7: Declare and wire it.** In `tests/vitest.d.ts`, inside `interface TaskMeta`, add:

```ts
    /** Under BSQ_TEST_TRACE=1: what the test touched (tests/browser/trace.ts). */
    bsqTrace?: { targetReads: number; workers: number; tags: string[] };
```

In `vitest.config.ts`, in `browserProject`'s `setupFiles`, append the trace after the guard:

```ts
      ...(options.target ? ['tests/browser/need-guard.ts'] : []),
      // Last, so the guard's own reads of the pair are discarded.
      ...(options.target && process.env.BSQ_TEST_TRACE === '1'
        ? ['tests/browser/trace.ts']
        : []),
```

- [ ] **Step 8: Prove the trace on one file** — `BSQ_TEST_TRACE=1 node scripts/test-plan.ts --browser chrome --modes not-isolated --json $WS/trace-probe.json tests/browser/realm.test.ts tests/browser/vacuum.test.ts > $WS/trace-probe.log 2>&1`; then `node scripts/trace-diff.ts $WS/trace-probe.json $WS/trace-probe.json`. Expected: lost 0, added 0, "Read no pair and not standalone" lists the four `realm.test.ts` tests (no pair read, not yet standalone) and not `vacuum.test.ts` (it reads its pair through `createTestClient`).

- [ ] **Step 9: The "before" trace** — in the background, with a progress line every 2 minutes: `BSQ_TEST_TRACE=1 node scripts/test-plan.ts --unit --json $WS/trace-before.json > $WS/trace-before.log 2>&1`. Expected: green, as `pnpm test` (2604 passed, 56 skipped on 2026-10-12, plus the four new unit tests). Keep `$WS/trace-before.json` for Task 11.

- [ ] **Step 10: Commit** — `pnpm exec biome check --write` on the five files, `pnpm exec tsc --noEmit`, then `test "$(git branch --show-current)" = test/convert-needs && git add tests/browser/helpers.ts tests/browser/trace.ts tests/vitest.d.ts vitest.config.ts scripts/trace-diff.ts tests/unit/trace-diff.test.ts && git commit -m "test(trace): record which tests read their pair and start workers" -m "Spec § 8 re-runs the trace of the introduction before and after the conversion: no test may lose its last run, and a test that reads no pair must be standalone. The throwaway tool of 2026-10-11 is gone; this one stays, behind BSQ_TEST_TRACE=1." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

### Task 2: `createTestClient(options, pair)` and `sharedDatabase()`

**Files:**
- Modify: `tests/browser/helpers.ts`
- Create: `tests/browser/shared-database.test.ts`

**Interfaces:**
- Consumes: `TEST_TARGET`, `withNativeWorker`, `removeDatabaseFiles` (helpers.ts).
- Produces: `type ClientOptions = Omit<InternalSQLiteClientOptions, 'vfs' | 'build'>`; `createTestClient(options?: TestClientOptions, pair?: TestTarget): Promise<SQLiteDB>` (the old `vfs`/`needs`/`skip` options still accepted until Task 9); `sharedDatabase(): { name: string; open(options?: ClientOptions, spelling?: string): SQLiteDB }`.

- [ ] **Step 1: Write the failing browser test** — `tests/browser/shared-database.test.ts`:

```ts
import { deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { SQLiteError } from '../../src/types/errors';
import { sharedDatabase, TEST_TARGET } from './helpers';

/**
 * `sharedDatabase()` is how a test opens several clients on one database
 * (plan C, decision 4). Its cleanup is what the per-file storage wipe relies
 * on: an IndexedDB database or an AccessHandlePoolVFS slot it left behind
 * would fail the next file.
 */
describe('sharedDatabase', { tags: ['requires:shared-second-client'] }, () => {
  it('opens every client on the same database', async () => {
    // Falsifiable: give `open` a fresh name per call and B sees no table.
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    await a.write('CREATE TABLE t (x)');
    await a.write('INSERT INTO t VALUES (7)');
    const b = db.open({ poolSize: 1 });
    expect(await b.read('SELECT x FROM t')).toEqual([{ x: 7 }]);
  });

  it('deletes the database once the test is over', async () => {
    // Falsifiable: drop the deleteDatabase from the cleanup and this goes red.
    // Registered first, so it runs after sharedDatabase's own cleanup
    // (onTestFinished hooks run in reverse).
    const { vfs, build } = TEST_TARGET;
    let name = '';
    onTestFinished(async () => {
      const error = await deleteDatabase(name, { vfs, build }).catch(
        (e: unknown) => e,
      );
      expect((error as SQLiteError)?.code).toBe('DATABASE_NOT_FOUND');
    });
    const db = sharedDatabase();
    name = db.name;
    await db.open({ poolSize: 1 }).write('CREATE TABLE t (x)');
  });
});
```

- [ ] **Step 2: Run it, expect red** — `node scripts/test-plan.ts --browser chrome --modes not-isolated tests/browser/shared-database.test.ts > $WS/t2.log 2>&1` → FAIL, `sharedDatabase` is not exported (a build error names it).

- [ ] **Step 3: Implement.** In `tests/browser/helpers.ts`:

(a) Extract the cleanup of `createTestClient` into a function placed before it (Serena `insert_before_symbol` on `createTestClient`), moving the long comment about `AccessHandlePoolVFS` with it:

```ts
/**
 * Closes `clients`, then deletes `name` on `pair` and removes its files — the
 * one cleanup of `createTestClient` and `sharedDatabase`.
 */
const cleanUp = async (
  name: string,
  pair: TestTarget,
  clients: readonly SQLiteDB[],
): Promise<void> => {
  // Closing first is what lets the deletion below happen at all —
  // deleteDatabase refuses with DATABASE_IN_USE while a client holds the
  // connection lock. A client the test deliberately poisoned may refuse to
  // close, which is that test's subject, not this cleanup's.
  for (const client of clients) await client.close().catch(() => {});
  // [the AccessHandlePoolVFS comment block, moved verbatim from createTestClient]
  const { storage } = VFS_CAPABILITIES[pair.vfs];
  if (
    storage === 'indexeddb' ||
    (storage === 'opfs' && folderOf(pair.vfs) === undefined)
  ) {
    // IndexedDB keeps its database, and AccessHandlePoolVFS its slot, until
    // deleteDatabase: removing files by name reaches neither.
    await withNativeWorker(() =>
      deleteDatabase(name, { vfs: pair.vfs, build: pair.build }),
    ).catch((error: unknown) => {
      // DATABASE_NOT_FOUND only: the client never got as far as creating
      // the file, or the test deleted it itself. Anything else — a slot
      // this cleanup could not give back — must reach the test.
      if ((error as SQLiteError)?.code !== 'DATABASE_NOT_FOUND') throw error;
    });
  }
  await removeDatabaseFiles(name, pair.vfs);
};
```

The condition widens today's (`storage === 'opfs' && no folder`, AccessHandlePoolVFS alone) to IndexedDB storage, which `removeDatabaseFiles` never reached. `withNativeWorker` is a `const` declared further down the file today: move it (and `NativeWorker`) above `cleanUp`.

(b) Replace `createTestClient` (Serena `replace_symbol_body`):

```ts
/**
 * Creates a SQLite client with a unique database name (UUID) on `pair` —
 * this project's (`TEST_TARGET`) unless a standalone test hands it the pair
 * it resolved — and closes and deletes it when the test ends.
 *
 * Decisions: D-06 (unique name), D-07 (per-test cleanup), D-08 (shared helper).
 * Until plan C's Task 9, `options.vfs` still pins and `options.needs` still
 * resolves through `pairFor`; both go then.
 */
export async function createTestClient(
  options: TestClientOptions = {},
  pair?: TestTarget,
) {
  const dbName = `bsq-test-${crypto.randomUUID()}`;
  const { needs: _needs, skip: _skip, ...clientOptions } = options;
  const resolved: TestTarget =
    pair ??
    (options.vfs === undefined
      ? options.needs === undefined
        ? pairFor()
        : pairFor(options.needs, options.skip)
      : {
          vfs: options.vfs,
          build: options.build ?? defaultBuildFor(options.vfs, AVAILABLE_FEATURES),
        });
  // createSQLiteClient is synchronous — workers initialize in the background.
  // The first query queues until a worker reaches READY.
  const db = createSQLiteClient(dbName, {
    ...clientOptions,
    vfs: resolved.vfs,
    build: resolved.build,
  } as InternalSQLiteClientOptions);
  // onTestFinished, NOT afterEach: afterEach registered from inside a test
  // body is suite-scoped, not test-scoped — under rstest it never ran.
  onTestFinished(() => cleanUp(dbName, resolved, [db]));
  return db;
}
```

and widen `TestClientOptions` so `name` (the client's log name) is accepted: `Omit<InternalSQLiteClientOptions, 'vfs'> & { vfs?: SQLiteVFS } & Needing` (only `'name'` leaves the `Omit`).

(c) Add after `createTestClient`:

```ts
/** What a test may set on a client it opens: everything but where. */
export type ClientOptions = Omit<InternalSQLiteClientOptions, 'vfs' | 'build'>;

/**
 * One database, on this project's pair, that a test opens as many clients on
 * as its subject needs, each when it decides and with its own options;
 * `spelling` opens it under another spelling of the same name (`./name`).
 * Every client is closed and the database deleted when the test ends.
 */
export const sharedDatabase = (): {
  name: string;
  open: (options?: ClientOptions, spelling?: string) => SQLiteDB;
} => {
  const name = `bsq-shared-${crypto.randomUUID()}`;
  const pair: TestTarget = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build };
  const clients: SQLiteDB[] = [];
  onTestFinished(() => cleanUp(name, pair, clients));
  return {
    name,
    open: (options = {}, spelling = name) => {
      const client = createSQLiteClient(spelling, {
        ...options,
        vfs: pair.vfs,
        build: pair.build,
      } as InternalSQLiteClientOptions);
      clients.push(client);
      return client;
    },
  };
};
```

`SQLiteDB` is imported as a type from `'../../src/api'`.

- [ ] **Step 4: Run it, expect green** — Step 2's command, then the same on Firefox (`--browser firefox`) and one IndexedDB pair: `node scripts/test-plan.ts --browser chrome --modes not-isolated --pair IDBBatchAtomicVFS/jspi tests/browser/shared-database.test.ts`. All green, and the storage wipe reports nothing.

- [ ] **Step 5: Run `pnpm test` in the background** (progress every 2 min): the widened cleanup now deletes IndexedDB databases after every IndexedDB test. Expected green.

- [ ] **Step 6: Commit** — `test(helpers): sharedDatabase, and a pair argument for createTestClient`, body: several clients on one database were hand-built in ~20 tests, each with its own cleanup, several of which removed OPFS files only; the conversion takes them to IndexedDB pairs. Standalone tests that sweep pairs hand `createTestClient` the pair they resolved.

### Task 3: needs become tags — the mechanical translation

**Files (modify):** `abandon-transaction`, `barrier` (the four commit-propagation tests), `concurrency`, `early-exit`, `interrupt` (the first three tests), `lifecycle` (the six `two-workers` tests), `long-query`, `params`, `query-timeout`, `routing`, `statement-cache` (the `interruptible` test), `tx-abort`, `tx-quiesce`, `tx-savepoint`, `vacuum`, `writer-spread` — all under `tests/browser/`, each `*.test.ts`.

**The transformation** (one per test, no other change):

```ts
// before
it('frees the worker, so the next query does not wait it out', async ({ skip }) => {
  const db = await createTestClient({ poolSize: 1, debug: true, needs: ['interruptible'], skip });
  …
}, 90_000);
// after
it('frees the worker, so the next query does not wait it out', {
  tags: ['requires:interruptible'],
  timeout: 90_000,
}, async () => {
  const db = await createTestClient({ poolSize: 1, debug: true });
  …
});
```

A module constant that carries the need (`TWO_WORKERS = { poolSize: 2, needs: ['two-workers'] }` in `abandon-transaction` and `tx-quiesce`; `forced` in `barrier`) loses `needs`; a `setUp(options: Needing)` helper (`tx-abort`, `tx-savepoint`) loses its parameter and the `Needing` import. A comment that explains the fallback or the skip (`concurrency` L310-313, `long-query` L49-53, …) is rewritten to state the need, or removed when the tag says it.

| File | Tests | Tags |
|---|---|---|
| abandon-transaction | all 3 | `requires:two-workers` (on the describe) |
| barrier | commit-propagation barrier › the 4 tests | `requires:two-workers` (on that describe) |
| concurrency | lock() blocking behavior (D-09) › both workers with poolSize: 2 reach READY | `requires:two-workers` |
| early-exit | both | `requires:interruptible` (describe) |
| interrupt | frees the worker…; still rejects immediately…; leaves nothing broken behind | `requires:interruptible` each |
| lifecycle | onWorkerLost callback › is called when a worker slot is permanently lost; a throwing callback does not break the pool; startup readiness gate › reports a slot that opened and then dies…; fails the client rather than hanging…; fires onWorkerLost for every slot…; does not report a slot as lost…; rejects db.ready when the pool is empty at gate-open… | `requires:two-workers` each |
| long-query | gives the caller back control…; does not terminate the worker it abandoned | `requires:two-workers`, `requires:interruptible` |
| params | rebinds a cached statement after an aborted query | `requires:interruptible` |
| query-timeout | rejects with OPERATION_TIMEOUT…; spends the budget over the whole call…; lets the caller signal win…; spends the budget while the call is still queued | `requires:interruptible` each |
| routing | write() accepts a read statement and routes it to the writer | `requires:two-workers` |
| statement-cache | an aborted query leaves its cached statement reusable | `requires:interruptible` |
| tx-abort | costs no worker…; undoes a caught abandoned write, and the transaction goes on (async); does not abandon the transaction for an abandoned read (R7); undoes a caught write issued through tx.first(), and goes on | `requires:interruptible` each |
| tx-quiesce | all 6 | `requires:two-workers` (both describes) |
| tx-savepoint | cuts the write, keeps nothing… (T3); cuts an abandoned write when the transaction's own timeout expires (T4) | `requires:interruptible` each |
| vacuum | has shrunk its files in OPFS when the write resolves | `requires:in-place-file` |
| writer-spread | both | `requires:two-workers` (describe) |

- [ ] **Step 1:** Apply the transformation file by file (Serena `replace_content` with a regex per test); `pnpm exec biome check --write` on each.
- [ ] **Step 2:** `pnpm exec tsc --noEmit` and `grep -n "needs:\|{ skip }" <the 16 files>` → nothing left.
- [ ] **Step 3:** `node scripts/test-plan.ts <the 16 files> > $WS/t3.log 2>&1` in the background (both browsers, both modes, complement). Green. The plan printed at the top shows these tests only on eligible pairs.
- [ ] **Step 4: Commit** — `test(browser): the declared needs become tags`, body: a need resolved at run time (`pairFor`'s fallback) moved a test to another pair and reported it under the target's name; as a tag the planner places it.

### Task 4: tests that resolved a need by hand follow their pair

**Files (modify):** `cross-tab`, `database-pragmas`, `debug`, `failed-client`, `inspect-marker`, `inspect-realm`, `inspect-write`, `inspect`, `multi-client`, `statement-cache`, `default-build`.

The pattern: `pairFor(NEEDS, skip)` (or a local helper wrapping it: `oneClient(skip)`, `twoClients(skip)`, `failedClient(skip)`, `shared(skip)`) becomes the tag on the test plus `TEST_TARGET` inside the test or helper; two clients on one name become `sharedDatabase()`.

| File | Test(s) | Tags | Body |
|---|---|---|---|
| cross-tab | all 4 | `requires:shared-second-client` (describe) | `oneClient()` and the first test read `const { vfs, build } = TEST_TARGET`; drop `NEEDS`, `skip`, `Skip` |
| database-pragmas | a pragma that writes the database › all 3 | `requires:shared-second-client` (describe; decision 1) | test 1: `const db = sharedDatabase(); const a = db.open({...}); const b = db.open({ pragmas: { ...('busy_timeout' in VFS_CAPABILITIES[TEST_TARGET.vfs].refusedPragmas ? {} : { busy_timeout: '100' }), … } })` (decision 9) — its manual `deleteDatabase` goes; tests 2-3: `createTestClient({ pragmas: … })` |
| debug | the cross-tab write lock in the history › shows a write waiting… | `requires:shared-second-client` | `twoClients()` → `sharedDatabase()`, `poolFor(TEST_TARGET.vfs)` for the pool size |
| debug | debug subsystem › names the client the way its log lines are prefixed | — | `createTestClient({ name: 'ledger', debug: true })` (the hand-built client and its fixed file go) |
| failed-client | lets the database be deleted, before close; lets a new client open, before close | `requires:shared-storage` | `failedClient()` reads `TEST_TARGET` |
| failed-client | holds no connection lock when the failure races its grant | `requires:shared-second-client` | `const pair = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build }` in the body |
| inspect-marker | is held while…; releases the marker when close() races…; is gone once the client fails…; releases the marker when the failure races…; does not change what deleteDatabase reports | `requires:shared-storage` each | the `shared(skip)` helper goes; `TEST_TARGET` in each body |
| inspect-realm | matches the realm holding our own client marker | `requires:shared-storage` | `TEST_TARGET` |
| inspect-write | is empty when nobody writes | `requires:shared-storage` | `TEST_TARGET.vfs` |
| inspect | all 4 | `requires:shared-storage` (describe) | `TEST_TARGET` in each body; drop `skip` |
| multi-client | two clients writing at once › all 4 | `requires:shared-second-client` (describe) | `twoClients()` → `sharedDatabase()` with `poolFor(TEST_TARGET.vfs)`; reword the header (L6-29) and drop the stale sentence at L262-264 |
| statement-cache | ends the read transaction of a statement abandoned by first() | `requires:shared-second-client` | `sharedDatabase()`, both clients `{ poolSize: 1 }` |
| default-build | falls back to the first declared build that requires nothing | — | `const { vfs } = TEST_TARGET` |
| default-build | keeps an explicit build where the engine could run a preferred one | `build:async` | `const { vfs, build } = TEST_TARGET`; `build` replaces the three `'async'` literals |

- [ ] **Step 1:** Convert each file; `biome check --write`.
- [ ] **Step 2:** `tsc --noEmit`; `grep -n "pairFor\|Skip\b" <the 11 files>` → nothing.
- [ ] **Step 3:** `node scripts/test-plan.ts <the 11 files>` in the background; green. A failure on a pair these tests never reached before goes through Task 10's triage, not into this task.
- [ ] **Step 4: Commit** — `test(browser): tests that resolved a need by hand follow their pair`.

### Task 5: a VFS that stood for a capability becomes the property

**Files (modify):** `barrier`, `default-pragmas`, `delete`, `exclusive-connection`, `lifecycle`, `inspect-client`, `inspect-marker`, `inspect-write`, `output`, `interrupt`, `write-lock-reclaim`, `firefox/handle-starvation`.

| File | Test | Tags | Body / name |
|---|---|---|---|
| barrier | barrier — two clients in one tab › client B observes client A's schema change | `requires:shared-second-client` | `sharedDatabase()`; `sharedFile` goes |
| barrier | › treats two spellings of one file as one database | `requires:shared-second-client` | `db.open({}, \`./${db.name}\`)` for the second client |
| default-pragmas | applies nothing on a VFS that declares no defaults | `excludes:default-pragmas` | `createTestClient({ poolSize: 1 })` |
| delete | still deletes on the memory VFS with a client open — nothing is shared there | `excludes:shared-storage` | `TEST_TARGET`; **renamed** "still deletes with a client open where nothing is shared" |
| exclusive-connection | the describe | — | **renamed** "the exclusive connection guard"; `closeAll` takes the pair from `TEST_TARGET` |
| exclusive-connection | makes the second client fail BUSY on its first query, not silently succeed | `requires:exclusive-connection` | clients through `sharedDatabase()`; the message regex `new RegExp(TEST_TARGET.vfs)` |
| exclusive-connection | fails fast — within 3 seconds, not after a timeout stall | `requires:exclusive-connection` | same; **renamed** "fails fast, not after a timeout stall" (the bound is 10 s) |
| exclusive-connection | allows a new client after the first is closed | `requires:exclusive-connection` | same |
| exclusive-connection | lets two clients coexist on a shared-mode VFS, and both hold the lock | `requires:shared-second-client` | `sharedDatabase()`; `options.vfs` → `TEST_TARGET.vfs`; **renamed** "lets two clients coexist where the database is shared, and both hold the lock" |
| exclusive-connection | takes no connection lock on the memory VFS | `excludes:shared-storage` | `createTestClient({ poolSize: 1 })`; **renamed** "takes no connection lock where nothing is shared" |
| exclusive-connection | does not block a second client on OPFSAdaptiveVFS (control) | `requires:shared-second-client` | `sharedDatabase()`; **renamed** "does not block a second client where the database is shared (control)" |
| lifecycle | worker lifecycle — bounds › rejects a second client with BUSY instead of crashing its workers | `requires:exclusive-connection` | `sharedDatabase()`; the describe's `afterEach` and `let shared` go |
| inspect-client | db.inspect › splits self from siblings | `requires:shared-second-client` | `sharedDatabase()`; `VFS` const goes |
| inspect-marker | gives one marker per client in the same tab | `requires:shared-second-client` | `sharedDatabase()`; `SHARED_FILE_VFS` goes |
| inspect-marker | holds no marker on the memory VFS | `excludes:shared-storage` | `createTestClient({ poolSize: 1 })`; **renamed** "holds no marker where nothing is shared" |
| inspect-write | names the writing tab and counts who waits | `requires:shared-second-client` | `sharedDatabase()`; the pin comment L21-25 goes |
| output | does not collect a staging table that is still in flight | `requires:shared-second-client` | `sharedDatabase()` (its `removeDatabaseFiles` cleanup goes) |
| interrupt | rejects an aborted read at once, and lets its statement run on, on a sync build without isolation | `build:sync`, `excludes:interruptible` | `createTestClient({ poolSize: 1, debug: true, drainTimeout: 2_000 })`; the "One VFS" comment L171-177 goes |
| write-lock-reclaim | close() releases the write lock a stuck transaction still holds; names another tab when the holder is in another realm | `requires:idb-storage` | `const { vfs, build } = TEST_TARGET` in each body and in `stuckTransaction`; `VFS` const goes; the header keeps its reason ("no OPFS handle in play") |
| write-lock-reclaim | names this tab when the holder is a transaction in this page | `requires:idb-storage`, `requires:shared-second-client` | same |
| firefox/handle-starvation | fails the second client with TIMEOUT while a write transaction holds the handle | `requires:env-capped-pool`, `requires:shared-second-client` | `TEST_TARGET`; `VFS` const goes (the second property keeps OPFSWriteAheadVFS out on Firefox, where a second client is refused with DATABASE_IN_USE) |

- [ ] **Step 1:** Convert each file; `biome check --write`.
- [ ] **Step 2:** `tsc --noEmit`; `grep -nE "'(OPFS|IDB|AccessHandle|Memory)[A-Za-z]*VFS'" <the 12 files>` → only in comments that state a fact, never in code.
- [ ] **Step 3:** `node scripts/test-plan.ts <the 12 files>` in the background. Failures on newly reached pairs are noted for Task 10, not fixed here; the run must at least plan without error.
- [ ] **Step 4: Commit** — `test(browser): a VFS that stood for a capability becomes its property`.

### Task 6: the VFS that is the subject becomes a `vfs:` tag

**Files (modify):** `barrier`, `coopsync-handover`, `coopsync-retry`, `database-pragmas`, `default-pragmas`, `delete`, `exclusive-connection`, `open-retry`, `second-client`, `vfs-create-retry`, `idb-long-read`.

| File | Test | Tags | Body |
|---|---|---|---|
| barrier | catch-up pragma › closes the pragma the barrier opens on OPFSWriteAheadVFS | `vfs:OPFSWriteAheadVFS`, `requires:two-workers` | `createTestClient({...})` without `vfs`; the `HAS_UNSAFE_HANDLES` skip and its import go (`two-workers` is that condition) |
| coopsync-handover | the 3 tests | `vfs:OPFSCoopSyncVFS` (already) | `open`/`scrub` keep reading `TEST_TARGET` inside the functions — nothing else; or `sharedDatabase()` where a test opens two clients on one name |
| coopsync-retry | does not surface the transfer BUSY to the caller | `vfs:OPFSCoopSyncVFS` | `sharedDatabase()`; the three literals go |
| database-pragmas | a pragma the VFS refuses › is refused in a statement that sets it… | `vfs:OPFSCoopSyncVFS` | `createTestClient(…)`; the describe-scope `vfs` const goes |
| default-pragmas | per-VFS default pragmas › the first three tests | `vfs:AccessHandlePoolVFS` (describe) | `modesOf` uses `createTestClient({ poolSize: 1, pragmas })`; `scrubVfsDirectory` keeps the VFS's directory name, read from `TEST_TARGET.vfs`; the stale header sentence ("the only VFS that declares any") is corrected |
| delete | deleting after a worker died inside a statement › deletes a database whose worker was killed mid-statement | `vfs:AccessHandlePoolVFS` | `TEST_TARGET`; the describe-scope `vfs` const goes |
| exclusive-connection | does not orphan workers when close() is called before any query | `vfs:AccessHandlePoolVFS` | `sharedDatabase()` |
| open-retry | opening a database whose file is momentarily held › succeeds once the holder lets go | `vfs:OPFSCoopSyncVFS` | `TEST_TARGET` for the clients and `databasePath`; `VFS` const goes |
| open-retry | opening a database whose file is refused for another reason › fails without waiting out the retry budget | `requires:opfs-file`, `requires:exclusive-file-handle` | same |
| second-client | a client whose worker 0 is lost before it answers the probe › fails the client… | `vfs:OPFSWriteAheadVFS` | `TEST_TARGET` (vfs and build); `poolSize: 2` kept |
| second-client | a client closed before worker 0 has answered › closes promptly… | `vfs:OPFSWriteAheadVFS` | `TEST_TARGET` |
| vfs-create-retry | opens once the held file is let go | `vfs:AccessHandlePoolVFS` | `createTestClient()` twice; `poolFiles(dir)` takes `creator.vfs`; `VFS` const goes |
| idb-long-read | serves a read from another worker without a signal | `vfs:IDBBatchAtomicVFS` (already) | unchanged (it reads `TEST_TARGET` inside the test) |

Steps 1-4 as Task 5; commit `test(browser): the VFS a test is about becomes its vfs tag`.

### Task 7: standalone tests, delete's representatives, splits and merges

**Files (modify):** `realm`, `guard-name`, `inspect-realm`, `features`, `vfs`, `delete`, `statement-errors`, `second-client`, `inspect-client`, `vfs-folders`, `wasm-url`, `abandon`, `init`, `params`, `pool-death`, `pool-savepoint`.

**Standalone, no VFS** — add `{ tags: ['standalone'] }` (describe or test):
- `realm` (describe, 4 tests); `guard-name` (1); `inspect-realm` › is stable across calls; `features` › never reports what no page can probe; `vfs` › vfs is required (describe, 2); `delete` › rejects with INVALID_OPTION when vfs is missing.

**Standalone sweeps** (tags already `standalone`…):
- `statement-errors`: `memoryClient(vfs, build, pragmas?)` becomes `createTestClient({ poolSize: 1, ...pragmas }, { vfs, build })`.
- `vfs` › every wired VFS: `createTestClient({}, { vfs, build: defaultBuildFor(vfs, AVAILABLE_FEATURES) })`.

**delete's representatives become pair tests** (decision 6) — `removes a closed database`, `rejects with BUSY while the init lock is held`, `releases the lock after a rejection, so a retry is possible`, `refuses a delete issued in the same task as a client construction`: each `{ tags: ['requires:shared-storage'] }`, `const { vfs, build } = TEST_TARGET` in the body in place of `'OPFSAdaptiveVFS'`, `tableCount(file, vfs, build)` takes the pair, and the `created`/`afterEach` scrub of the first describe becomes `sharedDatabase()` (its `name` is the file). The comment "One VFS: … the full cross-VFS sweep is below" goes.

**delete's splits** — in "deleteDatabase on a database that is not there", the describe-scope `const { vfs, build } = TEST_TARGET` moves into each test, and:
- "throws DATABASE_NOT_FOUND when nothing was created" keeps its name with `requires:shared-storage` (the error branch); a new test **"resolves when nothing was created, where nothing is kept"** with `excludes:shared-storage` takes the memory branch.
- "deletes, then reports the second attempt" keeps its name with `requires:shared-storage`; a new **"deletes, then deletes again without error, where nothing is kept"** with `excludes:shared-storage`.
- `VFS_CAPABILITIES` leaves the file's imports if nothing else uses it.
- "deletes a database that was opened but never written", "leaves no OPFS entry…", and the live-connection describe read `TEST_TARGET` inside each test (`liveClient()` reads it itself).

**second-client's split** — the bare block (L140-224) and `secondClientOutcome` go; `scenario(shape)` becomes three factories, one per outcome, each building its database with `sharedDatabase()`. Six tests replace two, under the describe "a second client on the target":

| Test | Tags |
|---|---|
| built together, shares the database | `requires:shared-second-client` |
| built together, is refused | `requires:exclusive-connection` |
| built together, gets a database of its own | `excludes:shared-storage` |
| built after the first write, shares the database | `requires:shared-second-client` |
| built after the first write, is refused | `requires:exclusive-connection` |
| built after the first write, gets a database of its own | `excludes:shared-storage` |

The refused tests keep the expected message computed from `VFS_CAPABILITIES[vfs].exclusiveConnectionWithout` and `AVAILABLE_FEATURES` (decision 9).

**Merges** (decision 7):
- `inspect-client`: delete the describe "db.inspect on a memory VFS" and its test.
- `vfs`: the describes "AccessHandlePoolVFS pool guard" and "OPFSCoopSyncVFS pool guard" become one, **"a VFS that caps its pool"**, `{ tags: ['requires:capped-pool'] }`, with two tests: **"defaults to the VFS cap rather than throwing when poolSize is omitted"** (`createTestClient()`, `expect(db.poolSize).toBe(VFS_CAPABILITIES[TEST_TARGET.vfs].maxPoolSize)`) and **"accepts poolSize 1 and serves queries"** (`createTestClient({ poolSize: 1 })`). Delete the describe "vfs/build combination guard".

**Module- or describe-scope reads move into the tests:** `vfs-folders` (L10), `wasm-url`'s `open()` and L39 already read inside; `abandon` › does not stop the live query…, `init` › supports poolSize: 1, `params` (last two), `pool-death`, `pool-savepoint` read `TEST_TARGET` inside functions called by the test — unchanged.

- [ ] **Step 1:** Convert; `biome check --write`; `tsc --noEmit`.
- [ ] **Step 2:** `grep -rn "TEST_TARGET" tests/browser/*.test.ts tests/browser/*/*.test.ts | grep -v "^\S*:\s*\(//\|\*\)"` and check by eye that none sits at module or describe scope.
- [ ] **Step 3:** `node scripts/test-plan.ts <the 16 files>` in the background; green except newly reached pairs (Task 10).
- [ ] **Step 4: Commit** — `test(browser): standalone tests, delete's representatives, and the splits`.

### Task 8: `firefox/` and `isolated/` flattened; the isolated precondition

**Files:**
- Move: `tests/browser/firefox/handle-starvation.test.ts` → `tests/browser/handle-starvation.test.ts`; `firefox/stream-retention.test.ts` → `stream-retention.test.ts`; `isolated/abort-slot.test.ts` → `abort-slot.test.ts`; `isolated/tx-savepoint.test.ts` → `tx-savepoint-cut.test.ts` (decision 11).
- Delete: `tests/browser/isolated/environment.test.ts`.
- Create: `tests/browser/isolation-check.ts`.
- Modify: `vitest.config.ts`, the moved files (relative imports `../helpers` → `./helpers`).

- [ ] **Step 1: Move** with `git mv`, fix the imports.
- [ ] **Step 2: Tags of the moved files:**
  - `stream-retention`: describe `{ tags: ['browser:firefox'] }` (an engine behaviour no probe detects, spec D9).
  - `abort-slot` (both describes) and `tx-savepoint-cut` (its describe): `['build:sync', 'requires:interruptible']` in place of `['vfs:OPFSWriteAheadVFS', 'build:sync', 'isolated']` (the property already means isolation on `sync`); every `createTestClient({ vfs: 'OPFSWriteAheadVFS', build: 'sync', … })` loses `vfs` and `build`; the "One VFS" comments go; `tx-savepoint-cut`'s `crossOriginIsolated` assertion (L36) goes (the tags guarantee it).
- [ ] **Step 3: The precondition** — `tests/browser/isolation-check.ts`:

```ts
import { beforeAll } from 'vitest';

/**
 * The isolated projects' precondition (spec § 3): a project that declares
 * itself isolated and is not would run every `requires:interruptible` test
 * of a `sync` pair against a build that cannot cut a step. Not a test of the
 * library — it fails the file, by name, before any of its tests.
 */
beforeAll(async () => {
  if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== 'function') {
    throw new Error(
      'ISOLATION_MISSING: this isolated project is not cross-origin isolated (COOP/COEP headers, vitest.config.ts)',
    );
  }
  const worker = new Worker(
    URL.createObjectURL(
      new Blob(
        [
          `self.onmessage = (e) => { const v = new Int32Array(e.data);
             Atomics.store(v, 0, 7); self.postMessage(Atomics.load(v, 0)); };`,
        ],
        { type: 'application/javascript' },
      ),
    ),
  );
  try {
    const seen = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage(new SharedArrayBuffer(8));
    });
    if (seen !== 7) {
      throw new Error(`ISOLATION_MISSING: a SharedArrayBuffer did not reach a worker (read ${String(seen)})`);
    }
  } finally {
    worker.terminate();
  }
});
```

- [ ] **Step 4: The config.** In `vitest.config.ts`: `ENGINE_DIR` goes; both target projects of a pair include `['tests/browser/*.test.ts']`; the isolated one adds `'tests/browser/isolation-check.ts'` to its `setupFiles` (a new `isolated` branch in `browserProject`'s `setupFiles`, before the guard).
- [ ] **Step 5:** `tsc --noEmit`; `node scripts/test-plan.ts --browser chrome --modes isolated --full > $WS/t8.log 2>&1` in the background: the isolated cells now hold every test isolation makes eligible (`requires:interruptible` on `sync` pairs); green except Task 10's triage. Then `pnpm test` in the background.
- [ ] **Step 6: Commit** — `test(browser): firefox/ and isolated/ join tests/browser/`, body: since the planner, a directory decides nothing; the isolated projects check their isolation before their first test.

### Task 9: the old API goes; one project per pair; the static check grows

**Files:**
- Modify: `tests/browser/helpers.ts`, `tests/browser/target.ts`, `tests/target-projects.ts`, `tests/vitest.d.ts`, `vitest.config.ts`, `scripts/plan-io.ts`, `scripts/test-plan.ts`, `tests/unit/target-projects.test.ts`, `tests/unit/static-tests.test.ts`
- Delete: `tests/browser/helpers/vfs-contract.ts`, `tests/unit/test-target.test.ts`

- [ ] **Step 1: Failing unit tests first.**
  - `tests/unit/target-projects.test.ts` becomes:

```ts
import { describe, expect, it } from 'vitest';
import type { SQLiteBuild } from '../../src/const/builds';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import { allTargets, targetLabel } from '../target-projects';

describe('allTargets', () => {
  it('is every declared (vfs, build) pair, in declaration order', () => {
    // Falsifiable: keep the recommended VFS alone and the matrix loses 20 pairs.
    expect(allTargets().map(targetLabel)).toEqual(
      (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).flatMap((vfs) =>
        (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map(
          (build) => `${vfs}/${build}`,
        ),
      ),
    );
  });
});
```

  - `tests/unit/static-tests.test.ts`: append two entries to `FORBIDDEN` and one test fixing them:

```ts
  [
    /\b(it|test|describe)(\.\w+)*\(\s*[A-Za-z_$][\w$.]*\s*,/,
    'a test whose name is not a literal: the parser reads the identifier, and every planned run fails as dynamic',
  ],
  [
    /\bif\s*\([^)]*\)\s*\{?\s*(it|test|describe)(\.\w+)*\s*\(/,
    'a test behind an if: tag its need instead',
  ],
```

```ts
  it('refuses the constructs it lists', () => {
    // Falsifiable: break one pattern and its sample passes.
    const samples = [
      "const x = cond ? it : it.skip;",
      "it.each([1])('t', () => {});",
      "it(name, () => {});",
      "if (ok) {\n  it('t', () => {});\n}",
    ];
    for (const sample of samples) {
      expect(FORBIDDEN.some(([pattern]) => pattern.test(sample))).toBe(true);
    }
    expect(FORBIDDEN.some(([p]) => p.test("it('t', { tags: ['standalone'] }, () => {});"))).toBe(false);
  });
```

  Run `pnpm exec vitest run --configLoader runner --project unit tests/unit/target-projects.test.ts tests/unit/static-tests.test.ts` → red (`allTargets` missing; the new patterns may also flag real files — fix those files' tests to literal names).

- [ ] **Step 2: Remove.**
  - `tests/target-projects.ts`: keep `targetLabel`; add `export const allTargets = (): TestTarget[] => …` (every declared pair, as the old `'all'` branch); delete `CHROMIUM_FEATURES`, `FIREFOX_FEATURES`, `targetsFromEnv`, `onUnmetFromEnv`, `parseTarget`.
  - `vitest.config.ts`: projects from `allTargets()` for both browsers; `FEATURES`, `onUnmet` and `bsqNeeds` go.
  - `tests/vitest.d.ts`: `bsqNeeds` goes.
  - `tests/browser/target.ts`: keep `TestTarget` only.
  - `tests/browser/helpers.ts`: `pairFor` (three overloads), `ON_UNMET_NEED`, `HERE`, `Skip`, `Needing`, the `vfs`/`needs`/`skip` options of `createTestClient` (now `options: ClientOptions = {}, pair: TestTarget = TEST_TARGET`), and the imports they used go. `TestClientOptions` is replaced by `ClientOptions`.
  - `tests/browser/helpers/vfs-contract.ts` and `tests/unit/test-target.test.ts`: `git rm`.
  - `scripts/plan-io.ts` (`process.env.BSQ_TEST_TARGETS = 'all'`) and `scripts/test-plan.ts` (`BSQ_TEST_TARGETS: 'all'` in the child env): removed — the config no longer reads it; `test-plan.ts` keeps reading `BSQ_TEST_TARGETS` for its own start pairs.
- [ ] **Step 3:** `tsc --noEmit` — every leftover pin, `needs` or `pairFor` is now a type error: fix each by the rule of Tasks 3-7. Then the unit tests of Step 1 → green, and `pnpm exec vitest run --configLoader runner --project unit` → green.
- [ ] **Step 4:** `grep -rn "BSQ_TEST_NEEDS\|bsqNeeds\|pairFor\|resolvePair\|onUnmetFromEnv\|CHROMIUM_FEATURES" --include=*.ts --include=*.md . | grep -v "node_modules\|tests/build\|docs/superpowers\|\.serena"` → nothing.
- [ ] **Step 5:** `pnpm test` in the background; green except Task 10's triage list.
- [ ] **Step 6: Commit** — `test(browser): pinning, the need fallback and BSQ_TEST_NEEDS are gone` (no `!`: nothing a consumer gets changes), body: a test runs on its cell's pair or not at all (spec D2); one project per declared pair whatever the environment, so the planner alone chooses.

### Task 10: run the plan and the matrix; triage the new coverage

- [ ] **Step 1:** `pnpm test` (background, progress every 2 min) and `pnpm test:matrix` (background, ~14 min). Read both reports, the plan's dead list (must be empty: the matrix fails on any), the not-applicable lists, and the "Skipped with a reason" section.
- [ ] **Step 2: Triage each red test on its own (spec § 8).** For each: re-run the cell alone (`node scripts/test-plan.ts --browser <b> --modes <m> --pair <vfs/build> <file>`) — a timing failure under load is not a defect (`mem:conventions`, reading a red cell). Then classify:
  - **a test assumption** (the test asserts something the pair legitimately does differently): fix the TAG so the test runs where its subject exists, and say why in the commit body. Never loosen an assertion to make a pair pass.
  - **a library defect**: stop, report it to the user with the failing output, the pair, and a reproduction; it becomes a `mem:follow-ups` entry and the user decides. Do not fix the library on this branch.
- [ ] **Step 3:** Commit each tag fix on its own: `test(<file>): <what the test needs> (found on <pair>)`.
- [ ] **Step 4:** Both runs green (or the user's decision recorded for each defect), the wdio orphan check at 0.

### Task 11: the "after" trace

- [ ] **Step 1:** `BSQ_TEST_TRACE=1 node scripts/test-plan.ts --unit --json $WS/trace-after.json > $WS/trace-after.log 2>&1` (background).
- [ ] **Step 2:** `node scripts/trace-diff.ts $WS/trace-before.json $WS/trace-after.json > $WS/trace-diff.txt`. Expected, exactly:
  - **Lost:** `exclusive-connection.test.ts › AccessHandlePoolVFS exclusive connection guard > …` (its 7 tests, renamed under "the exclusive connection guard"); `delete.test.ts › deleteDatabase under a live connection > still deletes on the memory VFS with a client open — nothing is shared there`; `second-client.test.ts › a second client on the target > built together` and `› … > built after the first write`; `inspect-client.test.ts › db.inspect on a memory VFS > throws INVALID_OPTION — two memory clients are two databases`; `inspect-marker.test.ts › the client liveness marker > holds no marker on the memory VFS`; `vfs.test.ts › AccessHandlePoolVFS pool guard > …` (2), `› OPFSCoopSyncVFS pool guard > …` (1), `› vfs/build combination guard > …` (1); `environment.test.ts › …` (2); `tx-savepoint.test.ts › a savepointed write on the sync isolated build (spec 2026-09-11) > …` (2, moved to `tx-savepoint-cut.test.ts`).
  - **Added:** the 7 renamed `exclusive-connection` tests; `delete`'s renamed test and its two new ones; `second-client`'s six; `inspect-marker`'s renamed test; `vfs`'s two `a VFS that caps its pool` tests; `tx-savepoint-cut.test.ts`'s two; `shared-database.test.ts`'s two.
  - **Read no pair and not standalone:** none.
  Anything else in "Lost" is a test that lost its last run: find why (a tag that excludes every pair, a file outside the includes) and fix it before going on.
- [ ] **Step 3:** Copy the three lists into the report of Task 12 (not into the repository).

### Task 12: memories, report, merge on approval

- [ ] **Step 1: Memories** (Serena `edit_memory`):
  - `stack-and-build`: § Test suites — pinning, `pairFor`, `BSQ_TEST_NEEDS` gone; one project per declared pair always; `createTestClient(options, pair)`, `sharedDatabase()`; the trace (`BSQ_TEST_TRACE=1`, `scripts/trace-diff.ts`); `firefox/`/`isolated/` gone and the isolation check; the table's rows for `firefox/` and `isolated/` updated; the paragraph "No test file enumerates VFS" rewritten for tags.
  - `follow-ups/test-planner-design`: step 5 done (`test/convert-needs`, merge SHA), the decisions of 2026-10-13 (this plan's § Decisions) in one paragraph, the triage outcomes, what step 6 still carries.
  - `history/2026-10`: one row.
  - `mem:state` baseline re-measured on sight if stale (`mem:conventions`).
- [ ] **Step 2:** Commit the memories on the branch (`docs(memory): …`).
- [ ] **Step 3: Report to the user** (French): what changed, counts (tests before/after, cells of `pnpm test` and of the matrix, durations), the trace diff, the triage, anything not done. **Stop. Merge only on the user's approval**, then `git switch main && git merge --no-ff test/convert-needs` in the background (its hook runs `pnpm test`), branch deleted after `git merge-base --is-ancestor`.

---

## Branch 2 — `ci/test-planner` (step 6)

### Task 13: the planner plans without running; dead fails CI

**Files:**
- Create: `scripts/plan-report.ts`, `tests/unit/plan-report.test.ts`
- Modify: `scripts/test-plan.ts`

**Interfaces:**
- Produces: `deadIsFatal(run: { mode: 'complement' | 'all-pairs'; explicitPairs: boolean; browsers: number; modes: number }, ci: boolean): boolean`; `test-plan.ts --plan-only` (plan, print, check, exit before running anything); `--pairs-out <file>` (writes `["vfs/build", …]`, the pairs with at least one non-empty cell, in canonical order).

- [ ] **Step 0:** `git switch main && git switch -c ci/test-planner`.
- [ ] **Step 1: Failing test** — `tests/unit/plan-report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deadIsFatal } from '../../scripts/plan-report.ts';

const full = { mode: 'all-pairs', explicitPairs: false, browsers: 2, modes: 2 } as const;

describe('deadIsFatal', () => {
  it('fails a full all-pairs run, locally or in CI', () => {
    expect(deadIsFatal(full, false)).toBe(true);
  });

  it('fails a full complement run in CI only, where both browsers are certain', () => {
    // Falsifiable: drop the CI case and verify never sees a dead test (spec § 4).
    const complement = { ...full, mode: 'complement' } as const;
    expect(deadIsFatal(complement, true)).toBe(true);
    expect(deadIsFatal(complement, false)).toBe(false);
  });

  it('never fails a run narrowed to some pairs, browsers or modes', () => {
    expect(deadIsFatal({ ...full, explicitPairs: true }, true)).toBe(false);
    expect(deadIsFatal({ ...full, browsers: 1 }, true)).toBe(false);
    expect(deadIsFatal({ ...full, modes: 1 }, true)).toBe(false);
  });
});
```

Red: module missing.

- [ ] **Step 2: Implement** `scripts/plan-report.ts`:

```ts
/**
 * Whether a dead test (eligible on no pair of any selected browser) fails the
 * run (spec 2026-10-12 § 4). Only a run that saw every pair of both browsers
 * in both modes can call a test dead; locally a browser may simply be absent,
 * so a complement run fails on it only in CI, where both browsers are
 * installed and `verify` runs it.
 */
export const deadIsFatal = (
  run: {
    mode: 'complement' | 'all-pairs';
    explicitPairs: boolean;
    browsers: number;
    modes: number;
  },
  ci: boolean,
): boolean =>
  !run.explicitPairs &&
  run.browsers === 2 &&
  run.modes === 2 &&
  (run.mode === 'all-pairs' || ci);
```

and in `scripts/test-plan.ts`: the `fatal` computation of the dead block becomes `deadIsFatal({ mode: options.mode, explicitPairs: Array.isArray(options.pairs), browsers: options.browsers.length, modes: options.isolatedModes.length }, process.env.CI === 'true')`; move the dead block before `// --- Run` so `--plan-only` reaches it; parse `--plan-only` and `--pairs-out <file>` in `parseArgs` (two new `Options` fields); after the not-runnable check, `if (options.pairsOut) writeFileSync(options.pairsOut, JSON.stringify(nonEmptyPairs))` where `nonEmptyPairs` is the distinct `${cell.vfs}/${cell.build}` of `plan.cells` in `allPairs()` order; `if (options.planOnly) { process.exitCode = status; return; }`.

- [ ] **Step 3:** unit test green; `node scripts/test-plan.ts --mode all-pairs --plan-only --pairs-out $WS/pairs.json` → prints the plan, exits 0, `pairs.json` lists the pairs with tests. Then fake a dead test (a scratch `it` tagged `vfs:MemoryVFS` + `requires:shared-storage` in a throwaway copy under `tests/browser/`, never committed) → the same command exits 1 naming it; remove the scratch file.
- [ ] **Step 4: Commit** — `feat(test-plan): plan without running, and fail CI on a dead test`.

### Task 14: the matrix workflow plans first and runs on every push of `main`

**Files:** `.github/workflows/matrix.yaml`, `.github/workflows/ci.yaml`

- [ ] **Step 1: `matrix.yaml`.**
  - `on:` gains `push: branches: [main]`; a `concurrency: { group: matrix-${{ github.ref }}, cancel-in-progress: true }` so a new push of `main` supersedes the previous run (a tag's run from the release is its own ref).
  - The `pairs` job becomes `plan`: checkout, pnpm, node, install, the WebdriverIO cache, the AppArmor step and `node scripts/browsers.ts install` (copied from `cells`, the probes open both browsers), then `id: list` runs `node scripts/test-plan.ts --mode all-pairs --plan-only --pairs-out pairs.json` and `echo "pairs=$(cat pairs.json)" >> "$GITHUB_OUTPUT"`. A dead test fails this job, once, over the whole plan. Its comment says so and replaces the one about `allPairs()`.
  - `cells` keeps `needs: plan` and `fromJSON(needs.plan.outputs.list)`; its header comment updated (a pair job runs only that pair's non-empty cells).
- [ ] **Step 2: `ci.yaml`.** The `Test` step's comment ("one Vitest invocation over the unit, Chrome, Firefox and isolated projects") is stale: `pnpm test` is the planner in complement mode, and under `CI=true` a dead test fails it. Rewrite the comment, keep the step.
- [ ] **Step 3:** `pnpm exec biome ci .` (YAML is not Biome's), `actionlint` if installed, otherwise read both files twice.
- [ ] **Step 4: Commit** — `ci(matrix): plan first, fail once on a dead test, run on every push of main`.

### Task 15: verification on GitHub, memories, report

- [ ] **Step 1: Ask the user** whether to push (plans A, B and C are then all done — the user's condition, 2026-10-12). Only on their yes: push `main` and the branch, then `gh workflow run matrix.yaml --ref ci/test-planner` and watch it (`gh run watch`), a progress line every 2 minutes.
- [ ] **Step 2: Memories** — `stack-and-build` § CI and hooks (the `plan` job, the push trigger, dead fatal in CI); `follow-ups/test-planner-design` (step 6 done; the planner work closed); `history/2026-10`.
- [ ] **Step 3: Report**, merge on approval as Task 12.
