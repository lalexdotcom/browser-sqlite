import { ALL_BROWSERS, type BrowserName } from '../../../scripts/browsers.ts';
import {
  BUILD_CAPABILITIES,
  type SQLiteBuild,
} from '../../../src/const/builds';
import type { PlatformFeature } from '../../../src/const/platform';
import {
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type VFSCapability,
} from '../../../src/const/vfs';
import { sharesStorage } from '../../../src/locks';

/**
 * What a browser test needs of the pair it runs on, and whether a context
 * gives it that (spec 2026-10-12, § 2). Pure, so the planner, each cell's
 * guard (browser) and the unit tests share one answer. In Node it loads
 * through Vite (the config, Vitest's runner), not plain `node`: its `src/`
 * imports, and `src/`'s own, carry no extension.
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
  'every-build',
  'env-cappable',
  'sync-handle',
  'immediate-connection-lock',
  'jspi-available',
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

const BROWSERS: readonly BrowserName[] = ALL_BROWSERS;

// The widening casts mirror client.ts's build guard: `as const` on the tables
// narrows an empty list to `readonly []`, where `.every` takes never.
const met = (features: readonly PlatformFeature[], context: TestContext) =>
  features.every((feature) => context.features.has(feature));

const declared = (vfs: SQLiteVFS): VFSCapability => VFS_CAPABILITIES[vfs];

/** Whether a second client is refused here: exclusive by declaration, or for lack of a feature. */
const refusesSecondClient = (context: TestContext) => {
  const c = declared(context.vfs);
  return (
    sharesStorage(context.vfs) &&
    (c.exclusiveConnection ||
      !met(c.exclusiveConnectionWithout as readonly PlatformFeature[], context))
  );
};

const VFS_NAMES = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];
const BUILD_NAMES = Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[];

export const holds = (property: Property, context: TestContext): boolean => {
  const c = declared(context.vfs);
  switch (property) {
    case 'two-workers':
      return (
        c.maxPoolSize !== 1 &&
        met(c.singleConnectionWithout as readonly PlatformFeature[], context)
      );
    case 'interruptible':
      return met(
        BUILD_CAPABILITIES[context.build]
          .interruptibleWithout as readonly PlatformFeature[],
        context,
      );
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
      return !met(
        c.singleConnectionWithout as readonly PlatformFeature[],
        context,
      );
    case 'default-pragmas':
      return Object.keys(c.defaultPragmas).length > 0;
    case 'exclusive-file-handle':
      return c.exclusiveFileHandle;
    case 'idb-storage':
      return c.storage === 'indexeddb';
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
    // The client requests its connection lock in the task that constructs it;
    // a VFS exclusive only without a probed feature asks after worker 0's answer.
    case 'immediate-connection-lock':
      return (
        sharesStorage(context.vfs) &&
        (c.exclusiveConnectionWithout as readonly PlatformFeature[]).length ===
          0
      );
    // The engine's, not the pair's: Safari 26 has no WebAssembly.Suspending.
    case 'jspi-available':
      return context.features.has('jspi');
  }
};

/** Whether the pair can run here at all: what its VFS and its build require. */
export const runsIn = (context: TestContext): boolean =>
  met(
    [
      ...(VFS_CAPABILITIES[context.vfs].requires as readonly PlatformFeature[]),
      ...(BUILD_CAPABILITIES[context.build]
        .requires as readonly PlatformFeature[]),
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
export const needFromTags = (
  tags: readonly string[],
): { standalone: boolean; need: TestNeed } => {
  const known = new Set(declaredTags());
  const lists: {
    -readonly [K in
      | 'browser'
      | 'vfs'
      | 'build'
      | 'requires'
      | 'excludes']?: string[];
  } = {};
  let isolated: boolean | undefined;
  let standalone = false;
  for (const tag of tags) {
    if (!known.has(tag))
      throw new Error(
        `NEED_TAG: "${tag}" is not in the need vocabulary (tests/harness/planner/need.ts)`,
      );
    if (tag === 'standalone') standalone = true;
    else if (tag === 'isolated' || tag === 'not-isolated') {
      const value = tag === 'isolated';
      if (isolated !== undefined && isolated !== value)
        throw new Error('NEED_TAG: "isolated" and "not-isolated" together');
      isolated = value;
    } else {
      const [key, value] = tag.split(':') as [
        'browser' | 'vfs' | 'build' | 'requires' | 'excludes',
        string,
      ];
      lists[key] = [...(lists[key] ?? []), value];
    }
  }
  const need = {
    ...lists,
    ...(isolated === undefined ? {} : { isolated }),
  } as TestNeed;
  return { standalone, need };
};
