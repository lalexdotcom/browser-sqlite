# VFS Wiring and Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the four VFS the library ships but hides, declare every VFS's capabilities in one compiler-checked table, prove those declarations with a conformance suite, and generate the README's VFS table from the same table.

**Architecture:** `VFS_BUILDS` becomes `VFS_CAPABILITIES`, entries growing from build arrays to objects carrying `builds`, `maxPoolSize`, `multiConnection`, `persistent`, `memoryModel` and `poolLimitReason`. Guards read the table instead of hardcoding VFS names. The table and its types are exported so the future benchmark page enumerates VFS at runtime. A separate rstest project holds six invariants that fail the build when a declaration is false.

**Tech Stack:** TypeScript 7.0.2 (ESM), rstest 0.11.8 with Playwright, rslib 0.23.2, biome 2.5.8, pnpm 10.31.0, Node 24.13.

**Spec:** `docs/superpowers/specs/2026-08-24-vfs-wiring-conformance-design.md`

## Global Constraints

- **rstest 0.11.8 has no `it.each`.** Parameterized tests use a plain `for` loop calling `it()` directly. Pattern: `tests/unit/routing.test.ts`.
- **Serena symbolic tools are primary for code.** Built-in Read/Edit only for `.md`, JSON, YAML and config.
- **Run `pnpm check` (biome) after every modification.**
- **Falsifiability is declared per test and verified by hand** — delete the named line, watch it go red, restore it. Declaring it without executing it is worth nothing; this project has paid for that twice.
- **`pnpm test` must stay at ~8 s.** Conformance is a separate project and must not enter it.
- **Chat is French; code, comments, commits and docs are English.**
- **Feature branch.** Create `feat/vfs-capabilities` before Task 1. Do not commit to `main`.
- **`OPFSPermutedVFS` must not be wired.** Removed deliberately: deprecated upstream and measured at 24 % stale cross-connection reads.

---

### Task 1: Reshape the table into `VFS_CAPABILITIES`

Refactor only — the five wired VFS keep their behaviour. No new VFS yet.

**Files:**
- Modify: `src/types.ts:68-96`
- Modify: `src/client.ts:391-394` (call sites only)
- Test: `tests/unit/capabilities.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `VFS_CAPABILITIES`, `type VFSCapability`, `type VFSMemoryModel`, `type SQLiteVFS = keyof typeof VFS_CAPABILITIES`, `defaultBuildFor(vfs: SQLiteVFS): SQLiteBuild`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/capabilities.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import {
  defaultBuildFor,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

describe('VFS_CAPABILITIES', () => {
  const names = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

  it('declares every field for every VFS', () => {
    for (const vfs of names) {
      const cap = VFS_CAPABILITIES[vfs];
      expect(cap.builds.length).toBeGreaterThan(0);
      expect(['page-cache', 'whole-database']).toContain(cap.memoryModel);
      expect(typeof cap.multiConnection).toBe('boolean');
      expect(typeof cap.persistent).toBe('boolean');
    }
  });

  // Falsifiable: change `.builds[0]` to `.builds[1]` in defaultBuildFor.
  it('resolves the default build to the first declared one', () => {
    for (const vfs of names) {
      expect(defaultBuildFor(vfs)).toBe(VFS_CAPABILITIES[vfs].builds[0]);
    }
  });

  // Falsifiable: delete `maxPoolSize: 1` from the AccessHandlePoolVFS entry.
  it('caps AccessHandlePoolVFS at one worker and leaves the others uncapped', () => {
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.maxPoolSize).toBe(1);
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.maxPoolSize).toBeNull();
  });

  // Falsifiable: set multiConnection to true on AccessHandlePoolVFS.
  it('records which VFS can share one database between connections', () => {
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.multiConnection).toBe(false);
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.multiConnection).toBe(true);
  });

  // Falsifiable: delete poolLimitReason from the AccessHandlePoolVFS entry.
  it('gives every capped VFS a reason for its cap', () => {
    for (const vfs of names) {
      const cap = VFS_CAPABILITIES[vfs];
      if (cap.maxPoolSize !== null) {
        expect(cap.poolLimitReason).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm exec rstest --project unit tests/unit/capabilities.test.ts`
Expected: FAIL — `VFS_CAPABILITIES` is not exported from `src/types.ts`.

- [ ] **Step 3: Replace the table in `src/types.ts`**

Use Serena `replace_content` on `src/types.ts`, replacing the block from `/**\n * The single source of truth for VFS selection` through the end of `defaultBuildFor`:

```ts
/** How much of the database a VFS keeps resident in RAM. */
export type VFSMemoryModel = 'page-cache' | 'whole-database';

/** What a VFS can and cannot do. One entry per VFS, and no second table. */
export type VFSCapability = {
  /** Builds this VFS can run on, most preferred first. */
  readonly builds: readonly [SQLiteBuild, ...SQLiteBuild[]];
  /** Largest pool this VFS supports; `null` when unbounded. */
  readonly maxPoolSize: number | null;
  /** Why the cap exists. Required whenever `maxPoolSize` is not null. */
  readonly poolLimitReason: string | null;
  /** Whether several connections may share one database. */
  readonly multiConnection: boolean;
  /** Whether data outlives `close()`. */
  readonly persistent: boolean;
  /**
   * `page-cache`: only SQLite's page cache is resident, bounded by
   * `PRAGMA cache_size`. `whole-database`: the entire database is resident,
   * and `poolSize` multiplies it.
   */
  readonly memoryModel: VFSMemoryModel;
};

/**
 * The single source of truth for VFS selection. `SQLiteVFS` is derived from its
 * keys, `worker/worker.ts` must supply a loader for every key, the guards in
 * `client.ts` read it, the conformance suite gates its scenarios on it, and the
 * README table is generated from it. Nothing may hold a second copy.
 *
 * Build order is a decision per VFS, not a rule: `sync` is both the fastest and
 * the most portable build, so it leads wherever supported; `OPFSAdaptiveVFS`
 * cannot use it and leads with `async` because `jspi` is Chromium-only.
 *
 * Every declared build combination is verified by running it against the pinned
 * wa-sqlite v1.1.2, never copied from upstream's table.
 */
export const VFS_CAPABILITIES = {
  OPFSAdaptiveVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
  },
  OPFSWriteAheadVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
  },
  AccessHandlePoolVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'it cannot share access handles between connections',
    multiConnection: false,
    persistent: true,
    memoryModel: 'page-cache',
  },
  IDBBatchAtomicVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
  },
} as const satisfies Record<string, VFSCapability>;

export type SQLiteVFS = keyof typeof VFS_CAPABILITIES;

/** The build used when the caller does not name one. */
export const defaultBuildFor = (vfs: SQLiteVFS): SQLiteBuild =>
  VFS_CAPABILITIES[vfs].builds[0];
```

- [ ] **Step 4: Update the two call sites in `src/client.ts`**

Change the import on line 27 from `VFS_BUILDS` to `VFS_CAPABILITIES`, then replace the build guard:

```ts
  const capability = VFS_CAPABILITIES[vfs];

  // Synchronous: an unsupported combination must fail here and name itself,
  // not surface later as an opaque open-error from a worker that could not
  // instantiate its module.
  if (!(capability.builds as readonly SQLiteBuild[]).includes(build)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} cannot run on the '${build}' build. Supported: ${capability.builds.join(', ')}.`,
    );
  }
```

- [ ] **Step 5: Verify nothing else references the old name**

Run: `grep -rn 'VFS_BUILDS' src/ tests/ scripts/ README.md`
Expected: only the README prose mention, which Task 7 rewrites. If any `src/` hit remains, fix it.

- [ ] **Step 6: Run the unit test, then the whole suite**

Run: `pnpm exec rstest --project unit tests/unit/capabilities.test.ts`
Expected: PASS, 5 tests.

Run: `pnpm test`
Expected: PASS, 313 tests (308 + 5).

- [ ] **Step 7: Verify falsifiability by hand**

For each of the four tests carrying a `Falsifiable:` comment, delete the named line, run the file, confirm RED, restore, confirm GREEN.

- [ ] **Step 8: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add src/types.ts src/client.ts tests/unit/capabilities.test.ts
git commit -m "refactor(types): VFS_BUILDS becomes VFS_CAPABILITIES

The table stops being about builds alone. Entries grow from arrays to
objects carrying maxPoolSize, poolLimitReason, multiConnection,
persistent and memoryModel, so the guards, the conformance suite and the
README generator all read one compiler-checked source instead of
hardcoding VFS names between them.

memoryModel is a declared field rather than prose because it is the one
axis a consumer cannot see at all today, where builds, concurrency and
persistence are at least discoverable. It is one axis among several and
vetoes nothing on its own."
```

---

### Task 2: Guards read the table, and every option guard throws the same error

**Files:**
- Modify: `src/client.ts:398-402` (the pool guard), `src/client.ts:347-352` (JSDoc `@throws`)
- Test: `tests/browser/vfs.test.ts:13-49`

**Interfaces:**
- Consumes: `VFS_CAPABILITIES`, `VFSCapability` from Task 1.
- Produces: all option guards throw `SQLiteError` with code `INVALID_OPTION`.

- [ ] **Step 1: Write the failing test**

Add to the `AccessHandlePoolVFS pool guard` describe block in `tests/browser/vfs.test.ts`:

```ts
  // Falsifiable: revert the pool guard in client.ts to `throw new Error(...)`.
  it('reports the pool guard as SQLiteError with code INVALID_OPTION', () => {
    let caught: unknown;
    try {
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
        poolSize: 2,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    // The message must carry the reason, or the caller cannot act on it.
    expect((caught as SQLiteError).message).toMatch(/pool sizes greater than 1/);
    expect((caught as SQLiteError).message).toMatch(/access handles/);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec rstest --project browser tests/browser/vfs.test.ts`
Expected: FAIL — the thrown value is a bare `Error`, so `toBeInstanceOf(SQLiteError)` fails.

- [ ] **Step 3: Replace the hardcoded guard**

In `src/client.ts`, replace lines 398-402:

```ts
  if (capability.maxPoolSize !== null && poolSize > capability.maxPoolSize) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} does not support pool sizes greater than ${capability.maxPoolSize}: ${capability.poolLimitReason}. Set poolSize: ${capability.maxPoolSize}.`,
    );
  }
```

- [ ] **Step 4: Correct the JSDoc that documents the old error type**

Replace the second `@throws` block on `createSQLiteClient` (lines 350-352):

```ts
 * @throws {SQLiteError} With code `INVALID_OPTION` when `poolSize` exceeds the
 *   `maxPoolSize` the chosen `vfs` declares. The message names the cap and the
 *   reason for it; both come from `VFS_CAPABILITIES`.
```

- [ ] **Step 5: Run the file, then the whole suite**

Run: `pnpm exec rstest --project browser tests/browser/vfs.test.ts`
Expected: PASS, 7 tests. The two pre-existing tests asserting `/pool sizes greater than 1/` still pass — the new message keeps that phrase deliberately.

Run: `pnpm test`
Expected: PASS, 314 tests.

- [ ] **Step 6: Verify falsifiability by hand**

Revert the guard to `throw new Error(...)`, confirm the new test goes RED, restore it.

- [ ] **Step 7: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add src/client.ts tests/browser/vfs.test.ts
git commit -m "fix(client): every option guard throws SQLiteError('INVALID_OPTION')

The pool guard threw a bare Error while the build guard three lines above
it threw SQLiteError, so a caller discriminating on \`code\` could not
catch the first. Adding a second pool guard for the memory VFS while
keeping two error types would have made the surface worse.

The guard also stops naming AccessHandlePoolVFS: it reads maxPoolSize and
poolLimitReason from the table, so a VFS added later gets its cap enforced
without touching client.ts. Breaking on the error type, free at rc."
```

---

### Task 3: Wire the four VFS

**Files:**
- Modify: `src/types.ts` (four entries in `VFS_CAPABILITIES`)
- Modify: `src/worker/worker.ts:50-81` (four loaders in `VFSConfigs`)
- Test: `tests/browser/vfs.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `VFS_CAPABILITIES` from Task 1, the guards from Task 2.
- Produces: `SQLiteVFS` gains `'IDBMirrorVFS' | 'OPFSAnyContextVFS' | 'MemoryVFS' | 'MemoryAsyncVFS'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/vfs.test.ts`:

```ts
/**
 * Each newly wired VFS opens on its default build and serves a round trip.
 * The exhaustive build sweep lives in the conformance project; this is the
 * gate that keeps `pnpm test` honest about the four additions.
 */
describe('newly wired VFS', () => {
  // Falsifiable: delete any one loader from VFSConfigs in worker/worker.ts.
  const cases = [
    { vfs: 'IDBMirrorVFS', poolSize: 2 },
    { vfs: 'OPFSAnyContextVFS', poolSize: 2 },
    { vfs: 'MemoryVFS', poolSize: 1 },
    { vfs: 'MemoryAsyncVFS', poolSize: 1 },
  ] as const;

  for (const { vfs, poolSize } of cases) {
    it(`${vfs} opens and serves a round trip`, async () => {
      const db = await createTestClient({ vfs, poolSize });

      await db.write('CREATE TABLE wired (id INTEGER, val TEXT)');
      await db.write("INSERT INTO wired VALUES (1, 'ok')");

      const rows = await db.read<{ id: number; val: string }>(
        'SELECT * FROM wired',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].val).toBe('ok');

      await db.close();
    });
  }
});

/**
 * The memory VFS hold their pages in the worker that opened them, so a pool
 * would hold independent databases diverging silently. That is corruption, not
 * volatility, and the guard states it.
 */
describe('memory VFS pool guard', () => {
  // Falsifiable: set maxPoolSize to null on MemoryVFS in VFS_CAPABILITIES.
  for (const vfs of ['MemoryVFS', 'MemoryAsyncVFS'] as const) {
    it(`${vfs} refuses a pool larger than 1`, () => {
      let caught: unknown;
      try {
        createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
          vfs,
          poolSize: 2,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SQLiteError);
      expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
      expect((caught as SQLiteError).message).toMatch(/diverge/);
    });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec rstest --project browser tests/browser/vfs.test.ts`
Expected: FAIL — TypeScript rejects `'IDBMirrorVFS'` because it is not in `SQLiteVFS`.

- [ ] **Step 3: Add the four capability entries**

Insert into `VFS_CAPABILITIES` in `src/types.ts`, after `IDBBatchAtomicVFS`:

```ts
  IDBMirrorVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    // Upstream: "keeps all files in memory, persisting database files to
    // IndexedDB", and the whole database must fit in available memory.
    memoryModel: 'whole-database',
  },
  OPFSAnyContextVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
  },
  MemoryVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
  },
  MemoryAsyncVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
  },
```

`IDBMirrorVFS`'s builds are inferred from its source — `jOpen`, `jLock` and `jClose` are async while `jRead` and `jWrite` are not — because it is absent from upstream's comparison table. It is the row most likely to be contradicted by Task 5's sweep.

- [ ] **Step 4: Add the four loaders**

Insert into `VFSConfigs` in `src/worker/worker.ts`, after the `IDBBatchAtomicVFS` entry:

```ts
  IDBMirrorVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "IDBMirrorVFS" */ 'wa-sqlite/src/examples/IDBMirrorVFS.js'
      ),
  },
  OPFSAnyContextVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSAnyContextVFS" */ 'wa-sqlite/src/examples/OPFSAnyContextVFS.js'
      ),
  },
  MemoryVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "MemoryVFS" */ 'wa-sqlite/src/examples/MemoryVFS.js'
      ),
  },
  MemoryAsyncVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "MemoryAsyncVFS" */ 'wa-sqlite/src/examples/MemoryAsyncVFS.js'
      ),
  },
```

- [ ] **Step 5: Run the file, then the whole suite**

Run: `pnpm exec rstest --project browser tests/browser/vfs.test.ts`
Expected: PASS, 13 tests.

Run: `pnpm test`
Expected: PASS, 320 tests.

If `MemoryAsyncVFS` fails to construct: its `create` static returns a `MemoryVFS` instance rather than a `MemoryAsyncVFS` one (visible in the upstream source). If that breaks the open, record the finding in the commit message and mark the VFS unwired rather than working around it — do not patch `node_modules`.

- [ ] **Step 6: Measure the bundle delta**

```bash
pnpm build
gzip -c dist/worker/worker.js | wc -c
```
Expected: around 134 000 bytes, against 123 652 before. Record the actual number in the commit message. A delta far above +12 % means something other than the four VFS was pulled in — investigate before committing.

- [ ] **Step 7: Verify falsifiability by hand**

Delete the `IDBMirrorVFS` loader from `VFSConfigs`; confirm the round-trip test for it goes RED; restore. Set `maxPoolSize: null` on `MemoryVFS`; confirm its guard test goes RED; restore.

- [ ] **Step 8: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add src/types.ts src/worker/worker.ts tests/browser/vfs.test.ts
git commit -m "feat(vfs): wire IDBMirror, AnyContext and the two memory VFS

IDBMirrorVFS and OPFSAnyContextVFS are the only VFS that escape HANDLE-1
structurally: neither holds a synchronous OPFS access handle, so neither
can strand the pool behind a worker inside a long uninterruptible step.
They are therefore the only candidates for a browser without
readwrite-unsafe.

MemoryVFS and MemoryAsyncVFS are not product options - their pages live
in the worker that opened them, so a pool would hold independent
databases diverging silently, and the guard says so. They are wired
because they are the storage floor that makes every other number
interpretable, and because the sync/async pair prices the Asyncify bridge
at identical storage, which is the missing piece for Firefox's measured
5.5x penalty.

IDBMirrorVFS's build row is inferred from its source rather than from
upstream's comparison table, which omits it entirely. The conformance
sweep is what will confirm or contradict it."
```

---

### Task 4: Export the capability table from the package entry

**Files:**
- Modify: `src/index.ts`
- Test: `tests/unit/exports.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `VFS_CAPABILITIES`, `defaultBuildFor`, `SQLiteVFS`, `SQLiteBuild`, `VFSCapability`, `VFSMemoryModel` reachable from `browser-sqlite`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/exports.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import * as api from '../../src/index';

/**
 * The benchmark page enumerates VFS from the library at runtime instead of
 * holding a copy that would drift. That only works if the table is reachable
 * from the package entry, which it was not: `SQLiteVFS` named the type of a
 * public option that no consumer could name.
 */
describe('public entry', () => {
  // Falsifiable: remove the types re-export from src/index.ts.
  it('exposes the capability table and its default-build helper', () => {
    expect(typeof api.VFS_CAPABILITIES).toBe('object');
    expect(typeof api.defaultBuildFor).toBe('function');
  });

  // Falsifiable: drop one VFS from VFS_CAPABILITIES.
  it('exposes every wired VFS', () => {
    expect(Object.keys(api.VFS_CAPABILITIES).sort()).toEqual(
      [
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'MemoryAsyncVFS',
        'MemoryVFS',
        'OPFSAdaptiveVFS',
        'OPFSAnyContextVFS',
        'OPFSCoopSyncVFS',
        'OPFSWriteAheadVFS',
      ].sort(),
    );
  });

  // Falsifiable: delete the createSQLiteClient re-export.
  it('still exposes the client and the error type', () => {
    expect(typeof api.createSQLiteClient).toBe('function');
    expect(typeof api.SQLiteError).toBe('function');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec rstest --project unit tests/unit/exports.test.ts`
Expected: FAIL — `api.VFS_CAPABILITIES` is `undefined`.

- [ ] **Step 3: Add the named re-export**

Replace `src/index.ts` in full:

```ts
export * from './client';
export * from './errors';
// Named rather than `export *`: the wire-protocol types in types.ts are
// internal and must not reach the public surface.
export {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type VFSCapability,
  type VFSMemoryModel,
} from './types';
```

- [ ] **Step 4: Run the test, then the whole suite**

Run: `pnpm exec rstest --project unit tests/unit/exports.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm test`
Expected: PASS, 323 tests.

- [ ] **Step 5: Verify the declarations reach the published artifact**

```bash
pnpm build
grep -c 'VFS_CAPABILITIES' dist/index.d.ts
grep -c 'SQLiteVFS' dist/index.d.ts
```
Expected: both non-zero. Before this task both were zero, which is the W-types defect being closed.

- [ ] **Step 6: Verify falsifiability by hand**

Remove the `./types` re-export, confirm the first test goes RED, restore.

- [ ] **Step 7: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add src/index.ts tests/unit/exports.test.ts
git commit -m "feat(api): export the VFS capability table and its types

SQLiteVFS named the type of a public option that no consumer could name:
index.ts re-exported only client and errors, and dist/index.d.ts
mentioned neither the table nor the types. That is the open half of
W-types.

Exporting it also lets the benchmark page enumerate VFS from the library
at runtime rather than holding a list that would drift, which makes the
page an ordinary consumer of the public API with no deep imports. The
re-export is named, not a star, so the wire-protocol types in types.ts
stay internal."
```

---

### Task 5: The conformance project, and the exhaustive build sweep

**Files:**
- Create: `rstest.conformance.config.ts`
- Create: `tests/conformance/builds.test.ts`
- Create: `tests/conformance/helpers.ts`
- Modify: `rstest.config.ts` (export the plugin for reuse)
- Modify: `package.json` (add `test:conformance`)
- Modify: `.github/workflows/ci.yaml` (add a step to `verify`)

**Interfaces:**
- Consumes: `VFS_CAPABILITIES`, `defaultBuildFor`, `createSQLiteClient`.
- Produces, all in `tests/conformance/helpers.ts` and all used by Task 6:
  `ALL_VFS: SQLiteVFS[]`, `HAS_JSPI: boolean`, `poolFor(vfs: SQLiteVFS): number`,
  `conformanceClient(vfs: SQLiteVFS, build?: SQLiteBuild, poolSize?: number): { file: string; db: SQLiteDB }`.

- [ ] **Step 1: Export the existing plugin so the second config reuses it**

In `rstest.config.ts`, change `const pluginSilenceWorkerHmrLogs = {` to `export const pluginSilenceWorkerHmrLogs = {`. Nothing else in that file changes — the `unit` and `browser` projects stay exactly as they are, and conformance must never join them.

- [ ] **Step 2: Create the conformance helpers**

Create `tests/conformance/helpers.ts`:

```ts
import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

/** Every wired VFS, in declaration order. */
export const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

/**
 * JSPI is Chromium 126+. Feature-detected rather than sniffed from the user
 * agent, so a browser that gains it later is picked up with no edit here.
 */
export const HAS_JSPI =
  typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function';

/** The largest pool a VFS allows, capped at 2 so scenarios stay comparable. */
export const poolFor = (vfs: SQLiteVFS): number =>
  VFS_CAPABILITIES[vfs].maxPoolSize ?? 2;

/**
 * A client on a unique database, registered for cleanup. Unique names keep
 * scenarios independent; OPFS entries are removed afterwards, and the memory
 * VFS have nothing to remove.
 */
export const conformanceClient = (
  vfs: SQLiteVFS,
  build: SQLiteBuild = defaultBuildFor(vfs),
  poolSize: number = poolFor(vfs),
) => {
  const file = `conformance-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(file, { recursive: true });
    } catch {
      // Never created, or this VFS does not use OPFS at all.
    }
  });

  return { file, db: createSQLiteClient(file, { vfs, build, poolSize }) };
};
```

- [ ] **Step 3: Write the build sweep**

Create `tests/conformance/builds.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { VFS_CAPABILITIES } from '../../src/types';
import { ALL_VFS, conformanceClient, HAS_JSPI } from './helpers';

/**
 * Every declared (vfs, build) pair is executed, never trusted. Declaring a
 * combination that does not work is the failure this exists to catch, and
 * IDBMirrorVFS is the row most at risk: it is absent from upstream's table, so
 * its builds were inferred from its source.
 *
 * Falsifiable: add 'sync' to OPFSAdaptiveVFS's builds — that pair goes red.
 */
describe('declared build combinations', () => {
  for (const vfs of ALL_VFS) {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      if (build === 'jspi' && !HAS_JSPI) {
        it.skip(`${vfs} on ${build} — skipped, no JSPI in this browser`, () => {});
        continue;
      }

      it(`${vfs} on ${build} opens and serves a query`, async () => {
        const { db } = conformanceClient(vfs, build);

        await db.write('CREATE TABLE t (a INTEGER)');
        await db.write('INSERT INTO t VALUES (1)');
        const rows = await db.read<{ n: number }>(
          'SELECT count(*) AS n FROM t',
        );

        expect(rows[0].n).toBe(1);
        await db.close();
      });
    }
  }
});
```

- [ ] **Step 4: Create the conformance config**

Create `rstest.conformance.config.ts`:

```ts
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

/**
 * Separate from rstest.config.ts on purpose. Eight VFS through the invariants
 * start workers and open real storage, which is too slow for the suite a
 * developer runs on every change. This one runs on demand and in CI.
 *
 * It holds invariants only. Measurements belong to the benchmark page, on the
 * machine of whoever opens it — CI runs tests, not benchmarks.
 */
export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'conformance',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: (process.env.CONFORMANCE_BROWSER ?? 'chromium') as
          | 'chromium'
          | 'firefox',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/conformance/**/*.test.ts'],
      testTimeout: 60000,
    },
  ],
});
```

- [ ] **Step 5: Add the script**

In `package.json`, add to `scripts`:

```json
    "test:conformance": "rstest --config rstest.conformance.config.ts",
```

- [ ] **Step 6: Verify conformance stays out of `pnpm test`**

Run: `pnpm test`
Expected: PASS, 323 tests — the same count as Task 4, and no `conformance` project in the output. If the count grew, `rstest.config.ts` is picking the new directory up; fix its `include` globs rather than the conformance config.

- [ ] **Step 7: Run the sweep on both browsers**

```bash
pnpm test:conformance
CONFORMANCE_BROWSER=firefox pnpm test:conformance
```
Expected on Chromium: 22 tests, all passing. Expected on Firefox: 22 collected, the 8 `jspi` pairs skipped with their reason, 14 passing.

**If a declared pair fails, the declaration is wrong, not the test.** Remove that build from the VFS's `builds` in `VFS_CAPABILITIES` and record what was observed in the commit message. `IDBMirrorVFS` is the expected candidate.

- [ ] **Step 8: Add the CI step**

In `.github/workflows/ci.yaml`, in the `verify` job, insert after the `Test` step:

```yaml
      # Conformance is a separate project and deliberately out of `pnpm test`:
      # eight VFS through the invariants start workers and open real storage.
      # It runs on both engines because a VFS can be sound on one and broken on
      # the other — which is how HANDLE-1 was found.
      - name: Conformance (Chromium)
        run: pnpm test:conformance

      - name: Conformance (Firefox)
        run: CONFORMANCE_BROWSER=firefox pnpm test:conformance
```

- [ ] **Step 9: Verify falsifiability by hand**

Add `'sync'` to `OPFSAdaptiveVFS`'s `builds`; run `pnpm test:conformance`; confirm the new pair goes RED; remove it.

- [ ] **Step 10: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add rstest.config.ts rstest.conformance.config.ts package.json tests/conformance .github/workflows/ci.yaml
git commit -m "test(conformance): a separate project, and every build pair executed

Twenty-two declared (vfs, build) pairs, each run rather than trusted.
That is the convention from feat/vfs-default applied to the nine new
combinations, and IDBMirrorVFS is the row it exists for: absent from
upstream's comparison table, its builds were read off its source.

Separate from pnpm test because eight VFS opening real storage is too
slow for the loop a developer runs on every change. It holds invariants
only - measurements belong to the benchmark page, on the machine of
whoever opens it.

JSPI is feature-detected through WebAssembly.Suspending rather than
sniffed from the user agent, so those pairs skip with a reason on Firefox
instead of failing, and a browser that gains JSPI later needs no edit."
```

---

### Task 6: The six invariants

**Files:**
- Create: `tests/conformance/invariants.test.ts`

**Interfaces:**
- Consumes: `ALL_VFS`, `conformanceClient`, `poolFor` from Task 5.
- Produces: nothing further.

- [ ] **Step 1: Write the invariants**

Create `tests/conformance/invariants.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { VFS_CAPABILITIES } from '../../src/types';
import { ALL_VFS, conformanceClient } from './helpers';

/**
 * What every VFS owes, whatever the browser. These fail the build: a VFS that
 * loses data is broken, full stop. What legitimately varies between VFS -
 * latency, throughput, footprint, whether a long statement strands the pool -
 * is measured by the benchmark page and never asserted here.
 *
 * A scenario a VFS cannot support is skipped with its reason, never silently
 * absent, so the output reads as coverage rather than as a pass.
 */
describe('invariant 1 — what is written is read back', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (42)');
      const rows = await db.read<{ a: number }>('SELECT a FROM t');
      expect(rows).toEqual([{ a: 42 }]);
      await db.close();
    });
  }
});

describe('invariant 2 — data survives close and reopen', () => {
  for (const vfs of ALL_VFS) {
    if (!VFS_CAPABILITIES[vfs].persistent) {
      it.skip(`${vfs} — skipped, declared not persistent`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { file, db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (7)');
      await db.close();

      const reopened = createReopened(file, vfs);
      const rows = await reopened.read<{ a: number }>('SELECT a FROM t');
      expect(rows).toEqual([{ a: 7 }]);
      await reopened.close();
    });
  }
});

describe('invariant 3 — concurrent writes lose nothing', () => {
  for (const vfs of ALL_VFS) {
    if (VFS_CAPABILITIES[vfs].maxPoolSize === 1) {
      it.skip(`${vfs} — skipped, capped at one worker`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          db.write('INSERT INTO t VALUES (?)', [i]),
        ),
      );

      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(N);
      await db.close();
    });
  }
});

describe('invariant 4 — a rolled-back transaction leaves nothing', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(0);
      await db.close();
    });
  }
});

describe('invariant 5 — close settles', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      // No clock: a close that never settles exhausts the 60 s testTimeout,
      // which is the failure. Asserting a duration here would be a benchmark.
      await db.close();
      await expect(db.read('SELECT 1 AS n')).rejects.toThrow();
    });
  }
});

describe('invariant 6 — no read runs inside an open transaction', () => {
  for (const vfs of ALL_VFS) {
    if (VFS_CAPABILITIES[vfs].maxPoolSize === 1) {
      it.skip(`${vfs} — skipped, capped at one worker`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const tx = db.transaction(async (inner) => {
        await inner.write('INSERT INTO t VALUES (1)');
        await held;
      });

      // B1: this must be served by another worker and must not see the
      // uncommitted row. If it ran inside the transaction it would see 1.
      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(0);

      release();
      await tx;
      await db.close();
    });
  }
});
```

- [ ] **Step 2: Add the reopen helper the second invariant needs**

Append to `tests/conformance/helpers.ts`:

```ts
/**
 * A second client on an existing database file, for the close-and-reopen
 * invariant. It deliberately registers no cleanup: the first client already
 * did, on the same name.
 */
export const createReopened = (file: string, vfs: SQLiteVFS) =>
  createSQLiteClient(file, {
    vfs,
    build: defaultBuildFor(vfs),
    poolSize: poolFor(vfs),
  });
```

Then add `createReopened` to the imports at the top of `invariants.test.ts`:

```ts
import { ALL_VFS, conformanceClient, createReopened } from './helpers';
```

`poolFor` is deliberately not imported: `conformanceClient` applies it internally, and biome
fails an unused import.

- [ ] **Step 3: Run on Chromium**

Run: `pnpm test:conformance`
Expected: 54 tests collected across the six describes (9 VFS × 6, minus none — every VFS appears in every describe, as a test or a skip). Passing or skipping, none failing.

**A failure here means a declaration is false, not that the test is wrong.** Fix the capability entry to match reality and note it in the commit message.

- [ ] **Step 4: Run on Firefox**

Run: `CONFORMANCE_BROWSER=firefox pnpm test:conformance`
Expected: same collection, same outcome. A VFS sound on Chromium and broken on Firefox is exactly the finding this suite exists to surface — record it rather than working around it.

- [ ] **Step 5: Verify falsifiability by hand**

For invariant 6, comment out the `await held;` line so the transaction closes immediately: the concurrent read then sees the committed row and the test goes RED. Restore it. For invariant 3, change `N` to `1`: confirm it still passes, which shows the assertion is only load-bearing at N > 1, then restore it to 20.

- [ ] **Step 6: Type-check, lint, commit**

```bash
pnpm exec tsc --noEmit
pnpm check
git add tests/conformance
git commit -m "test(conformance): six invariants every VFS owes

What is written is read back; data survives close and reopen; concurrent
writes lose nothing; a rolled-back transaction leaves nothing; close
settles; and no read runs inside an open transaction, which is B1, the
invariant this pool was rebuilt around.

They fail the build with no per-browser exemptions, because a VFS that
loses data is broken whatever the engine. What legitimately varies -
latency, throughput, footprint, whether a long statement strands the pool
- is not asserted here at all; it belongs to the benchmark page.

A scenario a VFS cannot support is skipped with its reason rather than
being absent, so the output reads as coverage instead of as a pass. The
capability table decides which, so a wrong declaration surfaces as a
failure rather than as a silent gap."
```

---

### Task 7: Generate the README's VFS table

**Files:**
- Create: `scripts/render-vfs-matrix.ts`
- Modify: `README.md:56-74` (the VFS Selection section)
- Modify: `package.json` (add `docs:vfs`)
- Modify: `.github/workflows/ci.yaml` (add a drift check to `verify`)

**Interfaces:**
- Consumes: `VFS_CAPABILITIES` from Task 1.
- Produces: a generated block in `README.md` between HTML comment markers.

- [ ] **Step 1: Confirm `src/types.ts` has no runtime imports**

Run: `grep -n '^import' src/types.ts`
Expected: no output, or type-only imports. Node 24 strips types natively, so a `.ts` script can import it directly. If a runtime import appears, the script must import from `dist/index.js` after `pnpm build` instead, and the CI step must move after the build step.

- [ ] **Step 2: Add the markers to the README**

Replace the table in `README.md` (the five `| ... |` rows and the header rows under `## VFS Selection`) with:

```markdown
<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->
<!-- END GENERATED VFS TABLE -->
```

Leave the surrounding prose — the intro sentence, `When \`vfs\` is omitted…`, and the `### Builds` section — untouched. Only the table is generated.

- [ ] **Step 3: Write the script**

Create `scripts/render-vfs-matrix.ts`:

```ts
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { VFS_CAPABILITIES } from '../src/types.ts';

const BEGIN =
  '<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->';
const END = '<!-- END GENERATED VFS TABLE -->';

const DEFAULT_VFS = 'OPFSAdaptiveVFS';

const MEMORY_LABEL = {
  'page-cache': 'Page cache only, bounded by `PRAGMA cache_size`',
  'whole-database': '**Whole database in RAM**, multiplied by `poolSize`',
} as const;

const rows = Object.entries(VFS_CAPABILITIES).map(([name, cap]) => {
  const label = name === DEFAULT_VFS ? `\`${name}\` **(default)**` : `\`${name}\``;
  const builds = cap.builds.map((b) => `\`${b}\``).join(', ');
  const pool =
    cap.maxPoolSize === null
      ? 'Any'
      : `**${cap.maxPoolSize}** — ${cap.poolLimitReason}`;
  const shared = cap.multiConnection ? 'Yes' : 'No';
  const durable = cap.persistent ? 'Yes' : '**No — volatile**';
  return `| ${label} | ${builds} | ${pool} | ${shared} | ${durable} | ${MEMORY_LABEL[cap.memoryModel]} |`;
});

const table = [
  '| VFS | Builds | Pool size | Shared between connections | Survives close | Memory |',
  '|-----|--------|-----------|----------------------------|----------------|--------|',
  ...rows,
].join('\n');

const path = new URL('../README.md', import.meta.url);
const readme = readFileSync(path, 'utf8');

const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END);
if (start === -1 || end === -1) {
  throw new Error('README markers not found — see scripts/render-vfs-matrix.ts');
}

const next =
  readme.slice(0, start + BEGIN.length) +
  '\n\n' +
  table +
  '\n\n' +
  readme.slice(end);

writeFileSync(path, next);
console.log(`Rendered ${rows.length} VFS rows into README.md`);
```

- [ ] **Step 4: Add the script entry**

In `package.json`, add to `scripts`:

```json
    "docs:vfs": "node scripts/render-vfs-matrix.ts",
```

- [ ] **Step 5: Run it and read the result**

```bash
pnpm docs:vfs
git diff README.md
```
Expected: nine rows between the markers. Read them: `MemoryVFS` and `MemoryAsyncVFS` must show **No — volatile**, `IDBMirrorVFS` must show the whole-database memory model, and `AccessHandlePoolVFS` must show its cap with its reason.

- [ ] **Step 6: Prove the generator is load-bearing**

```bash
sed -i 's/| `MemoryVFS` |/| `MemoryVFSX` |/' README.md
pnpm docs:vfs
git diff --stat README.md
```
Expected: the edit is overwritten — the generator owns the block. Then `git checkout -- README.md && pnpm docs:vfs`.

- [ ] **Step 7: Add the CI drift check**

In `.github/workflows/ci.yaml`, in the `verify` job, after the `Lint and format check` step:

```yaml
      # The README's VFS table is generated from VFS_CAPABILITIES. Regenerate
      # and fail on any diff: the table cannot drift from the declarations,
      # while the conformance job proves the declarations are true.
      - name: VFS table is current
        run: |
          pnpm docs:vfs
          git diff --exit-code README.md
```

- [ ] **Step 8: Rewrite the surrounding prose**

Two corrections the generated table does not make on its own, both recorded as open defects in `mem:project-state`:

1. Delete the dangling sentence `See Known Limitations before using it with \`poolSize > 1\`.` — it pointed at a Known Limitations entry that does not exist.
2. In `### Builds`, replace `The pairing is declared in one place, \`VFS_BUILDS\`` with `\`VFS_CAPABILITIES\``.

Add one paragraph below the table, and mark it as the single claim the suite does not prove:

```markdown
One property the table cannot show, because verifying it means timing something
and this project's CI runs tests rather than benchmarks: **on a browser without
`readwrite-unsafe` access handles, any VFS that rotates a single exclusive OPFS
handle serializes the whole pool for the duration of a long uninterruptible
statement.** That covers `OPFSAdaptiveVFS` in its degraded mode and
`OPFSCoopSyncVFS`. `IDBMirrorVFS`, `OPFSAnyContextVFS` and `IDBBatchAtomicVFS`
hold no such handle and are unaffected.

Browsers nobody has run are marked *not measured* rather than presumed
compatible.
```

- [ ] **Step 9: Full verification**

```bash
pnpm exec tsc --noEmit
pnpm check
pnpm test
pnpm test:conformance
CONFORMANCE_BROWSER=firefox pnpm test:conformance
pnpm build
pnpm test:consumer
```
Expected: 323 tests, conformance green on both engines, consumer smoke 11/11.

- [ ] **Step 10: Commit**

```bash
git add scripts/render-vfs-matrix.ts package.json README.md .github/workflows/ci.yaml
git commit -m "docs(readme): generate the VFS table from the capability table

The table is rendered from VFS_CAPABILITIES by a script that launches no
browser, and CI regenerates it and fails on any diff, so the documentation
cannot drift from the declarations while the conformance suite proves the
declarations are true. That is the same anti-drift guarantee an earlier
draft sought through a committed results artifact with provenance and
dates, obtained through tests instead - simpler, stronger, and with
nothing to maintain.

No timings appear. Benchmarks measured on one machine promise performance
the library does not control, and readers are reliably disappointed by
libraries that publish them; the benchmark page will let a consumer
measure their own.

Also fixes two standing defects in the surrounding prose: a cross
reference to a Known Limitations entry that does not exist, and a
reference to VFS_BUILDS under its old name. The pool-serialization
paragraph is marked as the one claim the suite does not prove, because
verifying it means timing something."
```

---

## Post-merge verification

Merge `feat/vfs-capabilities` into `main`, then verify **on `main`, not on the branch** — the closure condition every previous wave has used:

- [ ] `pnpm check` clean
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] `pnpm test` — 323 tests, 0 failures, and still around 8 s
- [ ] `pnpm test:conformance` green on Chromium and on Firefox
- [ ] `pnpm test:consumer` — 11/11
- [ ] `gzip -c dist/worker/worker.js | wc -c` recorded, and the delta against 123 652 explained
- [ ] `mem:project-state`, `mem:follow-ups` and `mem:resume-plan` updated: VFS-COV closes, the capability table replaces every mention of `VFS_BUILDS`, and the wired count goes from five to nine
