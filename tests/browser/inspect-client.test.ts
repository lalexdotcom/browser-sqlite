import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createTestClient, sharedDatabase, TEST_TARGET } from './helpers';

describe('db identity getters', () => {
  it('describes itself without the debug option', async () => {
    const db = createSQLiteClient('./ident.db', {
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      name: 'ledger',
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase('ident.db', { vfs: TEST_TARGET.vfs }).catch(
        () => {},
      );
    });
    expect(db.debug).toBeUndefined();
    expect(db.name).toMatch(/^ledger \d+$/);
    expect(db.file).toBe('ident.db');
    expect(db.vfs).toBe(TEST_TARGET.vfs);
    expect(db.build).toBe(TEST_TARGET.build);
    expect(db.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('db.inspect on a memory VFS', () => {
  // One VFS: the subject is MemoryVFS's own semantics — two clients on it are
  // two independent, unrelated databases, so inspect() cannot see a sibling.
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
  it('splits self from siblings', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();
    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);

    const view = await a.inspect();
    expect(view.self?.id).toBe(a.id);
    expect(view.siblings).toHaveLength(1);
    expect(view.siblings[0]?.id).toBe(b.id);
    expect(view.tabs).toBe(1);
    expect('clients' in view).toBe(false);
  });
});

/**
 * inspect() on the pair this project injects. The roster above needs two
 * clients on one database and is pinned for it; a lone client needs nothing of
 * the VFS, so these run wherever the target points — which is how inspect()
 * reaches the eight VFS the pinned tests never visit.
 */
describe('db.inspect on the target', () => {
  it('describes a lone client', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const db = await createTestClient();
    onTestFinished(() => db.close().catch(() => {}));
    await db.read('SELECT 1');
    const view = await db.inspect();
    expect(view.self?.id).toBe(db.id);
    expect(view.siblings).toHaveLength(0);
    expect(view.tabs).toBe(1);
  });

  // A memory VFS keeps its database inside its own client: there is no realm
  // to inspect, and inspect() says so rather than inventing one.
  it('refuses to describe a lone client of a memory VFS', {
    tags: ['excludes:shared-storage'],
  }, async () => {
    const db = await createTestClient();
    onTestFinished(() => db.close().catch(() => {}));
    await db.read('SELECT 1');
    await expect(db.inspect()).rejects.toMatchObject({
      code: 'INVALID_OPTION',
    });
  });

  it('throws CLIENT_CLOSED after close', async () => {
    const db = await createTestClient();
    await db.read('SELECT 1');
    await db.close();

    await expect(db.inspect()).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });
});
