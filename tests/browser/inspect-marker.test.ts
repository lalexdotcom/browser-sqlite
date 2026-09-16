import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { createLocks, parseClientMarker } from '../../src/locks';
import type { SQLiteVFS } from '../../src/types';
import { TEST_TARGET } from './helpers';

// One VFS: two clients must share one database (the marker roster);
// OPFSAdaptiveVFS shares it on every engine (see `secondClientOutcome`).
const SHARED_FILE_VFS = 'OPFSAdaptiveVFS' as const;
const locks = createLocks();

const markersFor = async (file: string, vfs: SQLiteVFS = TEST_TARGET.vfs) => {
  const { held } = await locks.entries();
  return held
    .map((entry) => parseClientMarker(entry.name, vfs, file))
    .filter(
      (m): m is NonNullable<ReturnType<typeof parseClientMarker>> =>
        m !== undefined,
    );
};

describe('the client liveness marker', () => {
  it('is held while the client lives and gone after close', async () => {
    const file = 'marker-life.db';
    const db = createSQLiteClient(file, {
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      name: 'ledger',
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: TEST_TARGET.vfs }).catch(() => {});
    });

    await db.read('SELECT 1');
    const during = await markersFor(file);
    expect(during).toHaveLength(1);
    expect(during[0]?.name).toBe('ledger 1');
    expect(during[0]?.vfs).toBe(TEST_TARGET.vfs);

    await db.close();
    expect(await markersFor(file)).toHaveLength(0);
  });

  it('gives one marker per client in the same tab', async () => {
    const file = 'marker-two.db';
    const a = createSQLiteClient(file, { vfs: SHARED_FILE_VFS });
    const b = createSQLiteClient(file, { vfs: SHARED_FILE_VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: SHARED_FILE_VFS }).catch(() => {});
    });

    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);
    const markers = await markersFor(file, SHARED_FILE_VFS);
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((m) => m?.id)).size).toBe(2);
  });

  it('holds no marker on the memory VFS', async () => {
    const db = createSQLiteClient('marker-mem.db', {
      vfs: 'MemoryVFS',
      poolSize: 1,
    });
    onTestFinished(() => db.close());
    await db.read('SELECT 1');
    const { held } = await locks.entries();
    expect(held.some((e) => e.name.startsWith('bsq:client:'))).toBe(false);
  });

  it('releases the marker when close() races the acquisition', async () => {
    const file = 'marker-race.db';
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: TEST_TARGET.vfs }).catch(() => {});
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
    const grantDeferred = new Promise<void>((resolve) => {
      triggerGrant = resolve;
    });
    (navigator.locks as unknown as Record<string, unknown>).request = (
      name: string,
      ...args: unknown[]
    ) => {
      if (name.startsWith('bsq:client:')) {
        return grantDeferred.then(() => originalRequest(name, ...args));
      }
      return originalRequest(name, ...args);
    };
    onTestFinished(() => {
      (navigator.locks as unknown as Record<string, unknown>).request =
        originalRequest;
    });

    const db = createSQLiteClient(file, {
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
    });
    // No query — close() runs before the marker grant can land.
    await db.close();

    // Release the deferred grant now. Without markerClosed, the .then() fires
    // and sets markerRelease = release, but nobody ever calls release().
    triggerGrant();
    // Yield a turn for the grant to process and (with the fix) self-release.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Without the fix: marker is leaked. With the fix: self-released.
    expect(await markersFor(file)).toHaveLength(0);
  });

  it('does not change what deleteDatabase reports', async () => {
    const file = 'marker-delete.db';
    const db = createSQLiteClient(file, {
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
    });
    await db.read('SELECT 1');

    await expect(
      deleteDatabase(file, { vfs: TEST_TARGET.vfs }),
    ).rejects.toMatchObject({
      code: 'DATABASE_IN_USE',
    });

    await db.close();
    await deleteDatabase(file, { vfs: TEST_TARGET.vfs });

    await expect(
      deleteDatabase(file, { vfs: TEST_TARGET.vfs }),
    ).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
    });
  });
});
