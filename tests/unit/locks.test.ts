import { describe, expect, it } from '@rstest/core';
import {
  clientMarkerName,
  connectionLockName,
  createLocks,
  initLockName,
  namespaceFor,
  noOpLocks,
  parseClientMarker,
  sharesStorage,
  stagingLockName,
  staleStagingTables,
  sweepLockName,
  writeLockName,
} from '../../src/locks';

describe('staleStagingTables', () => {
  const file = 'app.db';

  it('keeps a staging table whose lock is held', () => {
    const held = [stagingLockName(file, '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([]);
  });

  it('collects a staging table nobody holds', () => {
    expect(staleStagingTables(['__bsq_staging_a'], [], file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('ignores locks held for another database file', () => {
    const held = [stagingLockName('other.db', '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('collects several at once and keeps the live one', () => {
    const held = [stagingLockName(file, '__bsq_staging_b')];
    expect(
      staleStagingTables(
        ['__bsq_staging_a', '__bsq_staging_b', '__bsq_staging_c'],
        held,
        file,
      ),
    ).toEqual(['__bsq_staging_a', '__bsq_staging_c']);
  });
});

describe('createLocks', () => {
  /** Minimal in-memory stand-in for navigator.locks. */
  const fakeManager = () => {
    const held = new Set<string>();
    return {
      held,
      request: (name: string, ...rest: any[]) => {
        const callback = rest.length === 1 ? rest[0] : rest[1];
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => {
          held.delete(name);
        });
      },
      query: async () => ({
        held: [...held].map((name) => ({ name })),
        pending: [],
      }),
    } as any;
  };

  it('holds a lock until the returned releaser is called', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const release = await locks.hold('bsq:staging:app.db:t');
    expect(await locks.heldNames()).toContain('bsq:staging:app.db:t');

    release();
    // The release resolves the callback's promise; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(await locks.heldNames()).not.toContain('bsq:staging:app.db:t');
  });

  it('runs a function under an exclusive lock', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const seen: string[] = [];
    const result = await locks.withLock('bsq:sweep:app.db', async () => {
      seen.push(...(await locks.heldNames()));
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toContain('bsq:sweep:app.db');
  });

  it('degrades to a no-op when the API is unavailable', async () => {
    const locks = noOpLocks;

    expect(locks.available).toBe(false);
    expect(await locks.heldNames()).toEqual([]);
    const release = await locks.hold('x');
    expect(() => release()).not.toThrow();
    expect(await locks.withLock('x', async () => 'ran')).toBe('ran');
  });

  it('rejects hold() when the lock manager rejects', async () => {
    const manager = {
      request: async () => {
        throw new Error('AbortError');
      },
      query: async () => ({ held: [], pending: [] }),
    } as any;
    const locks = createLocks(manager);
    await expect(locks.hold('bsq:staging:app.db:t')).rejects.toThrow(
      'AbortError',
    );
  }, 1000);
});

describe('namespaceFor', () => {
  // Falsifiable: return `vfs` unconditionally and this goes red. That is the
  // whole point — these four VFS open the SAME OPFS path for one name, so a
  // per-VFS key would let two clients write the same bytes unexcluded.
  it('gives every opfs-path VFS one namespace', () => {
    expect(namespaceFor('OPFSAdaptiveVFS')).toBe('opfs');
    expect(namespaceFor('OPFSAnyContextVFS')).toBe('opfs');
    expect(namespaceFor('OPFSCoopSyncVFS')).toBe('opfs');
    expect(namespaceFor('OPFSWriteAheadVFS')).toBe('opfs');
  });

  it('keeps the two idb-store VFS apart — each owns its own IndexedDB database', () => {
    expect(namespaceFor('IDBBatchAtomicVFS')).not.toBe(
      namespaceFor('IDBMirrorVFS'),
    );
  });

  it('keeps AccessHandlePoolVFS out of the opfs namespace', () => {
    // Its own directory, random filenames: /<file> is not its file.
    expect(namespaceFor('AccessHandlePoolVFS')).not.toBe('opfs');
  });
});

describe('sharesStorage', () => {
  it('is false only for the memory VFS', () => {
    expect(sharesStorage('MemoryVFS')).toBe(false);
    expect(sharesStorage('MemoryAsyncVFS')).toBe(false);
    expect(sharesStorage('OPFSAdaptiveVFS')).toBe(true);
    expect(sharesStorage('IDBBatchAtomicVFS')).toBe(true);
  });
});

describe('writeLockName', () => {
  it('is shared by the opfs-path VFS and distinct per file', () => {
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).toBe(
      writeLockName('OPFSCoopSyncVFS', 'a.db'),
    );
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      writeLockName('OPFSAdaptiveVFS', 'b.db'),
    );
  });

  it('does not collide with the init, sweep or staging namespaces', () => {
    const write = writeLockName('OPFSAdaptiveVFS', 'a.db');
    expect(write).not.toBe(initLockName('OPFSAdaptiveVFS', 'a.db'));
    expect(write).not.toBe(sweepLockName('a.db'));
    expect(write.startsWith('bsq:write:')).toBe(true);
  });
});

describe('initLockName', () => {
  it('is distinct per database file', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      initLockName('OPFSAdaptiveVFS', 'b.db'),
    );
  });

  it('is shared by VFS that open the same file', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).toBe(
      initLockName('OPFSWriteAheadVFS', 'a.db'),
    );
  });

  it('does not collide with the sweep or staging namespaces', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      sweepLockName('a.db'),
    );
    expect(
      initLockName('OPFSAdaptiveVFS', 'a.db').startsWith('bsq:init:'),
    ).toBe(true);
  });
});

describe('tryWithLock', () => {
  /**
   * A LockManager stand-in. `ifAvailable: true` makes the real API invoke the
   * callback with `null` when the lock is held elsewhere; `granted` chooses
   * which of the two the fake plays.
   */
  const manager = (granted: boolean, seen?: unknown[]) => ({
    request: async (_name: string, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof options !== 'function') seen?.push(options);
      return cb(granted ? {} : null);
    },
    query: async () => ({ held: [] as { name?: string }[] }),
  });

  it('does not run the callback when the lock is held elsewhere', async () => {
    let ran = false;
    const locks = createLocks(manager(false));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(acquired).toBe(false);
  });

  it('runs the callback when the lock is free', async () => {
    let ran = false;
    const locks = createLocks(manager(true));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });

  // Falsifiable: drop `ifAvailable` from the request options. Without it the
  // real API waits, which is the whole thing this method exists not to do —
  // and no behavioural assertion above can see the difference against a fake.
  it('asks for ifAvailable, which is what makes it never wait', async () => {
    const seen: unknown[] = [];
    const locks = createLocks(manager(true, seen));

    await locks.tryWithLock('n', async () => {});

    expect(seen[0]).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  it('runs the callback when the Web Locks API is absent', async () => {
    let ran = false;

    const acquired = await noOpLocks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });
});

describe('hold options', () => {
  it('defaults to an exclusive request', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (
        _name: string,
        options: unknown,
        callback: () => Promise<unknown>,
      ) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
    } as any;
    const release = await createLocks(manager).hold('bsq:probe');
    release();
    expect(seen).toEqual([{ mode: 'exclusive' }]);
  });

  it('passes a shared mode through', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (
        _name: string,
        options: unknown,
        callback: () => Promise<unknown>,
      ) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
    } as any;
    const release = await createLocks(manager).hold('bsq:probe', {
      mode: 'shared',
    });
    release();
    expect(seen).toEqual([{ mode: 'shared' }]);
  });

  // The signal is omitted rather than passed as undefined: Web Locks rejects
  // `signal` together with `ifAvailable`, and an explicit undefined is the kind
  // of thing an engine may or may not treat as absent.
  it('includes the signal only when one was given', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (
        _name: string,
        options: unknown,
        callback: () => Promise<unknown>,
      ) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
    } as any;
    const controller = new AbortController();
    const release = await createLocks(manager).hold('bsq:probe', {
      signal: controller.signal,
    });
    release();
    expect(seen).toEqual([{ mode: 'exclusive', signal: controller.signal }]);
  });

  it('no-op locks accept the options and still resolve a releaser', async () => {
    const release = await noOpLocks.hold('bsq:probe', { mode: 'shared' });
    expect(typeof release).toBe('function');
    release();
  });

  it('no-op locks with ifAvailable still resolve a releaser — lock always free in no-op mode', async () => {
    const release = await noOpLocks.hold('bsq:conn:ahp:test.db', {
      ifAvailable: true,
    });
    // No-op mode has no real lock manager, so the connection is always "available".
    expect(release).toBeDefined();
    expect(typeof release).toBe('function');
    release?.();
  });
});

describe('hold ifAvailable', () => {
  /**
   * A LockManager stand-in for the ifAvailable path. When `granted` is false,
   * the callback receives null (lock held elsewhere), matching the real Web
   * Locks API's ifAvailable behaviour.
   */
  const manager = (granted: boolean, seen?: unknown[]) => ({
    request: async (_name: string, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof options !== 'function') seen?.push(options);
      return cb(granted ? { name: _name } : null);
    },
    query: async () => ({ held: [] as { name?: string }[] }),
  });

  // Falsifiable: remove the `if (ifAvail && !lock)` branch in createLocks.hold.
  // Without it the function waits forever (the held promise never resolves),
  // and this test times out or hangs.
  it('resolves with undefined when the lock is held elsewhere', async () => {
    const locks = createLocks(manager(false));
    const result = await locks.hold('bsq:conn:AccessHandlePoolVFS:app.db', {
      ifAvailable: true,
    });
    expect(result).toBeUndefined();
  });

  it('resolves with a release function when the lock is free', async () => {
    const locks = createLocks(manager(true));
    const result = await locks.hold('bsq:conn:AccessHandlePoolVFS:app.db', {
      ifAvailable: true,
    });
    expect(typeof result).toBe('function');
    result?.();
  });

  // Falsifiable: remove `ifAvailable: true` from the requestOptions build. The
  // real API would then wait instead of resolving with null, and the test above
  // would time out rather than asserting undefined.
  it('passes ifAvailable: true to the lock manager', async () => {
    const seen: unknown[] = [];
    const locks = createLocks(manager(true, seen));
    const result = await locks.hold('bsq:conn:AccessHandlePoolVFS:app.db', {
      ifAvailable: true,
    });
    result?.();
    expect(seen[0]).toEqual({ mode: 'exclusive', ifAvailable: true });
  });
});

describe('connectionLockName', () => {
  // Falsifiable: return a hardcoded string and the distinctness assertions fail.
  it('follows the bsq:conn:<ns>:<file> pattern', () => {
    expect(connectionLockName('AccessHandlePoolVFS', 'app.db')).toBe(
      `bsq:conn:AccessHandlePoolVFS:app.db`,
    );
  });

  it('is distinct per database file', () => {
    expect(connectionLockName('AccessHandlePoolVFS', 'a.db')).not.toBe(
      connectionLockName('AccessHandlePoolVFS', 'b.db'),
    );
  });

  it('does not collide with init, write, sweep or staging lock names', () => {
    const conn = connectionLockName('AccessHandlePoolVFS', 'a.db');
    expect(conn).not.toBe(initLockName('AccessHandlePoolVFS', 'a.db'));
    expect(conn).not.toBe(writeLockName('AccessHandlePoolVFS', 'a.db'));
    expect(conn).not.toBe(sweepLockName('a.db'));
    expect(conn.startsWith('bsq:conn:')).toBe(true);
  });
});

describe('clientMarkerName / parseClientMarker', () => {
  const ID = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a90';

  it('round-trips a plain name', () => {
    const lock = clientMarkerName('OPFSAdaptiveVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')).toEqual({
      id: ID,
      vfs: 'OPFSAdaptiveVFS',
      name: 'SQLite 1',
    });
  });

  it('round-trips a name containing a colon and a percent', () => {
    const lock = clientMarkerName('OPFSAdaptiveVFS', 'app.db', ID, 'a:b 100%');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')?.name).toBe(
      'a:b 100%',
    );
  });

  it('round-trips when the FILE contains a colon', () => {
    const file = 'weird:name.db';
    const lock = clientMarkerName('OPFSAdaptiveVFS', file, ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', file)?.id).toBe(ID);
  });

  it('sees a sibling opened through another VFS of the same namespace', () => {
    const lock = clientMarkerName('OPFSCoopSyncVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')?.vfs).toBe(
      'OPFSCoopSyncVFS',
    );
  });

  it('ignores a marker from another namespace', () => {
    const lock = clientMarkerName(
      'IDBBatchAtomicVFS',
      'app.db',
      ID,
      'SQLite 1',
    );
    expect(
      parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db'),
    ).toBeUndefined();
  });

  it('ignores a marker for another file', () => {
    const lock = clientMarkerName(
      'OPFSAdaptiveVFS',
      'other.db',
      ID,
      'SQLite 1',
    );
    expect(
      parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db'),
    ).toBeUndefined();
  });

  it('ignores a foreign lock name under our prefix shape', () => {
    expect(
      parseClientMarker('bsq:write:opfs:app.db', 'OPFSAdaptiveVFS', 'app.db'),
    ).toBeUndefined();
  });

  it('ignores a marker with too few or too many segments', () => {
    const prefix = 'bsq:client:opfs:app.db:';
    expect(
      parseClientMarker(
        `${prefix}${ID}:OPFSAdaptiveVFS`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
    expect(
      parseClientMarker(
        `${prefix}${ID}:OPFSAdaptiveVFS:SQLite%201:extra`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker whose id is not a UUID', () => {
    expect(
      parseClientMarker(
        'bsq:client:opfs:app.db:not-a-uuid:OPFSAdaptiveVFS:SQLite%201',
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker naming a VFS that does not exist', () => {
    expect(
      parseClientMarker(
        `bsq:client:opfs:app.db:${ID}:NoSuchVFS:SQLite%201`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker whose encoding is malformed', () => {
    expect(
      parseClientMarker(
        `bsq:client:opfs:app.db:${ID}:OPFSAdaptiveVFS:%E0%A4%A`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });
});
