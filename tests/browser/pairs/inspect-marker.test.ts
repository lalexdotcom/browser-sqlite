import {
  createLocks,
  createSQLiteClient,
  deleteDatabase,
} from 'browser-sqlite/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { SQLiteVFS } from '../../../src/const/vfs';
import { parseClientMarker } from '../../../src/locks';
import { databasePath } from '../../../src/utils';
import {
  createTestClient,
  interceptWorkers,
  scaled,
  sharedDatabase,
  sleep,
  TEST_TARGET,
  waitUntil,
} from '../helpers';

const locks = createLocks();

// A marker only reaches the lock registry for a database that outlives the
// worker holding it — a memory VFS has no roster to hold one in, which is what
// `holds no marker where nothing is shared` below asserts on purpose. Every other
// test here is tagged `requires:shared-storage` rather than assuming the
// target has it.

const markersFor = async (file: string, vfs: SQLiteVFS) => {
  const { held } = await locks.entries();
  const path = databasePath(vfs, file);
  return held
    .map((entry) => parseClientMarker(entry.name, vfs, path))
    .filter(
      (m): m is NonNullable<ReturnType<typeof parseClientMarker>> =>
        m !== undefined,
    );
};

/**
 * The markers left after a raced grant has LANDED (the caller waits for that
 * first): polled until none is left or the bound runs out, then returned as
 * they stand. A grant released at once leaves none within a few polls; a
 * leaked one stays to the bound. A fixed 50 ms wait went red once on a loaded
 * macOS runner (2026-10-23), and polling before the grant has landed sees no
 * marker at all, leak or not.
 */
const markersAfterRelease = async (file: string, vfs: SQLiteVFS) => {
  const deadline = Date.now() + scaled(5_000);
  for (;;) {
    const markers = await markersFor(file, vfs);
    if (markers.length === 0 || Date.now() >= deadline) return markers;
    await sleep(10);
  }
};

describe('the client liveness marker', () => {
  it('is held while the client lives and gone after close', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const pair = TEST_TARGET;
    const file = 'marker-life.db';
    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
      name: 'ledger',
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: pair.vfs }).catch(() => {});
    });

    await db.all('SELECT 1');
    const during = await markersFor(file, pair.vfs);
    expect(during).toHaveLength(1);
    expect(during[0]?.name).toBe('ledger 1');
    expect(during[0]?.vfs).toBe(pair.vfs);

    await db.close();
    expect(await markersFor(file, pair.vfs)).toHaveLength(0);
  });

  it('gives one marker per client in the same tab', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();

    await Promise.all([a.all('SELECT 1'), b.all('SELECT 1')]);
    const markers = await markersFor(shared.name, TEST_TARGET.vfs);
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((m) => m?.id)).size).toBe(2);
  });

  it('holds no marker where nothing is shared', {
    tags: ['excludes:shared-storage'],
  }, async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.all('SELECT 1');
    const { held } = await locks.entries();
    expect(held.some((e) => e.name.startsWith('bsq:client:'))).toBe(false);
  });

  it('releases the marker when close() races the acquisition', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const pair = TEST_TARGET;
    const file = 'marker-race.db';
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: pair.vfs }).catch(() => {});
    });

    // Wrap navigator.locks.request to defer bsq:client: grants until signaled.
    // This makes the race deterministic: close() runs and calls
    // markerRelease?.() while the grant is still pending. Without the
    // markerClosed flag, the grant lands afterwards and is never released —
    // a phantom marker that persists for the realm's lifetime.
    const originalRequest = (
      navigator.locks.request as (...args: unknown[]) => unknown
    ).bind(navigator.locks);
    let triggerGrant: () => void = () => {};
    let granted = false;
    const grantDeferred = new Promise<void>((resolve) => {
      triggerGrant = resolve;
    });
    (navigator.locks as unknown as Record<string, unknown>).request = (
      name: string,
      ...args: unknown[]
    ) => {
      if (name.startsWith('bsq:client:')) {
        // The callback flags the grant: the marker is only there to be
        // released once it has landed.
        const callback = args.at(-1) as (lock: unknown) => unknown;
        return grantDeferred.then(() =>
          originalRequest(name, ...args.slice(0, -1), (lock: unknown) => {
            granted = true;
            return callback(lock);
          }),
        );
      }
      return originalRequest(name, ...args);
    };
    onTestFinished(() => {
      (navigator.locks as unknown as Record<string, unknown>).request =
        originalRequest;
    });

    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
    });
    // No query — close() runs before the marker grant can land.
    await db.close();

    // Release the deferred grant now. Without markerClosed, the .then() fires
    // and sets markerRelease = release, but nobody ever calls release().
    triggerGrant();
    await waitUntil(() => granted, 'the marker grant to land');

    // Without the fix: marker is leaked. With the fix: self-released.
    expect(await markersAfterRelease(file, pair.vfs)).toHaveLength(0);
  });

  // Falsifiable: drop the marker release from failClient (src/client.ts) — a
  // client that failed stays in the roster until the application closes it.
  it('is gone once the client fails, before close', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const pair = TEST_TARGET;
    const file = 'marker-failed.db';
    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: pair.vfs }).catch(() => {});
    });

    await expect(db.ready).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    expect(await markersFor(file, pair.vfs)).toHaveLength(0);
  });

  // Falsifiable: in failClient, release the marker without setting
  // `markerClosed` — a grant landing after the failure is then kept.
  it('releases the marker when the failure races the acquisition', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const pair = TEST_TARGET;
    const file = 'marker-failed-race.db';
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: pair.vfs }).catch(() => {});
    });

    // Defers bsq:client: grants until signaled, as the close() race above.
    const originalRequest = (
      navigator.locks.request as (...args: unknown[]) => unknown
    ).bind(navigator.locks);
    let triggerGrant: () => void = () => {};
    let granted = false;
    const grantDeferred = new Promise<void>((resolve) => {
      triggerGrant = resolve;
    });
    (navigator.locks as unknown as Record<string, unknown>).request = (
      name: string,
      ...args: unknown[]
    ) => {
      if (name.startsWith('bsq:client:')) {
        // The callback flags the grant: the marker is only there to be
        // released once it has landed.
        const callback = args.at(-1) as (lock: unknown) => unknown;
        return grantDeferred.then(() =>
          originalRequest(name, ...args.slice(0, -1), (lock: unknown) => {
            granted = true;
            return callback(lock);
          }),
        );
      }
      return originalRequest(name, ...args);
    };
    onTestFinished(() => {
      (navigator.locks as unknown as Record<string, unknown>).request =
        originalRequest;
    });

    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
    });
    await expect(db.ready).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    triggerGrant();
    await waitUntil(() => granted, 'the marker grant to land');

    expect(await markersAfterRelease(file, pair.vfs)).toHaveLength(0);
  });

  it('does not change what deleteDatabase reports', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const pair = TEST_TARGET;
    const file = 'marker-delete.db';
    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
    });
    await db.all('SELECT 1');

    await expect(deleteDatabase(file, { vfs: pair.vfs })).rejects.toMatchObject(
      {
        code: 'DATABASE_IN_USE',
      },
    );

    await db.close();
    await deleteDatabase(file, { vfs: pair.vfs });

    await expect(deleteDatabase(file, { vfs: pair.vfs })).rejects.toMatchObject(
      {
        code: 'DATABASE_NOT_FOUND',
      },
    );
  });
});
