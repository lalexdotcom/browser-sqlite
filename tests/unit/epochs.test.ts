import { describe, expect, it } from '@rstest/core';
import {
  advanceSeen,
  epochLockName,
  epochsFor,
  maxEpochIn,
} from '../../src/epochs';
import { noOpLocks } from '../../src/locks';

describe('epochsFor', () => {
  it('starts at zero and only goes up', () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/counts-up', noOpLocks);
    expect(e.current()).toBe(0);
    expect(e.bump()).toBe(1);
    expect(e.bump()).toBe(2);
    expect(e.current()).toBe(2);
  });

  it('shares one counter between handles on the same database', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/shared', noOpLocks);
    const b = epochsFor('OPFSAdaptiveVFS', '/shared', noOpLocks);
    a.bump();
    expect(b.current()).toBe(1);
  });

  it('keeps distinct databases apart', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/apart-a', noOpLocks);
    const b = epochsFor('OPFSAdaptiveVFS', '/apart-b', noOpLocks);
    a.bump();
    expect(b.current()).toBe(0);
  });

  // Falsifiable: replace the globalThis symbol lookup with a module-level
  // `const registry = new Map()` and this goes red. That is the whole point of
  // the symbol: a bundler that loads two copies of this module (Vite
  // pre-bundling, two versions in a pnpm workspace, a dual ESM/CJS
  // resolution) must still find one counter, or two clients in one tab stop
  // seeing each other with no visible symptom.
  it('adopts a registry another module copy already installed', async () => {
    const key = Symbol.for('browser-sqlite.epochs.v1');
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[key] = new Map([['opfs:/preseeded', { value: 41 }]]);

    // In rstest's bundled Node environment the query-string trick does not
    // produce a separate module instance. A plain re-import is equivalent
    // because registry() reads globalThis[REGISTRY_KEY] on every call —
    // it never caches at module level — so seeding globalThis before the
    // call proves adoption regardless of whether `fresh` is a new copy.
    const fresh = await import('../../src/epochs');
    expect(
      fresh.epochsFor('OPFSAdaptiveVFS', '/preseeded', noOpLocks).current(),
    ).toBe(41);
  });
});

describe('epochLockName / maxEpochIn', () => {
  const prefix = 'bsq:epoch:opfs:a.db';

  it('reads the highest epoch published for this database', () => {
    const held = [
      epochLockName('opfs', 'a.db', 3),
      epochLockName('opfs', 'a.db', 7),
      epochLockName('opfs', 'a.db', 5),
    ];
    expect(maxEpochIn(held, prefix)).toBe(7);
  });

  it('ignores other databases and other namespaces', () => {
    const held = [
      epochLockName('opfs', 'b.db', 99),
      epochLockName('IDBMirrorVFS', 'a.db', 99),
      epochLockName('opfs', 'a.db', 2),
    ];
    expect(maxEpochIn(held, prefix)).toBe(2);
  });

  it('ignores every other lock this library takes', () => {
    const held = [
      'bsq:init:opfs:a.db',
      'bsq:write:opfs:a.db',
      'bsq:sweep:a.db',
    ];
    expect(maxEpochIn(held, prefix)).toBe(0);
  });

  // The trap: a normalized file may contain ':' — `new URL('./a:b','file://')`
  // gives the pathname 'a:b'. A prefix match plus lastIndexOf would read 7 out
  // of another database's marker. The tail after the prefix must be ALL digits.
  it('does not mistake a longer file name for this one', () => {
    const held = [epochLockName('opfs', 'a.db:extra', 7)];
    expect(maxEpochIn(held, prefix)).toBe(0);
  });

  it('is zero when nothing is held', () => {
    expect(maxEpochIn([], prefix)).toBe(0);
  });
});

describe('raiseTo', () => {
  it('raises the cell and never lowers it', () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/floor', noOpLocks);
    e.raiseTo(5);
    expect(e.current()).toBe(5);
    e.raiseTo(2);
    expect(e.current()).toBe(5);
    expect(e.bump()).toBe(6);
  });

  // This is what stops `max` dipping to zero when the last realm holding a
  // marker dies: a worker with `seen = 5` would read `5 >= 0` and believe
  // itself current for ever. epochs.ts:51-53 describes the same hole.
  it('keeps the floor even when the origin reports nothing', async () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/no-origin', noOpLocks);
    e.raiseTo(9);
    expect(await e.originMax()).toBe(0);
    expect(e.current()).toBe(9);
  });
});

describe('namespaced epoch keys', () => {
  it('shares one counter between VFS that open the same file', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/same', noOpLocks);
    const b = epochsFor('OPFSCoopSyncVFS', '/same', noOpLocks);
    a.bump();
    expect(b.current()).toBe(1);
  });

  it('keeps namespaces apart', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/apart-ns', noOpLocks);
    const b = epochsFor('IDBMirrorVFS', '/apart-ns', noOpLocks);
    a.bump();
    expect(b.current()).toBe(0);
  });
});

describe('publish', () => {
  it('takes the new marker before releasing the old one', async () => {
    const events: string[] = [];
    const locks = {
      available: true,
      hold: async (name: string) => {
        events.push(`hold ${name}`);
        return () => events.push(`release ${name}`);
      },
      withLock: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      tryWithLock: async () => true,
      heldNames: async () => [],
      entries: async () => ({ held: [], pending: [] }),
    };
    const e = epochsFor('OPFSAdaptiveVFS', '/publish', locks);
    await e.publish(1);
    await e.publish(2);
    expect(events).toEqual([
      'hold bsq:epoch:opfs:/publish:1',
      'hold bsq:epoch:opfs:/publish:2',
      'release bsq:epoch:opfs:/publish:1',
    ]);
  });

  it('does nothing when Web Locks is absent', async () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/publish-noop', noOpLocks);
    await e.publish(1);
    expect(await e.originMax()).toBe(0);
  });
});

describe('advanceSeen', () => {
  // Falsifiable: return `next` unconditionally and the second case goes red.
  // That case is the only place in the design where an error yields stale data
  // instead of a wasted prelude.
  it('advances when our commit is the next epoch', () => {
    expect(advanceSeen(5, 5, 6)).toBe(6);
  });

  it('does not advance when another client committed during our lease', () => {
    expect(advanceSeen(5, 5, 7)).toBe(5);
  });

  it('does not advance a worker that never caught up', () => {
    expect(advanceSeen(-1, 3, 4)).toBe(-1);
  });
});
