# The default build is the first one the engine supports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With no `build` passed, the library loads the first build the VFS declares whose requirements the engine meets, and every VFS declares `jspi` before `async`.

**Architecture:** `defaultBuildFor(vfs, available)` moves to `src/capabilities.ts` and becomes a pure resolution over `BUILD_CAPABILITIES`; the client and `deleteDatabase` call it with `detectFeatures()`, the worker stops resolving. Task 1 is the whole behaviour change in one green commit (the signature change breaks every caller at once). Task 2 adds the end-to-end browser test of the no-JSPI fallback. Task 3 is the documentation. Task 4 is the delivery verification, full matrix included.

**Tech Stack:** TypeScript 7 (native), rslib, rstest (browser mode on Playwright Chromium and Firefox 153), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-24-default-build-design.md`

## Global Constraints

- **Serena tools are primary for code** (AGENTS.md). Explore with `get_symbols_overview`, read with `find_symbol` (`include_body`), edit with `replace_symbol_body` / `insert_*_symbol` / `replace_content`. Built-in Read/Edit on code files only when Serena fails. Read/Edit are fine on `.md`, JSON, config.
- **`defaultBuildFor` stays exported** from `src/index.ts`, now from `./capabilities` (user, 2026-09-24). `tests/unit/exports.test.ts` is not modified.
- **Inside `src/const/`, cross-file imports are `import type` only.** That is why `defaultBuildFor` leaves `src/const/vfs.ts`.
- **No build is added to or removed from any VFS.** Only the order moves: `['sync', 'jspi', 'async']` and `['jspi', 'async']`.
- **After every modification:** `pnpm exec biome check --write <touched files>`.
- **Comments state the fact, one or two lines**; the reasoning goes to the commit message.
- **Markdown prose is not hard-wrapped** — a paragraph you rewrite becomes one line. Commit messages are wrapped at 72 and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`.** Run `pnpm exec tsc --noEmit` yourself before each commit; if the hook fails, stop and report its output verbatim; after committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- **Scratch files go in `.scratchpad/default-build/`** at the repository root (gitignored). Nothing in `src/` or `tests/` may depend on it.

## Review Focus

- **An explicit `build` must win, untouched.** `clientOptions.build ?? …` and `options.build ?? …` stay the first operand; a consumer passing `build: 'async'` on Chromium keeps `async`. Pinned by Task 2's second case, which passes `build: 'async'` with JSPI present.
- **`deleteDatabase` with no `build` on an engine without JSPI.** It resolves separately from the client; a forgotten call site would still hand the worker `jspi`. Pinned by Task 2's test, which deletes with JSPI hidden and no `build`.
- **The abort channel under cross-origin isolation.** `detectFeatures()` is now called once and shared; `abortSlots` must still be allocated when isolated. Pinned by the isolated config in Task 4's `pnpm test`.
- **A test config claiming a feature its engine lacks.** `CHROMIUM_FEATURES` / `FIREFOX_FEATURES` are declared by hand; a wrong claim makes a target the client refuses. Pinned by Task 1 Step 1's `targetsFromEnv` unit case and, loudly, by `INVALID_OPTION` at construction in Task 4.
- **Test selection moves with the order.** `resolvePair` tries a VFS's builds in declared order, so on Chromium and Firefox a test moved off a `sync` target now lands on `jspi` rather than `async`; `pnpm test` keeps `async` only where a test names it. Expected, not a defect — the matrix covers every `async` pair. Report the Task 4 counts beside the baseline.

---

### Task 1: Resolve the default build against the engine

**Files:**
- Modify: `src/const/vfs.ts` (the nine `builds` arrays; delete `defaultBuildFor`)
- Modify: `src/capabilities.ts` (add `defaultBuildFor`; import `type VFSCapability`)
- Modify: `src/index.ts` (`defaultBuildFor` exported from `./capabilities`)
- Modify: `src/client.ts` (`createSQLiteClient`: one `detectFeatures()` call; import)
- Modify: `src/delete.ts` (`deleteDatabase`; import)
- Modify: `src/types/protocol.ts` (`build` required on `open` and `delete`)
- Modify: `src/worker/worker.ts` (`OpenOptions`, `open`, `deleteDatabaseFiles`, import)
- Modify: `tests/target-projects.ts`, `rstest.config.ts`, `rstest.firefox.config.ts`, `rstest.isolated.config.ts`
- Modify: `tests/conformance/helpers.ts` (`missingHere`, `conformanceClient`, `createReopened`, import)
- Modify: `tests/browser/helpers.ts` (`createTestClient`, import)
- Modify: comments only — `tests/browser/vfs.test.ts:121,123`, `tests/browser/delete.test.ts:75`
- Test: `tests/unit/capabilities.test.ts`, `tests/unit/target-projects.test.ts` (new)

**Interfaces:**
- Produces, in `src/capabilities.ts`: `export const defaultBuildFor = (vfs: SQLiteVFS, available: ReadonlySet<PlatformFeature>): SQLiteBuild`.
- Produces, in `tests/target-projects.ts`: `export const CHROMIUM_FEATURES: ReadonlySet<PlatformFeature>`, `export const FIREFOX_FEATURES: ReadonlySet<PlatformFeature>`, and `targetsFromEnv(env: string | undefined, engine: ReadonlySet<PlatformFeature>): TestTarget[]`.
- `ClientMessageData`'s `open` and `delete` variants: `build: SQLiteBuild` (no longer optional).

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/capabilities.test.ts`, change the imports to:

```ts
import { describe, expect, it } from '@rstest/core';
import { defaultBuildFor } from '../../src/capabilities';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { folderOf, type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
```

(keep any other names the file already imports from these modules). Replace the test `'resolves the default build to the first declared one'` whole with:

```ts
  const WITH_JSPI = new Set<PlatformFeature>(['jspi']);
  const WITHOUT_JSPI = new Set<PlatformFeature>();
  const JSPI_FIRST: readonly SQLiteVFS[] = [
    'OPFSAdaptiveVFS',
    'IDBBatchAtomicVFS',
    'IDBMirrorVFS',
    'OPFSAnyContextVFS',
    'MemoryAsyncVFS',
  ];

  // Falsifiable: swap `jspi` and `async` back in any `builds` array.
  it('declares jspi before async on every VFS that runs both', () => {
    for (const vfs of names) {
      const builds = VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[];
      expect(builds.indexOf('jspi')).toBeLessThan(builds.indexOf('async'));
    }
  });

  // Falsifiable: return `builds[1]` in defaultBuildFor.
  it('resolves the default build to the first declared one where the engine has JSPI', () => {
    for (const vfs of names) {
      expect(defaultBuildFor(vfs, WITH_JSPI)).toBe(
        VFS_CAPABILITIES[vfs].builds[0],
      );
    }
  });

  // Falsifiable: return `builds[0]` whatever `available` says.
  it('falls back to the first declared build that requires nothing without JSPI', () => {
    for (const vfs of names) {
      const expected = JSPI_FIRST.includes(vfs) ? 'async' : 'sync';
      expect(defaultBuildFor(vfs, WITHOUT_JSPI)).toBe(expected);
    }
  });

  // Falsifiable: drop `async` from a jspi-first VFS's `builds`.
  it('gives every VFS a build that requires nothing, so the resolution always lands', () => {
    for (const vfs of names) {
      const builds = VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[];
      expect(
        builds.some((build) => BUILD_CAPABILITIES[build].requires.length === 0),
      ).toBe(true);
    }
  });
```

Create `tests/unit/target-projects.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import type { PlatformFeature } from '../../src/const/platform';
import {
  CHROMIUM_FEATURES,
  FIREFOX_FEATURES,
  targetsFromEnv,
} from '../target-projects';

describe('targetsFromEnv', () => {
  // Falsifiable: resolve the default targets without the engine's features.
  it('runs each recommended VFS on the default build of the engine under test', () => {
    for (const engine of [CHROMIUM_FEATURES, FIREFOX_FEATURES]) {
      expect(targetsFromEnv(undefined, engine)).toEqual([
        { vfs: 'OPFSWriteAheadVFS', build: 'sync' },
        { vfs: 'OPFSAdaptiveVFS', build: 'jspi' },
      ]);
    }
  });

  it('falls back to async on an engine without JSPI', () => {
    expect(targetsFromEnv(undefined, new Set<PlatformFeature>())).toContainEqual({
      vfs: 'OPFSAdaptiveVFS',
      build: 'async',
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/capabilities.test.ts tests/unit/target-projects.test.ts`
Expected: FAIL — `defaultBuildFor` is not exported by `src/capabilities`, and `CHROMIUM_FEATURES` does not exist.

- [ ] **Step 3: Reorder the builds**

In `src/const/vfs.ts`, with `replace_content` (literal, `allow_multiple_occurrences: true`): `builds: ['sync', 'async', 'jspi'],` → `builds: ['sync', 'jspi', 'async'],` (4 occurrences), and `builds: ['async', 'jspi'],` → `builds: ['jspi', 'async'],` (5 occurrences). Then delete the `defaultBuildFor` declaration and its one-line JSDoc at the end of the file (`safe_delete_symbol` will refuse while callers exist — use `replace_content` on the three lines).

- [ ] **Step 4: Add the resolution to `src/capabilities.ts`**

Change the import from `./const/vfs` to `import { type SQLiteVFS, VFS_CAPABILITIES, type VFSCapability } from './const/vfs';` and insert after `missingFeature`:

```ts
/**
 * The build used when the caller does not name one: the first the VFS declares
 * whose requirements `available` meets. Pure for `missingFeature`'s reason.
 */
export const defaultBuildFor = (
  vfs: SQLiteVFS,
  available: ReadonlySet<PlatformFeature>,
): SQLiteBuild => {
  const { builds }: VFSCapability = VFS_CAPABILITIES[vfs];
  return (
    builds.find((build) =>
      (BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]).every(
        (feature) => available.has(feature),
      ),
    ) ?? builds[0]
  );
};
```

In `src/index.ts`: `export { defaultBuildFor, detectFeatures, missingFeature } from './capabilities';` and remove `defaultBuildFor,` from the `./const/vfs` export block.

- [ ] **Step 5: The client probes once**

In `createSQLiteClient` (`src/client.ts`), replace

```ts
  const vfs = clientOptions.vfs;
  const build = clientOptions.build ?? defaultBuildFor(vfs);
```

with

```ts
  const vfs = clientOptions.vfs;
  // Probed once: the default build, the abort channel and the guard below read it.
  const available = detectFeatures();
  const build = clientOptions.build ?? defaultBuildFor(vfs, available);
```

Then `detectFeatures().has('cross-origin-isolated')` → `available.has('cross-origin-isolated')`, and `missingFeature(vfs, build, detectFeatures())` → `missingFeature(vfs, build, available)`. Imports: `defaultBuildFor` now comes from `./capabilities` (beside `detectFeatures`, `missingFeature`), and leaves the `./const/vfs` import.

- [ ] **Step 6: `deleteDatabase`**

In `src/delete.ts`: `import { defaultBuildFor, detectFeatures } from './capabilities';`, remove `defaultBuildFor` from the `./const/vfs` import, and

```ts
  const build = options.build ?? defaultBuildFor(vfs, detectFeatures());
```

- [ ] **Step 7: The worker stops resolving**

`src/types/protocol.ts`: on both the `open` and the `delete` variants of `ClientMessageData`, `build?: SQLiteBuild;` → `build: SQLiteBuild;`.

`src/worker/worker.ts`:
- `OpenOptions`: `build?: SQLiteBuild | undefined;` → `build: SQLiteBuild;`
- in `open`: `const { vfs, wasm, pragmas = {}, abortSlots, abortIndex } = options;` + `const build = options.build ?? defaultBuildFor(vfs);` → `const { vfs, build, wasm, pragmas = {}, abortSlots, abortIndex } = options;`
- `deleteDatabaseFiles`'s parameter type: `build?: SQLiteBuild;` → `build: SQLiteBuild;`, and `const { file, vfs, wasm } = data;` + `const build = data.build ?? defaultBuildFor(vfs);` → `const { file, vfs, build, wasm } = data;`
- remove `defaultBuildFor` from the `../const/vfs` import.

Run `pnpm exec tsc --noEmit`. Expected: clean. If it reports a site that builds an `open`/`delete` message without `build`, that site passes the resolved build it already holds — report it, do not add a fallback.

- [ ] **Step 8: Test targets follow the engine**

`tests/target-projects.ts`: imports become

```ts
import { RECOMMENDED_VFS } from '../scripts/recommended-vfs.ts';
import { defaultBuildFor } from '../src/capabilities.ts';
import type { SQLiteBuild } from '../src/const/builds.ts';
import type { PlatformFeature } from '../src/const/platform.ts';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../src/const/vfs.ts';
```

Add above `targetsFromEnv`:

```ts
/**
 * What each engine the configs drive offers a build — the only features the
 * default build reads. Both Playwright engines expose `WebAssembly.Suspending`.
 */
export const CHROMIUM_FEATURES: ReadonlySet<PlatformFeature> =
  new Set<PlatformFeature>(['jspi']);
export const FIREFOX_FEATURES: ReadonlySet<PlatformFeature> =
  new Set<PlatformFeature>(['jspi']);
```

`targetsFromEnv` takes `engine: ReadonlySet<PlatformFeature>` as its second parameter, and its unset branch becomes `RECOMMENDED_VFS.map((vfs) => ({ vfs, build: defaultBuildFor(vfs, engine) }))`. Its JSDoc line "unset: each recommended VFS on its default build;" becomes "unset: each recommended VFS on the default build of `engine`;".

`rstest.config.ts` and `rstest.isolated.config.ts`: `targetsFromEnv(process.env.BSQ_TEST_TARGETS, CHROMIUM_FEATURES)`; `rstest.firefox.config.ts`: `…, FIREFOX_FEATURES)`; each imports its constant from `./tests/target-projects.ts`.

- [ ] **Step 9: In-page helpers pass the page's features**

`tests/conformance/helpers.ts`: import `defaultBuildFor` from `'../../src/capabilities'` (beside `detectFeatures`) and drop it from the `../../src/const/vfs` import. `AVAILABLE_FEATURES` is declared above `missingHere` and below nothing that uses it, so the three defaults read it directly:
- `missingHere`: `build: SQLiteBuild = defaultBuildFor(vfs, AVAILABLE_FEATURES),`
- `conformanceClient`: `build: SQLiteBuild = defaultBuildFor(vfs, AVAILABLE_FEATURES),`
- `createReopened`: `build: defaultBuildFor(vfs, AVAILABLE_FEATURES),`

`tests/browser/helpers.ts`: import `defaultBuildFor` from `'../../src/capabilities'`, drop it from `../../src/const/vfs`, and in `createTestClient`: `build: options.build ?? defaultBuildFor(options.vfs, AVAILABLE_FEATURES),`.

Comments: in `tests/browser/vfs.test.ts` (two) and `tests/browser/delete.test.ts` (one), `OPFSAdaptiveVFS declares ['async', 'jspi']` → `OPFSAdaptiveVFS declares ['jspi', 'async']`.

- [ ] **Step 10: Run the unit project**

Run: `pnpm exec biome check --write src tests rstest.config.ts rstest.firefox.config.ts rstest.isolated.config.ts && pnpm exec tsc --noEmit && pnpm exec rstest --project unit`
Expected: PASS, the four new `capabilities` cases and the two `targetsFromEnv` cases included. `tests/unit/test-target.test.ts` is unchanged and passes: its `Here` sets carry no `jspi`, so no `jspi` candidate qualifies there.

- [ ] **Step 11: Confirm the Node-side loaders**

Run: `pnpm docs:vfs && git diff --stat VFS.md` — expected: only the nine `**Builds:**` lines change order (Task 3 rewrites the prose). Then `node -e "import('./scripts/test-matrix.mjs').then(() => console.log('test-matrix loads'))"` — importing does not run it (its main is guarded by `import.meta.url`); expected: `test-matrix loads`, no `ERR_MODULE_NOT_FOUND` from `src/const/*.ts`.

- [ ] **Step 12: Commit**

```bash
git add src tests rstest.config.ts rstest.firefox.config.ts rstest.isolated.config.ts VFS.md
git commit -m "feat: default to the first build the engine supports

jspi is declared before async on every VFS, and an omitted build
resolves to the first declared one whose requirements detectFeatures()
meets, so an engine without JSPI still gets async. defaultBuildFor
moves to src/capabilities.ts and takes the features: const/ files
import each other as types only. The worker no longer resolves; the
client and deleteDatabase always send the build.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 2: The no-JSPI fallback, end to end in the page

**Files:**
- Create: `tests/browser/default-build.test.ts`

**Interfaces:**
- Consumes: `pairFor` (`tests/browser/helpers.ts`), `createSQLiteClient` (`src/client.ts`), `deleteDatabase` (`src/delete.ts`), `BUILD_CAPABILITIES`, `VFS_CAPABILITIES`; `db.build` (`src/api.ts`).

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { pairFor } from './helpers';

type WithSuspending = typeof WebAssembly & { Suspending?: unknown };

describe('the default build without JSPI', () => {
  // Falsifiable: make defaultBuildFor return `builds[0]` whatever `available`
  // says — on a jspi-first VFS the client then refuses the pair, JSPI missing.
  it('falls back to the first declared build that requires nothing', async () => {
    const wasm = WebAssembly as WithSuspending;
    // The premise: both engines under test have JSPI to take away.
    expect(typeof wasm.Suspending).toBe('function');

    const { vfs } = pairFor();
    const expected = (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).find(
      (build) => BUILD_CAPABILITIES[build].requires.length === 0,
    );
    const file = `bsq-test-${crypto.randomUUID()}`;
    const saved = wasm.Suspending;
    delete wasm.Suspending;
    try {
      const db = createSQLiteClient(file, { vfs });
      try {
        expect(db.build).toBe(expected);
        expect(await db.read<{ one: number }>('SELECT 1 AS one')).toEqual([
          { one: 1 },
        ]);
      } finally {
        await db.close();
      }
      // No `build` here either: deleteDatabase resolves on its own.
      await deleteDatabase(file, { vfs });
    } finally {
      wasm.Suspending = saved;
    }
  });

  // Falsifiable: resolve before reading `clientOptions.build`, or drop the
  // `??` — the engine has JSPI, so the explicit `async` would be overridden.
  it('keeps an explicit build where the engine could run a preferred one', async () => {
    const { vfs } = pairFor();
    const file = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(file, { vfs, build: 'async' });
    try {
      expect(db.build).toBe('async');
      await db.read('SELECT 1');
    } finally {
      await db.close();
    }
    await deleteDatabase(file, { vfs, build: 'async' });
  });
});
```

- [ ] **Step 2: Run it on both engines**

Run: `pnpm exec rstest tests/browser/default-build.test.ts && pnpm exec rstest --config rstest.firefox.config.ts tests/browser/default-build.test.ts`
Expected: both cases PASS in each project (`OPFSWriteAheadVFS/sync` — `sync`, trivially — and `OPFSAdaptiveVFS/jspi` — `async`). Every VFS declares `async`, so the second case runs on any target.

- [ ] **Step 3: Falsify it**

Temporarily change `defaultBuildFor`'s body in `src/capabilities.ts` to `return VFS_CAPABILITIES[vfs].builds[0];`, rerun the Chromium command of Step 2, and confirm the `OPFSAdaptiveVFS/jspi` project FAILS with `INVALID_OPTION` naming JSPI. Restore the body; `git diff src/capabilities.ts` must be empty.

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write tests/browser/default-build.test.ts && pnpm exec tsc --noEmit
git add tests/browser/default-build.test.ts
git commit -m "test: the default build falls back without JSPI, end to end

Hides WebAssembly.Suspending in the page, then opens and deletes with
no build: the client and deleteDatabase must both land on the first
declared build that requires nothing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 3: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`## Unreleased`: `### Breaking`, `### Changed`)
- Modify: `API.md` (the two `build` rows, lines ~39 and ~340)
- Modify: `VFS.md` (the first paragraph under `## Builds reference`, hand-written)
- Modify: `scripts/render-vfs-matrix.ts` (`BUILD_NOTE.async`, `BUILD_NOTE.jspi`)
- Modify: `src/client.ts` (JSDoc: "Browser requirements" paragraph of `createSQLiteClient`; the `wasmUrl` example)

- [ ] **Step 1: `CHANGELOG.md`**

Under `### Changed` of `## Unreleased`, first entry:

```markdown
- **An omitted `build` is the first one the VFS declares that the browser supports, and `jspi` is now declared before `async` everywhere.** On browsers with JSPI (Chrome 137+, Firefox 153+, Safari 27+), `OPFSAdaptiveVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS` and `MemoryAsyncVFS` now load `jspi` instead of `async`; elsewhere they load `async` as before, and the other VFS keep `sync`. `db.build` reports the one loaded. Pass `build: 'async'` to keep the previous behaviour.
```

Under `### Breaking`, at the end:

```markdown
- **A `wasmUrl` callback that ignores its argument can hand the wrong `.wasm` to the five VFS above** when no `build` is passed and the browser has JSPI: the callback now receives `'jspi'`. Return the file for the build it receives, or pass `build`.
- **`defaultBuildFor(vfs)` becomes `defaultBuildFor(vfs, available)`**: pass `detectFeatures()`.
```

- [ ] **Step 2: `API.md`**

In both `build` rows, the default column `first build the VFS declares` → `first build the VFS declares that the browser supports`.

- [ ] **Step 3: `VFS.md` hand prose**

Replace the first paragraph under `## Builds reference` (the one beginning "Each VFS runs on one or more wa-sqlite WebAssembly builds") with one unwrapped line:

```markdown
Each VFS runs on one or more wa-sqlite WebAssembly builds. The `build` option selects one; omitted, the first build the VFS declares that the browser supports is used — the `Builds` line of its entry lists them in that order, and `db.build` reports the one loaded. A pair the VFS does not support throws a `SQLiteError` with code `INVALID_OPTION` at construction, naming the builds it does support. The pairing is declared in one place, `VFS_CAPABILITIES`, which is also what the `SQLiteVFS` type is derived from.
```

- [ ] **Step 4: `BUILD_NOTE` in `scripts/render-vfs-matrix.ts`**

`async`'s second paragraph: replace "The [`jspi`](#build-jspi) build avoids it on Safari 27+. Safari 26 has no JSPI, so there a VFS without a `sync` build has no way around it." with "Where the browser has JSPI — Safari 27+ — an omitted `build` loads [`jspi`](#build-jspi), which avoids it. Safari 26 has no JSPI, so there a VFS without a `sync` build has no way around it."

`jspi`: replace "Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it." with "Declared before `async` by every VFS that runs both, so it is the default wherever the browser has it; elsewhere an omitted `build` falls back to `async`, and its narrower availability constrains nobody."

Then `pnpm docs:vfs`.

- [ ] **Step 5: `src/client.ts` JSDoc**

In `createSQLiteClient`'s `@remarks`, replace the two sentences "The default `build` needs no browser opt-in; only `build: 'jspi'` does, and JSPI is Chromium-only — an unrelated constraint, not a header requirement." with "An omitted `build` needs no browser opt-in: it is the first build the VFS declares that the browser supports. Only an explicit `build: 'jspi'` requires JSPI — an engine constraint, not a header requirement."

In the `wasmUrl` option's JSDoc, the example becomes:

```ts
   * import wasm from 'browser-sqlite/dist/worker/wa-sqlite.wasm?url';
   * import wasmAsync from 'browser-sqlite/dist/worker/wa-sqlite-async.wasm?url';
   * import wasmJspi from 'browser-sqlite/dist/worker/wa-sqlite-jspi.wasm?url';
   * const urls = { sync: wasm, async: wasmAsync, jspi: wasmJspi };
   * createSQLiteClient('app.db', { vfs, wasmUrl: (build) => urls[build] });
```

and the sentence after it gains: "A callback that ignores its argument must be paired with an explicit `build`: an omitted one depends on the browser."

- [ ] **Step 6: Verify and commit**

```bash
pnpm exec biome check --write scripts/render-vfs-matrix.ts src/client.ts
pnpm docs:vfs && pnpm exec tsc --noEmit
git add CHANGELOG.md API.md VFS.md scripts/render-vfs-matrix.ts src/client.ts
git commit -m "docs: the default build follows the browser

CHANGELOG (the new default, the wasmUrl callback that ignores its
argument, defaultBuildFor's signature), API.md's two build rows, the
Builds reference prose and both build notes of VFS.md, and the client
JSDoc, whose example callback now uses the build it receives.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 4: Delivery verification

**Files:** none modified, unless a step fails.

- [ ] **Step 1: Full suite and static checks**

Run, reading all three reports: `pnpm test 2>&1 | tee .scratchpad/default-build/pnpm-test.log`, then `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, `pnpm docs:vfs && git diff --exit-code VFS.md`.
Expected: all green. Compare each config's file and test counts with `mem:state`'s verification baseline; the new file adds one test per project.

- [ ] **Step 2: The full matrix, monitored**

`VFS_CAPABILITIES` changed, so the matrix runs (`mem:conventions`, ~45 min). Launch `pnpm test:matrix` in the background and, at launch, a monitor reporting every 2 minutes — elapsed time, cells finished, cells failed — until it ends. Expected: 66 of 66 cells green. A red cell: re-run it alone before diagnosing (`mem:conventions`), and `scripts/matrix-triage.mjs` regroups the run.

- [ ] **Step 3: Report**

Report the counts of Steps 1 and 2 against the baseline, and any cell re-run. Nothing is merged by this plan: the merge follows the user's closure.
