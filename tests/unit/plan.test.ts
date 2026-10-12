import { describe, expect, it } from 'vitest';
import type { PlatformFeature } from '../../src/const/platform';
import {
  type CollectedTest,
  type FamilyInput,
  type PlanOptions,
  plan,
} from '../planner/plan';

// The features the 2026-10-11 probe measured on the pinned browsers.
const BASE: PlatformFeature[] = [
  'jspi',
  'opfs',
  'sync-access-handle',
  'web-locks',
  'writable-stream',
  'indexeddb',
];
const CHROME: PlatformFeature[] = [...BASE, 'readwrite-unsafe'];
const FIREFOX: PlatformFeature[] = BASE;
const ISOLATED: PlatformFeature[] = ['cross-origin-isolated'];

let position = 0;
const test = (
  name: string,
  tags: string[] = [],
  file = 'tests/browser/a.test.ts',
): CollectedTest => ({
  file,
  position: position++,
  name,
  tags,
  dynamic: false,
});
const families = (
  tests: CollectedTest[],
  isolatedTests: CollectedTest[] = [],
): FamilyInput[] => [
  { browser: 'chrome', isolated: false, features: CHROME, tests },
  { browser: 'firefox', isolated: false, features: FIREFOX, tests },
  {
    browser: 'chrome',
    isolated: true,
    features: [...CHROME, ...ISOLATED],
    tests: isolatedTests,
  },
  {
    browser: 'firefox',
    isolated: true,
    features: [...FIREFOX, ...ISOLATED],
    tests: isolatedTests,
  },
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
  p.cells
    .map(
      (c) =>
        `${c.project} [${c.reason}]: ${c.tests.map((t) => t.name).join(', ')}`,
    )
    .sort();

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
    expect(
      layout(
        plan(families([test('idb', ['vfs:IDBBatchAtomicVFS'])]), COMPLEMENT),
      ),
    ).toEqual([
      'chrome · IDBBatchAtomicVFS/jspi [complement]: idb',
      'firefox · IDBBatchAtomicVFS/jspi [complement]: idb',
    ]);
  });

  it('opens no cell where nothing runs: an isolated family with no isolated test is empty', () => {
    const p = plan(
      families([test('plain')], [test('plain isolated file')]),
      COMPLEMENT,
    );
    expect(p.cells.some((c) => c.isolated)).toBe(false);
  });

  it('runs the slot-channel test in the isolated start cell of each browser', () => {
    const p = plan(
      families([], [test('slot', ['build:sync', 'requires:interruptible'])]),
      COMPLEMENT,
    );
    expect(layout(p)).toEqual([
      'isolated chrome · OPFSWriteAheadVFS/sync [start]: slot',
      'isolated firefox · OPFSWriteAheadVFS/sync [start]: slot',
    ]);
  });

  it('lists a test as not applicable on a browser where no pair runs it, and runs it on the other', () => {
    const p = plan(
      families([test('capped', ['requires:env-capped-pool'])]),
      COMPLEMENT,
    );
    expect(layout(p)).toEqual([
      'firefox · OPFSAdaptiveVFS/jspi [start]: capped',
      'firefox · OPFSWriteAheadVFS/sync [start]: capped',
    ]);
    expect(p.notApplicable.map((u) => `${u.browser}: ${u.name}`)).toEqual([
      'chrome: capped',
    ]);
    expect(p.dead).toEqual([]);
  });

  // Falsifiable: compute `dead` from notApplicable alone.
  it('calls a test no pair of any browser runs dead', () => {
    const p = plan(
      families([
        test('nowhere', ['requires:idb-storage', 'requires:opfs-file']),
      ]),
      COMPLEMENT,
    );
    expect(p.cells).toEqual([]);
    expect(p.dead.map((d) => d.name)).toEqual(['nowhere']);
  });

  it('hosts a standalone test in the first start cell of each browser, once', () => {
    const p = plan(
      families([test('alone', ['standalone']), test('plain')]),
      COMPLEMENT,
    );
    const hosts = p.cells
      .filter((c) => c.tests.some((t) => t.name === 'alone'))
      .map((c) => c.project);
    expect(hosts).toEqual([
      'chrome · OPFSWriteAheadVFS/sync',
      'firefox · OPFSWriteAheadVFS/sync',
    ]);
  });

  it('lists a standalone test whose need no pair admits as not applicable', () => {
    const p = plan(
      families([test('alone', ['standalone', 'requires:env-capped-pool'])]),
      COMPLEMENT,
    );
    expect(p.notApplicable.map((u) => `${u.browser}: ${u.name}`)).toEqual([
      'chrome: alone',
    ]);
    expect(p.cells.map((c) => c.project)).toEqual([
      'firefox · OPFSWriteAheadVFS/sync',
    ]);
  });

  it('runs every eligible isolated test in isolation when the mode is asked for in full', () => {
    const p = plan(families([], [test('plain isolated file')]), {
      ...COMPLEMENT,
      fullIsolation: true,
    });
    expect(
      p.cells
        .filter((c) => c.isolated)
        .map((c) => c.project)
        .sort(),
    ).toEqual([
      'isolated chrome · OPFSAdaptiveVFS/jspi',
      'isolated chrome · OPFSWriteAheadVFS/sync',
      'isolated firefox · OPFSAdaptiveVFS/jspi',
      'isolated firefox · OPFSWriteAheadVFS/sync',
    ]);
  });
});

describe('explicit pairs', () => {
  it('start from them instead of the recommended VFS, never substituted', () => {
    const p = plan(families([test('plain')]), {
      ...COMPLEMENT,
      pairs: [{ vfs: 'MemoryVFS', build: 'async' }],
    });
    expect(p.cells.map((c) => c.project).sort()).toEqual([
      'chrome · MemoryVFS/async',
      'firefox · MemoryVFS/async',
    ]);
  });

  // Falsifiable: let an unrunnable explicit pair fall back to another one.
  it('show a pair a browser cannot run as not runnable there', () => {
    const noJspi = FIREFOX.filter((f) => f !== 'jspi');
    const p = plan(
      [
        {
          browser: 'chrome',
          isolated: false,
          features: CHROME,
          tests: [test('plain')],
        },
        {
          browser: 'firefox',
          isolated: false,
          features: noJspi,
          tests: [test('plain')],
        },
      ],
      { ...COMPLEMENT, pairs: [{ vfs: 'OPFSAdaptiveVFS', build: 'jspi' }] },
    );
    expect(
      p.notRunnable.map((n) => `${n.browser} ${n.vfs}/${n.build}`),
    ).toEqual(['firefox OPFSAdaptiveVFS/jspi']);
    expect(p.cells.map((c) => c.project)).toContain(
      'chrome · OPFSAdaptiveVFS/jspi',
    );
  });

  it('refuse a pair the VFS does not declare', () => {
    expect(() =>
      plan(families([test('plain')]), {
        ...COMPLEMENT,
        pairs: [{ vfs: 'OPFSAdaptiveVFS', build: 'sync' }],
      }),
    ).toThrow(/PLAN_PAIR/);
  });
});

describe('all-pairs mode', () => {
  it('runs a test with no need on every runnable pair, never in isolation', () => {
    const p = plan(
      families([test('plain')], [test('isolated, untagged')]),
      ALL_PAIRS,
    );
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
    expect(() =>
      plan(families([{ ...test('each %i'), dynamic: true }]), COMPLEMENT),
    ).toThrow(/PLAN_DYNAMIC/);
  });

  it('a tag outside the vocabulary', () => {
    expect(() =>
      plan(families([test('typo', ['requires:two-worker'])]), COMPLEMENT),
    ).toThrow(/NEED_TAG/);
  });
});
