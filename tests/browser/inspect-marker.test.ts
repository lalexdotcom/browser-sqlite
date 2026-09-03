import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { createLocks, parseClientMarker } from '../../src/locks';

const VFS = 'IDBBatchAtomicVFS' as const;
const locks = createLocks();

const markersFor = async (file: string) => {
  const { held } = await locks.entries();
  return held
    .map((entry) => parseClientMarker(entry.name, VFS, file))
    .filter(
      (m): m is NonNullable<ReturnType<typeof parseClientMarker>> =>
        m !== undefined,
    );
};

describe('the client liveness marker', () => {
  it('is held while the client lives and gone after close', async () => {
    const file = 'marker-life.db';
    const db = createSQLiteClient(file, { vfs: VFS, name: 'ledger' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    await db.read('SELECT 1');
    const during = await markersFor(file);
    expect(during).toHaveLength(1);
    expect(during[0]?.name).toBe('ledger 1');
    expect(during[0]?.vfs).toBe(VFS);

    await db.close();
    expect(await markersFor(file)).toHaveLength(0);
  });

  it('gives one marker per client in the same tab', async () => {
    const file = 'marker-two.db';
    const a = createSQLiteClient(file, { vfs: VFS });
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);
    const markers = await markersFor(file);
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
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    // Close immediately — no query, so the marker grant may not have landed
    // in `markerRelease` yet when `close()` runs.
    const db = createSQLiteClient(file, { vfs: VFS });
    await db.close();

    // The grant that lands after close() must self-release, not leak.
    expect(await markersFor(file)).toHaveLength(0);
  });

  it('does not change what deleteDatabase reports', async () => {
    const file = 'marker-delete.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    await db.read('SELECT 1');

    await expect(deleteDatabase(file, { vfs: VFS })).rejects.toMatchObject({
      code: 'DATABASE_IN_USE',
    });

    await db.close();
    await deleteDatabase(file, { vfs: VFS });

    await expect(deleteDatabase(file, { vfs: VFS })).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
    });
  });
});
