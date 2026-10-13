import { describe, expect, it } from 'vitest';
import { KNOWN_FEATURES } from '../../src/capabilities';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import {
  canonicalPairs,
  declaredTags,
  holds,
  needFromTags,
  PROPERTIES,
  type Property,
  representative,
  runsIn,
  shouldTestRun,
  type TestContext,
} from '../need';

// The features the 2026-10-11 probe measured on the pinned browsers.
const BASE: PlatformFeature[] = [
  'jspi',
  'opfs',
  'sync-access-handle',
  'web-locks',
  'writable-stream',
  'indexeddb',
];
const CHROME = new Set<PlatformFeature>([...BASE, 'readwrite-unsafe']);
const FIREFOX = new Set<PlatformFeature>(BASE);
const isolatedOf = (f: ReadonlySet<PlatformFeature>) =>
  new Set<PlatformFeature>([...f, 'cross-origin-isolated']);

const ctx = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  browser: 'chrome' | 'firefox',
  isolated = false,
): TestContext => {
  const base = browser === 'chrome' ? CHROME : FIREFOX;
  return {
    vfs,
    build,
    browser,
    isolated,
    features: isolated ? isolatedOf(base) : base,
  };
};

/** The VFS where a property holds on every runnable build, for one browser, non-isolated. */
const satisfying = (property: Property, browser: 'chrome' | 'firefox') =>
  (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter((vfs) => {
    const builds = (
      VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]
    ).filter((b) => runsIn(ctx(vfs, b, browser)));
    return (
      builds.length > 0 &&
      builds.every((b) => holds(property, ctx(vfs, b, browser)))
    );
  });

describe('the properties, against the spec table (2026-10-12)', () => {
  const table: Record<
    Exclude<Property, 'interruptible'>,
    Record<'chrome' | 'firefox', SQLiteVFS[]>
  > = {
    'two-workers': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'IDBBatchAtomicVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: ['IDBBatchAtomicVFS', 'OPFSAnyContextVFS'],
    },
    'shared-second-client': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: [
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
    },
    'exclusive-connection': {
      chrome: ['AccessHandlePoolVFS'],
      firefox: ['OPFSWriteAheadVFS', 'AccessHandlePoolVFS'],
    },
    'shared-storage': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
    },
    'opfs-file': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'OPFSAnyContextVFS',
      ],
    },
    'in-place-file': {
      chrome: ['OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
      firefox: ['OPFSAdaptiveVFS', 'OPFSCoopSyncVFS', 'OPFSAnyContextVFS'],
    },
    'capped-pool': {
      chrome: [
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBMirrorVFS',
        'MemoryVFS',
        'MemoryAsyncVFS',
      ],
      firefox: [
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBMirrorVFS',
        'MemoryVFS',
        'MemoryAsyncVFS',
      ],
    },
    'env-capped-pool': {
      chrome: [],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
    },
    'default-pragmas': {
      chrome: [
        'OPFSAdaptiveVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: [
        'OPFSAdaptiveVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'OPFSAnyContextVFS',
      ],
    },
    'exclusive-file-handle': {
      chrome: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
      firefox: ['OPFSCoopSyncVFS', 'AccessHandlePoolVFS'],
    },
    'idb-storage': {
      chrome: ['IDBBatchAtomicVFS', 'IDBMirrorVFS'],
      firefox: ['IDBBatchAtomicVFS', 'IDBMirrorVFS'],
    },
    'every-build': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'MemoryVFS',
      ],
      firefox: [
        'OPFSWriteAheadVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'MemoryVFS',
      ],
    },
    'env-cappable': {
      chrome: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
      firefox: ['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS'],
    },
    'sync-handle': {
      chrome: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
      ],
      firefox: [
        'OPFSWriteAheadVFS',
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
      ],
    },
    'immediate-connection-lock': {
      chrome: [
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
      firefox: [
        'OPFSAdaptiveVFS',
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'OPFSAnyContextVFS',
      ],
    },
  };
  for (const [property, browsers] of Object.entries(table))
    for (const [browser, expected] of Object.entries(browsers))
      it(`${property} holds on ${browser} for ${expected.join(', ') || 'no VFS'}`, () => {
        expect(
          satisfying(
            property as Property,
            browser as 'chrome' | 'firefox',
          ).sort(),
        ).toEqual([...expected].sort());
      });

  it('makes interruptible a property of the build, sync only under isolation', () => {
    for (const build of Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[]) {
      expect(holds('interruptible', ctx('MemoryVFS', build, 'firefox'))).toBe(
        build !== 'sync',
      );
    }
    expect(
      holds('interruptible', ctx('MemoryVFS', 'sync', 'firefox', true)),
    ).toBe(true);
  });

  it('puts a second client in exactly one of shared, refused or its own database', () => {
    for (const browser of ['chrome', 'firefox'] as const)
      for (const vfs of Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]) {
        const c = ctx(vfs, VFS_CAPABILITIES[vfs].builds[0], browser);
        const outcomes = [
          holds('shared-second-client', c),
          holds('exclusive-connection', c),
          !holds('shared-storage', c),
        ];
        expect(outcomes.filter(Boolean)).toHaveLength(1);
      }
  });
});

describe('shouldTestRun', () => {
  const wa = (browser: 'chrome' | 'firefox', isolated = false) =>
    ctx('OPFSWriteAheadVFS', 'sync', browser, isolated);

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
    expect(
      shouldTestRun(
        {
          ...adaptive,
          isolated: true,
          features: isolatedOf(adaptive.features),
        },
        need,
      ),
    ).toBe(false);
  });

  it('runs an isolated: true test in isolation even where isolation changes nothing', () => {
    expect(shouldTestRun(wa('chrome', true), { isolated: true })).toBe(true);
    expect(shouldTestRun(wa('chrome'), { isolated: true })).toBe(false);
  });

  it('honours isolated: false', () => {
    expect(shouldTestRun(wa('chrome'), { isolated: false })).toBe(true);
    expect(shouldTestRun(wa('chrome', true), { isolated: false })).toBe(false);
  });

  // Falsifiable: ignore dedupeIsolation in shouldTestRun.
  it('runs every eligible test in isolation when the mode was asked for in full', () => {
    expect(
      shouldTestRun(wa('chrome', true), {}, { dedupeIsolation: false }),
    ).toBe(true);
    expect(
      shouldTestRun(
        wa('chrome', true),
        { isolated: false },
        { dedupeIsolation: false },
      ),
    ).toBe(false);
  });

  it('reads a list as OR and the fields as AND', () => {
    const need = {
      vfs: ['OPFSAdaptiveVFS', 'OPFSWriteAheadVFS'],
      browser: ['firefox'],
    } as const;
    expect(shouldTestRun(wa('firefox'), need)).toBe(true);
    expect(shouldTestRun(wa('chrome'), need)).toBe(false);
    expect(shouldTestRun(ctx('MemoryVFS', 'sync', 'firefox'), need)).toBe(
      false,
    );
  });

  it('refuses when any excluded property holds', () => {
    expect(
      shouldTestRun(ctx('MemoryVFS', 'sync', 'chrome'), {
        excludes: ['shared-storage'],
      }),
    ).toBe(true);
    expect(shouldTestRun(wa('chrome'), { excludes: ['shared-storage'] })).toBe(
      false,
    );
  });

  // Falsifiable: read `requires` with `some` in eligible().
  it('needs every required property, not one of them', () => {
    // On Chrome, OPFSWriteAheadVFS runs two workers but stores in OPFS.
    const need = { requires: ['two-workers', 'idb-storage'] } as const;
    expect(shouldTestRun(wa('chrome'), need)).toBe(false);
  });

  // Falsifiable: read `excludes` as "not all of them" in eligible().
  it('refuses when one excluded property holds and the other does not', () => {
    const need = { excludes: ['idb-storage', 'shared-storage'] } as const;
    expect(shouldTestRun(wa('chrome'), need)).toBe(false);
  });

  // Falsifiable: drop the `build` field from eligible().
  it('keeps a build-bound test off the other builds', () => {
    const asyncPair = ctx('OPFSWriteAheadVFS', 'async', 'chrome');
    expect(shouldTestRun(asyncPair, { build: ['sync'] })).toBe(false);
    expect(shouldTestRun(wa('chrome'), { build: ['sync'] })).toBe(true);
  });
});

describe('runsIn', () => {
  it('says no for a build whose feature is missing', () => {
    const noJspi = new Set<PlatformFeature>(
      [...FIREFOX].filter((f) => f !== 'jspi'),
    );
    expect(
      runsIn({
        ...ctx('OPFSAdaptiveVFS', 'jspi', 'firefox'),
        features: noJspi,
      }),
    ).toBe(false);
    expect(
      runsIn({
        ...ctx('OPFSAdaptiveVFS', 'async', 'firefox'),
        features: noJspi,
      }),
    ).toBe(true);
  });

  // Falsifiable: drop the VFS's `requires` from runsIn.
  it('says no for a VFS whose feature is missing', () => {
    const noIndexedDB = new Set<PlatformFeature>(
      [...FIREFOX].filter((f) => f !== 'indexeddb'),
    );
    const idb = ctx('IDBBatchAtomicVFS', 'async', 'firefox');
    expect(runsIn({ ...idb, features: noIndexedDB })).toBe(false);
    expect(runsIn(idb)).toBe(true);
  });
});

describe('the tags', () => {
  it('rebuild the need they spell', () => {
    expect(
      needFromTags([
        'requires:two-workers',
        'excludes:shared-storage',
        'vfs:OPFSCoopSyncVFS',
        'build:sync',
        'browser:firefox',
        'isolated',
      ]),
    ).toEqual({
      standalone: false,
      need: {
        requires: ['two-workers'],
        excludes: ['shared-storage'],
        vfs: ['OPFSCoopSyncVFS'],
        build: ['sync'],
        browser: ['firefox'],
        isolated: true,
      },
    });
    expect(needFromTags(['not-isolated'])).toEqual({
      standalone: false,
      need: { isolated: false },
    });
    expect(needFromTags(['standalone'])).toEqual({
      standalone: true,
      need: {},
    });
    expect(needFromTags([])).toEqual({ standalone: false, need: {} });
  });

  it('fail loudly on a tag they do not know', () => {
    expect(() => needFromTags(['requires:two-worker'])).toThrow(
      /requires:two-worker/,
    );
    expect(() => needFromTags(['vfs:NopeVFS'])).toThrow(/vfs:NopeVFS/);
    expect(() => needFromTags(['isolated', 'not-isolated'])).toThrow(
      /isolated/,
    );
  });

  it('declare every tag the vocabulary can spell, once', () => {
    const tags = declaredTags();
    expect(new Set(tags).size).toBe(tags.length);
    for (const p of PROPERTIES)
      expect(tags).toEqual(
        expect.arrayContaining([`requires:${p}`, `excludes:${p}`]),
      );
    for (const v of Object.keys(VFS_CAPABILITIES))
      expect(tags).toContain(`vfs:${v}`);
    for (const b of Object.keys(BUILD_CAPABILITIES))
      expect(tags).toContain(`build:${b}`);
    expect(tags).toEqual(
      expect.arrayContaining([
        'browser:chrome',
        'browser:firefox',
        'isolated',
        'not-isolated',
        'standalone',
      ]),
    );
  });

  // KNOWN_FEATURES, not a list here: a feature added later is covered too.
  it('never name a property like a platform feature', () => {
    for (const p of PROPERTIES)
      expect(KNOWN_FEATURES.has(p as PlatformFeature)).toBe(false);
  });
});

describe('canonicalPairs', () => {
  it('lists every runnable pair, VFS in declaration order, then builds as declared', () => {
    const pairs = canonicalPairs('chrome', false, CHROME);
    expect(pairs).toHaveLength(22);
    expect(
      pairs.slice(0, 4).map(({ vfs, build }) => `${vfs}/${build}`),
    ).toEqual([
      'OPFSWriteAheadVFS/sync',
      'OPFSWriteAheadVFS/jspi',
      'OPFSWriteAheadVFS/async',
      'OPFSAdaptiveVFS/jspi',
    ]);
    expect(pairs.every((p) => p.browser === 'chrome' && !p.isolated)).toBe(
      true,
    );
  });

  // Falsifiable: drop the runsIn filter.
  it('leaves out the pairs this environment cannot run', () => {
    const noJspi = new Set<PlatformFeature>(
      [...FIREFOX].filter((f) => f !== 'jspi'),
    );
    const pairs = canonicalPairs('firefox', false, noJspi);
    expect(pairs).toHaveLength(13);
    expect(pairs.some((p) => p.build === 'jspi')).toBe(false);
  });
});

describe('representative', () => {
  it('gives a standalone test the first pair its need admits', () => {
    const memory = representative(
      { excludes: ['shared-storage'], requires: ['every-build'] },
      'chrome',
      CHROME,
    );
    expect(memory && `${memory.vfs}/${memory.build}`).toBe('MemoryVFS/sync');
    const capped = representative(
      { requires: ['env-capped-pool'] },
      'firefox',
      FIREFOX,
    );
    expect(capped && `${capped.vfs}/${capped.build}`).toBe(
      'OPFSWriteAheadVFS/sync',
    );
  });

  it('says null where no pair admits the need', () => {
    expect(
      representative({ requires: ['env-capped-pool'] }, 'chrome', CHROME),
    ).toBeNull();
  });

  // Sync is interruptible only under isolation, and a standalone test runs
  // non-isolated: the isolated feature set must not leak into the answer.
  it('never answers with an isolated pair', () => {
    const rep = representative(
      { requires: ['interruptible'] },
      'chrome',
      isolatedOf(CHROME),
    );
    expect(`${rep?.vfs}/${rep?.build}`).toBe('OPFSWriteAheadVFS/jspi');
    expect(rep?.isolated).toBe(false);
  });
});
