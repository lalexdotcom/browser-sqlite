# Test planner, plan A — guard order, IndexedDB requirement, guards in `unit`, the need model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver steps 1 to 3 of the test-planner spec: one guard order for `createSQLiteClient` and `deleteDatabase`, the IndexedDB requirement of the two IndexedDB VFS, twelve guard tests moved from the browser to `unit`, and the pure need model (`TestNeed`, properties, `shouldTestRun`, tags) the planner of plan B will use.

**Architecture:** Three branches, one per spec step, each closed before the next starts. Steps 1 and 2 change the library and move tests; step 3 adds `tests/need.ts`, a pure module importable from Node and the browser, makes `tests/browser/target.ts` delegate its six existing predicates to it, and declares the generated tag list in `vitest.config.ts` without any test using a tag yet.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Biome, Vitest 5.0.3 (`unit` project in Node, browser projects on WebdriverIO with Chrome 153 and Firefox 155), pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-12-test-planner-design.md` (§ 2, § 7, § 8 first paragraph, § 10 steps 1-3). Decisions behind it: `mem:follow-ups/test-planner-design`.

## Global Constraints

- Every piece of work on its own branch off `main`; closing = format, lint, typecheck, tests green, Serena memories updated, `git merge --no-ff` into `main`, branch deleted (`AGENTS.md`). Never push.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Code files are read and edited through Serena's symbolic tools (`AGENTS.md`, § Tooling); built-in Read/Edit only on non-code files or when Serena fails.
- After every modification: `pnpm exec biome check --write <files>`; before every commit: `pnpm exec tsc --noEmit`.
- Check the branch in the same command as the commit: `test "$(git branch --show-current)" = <branch> && git commit …`.
- Any run past ~2 minutes (`pnpm test` ≈ 12 min, `pnpm test:matrix` ≈ 13 min, a commit or merge whose hook runs the suite): run it in the background writing to a log, never through `| tail`, and post a progress line every 2 minutes from launch (`mem:conventions`).
- `CHANGELOG.md` entries go through the `changelog-maintenance` skill, under `## [Unreleased]`, on the branch that makes the change.
- Property names, verbatim: `two-workers`, `interruptible`, `shared-second-client`, `exclusive-connection`, `shared-storage`, `opfs-file`, `in-place-file`, `capped-pool`, `env-capped-pool`, `default-pragmas`, `exclusive-file-handle`, `idb-storage`.
- Tag names, verbatim: `requires:<property>`, `excludes:<property>`, `vfs:<VFS>`, `build:<build>`, `browser:<chrome|firefox>`, `isolated`, `not-isolated`, `standalone`.
- No property shares a name with a `PlatformFeature`.

## Review Focus

- A client given `wasmUrl` (string or callback) must still load its `.wasm` and serve a query once the URL is resolved later in `createSQLiteClient` — no test exercises `wasmUrl` today. Pinned in Task 1, Step 1.
- A `wasmUrl` callback must not run when a guard throws, in `createSQLiteClient` and in `deleteDatabase`'s BUSY path. Pinned in Task 1, Steps 1 and 3.
- A page without IndexedDB must be refused at construction for both IndexedDB VFS, with a message naming IndexedDB and the alternatives — not fail later in a worker. Pinned in Task 2, Step 1.
- `shouldTestRun` must say false for an isolated context whenever isolation changes nothing for the test (no need, or a need met without isolation), and true when only isolation makes it eligible. Pinned in Task 5, Step 1.
- An unknown or misspelt tag must fail loudly in `needFromTags`, never read as "no need". Pinned in Task 5, Step 1.

---

## Step 1 — branch `fix/guard-order`

### Task 1: one guard order for `createSQLiteClient` and `deleteDatabase`

**Files:**
- Create: `tests/unit/guard-order.test.ts`
- Create: `tests/browser/wasm-url.test.ts`
- Modify: `src/client.ts` (inside `createSQLiteClient`, the blocks around today's lines 446-482)
- Modify: `src/delete.ts` (inside `deleteDatabase`, today's lines 102 and 127-129)
- Modify: `tests/browser/delete.test.ts` (the test `rejects with BUSY while the init lock is held`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the guard order the spec's § 7 states; Task 4 relies on the option guards (pool, combination, pragmas, names) throwing in Node before any `location` read.

- [ ] **Step 0: Branch**

```bash
cd /workspaces/wsqlite && git switch main && git switch -c fix/guard-order
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/guard-order.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/types/errors';

// Node has neither OPFS nor `location`: an option guard that throws here ran
// before both the environment guard and the `.wasm` URL resolution.
describe('createSQLiteClient validates its options before the environment', () => {
  // Falsifiable: move assertPragmasAllowed back after missingFeature.
  it('refuses a pragma the VFS refuses before reporting a missing OPFS', () => {
    let caught: unknown;
    try {
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSCoopSyncVFS',
        pragmas: { busy_timeout: '100' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_PRAGMA');
  });

  // Falsifiable: move resolveWasmLocation back before the pool guard.
  it('does not call wasmUrl when the pool guard throws', () => {
    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    expect(() =>
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
        poolSize: 2,
        wasmUrl,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
    expect(wasmUrl).not.toHaveBeenCalled();
  });

  // Falsifiable: move resolveWasmLocation back before missingFeature.
  it('does not call wasmUrl when the environment lacks what the VFS requires', () => {
    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    expect(() =>
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSAdaptiveVFS',
        wasmUrl,
      }),
    ).toThrow(/does not support OPFS/);
    expect(wasmUrl).not.toHaveBeenCalled();
  });
});
```

`tests/browser/wasm-url.test.ts` (the option has no test today; this pins it before Step 3 moves its resolution):

```ts
import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_TARGET } from './helpers';

// The directory the worker resolves its `.wasm` from by default: the build
// under test, served beside this file's `tests/` parent.
const WASM_DIR = new URL('../build/worker/', import.meta.url).href;

describe('the wasmUrl option', () => {
  // Falsifiable: drop `wasm` from the open message in client.ts.
  it('takes a callback, called once with the build, and serves a query', async () => {
    const { vfs, build } = TEST_TARGET;
    const name = `bsq-test-${crypto.randomUUID()}`;
    const wasmUrl = vi.fn(() => WASM_DIR);
    const db = createSQLiteClient(name, { vfs, build, wasmUrl });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(name, { vfs, build }).catch(() => {});
    });
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    expect(wasmUrl).toHaveBeenCalledTimes(1);
    expect(wasmUrl).toHaveBeenCalledWith(build);
  });

  it('takes a string and serves a query', async () => {
    const { vfs, build } = TEST_TARGET;
    const name = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(name, { vfs, build, wasmUrl: WASM_DIR });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(name, { vfs, build }).catch(() => {});
    });
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });
});
```

In `tests/browser/delete.test.ts`, test `rejects with BUSY while the init lock is held`: pass a spied `wasmUrl` to the `deleteDatabase` call and assert it was not called. The call becomes:

```ts
    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS', wasmUrl }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    // Falsifiable: resolve the `.wasm` URL before the locks again.
    expect(wasmUrl).not.toHaveBeenCalled();
```

and `vi` joins the `vitest` import of that file.

- [ ] **Step 2: Run them; the unit ones and the delete one fail, the wasm-url ones pass**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/guard-order.test.ts
```
Expected: 3 failed, all on `ReferenceError: location is not defined` — today `resolveWasmLocation(…, location.href)` runs before the pool guard and `missingFeature`, and its argument is evaluated before the callback could be called.

```bash
pnpm exec vitest run --configLoader runner --project 'chrome ·*' tests/browser/wasm-url.test.ts tests/browser/delete.test.ts -t 'wasmUrl|BUSY while'
```
Expected: the two `wasmUrl` tests PASS (they pin today's behaviour); the BUSY test FAILS on `expect(wasmUrl).not.toHaveBeenCalled()`. If a `wasmUrl` test fails on a 404 for the `.wasm`, print `WASM_DIR` and the URL the worker requested (`db.debug`, or the browser console) and fix `WASM_DIR`, not the library.

- [ ] **Step 3: Reorder `createSQLiteClient`**

In `src/client.ts`, inside `createSQLiteClient`, cut these two blocks from where they are today:

```ts
  // Resolved once, here, and reused by every worker in the pool and by every
  // restart — a callback must not be re-entered per slot. Undefined when the
  // option was not given, which is what leaves the worker's resolution alone.
  const wasm = resolveWasmLocation(clientOptions.wasmUrl, build, location.href);
```

```ts
  // The engine, not the declaration. Without this the mismatch surfaces later
  // as an opaque open-error from a worker that could not instantiate wasm.
  const absent = missingFeature(vfs, build, available);
  if (absent) {
    throw new SQLiteError(
      'INVALID_OPTION',
      describeMissing(vfs, build, absent, available),
    );
  }
```

and paste them, the environment guard first, right after

```ts
  renderPragmas(pragmas);
  assertPragmasAllowed(vfs, pragmas);
```

Above the pasted environment guard, one comment line: `// Every option is valid by now: an invalid one is invalid on every browser, so it is reported before this one.`

Resulting order: build combination → `resolveDatabase` → pool guard → `resolvePragmas` / `renderPragmas` / `assertPragmasAllowed` → `missingFeature` → `resolveWasmLocation`.

- [ ] **Step 4: Defer the `.wasm` URL in `deleteDatabase`**

In `src/delete.ts`, remove the line

```ts
  const wasm = resolveWasmLocation(options.wasmUrl, build, location.href);
```

and resolve it where the delete worker starts:

```ts
    const ran = await locks.tryWithLock(initLockName(vfs, dbFile), () =>
      runDelete(
        {
          file: dbFile,
          vfs,
          build,
          // Only now: a refused delete starts no worker and has no use for it.
          wasm: resolveWasmLocation(options.wasmUrl, build, location.href),
        },
        logicalFile,
      ),
    );
```

- [ ] **Step 5: Format, typecheck, run the tests**

```bash
pnpm exec biome check --write src/client.ts src/delete.ts tests/unit/guard-order.test.ts tests/browser/wasm-url.test.ts tests/browser/delete.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/guard-order.test.ts
pnpm exec vitest run --configLoader runner --project 'chrome ·*' --project 'firefox ·*' tests/browser/wasm-url.test.ts tests/browser/delete.test.ts tests/browser/vfs.test.ts tests/browser/database-pragmas.test.ts tests/browser/vfs-folders.test.ts tests/browser/default-build.test.ts tests/browser/init.test.ts
```
Expected: 3 passed (unit); every browser file green on both browsers.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/delete.ts tests/unit/guard-order.test.ts tests/browser/wasm-url.test.ts tests/browser/delete.test.ts
test "$(git branch --show-current)" = fix/guard-order && git commit -m "fix: validate every option before probing the environment

createSQLiteClient read location.href and checked the engine's features
between its option guards, so an invalid pragma on a browser without
OPFS was reported as the missing OPFS, and a wasmUrl callback ran for a
client that was about to throw. Options are now validated first, the
environment second, and the .wasm URL resolved last; deleteDatabase
resolves it only when its worker starts, after its locks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: the IndexedDB VFS require IndexedDB

**Files:**
- Modify: `src/const/platform.ts` (`PlatformFeature`)
- Modify: `src/capabilities.ts` (`PROBES`, `FEATURE_LABEL`)
- Modify: `src/const/vfs.ts` (`IDBBatchAtomicVFS.requires`, `IDBMirrorVFS.requires`)
- Modify: `scripts/render-vfs-matrix.ts` (`FEATURE_SUPPORT`, `SECURE_CONTEXT_ONLY`, the sources comment)
- Modify: `tests/unit/capabilities.test.ts`
- Regenerated: `VFS.md`, `README.md` (`pnpm docs:vfs`)

**Interfaces:**
- Consumes: nothing.
- Produces: `PlatformFeature` gains `'indexeddb'`; `detectFeatures()` reports it where `globalThis.indexedDB` exists. Task 5's property predicates and plan B's probes read it like any other feature.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/capabilities.test.ts`, next to `requires Web Locks for the IndexedDB VFS, and nothing for the memory VFS`:

```ts
  // Falsifiable: drop 'indexeddb' from an IndexedDB VFS's `requires`. Where
  // IndexedDB is missing it would construct, then fail inside its worker.
  it('requires IndexedDB for the IndexedDB VFS once Web Locks are there', () => {
    const here = new Set<PlatformFeature>(['web-locks']);
    expect(missingFeature('IDBBatchAtomicVFS', 'async', here)).toBe('indexeddb');
    expect(missingFeature('IDBMirrorVFS', 'async', here)).toBe('indexeddb');
  });

  it('names IndexedDB and the VFS that do without it when it is missing', () => {
    const here = new Set<PlatformFeature>(['web-locks', 'opfs', 'sync-access-handle']);
    const message = describeMissing('IDBBatchAtomicVFS', 'async', 'indexeddb', here);
    expect(message).toContain('IndexedDB');
    expect(message).toContain('OPFSWriteAheadVFS');
    expect(message).not.toContain('IDBMirrorVFS');
  });

  it('probes IndexedDB, which Node does not have', () => {
    expect(detectFeatures().has('indexeddb')).toBe(false);
  });
```

`PlatformFeature` joins the imports of that file if it is not there yet (`import type { PlatformFeature } from '../../src/const/platform';`).

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/capabilities.test.ts
```
Expected: the new tests fail — a TypeScript-level `'indexeddb'` that is not a `PlatformFeature` surfaces at runtime as `missingFeature` returning `null`.

- [ ] **Step 3: Declare and probe the feature**

`src/const/platform.ts`: add `| 'indexeddb'` as the last member of `PlatformFeature`, with the doc comment style of its neighbours: `/** \`indexedDB\` on the global: what the IndexedDB VFS store their pages in. Exposed outside secure contexts too. */` if the file documents members, nothing otherwise.

`src/capabilities.ts`, in `PROBES`, after `'web-locks'`:

```ts
  indexeddb: () => typeof indexedDB !== 'undefined',
```

and in `FEATURE_LABEL`: `indexeddb: 'IndexedDB',`.

`src/const/vfs.ts`: `IDBBatchAtomicVFS.requires` and `IDBMirrorVFS.requires` become `['web-locks', 'indexeddb']` — Web Locks first, so a page that is not a secure context is told about the secure context first, as today.

- [ ] **Step 4: Document its support**

`scripts/render-vfs-matrix.ts` has `satisfies Record<PlatformFeature, …>` on `FEATURE_SUPPORT` and `SECURE_CONTEXT_ONLY`, so `tsc` fails until both have the key. Read the versions from MDN's data rather than from memory:

```bash
node --input-type=module -e "import bcd from '@mdn/browser-compat-data' with { type: 'json' }; const s = bcd.api.indexedDB.__compat.support; for (const k of ['chrome','chrome_android','firefox','safari','safari_ios']) console.log(k, JSON.stringify(s[k]));"
```

Add `indexeddb: { Chrome: …, Android: …, Firefox: …, Safari: …, iOS: … }` with the first unprefixed, non-flagged `version_added` of each, `SECURE_CONTEXT_ONLY.indexeddb: false` (IndexedDB is exposed on plain http), and one bullet in the sources comment: `` - `indexeddb` (`indexedDB` on the global): MDN browser-compat-data, `api.indexedDB`, checked <today's date>.``

- [ ] **Step 5: Regenerate the docs, run the tests**

```bash
pnpm exec biome check --write src/const/platform.ts src/capabilities.ts src/const/vfs.ts scripts/render-vfs-matrix.ts tests/unit/capabilities.test.ts
pnpm exec tsc --noEmit
pnpm docs:vfs && git diff --stat VFS.md README.md
pnpm test:unit
```
Expected: `unit` all green; `VFS.md` gains IndexedDB in the two IndexedDB VFS's requirements; README's browser floor does not move (IndexedDB predates Web Locks everywhere) — if it moves, the MDN versions read in Step 4 are wrong, re-read them.

- [ ] **Step 6: Commit**

```bash
git add src/const/platform.ts src/capabilities.ts src/const/vfs.ts scripts/render-vfs-matrix.ts tests/unit/capabilities.test.ts VFS.md README.md
test "$(git branch --show-current)" = fix/guard-order && git commit -m "fix: refuse the IndexedDB VFS where IndexedDB is missing

IDBBatchAtomicVFS and IDBMirrorVFS declared only Web Locks, so a page
without IndexedDB constructed a client whose worker then failed to open.
IndexedDB is now a probed feature both of them require, and the refusal
names the VFS that store elsewhere.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: changelog, full verification, close step 1

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `.serena/memories/history/2026-10.md`, `.serena/memories/follow-ups/test-planner-design.md`

- [ ] **Step 1: Changelog entries** — invoke the `changelog-maintenance` skill with these three, under `## [Unreleased]`:
  - *Changed*: an invalid or refused pragma is reported (`INVALID_PRAGMA`) before a missing browser feature; it used to be reported as the missing OPFS on a browser without it.
  - *Changed*: a `wasmUrl` callback is no longer called when the client's options are invalid or the browser lacks what the VFS needs, nor when `deleteDatabase` is refused before starting its worker.
  - *Fixed*: `IDBBatchAtomicVFS` and `IDBMirrorVFS` are refused at construction where IndexedDB is missing, naming the VFS that do without it, instead of failing in their worker.

- [ ] **Step 2: Full verification** (background, progress every 2 minutes)

```bash
pnpm exec biome ci . && pnpm exec tsc --noEmit && pnpm docs:vfs && git diff --exit-code VFS.md README.md
pnpm test > "$SCRATCH/step1-test.log" 2>&1
pnpm test:matrix > "$SCRATCH/step1-matrix.log" 2>&1
```
`VFS_CAPABILITIES` changed, which is a matrix trigger (`mem:conventions`, § When to run the full matrix). Expected: `pnpm test` all green, its total the previous 2616 plus the new tests in every project that runs them (each browser test file runs in the eight browser projects), and the matrix 88/88 cells. A red cell is triaged before anything else (`superpowers:systematic-debugging`).

- [ ] **Step 3: Memories** — one row in `history/2026-10.md` (branch, what shipped, the numbers of Step 2); in `follow-ups/test-planner-design.md`, mark step 1 done with its merge commit.

- [ ] **Step 4: Merge**

```bash
git add CHANGELOG.md .serena/memories
test "$(git branch --show-current)" = fix/guard-order && git commit -m "docs: changelog and memories for the guard order and the IndexedDB requirement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git switch main && git merge --no-ff fix/guard-order -m "Merge branch 'fix/guard-order'" && git branch -d fix/guard-order
```
The merge hook runs the full suite: background, progress every 2 minutes.

---

## Step 2 — branch `test/guards-in-unit`

### Task 4: twelve guards move to `unit`, written over `VFS_CAPABILITIES`

**Files:**
- Create: `tests/unit/vfs-guards.test.ts`
- Modify: `tests/browser/vfs.test.ts` (remove the describes `AccessHandlePoolVFS pool guard` tests `throws when combined with an explicit poolSize > 1` and `reports the pool guard as SQLiteError with code INVALID_OPTION`; `OPFSCoopSyncVFS pool guard` test `throws when combined with an explicit poolSize > 1`; the whole describe `vfs/build combination guard` except `accepts an explicitly declared combination and serves queries`; the whole describe `memory VFS pool guard`)
- Modify: `tests/browser/delete.test.ts` (remove `rejects with INVALID_OPTION when the build is not one the VFS supports` and `resolves without a worker for a memory VFS`)
- Modify: `tests/browser/database-pragmas.test.ts` (remove `is refused at construction`)
- Modify: `tests/browser/vfs-folders.test.ts` (remove `deleteDatabase refuses a too-long name before taking any lock` and `inspectDatabase refuses a too-long name before taking any lock`)

**Interfaces:**
- Consumes: Task 1's order (option guards before `location` and `missingFeature`).
- Produces: nothing other tasks call.

- [ ] **Step 0: Branch** — `git switch main && git switch -c test/guards-in-unit`

- [ ] **Step 1: Write the unit tests**

`tests/unit/vfs-guards.test.ts`:

```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { inspectDatabase } from '../../src/inspect';
import { createSQLiteClient } from '../../src/client';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/types/errors';

// Every guard here reads the declaration and throws before any worker, so it
// runs in Node, once per VFS the declaration concerns — a VFS added to
// VFS_CAPABILITIES is covered with no edit here.
const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];
const ALL_BUILDS = Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[];
const fresh = () => `bsq-test-${crypto.randomUUID()}`;
const thrown = (f: () => unknown): SQLiteError => {
  try {
    f();
  } catch (error) {
    if (error instanceof SQLiteError) return error;
    throw error;
  }
  throw new Error('expected a SQLiteError, nothing was thrown');
};

describe('the pool guard', () => {
  const capped = ALL_VFS.filter((vfs) => VFS_CAPABILITIES[vfs].maxPoolSize !== null);

  it('covers at least the VFS capped today', () => {
    expect(capped).toEqual(
      expect.arrayContaining(['OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'IDBMirrorVFS', 'MemoryVFS', 'MemoryAsyncVFS']),
    );
  });

  // Falsifiable: drop the pool guard from createSQLiteClient.
  it.each(capped)('%s refuses a pool larger than its cap, and says why', (vfs) => {
    const { maxPoolSize, poolLimitReason } = VFS_CAPABILITIES[vfs];
    const error = thrown(() =>
      createSQLiteClient(fresh(), { vfs, poolSize: (maxPoolSize as number) + 1 }),
    );
    expect(error.code).toBe('INVALID_OPTION');
    expect(error.message).toContain(`pool sizes greater than ${maxPoolSize}`);
    expect(error.message).toContain(poolLimitReason as string);
  });
});

describe('the vfs/build combination guard', () => {
  const refused = ALL_VFS.flatMap((vfs) =>
    ALL_BUILDS.filter((b) => !(VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).includes(b)).map(
      (build) => [vfs, build] as const,
    ),
  );

  it('has at least one refused combination to check', () => {
    expect(refused.length).toBeGreaterThan(0);
  });

  // Falsifiable: drop the build guard from createSQLiteClient.
  it.each(refused)('createSQLiteClient refuses %s on %s, naming the builds it supports', (vfs, build) => {
    const error = thrown(() => createSQLiteClient(fresh(), { vfs, build }));
    expect(error.code).toBe('INVALID_OPTION');
    expect(error.message).toContain(`cannot run on the '${build}' build`);
    for (const supported of VFS_CAPABILITIES[vfs].builds) expect(error.message).toContain(supported);
  });

  // Falsifiable: drop the build guard from deleteDatabase.
  it.each(refused)('deleteDatabase refuses %s on %s', async (vfs, build) => {
    await expect(deleteDatabase(fresh(), { vfs, build })).rejects.toMatchObject({
      code: 'INVALID_OPTION',
    });
  });
});

describe('the refused pragma guard', () => {
  const refusals = ALL_VFS.flatMap((vfs) =>
    Object.entries(VFS_CAPABILITIES[vfs].refusedPragmas).map(([pragma, reason]) => [vfs, pragma, reason] as const),
  );

  it('has at least one refused pragma to check', () => {
    expect(refusals.length).toBeGreaterThan(0);
  });

  // Falsifiable: drop assertPragmasAllowed from createSQLiteClient.
  it.each(refusals)('%s refuses PRAGMA %s at construction, with its reason', (vfs, pragma, reason) => {
    const error = thrown(() => createSQLiteClient(fresh(), { vfs, pragmas: { [pragma]: '100' } }));
    expect(error.code).toBe('INVALID_PRAGMA');
    expect(error.message).toContain(reason);
  });
});

describe('deleteDatabase on a memory VFS', () => {
  const memory = ALL_VFS.filter((vfs) => VFS_CAPABILITIES[vfs].storage === 'memory');

  // Node has no Worker: resolving at all proves no worker was asked for.
  // Falsifiable: drop the memory early return from deleteDatabase.
  it.each(memory)('%s resolves without a worker', async (vfs) => {
    await expect(deleteDatabase(fresh(), { vfs })).resolves.toBeUndefined();
  });
});

describe('the name length guard', () => {
  // The bound is the same for every VFS; each is checked because the guard
  // runs inside each entry point's own VFS-dependent path.
  // Falsifiable: move resolveDatabase after the lock in deleteDatabase.
  it.each(ALL_VFS)('deleteDatabase refuses a too-long name on %s before taking any lock', async (vfs) => {
    const request = vi.spyOn(navigator.locks, 'request');
    onTestFinished(() => request.mockRestore());
    await expect(deleteDatabase('n'.repeat(60), { vfs })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    expect(request).not.toHaveBeenCalled();
  });

  // inspectDatabase's only Web Locks call is locks.entries() -> query().
  // Falsifiable: move resolveDatabase after locks.entries() in inspectDatabase.
  it.each(ALL_VFS.filter((vfs) => VFS_CAPABILITIES[vfs].storage !== 'memory'))(
    'inspectDatabase refuses a too-long name on %s before taking any lock',
    async (vfs) => {
      const query = vi.spyOn(navigator.locks, 'query');
      onTestFinished(() => query.mockRestore());
      await expect(inspectDatabase('n'.repeat(60), { vfs })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
      expect(query).not.toHaveBeenCalled();
    },
  );
});
```

`inspectDatabase` on a memory VFS refuses for another reason (no shared storage), which is why its loop skips them.

- [ ] **Step 2: Run them**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/vfs-guards.test.ts
```
Expected: all pass. If one fails, the guard behaves differently from the browser test it replaces: compare with the removed browser test before changing anything.

- [ ] **Step 3: Remove the browser copies** listed under **Files**, through Serena (`safe_delete_symbol` cannot address an `it` callback: use `replace_content` with a regex from `  it\('<title>'` to the test's closing `\);`). Remove imports left unused (Biome reports them).

- [ ] **Step 4: Format, typecheck, run**

```bash
pnpm exec biome check --write tests/unit/vfs-guards.test.ts tests/browser/vfs.test.ts tests/browser/delete.test.ts tests/browser/database-pragmas.test.ts tests/browser/vfs-folders.test.ts
pnpm exec tsc --noEmit
pnpm test:unit
pnpm exec vitest run --configLoader runner --project 'chrome ·*' --project 'firefox ·*' tests/browser/vfs.test.ts tests/browser/delete.test.ts tests/browser/database-pragmas.test.ts tests/browser/vfs-folders.test.ts
```
Expected: green everywhere.

- [ ] **Step 5: Commit, verify, memories, merge**

```bash
git add tests
test "$(git branch --show-current)" = test/guards-in-unit && git commit -m "test: run the option guards in unit, once per VFS they concern

Twelve browser tests checked a guard that reads the VFS declaration and
throws before any worker, each pinned to one VFS and repeated in every
browser project. They now run in Node over VFS_CAPABILITIES, which also
reaches IDBMirrorVFS's pool cap, never tested before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Then `pnpm test` in the background (progress every 2 minutes; expected: all green, its total the previous one minus the removed browser executions plus the new unit tests), a row in `history/2026-10.md`, step 2 marked done in `follow-ups/test-planner-design.md`, commit, `git merge --no-ff test/guards-in-unit`, branch deleted.

---

## Step 3 — branch `test/need-model`

### Task 5: `tests/need.ts` — properties, `TestNeed`, `shouldTestRun`, tags

**Files:**
- Create: `tests/need.ts`
- Create: `tests/unit/need.test.ts`

**Interfaces:**
- Consumes: `VFS_CAPABILITIES`, `SQLiteVFS` (`src/const/vfs.ts`), `BUILD_CAPABILITIES`, `SQLiteBuild` (`src/const/builds.ts`), `PlatformFeature` (`src/const/platform.ts`), `sharesStorage` (`src/locks.ts`), `BrowserName` (`scripts/browsers.ts`, type only).
- Produces (plan B relies on these exact names):
  - `export const PROPERTIES: readonly Property[]` and `export type Property`
  - `export type TestContext = { vfs: SQLiteVFS; build: SQLiteBuild; browser: BrowserName; isolated: boolean; features: ReadonlySet<PlatformFeature> }`
  - `export type TestNeed = { browser?: readonly BrowserName[]; vfs?: readonly SQLiteVFS[]; build?: readonly SQLiteBuild[]; isolated?: boolean; requires?: readonly Property[]; excludes?: readonly Property[] }`
  - `export const holds: (property: Property, context: TestContext) => boolean`
  - `export const runsIn: (context: TestContext) => boolean` — the pair's VFS and build requirements are all present
  - `export const shouldTestRun: (context: TestContext, need?: TestNeed) => boolean`
  - `export const needFromTags: (tags: readonly string[]) => { standalone: boolean; need: TestNeed }` — throws on an unknown tag
  - `export const declaredTags: () => string[]`

- [ ] **Step 0: Branch** — `git switch main && git switch -c test/need-model`

- [ ] **Step 1: Write the failing tests**

`tests/unit/need.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import {
  declaredTags,
  holds,
  needFromTags,
  PROPERTIES,
  type Property,
  runsIn,
  shouldTestRun,
  type TestContext,
} from '../need';

// The features the 2026-10-11 probe measured on the pinned browsers.
const BASE: PlatformFeature[] = ['jspi', 'opfs', 'sync-access-handle', 'web-locks', 'writable-stream', 'indexeddb'];
const CHROME = new Set<PlatformFeature>([...BASE, 'readwrite-unsafe']);
const FIREFOX = new Set<PlatformFeature>(BASE);
const isolatedOf = (f: ReadonlySet<PlatformFeature>) => new Set<PlatformFeature>([...f, 'cross-origin-isolated']);

const ctx = (vfs: SQLiteVFS, build: SQLiteBuild, browser: 'chrome' | 'firefox', isolated = false): TestContext => {
  const base = browser === 'chrome' ? CHROME : FIREFOX;
  return { vfs, build, browser, isolated, features: isolated ? isolatedOf(base) : base };
};

/** The VFS where a property holds on every runnable build, for one browser, non-isolated. */
const satisfying = (property: Property, browser: 'chrome' | 'firefox') =>
  (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter((vfs) => {
    const builds = (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).filter((b) => runsIn(ctx(vfs, b, browser)));
    return builds.length > 0 && builds.every((b) => holds(property, ctx(vfs, b, browser)));
  });

describe('the properties, against the spec table (2026-10-12)', () => {
  const table: Record<Exclude<Property, 'interruptible'>, Record<'chrome' | 'firefox', SQLiteVFS[]>> = {
    'two-workers': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'IDBBatchAtomicVFS', 'OPFSAnyContextVFS'],
      firefox: ['IDBBatchAtomicVFS', 'OPFSAnyContextVFS'],
    },
    'shared-second-client': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'IDBBatchAtomicVFS', 'IDBMirrorVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'IDBBatchAtomicVFS', 'IDBMirrorVFS', 'OPFSAnyContextVFS'],
    },
    'exclusive-connection': {
      chrome: ['AccessHandlePoolVFS'],
      firefox: ['OPFSWriteAheadVFS', 'AccessHandlePoolVFS'],
    },
    'shared-storage': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'IDBBatchAtomicVFS', 'IDBMirrorVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'IDBBatchAtomicVFS', 'IDBMirrorVFS', 'OPFSAnyContextVFS'],
    },
    'opfs-file': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
    },
    'in-place-file': {
      chrome: ['OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
    },
    'capped-pool': {
      chrome: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'IDBMirrorVFS', 'MemoryVFS', 'MemoryAsyncVFS'],
      firefox: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS', 'IDBMirrorVFS', 'MemoryVFS', 'MemoryAsyncVFS'],
    },
    'env-capped-pool': { chrome: [], firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'] },
    'default-pragmas': {
      chrome: ['OPFSAdaptiveVFS', 'AccessHandlePoolVFS', 'IDBBatchAtomicVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSAdaptiveVFS', 'AccessHandlePoolVFS', 'IDBBatchAtomicVFS', 'OPFSAnyContextVFS'],
    },
    'exclusive-file-handle': {
      chrome: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
      firefox: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
    },
    'idb-storage': { chrome: ['IDBBatchAtomicVFS', 'IDBMirrorVFS'], firefox: ['IDBBatchAtomicVFS', 'IDBMirrorVFS'] },
  };
  for (const [property, browsers] of Object.entries(table))
    for (const [browser, expected] of Object.entries(browsers))
      it(`${property} holds on ${browser} for ${expected.join(', ') || 'no VFS'}`, () => {
        expect(satisfying(property as Property, browser as 'chrome' | 'firefox').sort()).toEqual([...expected].sort());
      });

  it('makes interruptible a property of the build, sync only under isolation', () => {
    for (const build of Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[]) {
      expect(holds('interruptible', ctx('MemoryVFS', build, 'firefox'))).toBe(build !== 'sync');
    }
    expect(holds('interruptible', ctx('MemoryVFS', 'sync', 'firefox', true))).toBe(true);
  });

  it('puts a second client in exactly one of shared, refused or its own database', () => {
    for (const browser of ['chrome', 'firefox'] as const)
      for (const vfs of Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]) {
        const c = ctx(vfs, VFS_CAPABILITIES[vfs].builds[0], browser);
        const outcomes = [holds('shared-second-client', c), holds('exclusive-connection', c), !holds('shared-storage', c)];
        expect(outcomes.filter(Boolean)).toHaveLength(1);
      }
  });
});

describe('shouldTestRun', () => {
  const wa = (browser: 'chrome' | 'firefox', isolated = false) => ctx('OPFSWriteAheadVFS', 'sync', browser, isolated);

  it('runs a test with no need everywhere non-isolated, and never isolated', () => {
    expect(shouldTestRun(wa('chrome'))).toBe(true);
    expect(shouldTestRun(wa('chrome', true))).toBe(false);
  });

  it('runs the slot-channel test only under isolation', () => {
    const need = { build: ['sync'], requires: ['interruptible'] } as const;
    expect(shouldTestRun(wa('chrome'), need)).toBe(false);
    expect(shouldTestRun(wa('chrome', true), need)).toBe(true);
  });

  it('runs the degraded path only without isolation', () => {
    const need = { build: ['sync'], excludes: ['interruptible'] } as const;
    expect(shouldTestRun(wa('chrome'), need)).toBe(true);
    expect(shouldTestRun(wa('chrome', true), need)).toBe(false);
  });

  it('does not repeat in isolation a test isolation changes nothing for', () => {
    const need = { requires: ['interruptible'] } as const;
    const adaptive = ctx('OPFSAdaptiveVFS', 'jspi', 'chrome');
    expect(shouldTestRun(adaptive, need)).toBe(true);
    expect(shouldTestRun({ ...adaptive, isolated: true, features: isolatedOf(adaptive.features) }, need)).toBe(false);
  });

  it('runs an isolated: true test in isolation even where isolation changes nothing', () => {
    expect(shouldTestRun(wa('chrome', true), { isolated: true })).toBe(true);
    expect(shouldTestRun(wa('chrome'), { isolated: true })).toBe(false);
  });

  it('honours isolated: false', () => {
    expect(shouldTestRun(wa('chrome'), { isolated: false })).toBe(true);
    expect(shouldTestRun(wa('chrome', true), { isolated: false })).toBe(false);
  });

  it('reads a list as OR and the fields as AND', () => {
    const need = { vfs: ['OPFSAdaptiveVFS', 'OPFSWriteAheadVFS'], browser: ['firefox'] } as const;
    expect(shouldTestRun(wa('firefox'), need)).toBe(true);
    expect(shouldTestRun(wa('chrome'), need)).toBe(false);
    expect(shouldTestRun(ctx('MemoryVFS', 'sync', 'firefox'), need)).toBe(false);
  });

  it('refuses when any excluded property holds', () => {
    expect(shouldTestRun(ctx('MemoryVFS', 'sync', 'chrome'), { excludes: ['shared-storage'] })).toBe(true);
    expect(shouldTestRun(wa('chrome'), { excludes: ['shared-storage'] })).toBe(false);
  });
});

describe('runsIn', () => {
  it('says no for a build whose feature is missing', () => {
    const noJspi = new Set<PlatformFeature>([...FIREFOX].filter((f) => f !== 'jspi'));
    expect(runsIn({ ...ctx('OPFSAdaptiveVFS', 'jspi', 'firefox'), features: noJspi })).toBe(false);
    expect(runsIn({ ...ctx('OPFSAdaptiveVFS', 'async', 'firefox'), features: noJspi })).toBe(true);
  });
});

describe('the tags', () => {
  it('rebuild the need they spell', () => {
    expect(
      needFromTags(['requires:two-workers', 'excludes:shared-storage', 'vfs:OPFSCoopSyncVFS', 'build:sync', 'browser:firefox', 'isolated']),
    ).toEqual({
      standalone: false,
      need: { requires: ['two-workers'], excludes: ['shared-storage'], vfs: ['OPFSCoopSyncVFS'], build: ['sync'], browser: ['firefox'], isolated: true },
    });
    expect(needFromTags(['not-isolated'])).toEqual({ standalone: false, need: { isolated: false } });
    expect(needFromTags(['standalone'])).toEqual({ standalone: true, need: {} });
    expect(needFromTags([])).toEqual({ standalone: false, need: {} });
  });

  it('fail loudly on a tag they do not know', () => {
    expect(() => needFromTags(['requires:two-worker'])).toThrow(/requires:two-worker/);
    expect(() => needFromTags(['vfs:NopeVFS'])).toThrow(/vfs:NopeVFS/);
    expect(() => needFromTags(['isolated', 'not-isolated'])).toThrow(/isolated/);
  });

  it('declare every tag the vocabulary can spell, once', () => {
    const tags = declaredTags();
    expect(new Set(tags).size).toBe(tags.length);
    for (const p of PROPERTIES) expect(tags).toEqual(expect.arrayContaining([`requires:${p}`, `excludes:${p}`]));
    for (const v of Object.keys(VFS_CAPABILITIES)) expect(tags).toContain(`vfs:${v}`);
    for (const b of Object.keys(BUILD_CAPABILITIES)) expect(tags).toContain(`build:${b}`);
    expect(tags).toEqual(expect.arrayContaining(['browser:chrome', 'browser:firefox', 'isolated', 'not-isolated', 'standalone']));
  });

  it('never name a property like a platform feature', () => {
    const features: PlatformFeature[] = ['opfs', 'sync-access-handle', 'readwrite-unsafe', 'jspi', 'writable-stream', 'cross-origin-isolated', 'web-locks', 'indexeddb'];
    for (const p of PROPERTIES) expect(features).not.toContain(p as string);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
pnpm exec vitest run --configLoader runner --project unit tests/unit/need.test.ts
```
Expected: FAIL — `Cannot find module '../need'`. (The unit project's `include` is `tests/**/*.test.ts`, so `tests/unit/need.test.ts` is collected; `tests/need.ts` itself is not a test file.)

- [ ] **Step 3: Write `tests/need.ts`**

```ts
import type { BrowserName } from '../scripts/browsers.ts';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../src/const/builds';
import type { PlatformFeature } from '../src/const/platform';
import { type SQLiteVFS, type VFSCapability, VFS_CAPABILITIES } from '../src/const/vfs';
import { sharesStorage } from '../src/locks';

/**
 * What a browser test needs of the pair it runs on, and whether a context
 * gives it that (spec 2026-10-12, § 2). Pure, so the planner (Node), each
 * cell's guard (browser) and the unit tests share one answer.
 */
export const PROPERTIES = [
  'two-workers',
  'interruptible',
  'shared-second-client',
  'exclusive-connection',
  'shared-storage',
  'opfs-file',
  'in-place-file',
  'capped-pool',
  'env-capped-pool',
  'default-pragmas',
  'exclusive-file-handle',
  'idb-storage',
] as const;
export type Property = (typeof PROPERTIES)[number];

export type TestContext = {
  readonly vfs: SQLiteVFS;
  readonly build: SQLiteBuild;
  readonly browser: BrowserName;
  readonly isolated: boolean;
  readonly features: ReadonlySet<PlatformFeature>;
};

export type TestNeed = {
  readonly browser?: readonly BrowserName[];
  readonly vfs?: readonly SQLiteVFS[];
  readonly build?: readonly SQLiteBuild[];
  /** true: isolated contexts only; false: non-isolated only. */
  readonly isolated?: boolean;
  readonly requires?: readonly Property[];
  readonly excludes?: readonly Property[];
};

const BROWSERS: readonly BrowserName[] = ['chrome', 'firefox'];

// The widening casts mirror client.ts's build guard: `as const` on the tables
// narrows an empty list to `readonly []`, where `.every` takes never.
const met = (features: readonly PlatformFeature[], context: TestContext) =>
  features.every((feature) => context.features.has(feature));

const declared = (vfs: SQLiteVFS): VFSCapability => VFS_CAPABILITIES[vfs];

/** Whether a second client is refused here: exclusive by declaration, or for lack of a feature. */
const refusesSecondClient = (context: TestContext) => {
  const c = declared(context.vfs);
  return sharesStorage(context.vfs) && (c.exclusiveConnection || !met(c.exclusiveConnectionWithout as readonly PlatformFeature[], context));
};

export const holds = (property: Property, context: TestContext): boolean => {
  const c = declared(context.vfs);
  switch (property) {
    case 'two-workers':
      return c.maxPoolSize !== 1 && met(c.singleConnectionWithout as readonly PlatformFeature[], context);
    case 'interruptible':
      return met(BUILD_CAPABILITIES[context.build].interruptibleWithout as readonly PlatformFeature[], context);
    case 'shared-second-client':
      return sharesStorage(context.vfs) && !refusesSecondClient(context);
    case 'exclusive-connection':
      return refusesSecondClient(context);
    case 'shared-storage':
      return sharesStorage(context.vfs);
    case 'opfs-file':
      return c.folder !== undefined;
    case 'in-place-file':
      return c.folder !== undefined && c.extraFileSuffixes.length === 0;
    case 'capped-pool':
      return c.maxPoolSize !== null;
    case 'env-capped-pool':
      return !met(c.singleConnectionWithout as readonly PlatformFeature[], context);
    case 'default-pragmas':
      return Object.keys(c.defaultPragmas).length > 0;
    case 'exclusive-file-handle':
      return c.exclusiveFileHandle;
    case 'idb-storage':
      return c.storage === 'indexeddb';
  }
};

/** Whether the pair can run here at all: what its VFS and its build require. */
export const runsIn = (context: TestContext): boolean =>
  met(
    [
      ...(VFS_CAPABILITIES[context.vfs].requires as readonly PlatformFeature[]),
      ...(BUILD_CAPABILITIES[context.build].requires as readonly PlatformFeature[]),
    ],
    context,
  );

const eligible = (context: TestContext, need: TestNeed): boolean =>
  (need.browser === undefined || need.browser.includes(context.browser)) &&
  (need.vfs === undefined || need.vfs.includes(context.vfs)) &&
  (need.build === undefined || need.build.includes(context.build)) &&
  (need.isolated === undefined || need.isolated === context.isolated) &&
  (need.requires ?? []).every((p) => holds(p, context)) &&
  !(need.excludes ?? []).some((p) => holds(p, context));

/**
 * Whether a test with this need runs in this context. In an isolated context a
 * test that does not ask for isolation runs only when isolation is what makes
 * it eligible (spec § 2, D3) — otherwise its non-isolated run already covers it.
 * Assumes `runsIn(context)`: a pair the context cannot run is the planner's
 * "not applicable", not a need's answer.
 */
export const shouldTestRun = (context: TestContext, need: TestNeed = {}): boolean => {
  if (!eligible(context, need)) return false;
  if (!context.isolated || need.isolated === true) return true;
  const features = new Set(context.features);
  features.delete('cross-origin-isolated');
  return !eligible({ ...context, isolated: false, features }, need);
};

const VFS_NAMES = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];
const BUILD_NAMES = Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[];

/** Every tag a need can be spelt with — what `vitest.config.ts` declares. */
export const declaredTags = (): string[] => [
  ...PROPERTIES.flatMap((p) => [`requires:${p}`, `excludes:${p}`]),
  ...VFS_NAMES.map((v) => `vfs:${v}`),
  ...BUILD_NAMES.map((b) => `build:${b}`),
  ...BROWSERS.map((b) => `browser:${b}`),
  'isolated',
  'not-isolated',
  'standalone',
];

/** The need a test's tags spell. Throws on a tag outside the vocabulary. */
export const needFromTags = (tags: readonly string[]): { standalone: boolean; need: TestNeed } => {
  const known = new Set(declaredTags());
  const lists: { -readonly [K in 'browser' | 'vfs' | 'build' | 'requires' | 'excludes']?: string[] } = {};
  let isolated: boolean | undefined;
  let standalone = false;
  for (const tag of tags) {
    if (!known.has(tag)) throw new Error(`NEED_TAG: "${tag}" is not in the need vocabulary (tests/need.ts)`);
    if (tag === 'standalone') standalone = true;
    else if (tag === 'isolated' || tag === 'not-isolated') {
      const value = tag === 'isolated';
      if (isolated !== undefined && isolated !== value) throw new Error('NEED_TAG: "isolated" and "not-isolated" together');
      isolated = value;
    } else {
      const [key, value] = tag.split(':') as ['browser' | 'vfs' | 'build' | 'requires' | 'excludes', string];
      (lists[key] ??= []).push(value);
    }
  }
  const need = { ...lists, ...(isolated === undefined ? {} : { isolated }) } as TestNeed;
  return { standalone, need };
};
```

- [ ] **Step 4: Run to see it pass**

```bash
pnpm exec biome check --write tests/need.ts tests/unit/need.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/need.test.ts
```
Expected: all pass. A property-table test that fails means the predicate or the table is wrong: re-derive the expected set from `VFS_CAPABILITIES` by hand before touching either, and if the spec table itself was wrong, correct the spec in the same commit and say so in the body.

- [ ] **Step 5: Commit**

```bash
git add tests/need.ts tests/unit/need.test.ts
test "$(git branch --show-current)" = test/need-model && git commit -m "test: the need model a browser test will declare

What a test requires of its pair, as properties computed from the VFS and
build declarations, and shouldTestRun, which also keeps isolated contexts
to the tests isolation changes. Pure, so the planner, each cell's guard
and these unit tests share one answer; nothing uses it yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: one definition of the six existing needs; the tags declared

**Files:**
- Modify: `tests/browser/target.ts` (`holds`, and the now-unused local helpers)
- Modify: `vitest.config.ts` (root `test.tags`)

**Interfaces:**
- Consumes: `holds`, `TestContext` (Task 5).
- Produces: `resolvePair` and every browser test unchanged in behaviour; the tag vocabulary declared for plan B and the conversion.

- [ ] **Step 1: Delegate `target.ts`'s `holds` to `tests/need.ts`**

`tests/browser/target.ts`'s `holds(need, { vfs, build }, here)` switches over the six `Need` values with predicates of its own. Replace its body so each case asks `tests/need.ts`:

```ts
import { holds as propertyHolds } from '../need';

const holds = (need: Need, { vfs, build }: TestTarget, here: Here): boolean =>
  // One definition (tests/need.ts): this resolver goes with the planner (plan B).
  // `browser` and `isolated` are not read by these six properties.
  propertyHolds(need, { vfs, build, browser: 'chrome', isolated: here.features.has('cross-origin-isolated'), features: here.features });
```

`Need`'s six names are all `Property` names, so `need` type-checks as a `Property`; if `tsc` objects, widen with `need satisfies Property` rather than a cast. Remove `sharedSecondClient` only if nothing else imports it (`find_referencing_symbols`; `tests/browser/helpers/vfs-contract.ts` does, by its docstring — keep it then, rewritten as `(vfs, here) => propertyHolds('shared-second-client', …)`).

- [ ] **Step 2: The resolver's own tests still pass**

```bash
pnpm exec biome check --write tests/browser/target.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --configLoader runner --project unit tests/unit/test-target.test.ts tests/unit/target-projects.test.ts
```
Expected: unchanged results, all green — the proof that both definitions agreed.

- [ ] **Step 3: Declare the tags**

`vitest.config.ts`, root `test` object (beside `passWithNoTests`):

```ts
    // The need vocabulary (tests/need.ts). Vitest refuses a tag it was not
    // told about, which is what keeps the vocabulary closed.
    tags: declaredTags().map((name) => ({ name })),
```

with `import { declaredTags } from './tests/need.ts';`.

- [ ] **Step 4: Prove a declared tag is accepted and an undeclared one refused** — a throwaway file, not committed:

```bash
mkdir -p .test-parallel/tagcheck && printf "import { it } from 'vitest';\nit('declared', { tags: ['requires:two-workers'] }, () => {});\n" > .test-parallel/tagcheck/ok.test.ts
printf "import { it } from 'vitest';\nit('undeclared', { tags: ['requires:nope'] }, () => {});\n" > .test-parallel/tagcheck/bad.test.ts
pnpm exec vitest run --configLoader runner --project unit --dir .test-parallel/tagcheck 2>&1 | grep -E "passed|failed|doesn't define|cannot apply"
rm -r .test-parallel/tagcheck
```
Expected: `ok.test.ts` passes; `bad.test.ts` fails with Vitest's "cannot apply" error. If the `unit` project's `include` does not reach `.test-parallel/`, run the two files with `--root .` and an explicit `include` instead; the point is the two outcomes.

- [ ] **Step 5: Full verification, memories, merge**

```bash
pnpm exec biome ci . && pnpm exec tsc --noEmit
pnpm test > "$SCRATCH/step3-test.log" 2>&1
```
(background, progress every 2 minutes; expected: Task 4's total, all green). Then:

```bash
git add tests/browser/target.ts vitest.config.ts
test "$(git branch --show-current)" = test/need-model && git commit -m "test: one definition of the needs, and the tag vocabulary declared

The target resolver's six needs now ask tests/need.ts, so the resolver
and the planner that replaces it cannot disagree in between; its own
tests pass unchanged. The config declares every tag a need can be spelt
with, so a misspelt tag fails its file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
A row in `history/2026-10.md`; in `follow-ups/test-planner-design.md`, step 3 done and **plan B next: the planner, starting with the measurement of how a cell is given its exact tests (spec § 4.5)**; commit; `git merge --no-ff test/need-model`; branch deleted.
