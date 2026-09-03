import { describe, expect, it } from '@rstest/core';
import {
  inspectDatabase,
  inspectWith,
  libraryClientsHold,
} from '../../src/inspect';
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
  it('rejects a missing vfs by name, the way deleteDatabase does', async () => {
    await expect(
      inspectDatabase('app.db', undefined as never),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    // Not "Unknown vfs 'undefined'": a caller who forgot the option is told to
    // pass one, not shown their own mistake echoed back as a value.
    await expect(inspectDatabase('app.db', {} as never)).rejects.toThrow(
      /vfs is required/,
    );
  });

  it('rejects the memory VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase('app.db', { vfs: 'MemoryVFS' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects an unknown VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase('app.db', { vfs: 'NoSuchVFS' as never }),
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
        inspectDatabase('app.db', { vfs: 'OPFSAdaptiveVFS' }),
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

describe('libraryClientsHold', () => {
  const marker = (id: string, file = 'app.db') =>
    clientMarkerName('OPFSAdaptiveVFS', file, id, 'SQLite 1');

  it('reports true when another client of this library holds the file', async () => {
    const locks = stubLocks([
      { name: marker(ID_A), clientId: 'r1' },
      { name: marker(ID_B), clientId: 'r2' },
    ]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBe(true);
  });

  it('reports true across the opfs-path family, which shares one file', async () => {
    // Four VFS collapse to the `opfs` namespace and therefore to one file. A
    // client that opened it through another of them is a holder, and the
    // timeout message would be wrong to say no client of this library has it.
    const locks = stubLocks([
      {
        name: clientMarkerName('OPFSCoopSyncVFS', 'app.db', ID_B, 'SQLite 1'),
        clientId: 'r2',
      },
    ]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBe(true);
  });

  it('reports false when the only marker held is our own', async () => {
    const locks = stubLocks([{ name: marker(ID_A), clientId: 'r1' }]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBe(false);
  });

  it('reports false when the markers held name another database', async () => {
    const locks = stubLocks([
      { name: marker(ID_B, 'other.db'), clientId: 'r2' },
    ]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBe(false);
  });

  it('reports undefined where Web Locks is unavailable', async () => {
    await expect(
      libraryClientsHold(noOpLocks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBeUndefined();
  });

  it('reports undefined for a VFS that keeps its pages in the worker', async () => {
    const locks = stubLocks([{ name: marker(ID_B), clientId: 'r2' }]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'MemoryVFS', ID_A),
    ).resolves.toBeUndefined();
  });

  it('reports undefined when the registry rejects', async () => {
    const locks = {
      ...noOpLocks,
      available: true,
      entries: async () => {
        throw new Error('registry unavailable');
      },
    } as Locks;
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBeUndefined();
  });

  it('reports undefined when the registry never answers', async () => {
    const locks = {
      ...noOpLocks,
      available: true,
      entries: () => new Promise<never>(() => {}),
    } as Locks;
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A, 10),
    ).resolves.toBeUndefined();
  });
});
