import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

const VFS = 'IDBBatchAtomicVFS' as const;

describe('db identity getters', () => {
  it('describes itself without the debug option', async () => {
    const db = createSQLiteClient('./ident.db', { vfs: VFS, name: 'ledger' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase('ident.db', { vfs: VFS }).catch(() => {});
    });
    expect(db.debug).toBeUndefined();
    expect(db.name).toMatch(/^ledger \d+$/);
    expect(db.file).toBe('ident.db');
    expect(db.vfs).toBe(VFS);
    expect(db.build).toBe('async');
    expect(db.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('db.inspect on a memory VFS', () => {
  it('throws INVALID_OPTION — two memory clients are two databases', async () => {
    const db = createSQLiteClient('mem.db', { vfs: 'MemoryVFS', poolSize: 1 });
    onTestFinished(async () => {
      await db.close().catch(() => {});
    });
    await db.read('SELECT 1');
    await expect(db.inspect()).rejects.toMatchObject({
      code: 'INVALID_OPTION',
    });
  });
});

describe('db.inspect', () => {
  it('splits self from siblings', async () => {
    const file = 'siblings.db';
    const a = createSQLiteClient(file, { vfs: VFS });
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });
    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);

    const view = await a.inspect();
    expect(view.self?.id).toBe(a.id);
    expect(view.siblings).toHaveLength(1);
    expect(view.siblings[0]?.id).toBe(b.id);
    expect(view.tabs).toBe(1);
    expect('clients' in view).toBe(false);
  });

  it('throws CLIENT_CLOSED after close', async () => {
    const file = 'closed.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    await db.read('SELECT 1');
    await db.close();
    onTestFinished(() => deleteDatabase(file, { vfs: VFS }).catch(() => {}));
    await expect(db.inspect()).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });
});
