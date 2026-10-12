import { describe, expect, it } from 'vitest';
import type { PlatformFeature } from '../../src/const/platform';
import {
  featureDifference,
  type GuardInput,
  guardVerdict,
} from '../planner/guard';

const CHROME = new Set<PlatformFeature>([
  'jspi',
  'opfs',
  'sync-access-handle',
  'web-locks',
  'writable-stream',
  'indexeddb',
  'readwrite-unsafe',
]);
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
const planned = {
  tests: { f_0_0: 'a > b' },
  features: [...CHROME],
  fullIsolation: false,
  target: { vfs: 'OPFSWriteAheadVFS', build: 'sync' },
} as const;

describe('outside a plan (a project run directly)', () => {
  it('runs an eligible test', () => {
    expect(guardVerdict(base)).toEqual({ kind: 'run' });
  });

  // Falsifiable: return run whatever the need.
  it('skips an ineligible one, saying what it needs', () => {
    const verdict = guardVerdict({ ...base, tags: ['vfs:IDBBatchAtomicVFS'] });
    expect(verdict.kind).toBe('skip');
    expect(verdict.kind === 'skip' && verdict.reason).toContain(
      'vfs:IDBBatchAtomicVFS',
    );
  });

  it('runs a standalone test wherever it lands', () => {
    expect(
      guardVerdict({
        ...base,
        tags: ['standalone', 'excludes:shared-storage'],
      }),
    ).toEqual({ kind: 'run' });
  });

  it('lets a misspelt tag fail the test', () => {
    expect(() =>
      guardVerdict({ ...base, tags: ['requires:two-worker'] }),
    ).toThrow(/NEED_TAG/);
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
    expect(verdict.kind === 'fail' && verdict.reason).toMatch(
      /PLAN_GUARD.*dynamically/,
    );
  });

  it('reads the parser escapes of a planned name', () => {
    const escaped = { ...planned, tests: { f_0_0: 'a > says \\"closed\\"' } };
    expect(
      guardVerdict({ ...base, name: 'a > says "closed"', planned: escaped }),
    ).toEqual({ kind: 'run' });
  });

  it('fails a planned test whose tags do not run on this pair', () => {
    const verdict = guardVerdict({ ...base, tags: ['vfs:MemoryVFS'], planned });
    expect(verdict.kind).toBe('fail');
  });

  it('fails a test that ran without being planned', () => {
    expect(guardVerdict({ ...base, id: 'f_0_9', planned }).kind).toBe('fail');
  });

  it('fails when the cell is not on the planned pair', () => {
    expect(
      guardVerdict({ ...base, vfs: 'OPFSAdaptiveVFS', build: 'jspi', planned })
        .kind,
    ).toBe('fail');
  });

  it('runs a test isolation changes nothing for when the mode was asked for in full', () => {
    const full = { ...planned, fullIsolation: true };
    expect(
      guardVerdict({
        ...base,
        isolated: true,
        features: new Set([...CHROME, 'cross-origin-isolated']),
        planned: full,
      }),
    ).toEqual({ kind: 'run' });
  });
});

describe('featureDifference', () => {
  it('names what the probe saw and this page does not, and the reverse', () => {
    expect(
      featureDifference(
        ['jspi', 'opfs'],
        new Set<PlatformFeature>(['jspi', 'indexeddb']),
      ),
    ).toBe('planned for [opfs], missing here; here [indexeddb], not planned');
    expect(
      featureDifference(['jspi'], new Set<PlatformFeature>(['jspi'])),
    ).toBeNull();
  });
});
