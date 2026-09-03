import { describe, expect, it } from '@rstest/core';
import { inspectDatabase, inspectWith } from '../../src/inspect';
import { clientMarkerName, type Locks, noOpLocks } from '../../src/locks';

const ID_A = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a90';
const ID_B = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a91';

const stubLocks = (held: { name: string; clientId: string }[]): Locks =>
  ({
    ...noOpLocks,
    available: true,
    entries: async () => ({
      held: held.map((h) => ({ ...h, mode: 'shared' as const })),
      pending: [],
    }),
    hold: async () => () => {},
  }) as Locks;

describe('inspectWith', () => {
  it('counts one tab for two clients in one realm', async () => {
    const marker = (id: string) =>
      clientMarkerName('OPFSAdaptiveVFS', 'app.db', id, 'SQLite 1');
    const locks = stubLocks([
      { name: marker(ID_A), clientId: 'r1' },
      { name: marker(ID_B), clientId: 'r1' },
    ]);
    const result = await inspectWith(
      locks,
      'app.db',
      'OPFSAdaptiveVFS',
      marker(ID_A),
    );
    expect(result.clients).toHaveLength(2);
    expect(result.tabs).toBe(1);
  });

  it('counts two tabs for two realms', async () => {
    const marker = (id: string) =>
      clientMarkerName('OPFSAdaptiveVFS', 'app.db', id, 'SQLite 1');
    const locks = stubLocks([
      { name: marker(ID_A), clientId: 'r1' },
      { name: marker(ID_B), clientId: 'r2' },
    ]);
    const result = await inspectWith(
      locks,
      'app.db',
      'OPFSAdaptiveVFS',
      marker(ID_A),
    );
    expect(result.tabs).toBe(2);
    expect(result.clients.filter((c) => c.sameTab)).toHaveLength(1);
  });

  it('ignores locks that are not our markers', async () => {
    // ownMarkerName is explicit so this test is self-sufficient regardless of
    // whether prior tests filled the module-scope cachedRealmId.
    const ownMarker = clientMarkerName(
      'OPFSAdaptiveVFS',
      'app.db',
      ID_A,
      'SQLite 1',
    );
    const locks = stubLocks([
      { name: 'bsq:write:opfs:app.db', clientId: 'r1' },
      { name: 'someone-elses-lock', clientId: 'r1' },
      { name: ownMarker, clientId: 'r1' },
    ]);
    const result = await inspectWith(
      locks,
      'app.db',
      'OPFSAdaptiveVFS',
      ownMarker,
    );
    expect(result.clients).toHaveLength(1);
  });
});

describe('inspectDatabase degenerate cases', () => {
  it('rejects the memory VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase({ file: 'app.db', vfs: 'MemoryVFS' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects an unknown VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase({ file: 'app.db', vfs: 'NoSuchVFS' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects with UNSUPPORTED where Web Locks is missing', async () => {
    // The brief assumed Node lacks navigator.locks, but Node 24 ships it.
    // Temporarily patch it away so createLocks() returns noOpLocks (available:
    // false), exercising the UNSUPPORTED guard regardless of Node version.
    const nav = globalThis.navigator as Navigator & { locks?: unknown };
    const hadLocks = Object.hasOwn(nav, 'locks');
    const savedLocks = nav.locks;
    Object.defineProperty(nav, 'locks', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      await expect(
        inspectDatabase({ file: 'app.db', vfs: 'OPFSAdaptiveVFS' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    } finally {
      if (hadLocks) {
        Object.defineProperty(nav, 'locks', {
          configurable: true,
          value: savedLocks,
          writable: true,
        });
      } else {
        delete (nav as unknown as Record<string, unknown>).locks;
      }
    }
  });
});
