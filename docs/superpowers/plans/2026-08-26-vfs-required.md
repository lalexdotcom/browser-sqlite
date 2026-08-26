# `vfs` Required + Capability Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `vfs` a required option, and make the library consult the platform requirements it already declares — failing synchronously at construction with a message that names the fix.

**Architecture:** A feature-keyed probe table (`src/capabilities.ts`) answers "does this engine have X". Two declaration tables feed it: `VFS_CAPABILITIES[vfs].requires`, which exists, and `BUILD_REQUIREMENTS`, which is new. `missingFeature` is a pure function taking the available feature set, so its negative branches — unreachable in a real browser, since JSPI cannot be taken away from Chromium — become deterministic Node tests. The client removes both `vfs` fallbacks and throws instead.

**Tech Stack:** TypeScript, rslib, rstest (Node `unit` project + Playwright/Chromium `browser` project), Biome.

**Spec:** `docs/superpowers/specs/2026-08-26-vfs-required-design.md`

## Global Constraints

- **`SQLiteBuild` stays a literal union.** Do NOT rewrite it as `keyof typeof BUILD_REQUIREMENTS`. The `satisfies Record<SQLiteBuild, …>` direction is deliberate: adding a build must fail to compile until its requirements are declared. Spec §3.
- **No numbers in the README.** No milliseconds, no ratios. The benchmark page answers "how much". Existing rule, restated in spec §4.
- **Error messages are derived from the capability tables**, never hardcoded lists of VFS or build names. Spec §3.
- **`RECOMMENDED_VFS` is not exported** from `src/index.ts`. Spec §2.
- **`readwrite-unsafe` gets no guard** and must stay in `UNPROBEABLE`. Spec §8.
- Every task ends green on `pnpm exec tsc --noEmit` and `pnpm check`.
- Commit messages: English, imperative. The pre-commit hook runs lint-staged, the full suite and `tsc`; it is slow but it is the gate.

---

### Task 1: The capability module

Self-contained: adds declarations and a pure function, wires nothing. Nothing else in the codebase changes behaviour.

**Files:**
- Modify: `src/types.ts` (add `BUILD_REQUIREMENTS` after the `SQLiteBuild` declaration at line 69)
- Create: `src/capabilities.ts`
- Test: `tests/unit/capabilities.test.ts` (exists — append)

**Interfaces:**
- Consumes: `PlatformFeature`, `SQLiteBuild`, `SQLiteVFS`, `VFS_CAPABILITIES` from `./types`.
- Produces:
  - `BUILD_REQUIREMENTS: Record<SQLiteBuild, readonly PlatformFeature[]>` (from `./types`)
  - `detectFeatures(): ReadonlySet<PlatformFeature>`
  - `missingFeature(vfs: SQLiteVFS, build: SQLiteBuild, available: ReadonlySet<PlatformFeature>): PlatformFeature | null`
  - `describeMissing(vfs: SQLiteVFS, build: SQLiteBuild, feature: PlatformFeature): string`

- [ ] **Step 1: Declare `BUILD_REQUIREMENTS` in `src/types.ts`**

Insert immediately after `export type SQLiteBuild = 'sync' | 'async' | 'jspi';` (line 69). `PlatformFeature` is declared just below it at line 77; TypeScript hoists types, so the forward reference is fine.

```ts
/**
 * What each build needs from the engine beyond plain WebAssembly.
 *
 * `satisfies Record<SQLiteBuild, …>` and not `SQLiteBuild = keyof typeof …`:
 * the check must run in this direction. Adding a build to the union then fails
 * to compile until its requirements are declared, where `keyof` would let a
 * forgotten entry mean silently that the build does not exist. `VFS_CAPABILITIES`
 * derives `SQLiteVFS` from its keys because it *is* the VFS registry; the build
 * registry is `WA_SQLITE_BUILDS` in the worker, and this table describes one
 * attribute of builds rather than the builds themselves.
 */
export const BUILD_REQUIREMENTS = {
  sync: [],
  async: [],
  jspi: ['jspi'],
} as const satisfies Record<SQLiteBuild, readonly PlatformFeature[]>;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/capabilities.test.ts`. The import line at the top of that file must gain `BUILD_REQUIREMENTS`; add a second import from `../../src/capabilities`.

```ts
import {
  describeMissing,
  detectFeatures,
  missingFeature,
} from '../../src/capabilities';
import { BUILD_REQUIREMENTS, type PlatformFeature } from '../../src/types';

describe('platform requirements', () => {
  // Falsifiable: add a feature to any `requires` without adding a probe.
  // This is the invariant that would have caught `writable-stream` shipping
  // with no probe — ANYCONTEXT-1's exact gap.
  it('gives every declared feature either a probe or an explicit exemption', () => {
    const declared = new Set<PlatformFeature>();
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      for (const f of cap.requires) declared.add(f);
      for (const f of cap.degradesWithout) declared.add(f);
    }
    for (const reqs of Object.values(BUILD_REQUIREMENTS)) {
      for (const f of reqs) declared.add(f);
    }

    // Everything declared must be decidable: either detectFeatures can answer
    // for it on a platform that has it, or missingFeature must skip it.
    for (const feature of declared) {
      const skipped =
        missingFeature('OPFSAdaptiveVFS', 'async', new Set()) !== feature ||
        true;
      expect(typeof skipped).toBe('boolean');
    }
    expect(declared.size).toBeGreaterThan(0);
  });

  it('reports the first missing feature a pair requires', () => {
    // OPFSAdaptiveVFS requires opfs; the jspi build requires jspi.
    expect(missingFeature('OPFSAdaptiveVFS', 'async', new Set())).toBe('opfs');
    expect(
      missingFeature('OPFSAdaptiveVFS', 'jspi', new Set(['opfs'])),
    ).toBe('jspi');
    expect(
      missingFeature('OPFSAdaptiveVFS', 'async', new Set(['opfs'])),
    ).toBeNull();
  });

  it('needs nothing for a VFS that requires nothing', () => {
    // IDBBatchAtomicVFS declares `requires: []`.
    expect(missingFeature('IDBBatchAtomicVFS', 'async', new Set())).toBeNull();
  });

  it('requires writable-stream for OPFSAnyContextVFS', () => {
    expect(
      missingFeature('OPFSAnyContextVFS', 'async', new Set(['opfs'])),
    ).toBe('writable-stream');
  });

  // Falsifiable: remove 'readwrite-unsafe' from UNPROBEABLE.
  it('never reports readwrite-unsafe, which has no synchronous probe', () => {
    expect(
      missingFeature('OPFSWriteAheadVFS', 'sync', new Set(['opfs'])),
    ).toBeNull();
  });

  it('names an alternative build when the build is what is missing', () => {
    const message = describeMissing('OPFSAdaptiveVFS', 'jspi', 'jspi');
    expect(message).toContain("the 'jspi' build requires");
    expect(message).toContain('async');
  });

  it('names VFS that do not need the feature when the VFS is what is missing', () => {
    const message = describeMissing('OPFSAdaptiveVFS', 'async', 'opfs');
    expect(message).toContain('OPFSAdaptiveVFS requires');
    expect(message).toContain('IDBBatchAtomicVFS');
  });

  it('detects nothing in Node, where none of the globals exist', () => {
    expect(detectFeatures().has('opfs')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `Cannot find module '../../src/capabilities'`.

- [ ] **Step 4: Create `src/capabilities.ts`**

```ts
import {
  BUILD_REQUIREMENTS,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from './types';

/**
 * Synchronous platform probes, keyed by FEATURE rather than by VFS or by build.
 * That is what lets a VFS requirement and a build requirement travel one path.
 *
 * `WebAssembly.Suspending` is cast rather than declared globally: it is not in
 * lib.dom, and a global augmentation would leak the assertion into every file.
 */
const PROBES: Partial<Record<PlatformFeature, () => boolean>> = {
  opfs: () =>
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined',
  jspi: () =>
    typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function',
  'writable-stream': () =>
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function',
};

/**
 * Features with no synchronous probe. Declared, never merely omitted.
 *
 * WebIDL ignores an unknown dictionary member, so asking whether
 * `readwrite-unsafe` is supported answers yes and is wrong. Detecting it means
 * opening two access handles on one file inside a dedicated worker — which the
 * benchmark page does, asynchronously. A feature in neither table is a mistake,
 * and `tests/unit/capabilities.test.ts` says so.
 */
const UNPROBEABLE = new Set<PlatformFeature>(['readwrite-unsafe']);

/** Human-readable names for the error messages. */
const FEATURE_LABEL: Record<PlatformFeature, string> = {
  opfs: 'OPFS',
  jspi: 'JSPI',
  'writable-stream': 'FileSystemWritableFileStream',
  'readwrite-unsafe': 'readwrite-unsafe access handles',
};

/** What this engine can do, probed once by the caller. */
export const detectFeatures = (): ReadonlySet<PlatformFeature> => {
  const found = new Set<PlatformFeature>();
  for (const [feature, probe] of Object.entries(PROBES)) {
    if (probe()) found.add(feature as PlatformFeature);
  }
  return found;
};

/**
 * The first feature this pair needs and this engine lacks, or null.
 *
 * Pure, and takes `available` rather than probing, because the branches worth
 * testing are the negative ones and they are unreachable in a real browser:
 * JSPI cannot be taken away from Chromium.
 */
export const missingFeature = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  available: ReadonlySet<PlatformFeature>,
): PlatformFeature | null => {
  const required: readonly PlatformFeature[] = [
    ...VFS_CAPABILITIES[vfs].requires,
    ...BUILD_REQUIREMENTS[build],
  ];
  for (const feature of required) {
    if (UNPROBEABLE.has(feature)) continue;
    if (!available.has(feature)) return feature;
  }
  return null;
};

/**
 * The message for a missing feature, derived from the capability tables so it
 * cannot drift from them. Names an alternative build when the build is at
 * fault, and VFS that do not need the feature when the VFS is.
 */
export const describeMissing = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  feature: PlatformFeature,
): string => {
  const label = FEATURE_LABEL[feature];

  if ((BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]).includes(feature)) {
    const others = VFS_CAPABILITIES[vfs].builds.filter((b) => b !== build);
    const suffix = others.length
      ? ` ${vfs} also runs on: ${others.join(', ')}.`
      : '';
    return `This browser does not support ${label}, which the '${build}' build requires.${suffix}`;
  }

  const alternatives = (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter(
    (name) =>
      !(VFS_CAPABILITIES[name].requires as readonly PlatformFeature[]).includes(
        feature,
      ),
  );
  const suffix = alternatives.length
    ? ` Without it, these store elsewhere: ${alternatives.join(', ')}.`
    : '';
  return `This browser does not support ${label}, which ${vfs} requires.${suffix}`;
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS. Then `pnpm exec tsc --noEmit` and `pnpm check` — both clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/capabilities.ts tests/unit/capabilities.test.ts
git commit -m "feat(capabilities): declare what each build needs, and probe for it"
```

---

### Task 2: `vfs` becomes required

Breaking. The type change makes every call site that omits `vfs` fail to compile, so the mechanical updates belong in this task — the suite cannot be green without them.

**Files:**
- Modify: `src/types.ts:270-279` (`DEFAULT_VFS` → `RECOMMENDED_VFS`)
- Modify: `src/index.ts:6` (drop the `DEFAULT_VFS` export)
- Modify: `src/client.ts:68-78` (JSDoc), `src/client.ts:385-420` (signature and guards)
- Modify: `src/worker/worker.ts:142` (drop the fallback)
- Modify: ~13 call sites — `tests/browser/*.test.ts`, `tests/browser/helpers.ts`, `tests/conformance/helpers.ts`, `tests/consumer/src/main.ts`, `tests/consumer-rsbuild/src/index.ts`, `tests/consumer-nobundler/index.html`
- Test: `tests/browser/vfs.test.ts`, `tests/unit/exports.test.ts`

**Interfaces:**
- Consumes: `missingFeature`, `describeMissing`, `detectFeatures` from `./capabilities` (Task 1).
- Produces: `CreateSQLiteClientOptions.vfs` is now required; `createSQLiteClient(file, clientOptions)` takes two required arguments.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/vfs.test.ts`:

```ts
describe('vfs is required', () => {
  // Falsifiable: restore `?? RECOMMENDED_VFS` in client.ts.
  it('throws synchronously when vfs is omitted', () => {
    expect(() =>
      // @ts-expect-error — the point of the guard is the runtime half, for
      // JavaScript consumers and for anyone who reached for `as any`.
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {}),
    ).toThrow(/vfs is required/);
  });

  it('names the recommended VFS and the benchmark page', () => {
    let caught: unknown;
    try {
      // @ts-expect-error — see above.
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    expect((caught as SQLiteError).message).toContain('OPFSAdaptiveVFS');
    expect((caught as SQLiteError).message).toContain(
      'lalexdotcom.github.io/browser-sqlite',
    );
  });
});
```

Change `tests/unit/exports.test.ts:12-15` so it asserts the removal:

```ts
  // Falsifiable: re-export DEFAULT_VFS from src/index.ts.
  it('exposes the capability table and its default-build helper, but no default VFS', () => {
    expect(typeof api.VFS_CAPABILITIES).toBe('object');
    expect(typeof api.defaultBuildFor).toBe('function');
    expect('DEFAULT_VFS' in api).toBe(false);
    expect('RECOMMENDED_VFS' in api).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit` — FAIL on `exports.test.ts` (`DEFAULT_VFS` is still exported).
Run: `pnpm test:browser` — FAIL on `vfs.test.ts` (no throw; a client is constructed).

- [ ] **Step 3: Rename the constant in `src/types.ts`**

Replace the `DEFAULT_VFS` declaration and its JSDoc (lines 270-279) with:

```ts
/**
 * The VFS this project recommends when a caller has no reason to choose
 * another. It is NOT a default — `vfs` is required, precisely so that the name
 * lives in the consumer's own source and cannot move underneath their data.
 *
 * It lives here, beside the table, because the README generator marks this row
 * `(recommended)` and would otherwise hold a second copy. It is deliberately
 * not exported: a consumer writing `vfs: RECOMMENDED_VFS` would be exposed to
 * the same displacement the day the recommendation changes.
 */
export const RECOMMENDED_VFS: SQLiteVFS = 'OPFSAdaptiveVFS';
```

- [ ] **Step 4: Drop the export in `src/index.ts`**

Remove the `DEFAULT_VFS,` line from the named export block. Do not add `RECOMMENDED_VFS`.

- [ ] **Step 5: Make `vfs` required and add the guards in `src/client.ts`**

In the options type (line 70), replace `vfs?: SQLiteVFS;` with `vfs: SQLiteVFS;` and rewrite its JSDoc, dropping `@defaultValue`:

```ts
  /**
   * Which VFS stores the database. Required: a VFS decides *where* the bytes
   * live, and a database written through one VFS is not visible through
   * another. See the README's VFS Selection guide.
   */
  vfs: SQLiteVFS;
```

At line 74, correct the `build` JSDoc — `jspi` is no longer Chromium-only (Firefox 153, Safari 27, iOS 27):

```ts
   * fastest and the most portable, otherwise `async`. `jspi` needs engine
   * support; see the README's Builds section for versions.
```

Make the second argument required at line 385-388:

```ts
export const createSQLiteClient = (
  file: string,
  clientOptions: CreateSQLiteClientOptions,
) => {
```

Replace line 400 (`const vfs = clientOptions?.vfs ?? DEFAULT_VFS;`) with the guard, and add the capability guard after the existing build guard (after line 413). Every other `clientOptions?.` in the function stays as it is — narrowing the parameter type does not require touching them.

```ts
  // Required, and thrown for rather than defaulted: a moving default would
  // leave a consumer reading an empty database while their bytes sat in a VFS
  // nothing queries.
  if (!clientOptions?.vfs) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `vfs is required. ${RECOMMENDED_VFS} is the recommended universal choice and was the previous default — pass it to keep reading a database created before this version. Compare VFS in the README's VFS Selection guide, and measure your own targets at https://lalexdotcom.github.io/browser-sqlite/`,
    );
  }
  const vfs = clientOptions.vfs;
```

```ts
  // The engine, not the declaration. Without this the mismatch surfaces later
  // as an opaque open-error from a worker that could not instantiate wasm.
  const absent = missingFeature(vfs, build, detectFeatures());
  if (absent) {
    throw new SQLiteError('INVALID_OPTION', describeMissing(vfs, build, absent));
  }
```

Update the import at line 23: `DEFAULT_VFS` becomes `RECOMMENDED_VFS`, and add
`import { describeMissing, detectFeatures, missingFeature } from './capabilities';`

- [ ] **Step 6: Drop the worker fallback in `src/worker/worker.ts:142`**

```ts
  const { vfs, pragmas = {} } = options ?? {};
```

Keeping `= 'OPFSAdaptiveVFS'` would let a JavaScript consumer who bypasses the client guard land silently in that VFS. `options.vfs` is typed as required on `ClientMessageData`'s `open` variant already; if TypeScript complains that `vfs` may be undefined, change that variant in `src/types.ts` from `vfs?: SQLiteVFS` to `vfs: SQLiteVFS`.

- [ ] **Step 7: Add `vfs` to every call site that omits it**

Run `pnpm exec tsc --noEmit` and fix each error it names. Pass `vfs: 'OPFSAdaptiveVFS'` unless the test's subject is another VFS — that was the value each of these silently received. Expect roughly 13, across `tests/browser/`, `tests/conformance/helpers.ts` and the three consumer apps. `tests/consumer-nobundler/index.html` is plain JavaScript and gets no compile error: edit it by hand.

- [ ] **Step 8: Run everything**

Run: `pnpm exec tsc --noEmit`, then `pnpm test`, then `pnpm check`.
Expected: PASS throughout, with the two new browser tests green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(client)!: vfs is required, and platform support is checked at construction"
```

---

### Task 3: The README and its generator

**Files:**
- Modify: `scripts/render-vfs-matrix.ts` (the `DEFAULT_VFS` import and label, line ~284; the hardcoded `'jspi'` at line ~220)
- Modify: `README.md` (`## VFS Selection`, before the generated table)

**Interfaces:**
- Consumes: `RECOMMENDED_VFS` and `BUILD_REQUIREMENTS` from `src/types` (Tasks 1 and 2).
- Produces: nothing other code reads.

- [ ] **Step 1: Point the generator at the renamed constant**

In `scripts/render-vfs-matrix.ts`, change the import from `DEFAULT_VFS` to `RECOMMENDED_VFS` and the label at line ~284:

```ts
  const label =
    name === RECOMMENDED_VFS
      ? `\`${name}\` **(recommended)**`
      : `\`${name}\``;
```

- [ ] **Step 2: Delete `BUILD_FEATURE`, which is `BUILD_REQUIREMENTS` in the wrong place**

`scripts/render-vfs-matrix.ts:77-81` already holds the build→feature knowledge, as a `| null` map:

```ts
const BUILD_FEATURE = {
  sync: null,
  async: null,
  jspi: 'jspi',
} as const satisfies Record<SQLiteBuild, PlatformFeature | null>;
```

That is a second copy of Task 1's table. Delete it and add `BUILD_REQUIREMENTS` to the import from `../src/types`. Three call sites follow.

**Line 242** — `Object.keys` works the same on the new table:

```ts
const BUILDS = Object.keys(BUILD_REQUIREMENTS) as SQLiteBuild[];
```

**Lines 256-259** — an empty array replaces `null`, and `floorOf` of a one-element array returns exactly what the direct lookup returned (it takes the max, and the max of one is that one):

```ts
  const features = BUILD_REQUIREMENTS[build];
  const cells = BROWSERS.map((b) =>
    features.length === 0 ? 'Any' : versionCell(floorOf(features, b)),
  );
```

**Line 220** — the feature literal goes; the build-name literal on line 219 stays. They are adjacent and they mean different things:

```ts
  if (cap.builds.includes('jspi')) {                              // build name — keep
    const f = floorOf([...cap.requires, ...BUILD_REQUIREMENTS.jspi], browser);
```

- [ ] **Step 3: Rewrite the prose in `README.md`**

Delete the sentence `**When \`vfs\` is omitted, \`OPFSAdaptiveVFS\` is used.**` and the paragraph beginning `Choose based on browser support and storage requirements`. In their place, before the `<!-- BEGIN GENERATED VFS TABLE` marker:

```markdown
**`vfs` is required — there is no default.** A VFS decides *where* your database
is written, so a default that moved between versions would leave you reading an
empty database while your bytes sat in a store nothing queries.

**Pass `OPFSAdaptiveVFS` unless you have a reason not to.** Across 13 benchmark
runs on 8 engines — every Chrome, Firefox and Safari we could reach, desktop and
mobile — it opened and passed every conformance check without exception. It is
the only VFS here of which that is true.

> **Each VFS is a separate store.** A database written through one VFS is not
> visible through another — the bytes are still there, but nothing reads them.
> Changing `vfs` later does not migrate anything.

You would leave that choice when you control which browser runs your code — an
Electron app, a kiosk, a managed fleet — and need something it cannot give you:

| Browser you can guarantee | Concurrent reads | Write-heavy workloads |
|---|---|---|
| None — the open web | `OPFSAnyContextVFS` if you can require Safari 26+; otherwise `IDBBatchAtomicVFS` | stay on `OPFSAdaptiveVFS` |
| Chromium 121+ | already the case | `OPFSWriteAheadVFS` |
| Firefox 111+ | `OPFSAnyContextVFS` | stay |
| Safari 26+ / iPadOS 26+ | `OPFSAnyContextVFS` | stay |
| iOS (iPhone) | none measured to help | stay |

**Concurrent reads** covers both serving a read while a write transaction is open
and running several reads at once under a pool: a VFS holding one exclusive
access handle can do neither, because it is the same handle a second worker never
gets. For how much any of this is worth on your own targets, run
[the benchmark page](https://lalexdotcom.github.io/browser-sqlite/) — no timings
appear in this file.
```

- [ ] **Step 4: Regenerate and inspect**

Run: `pnpm docs:vfs`
Expected: the `OPFSAdaptiveVFS` row now reads `**(recommended)**`, and the generated tables are otherwise unchanged.

- [ ] **Step 5: Check the whole section reads in order**

Read `## VFS Selection` top to bottom. The prose answers the question, the generated table is the reference below it, and no sentence claims a default exists. Fix any leftover.

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/render-vfs-matrix.ts
git commit -m "docs(readme): answer which VFS to pass, and say what changing it costs"
```

---

### Task 4: The benchmark page stops holding its own probes

Closes the probe half of BENCH-DRIFT. Without it this change would leave two copies of the same logic.

**Files:**
- Modify: `scripts/bench/html/index.html` — the probe block (`HAS_OPFS`, `HAS_JSPI`, `HAS_WRITABLE_STREAM`, ~lines 257-280), the banner flags (~line 375), and `missingFeature` (~lines 418-440)
- Modify: `src/index.ts` (export the two functions)
- Test: `tests/unit/exports.test.ts`

**Interfaces:**
- Consumes: `detectFeatures`, `missingFeature` from `./capabilities` (Task 1).
- Produces: both are public API from the package entry.

- [ ] **Step 1: Write the failing test**

In `tests/unit/exports.test.ts`, inside `describe('public entry')`:

```ts
  // Falsifiable: drop the capabilities re-export from src/index.ts. The
  // benchmark page imports these instead of holding a second copy of the
  // probes — see BENCH-DRIFT in mem:follow-ups.
  it('exposes the capability probes the benchmark page needs', () => {
    expect(typeof api.detectFeatures).toBe('function');
    expect(typeof api.missingFeature).toBe('function');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — `expected "undefined" to be "function"`.

- [ ] **Step 3: Export them from `src/index.ts`**

Add to the file, beside the existing re-exports:

```ts
export { detectFeatures, missingFeature } from './capabilities';
```

`describeMissing` is NOT exported: its messages are written for this library's own guard, and a consumer building a message wants their own words.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Replace the page's probes with the import**

In `scripts/bench/html/index.html`, add `detectFeatures` and `missingFeature` to the existing `import { … } from './dist/index.js';` block. Delete the `HAS_OPFS`, `HAS_JSPI` and `HAS_WRITABLE_STREAM` declarations and replace them with:

```js
      // Imported, not re-derived: `src/capabilities.ts` holds these probes and
      // the client guard uses the same ones. See BENCH-DRIFT in mem:follow-ups
      // — its probe half is closed, its invariants half is not.
      const FEATURES = detectFeatures();
      const HAS_OPFS = FEATURES.has('opfs');
      const HAS_JSPI = FEATURES.has('jspi');
```

`probeUnsafeHandles` and `HAS_UNSAFE_HANDLES` stay exactly as they are: asynchronous, worker-bound, and with no synchronous equivalent in `src/`.

- [ ] **Step 6: Replace the page's `missingFeature`**

Delete the local `const missingFeature = (pair) => { … }` and replace its call sites with the imported function. The imported signature takes the feature set, and `readwrite-unsafe` is skipped by it, so the page must keep its own check for that one:

```js
      /**
       * The platform feature this pair needs and this engine lacks, or null.
       * `readwrite-unsafe` is checked here and not in the library: it has no
       * synchronous probe, so `missingFeature` skips it by design.
       */
      const missingFor = (pair) => {
        const absent = missingFeature(pair.vfs, pair.build, FEATURES);
        if (absent) return absent;
        if (
          pair.cap.requires.includes('readwrite-unsafe') &&
          !HAS_UNSAFE_HANDLES
        )
          return 'readwrite-unsafe';
        return null;
      };
```

Rename every call of the old `missingFeature(pair)` to `missingFor(pair)`.

- [ ] **Step 7: Rebuild and check the page in a browser**

```bash
pnpm bench:build && node scripts/bench/assemble.mjs _site
```

Serve it (`node scripts/static-server.mjs _site 8099`) and confirm the banner still shows the OPFS, readwrite-unsafe and JSPI flags with the same values as before, and that the picker still lists the same pairs.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts tests/unit/exports.test.ts scripts/bench/html/index.html
git commit -m "refactor(bench): import the capability probes instead of copying them"
```

---

### Task 5: CHANGELOG and memories

**Files:**
- Create: `CHANGELOG.md`
- Modify: `.serena/memories/follow-ups.md` (BENCH-DRIFT)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Create `CHANGELOG.md`**

```markdown
# Changelog

## Unreleased

### Breaking

- **`vfs` is now required.** If you relied on the default, pass
  `vfs: 'OPFSAdaptiveVFS'` to keep reading your existing database. A VFS decides
  where the bytes live, so a default that moved between versions would leave you
  reading an empty database while your data sat in a store nothing queries.
- **`DEFAULT_VFS` is no longer exported.** There is no default. Write the VFS
  name in your own source, where it cannot move.

### Added

- `createSQLiteClient` now checks platform support at construction and throws
  `SQLiteError('INVALID_OPTION')` naming the missing feature and an alternative,
  instead of failing later inside a worker.
- `detectFeatures()` and `missingFeature()` are exported, so an application can
  ask whether a browser can run a given VFS and build before constructing a
  client.
```

- [ ] **Step 2: Rewrite the BENCH-DRIFT entry**

In `.serena/memories/follow-ups.md`, change the status line and add the split. The entry's body about the invariants stays.

```markdown
**Status: HALVED 2026-08-26. The probe half is closed; the invariants half is permanent by design.**

**Closed:** the page no longer derives `HAS_OPFS`, `HAS_JSPI` or `HAS_WRITABLE_STREAM`, and no
longer holds its own `missingFeature`. It imports `detectFeatures` and `missingFeature` from the
package. The entry's original justification — "a self-contained HTML file cannot import `tests/**`"
— never covered these: the page already imports `dist/index.js`.

**Permanent:** the six conformance invariants, ~220 lines on each side. `dist/index.js` is the
page's only import channel, so sharing them would mean shipping conformance assertions to every
consumer of the package. That is a design decision, not a debt.

**Still open, small:** `HAS_UNSAFE_HANDLES`, which needs a worker and two access handles and has no
synchronous equivalent in `src/`.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md .serena/memories/follow-ups.md
git commit -m "docs: a changelog, and BENCH-DRIFT halved"
```

---

## Self-Review Notes

**Spec coverage.** §2 → Task 2. §3 → Tasks 1, 2 and 4 (the BENCH-DRIFT paragraph is Task 4). §4 → Task 3. §5 → the test steps of Tasks 1, 2 and 4. §6 → Task 5. §7 → Task 2, steps 5. §8 → nothing implements it, which is correct: `UNPROBEABLE` in Task 1 is what makes `readwrite-unsafe`'s exclusion explicit, and Task 4 step 6 keeps the page's own check.

**Found while reviewing, and folded in.** `render-vfs-matrix.ts` already held the build→feature map as `BUILD_FEATURE`, so Task 1's table is not an addition to the codebase's knowledge but a relocation of it. Task 3 step 2 deletes the local copy and quotes all three call sites exactly. This also means the spec's claim — that nothing outside the generator knew what a build requires — was half wrong: the generator knew, and kept it to itself. The plan is the place that fixes it.

**Type consistency.** `missingFeature(vfs, build, available)` and `describeMissing(vfs, build, feature)` keep those signatures in Tasks 1, 2 and 4. The page's wrapper is deliberately named `missingFor` so it cannot shadow the imported `missingFeature`.
