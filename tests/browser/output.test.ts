import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { createTestClient } from './helpers';

/**
 * Characterization tests for `db.output()` — the schema-driven staging-table
 * load, atomic rename, and optional index construction.
 *
 * Wave-3 B5 fix (Task 8): `output()` loads rows into a `__bsq_staging_<uuid>`
 * table and swaps it in atomically via RENAME inside a single transaction at
 * close(). The previous table stays intact until the swap succeeds. Tests below
 * cover both the happy-path schema DDL and the atomicity / failure-isolation
 * guarantees.
 */
describe('output() create and populate', () => {
  it('creates the table from the schema and inserts the rows', async () => {
    const db = await createTestClient();

    const out = db.output('out_basic', { id: 'INTEGER', name: 'TEXT' });
    out.enqueue({ id: 1, name: 'alpha' });
    out.enqueue({ id: 2, name: 'beta' });
    const affected = await out.close();

    expect(affected).toBe(2);

    const rows = await db.read<{ id: number; name: string }>(
      'SELECT * FROM out_basic ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('alpha');
    expect(rows[1].name).toBe('beta');

    db.close();
  });

  it('drops and replaces a pre-existing table with a different schema', async () => {
    // poolSize: 1 pins writes and the subsequent read to the same worker,
    // guaranteeing read-your-own-writes. The scheduler no longer routes reads
    // to the designated writer by preference; wave 4's propagation barrier is
    // what will make the multi-worker case reliable.
    const db = await createTestClient({ poolSize: 1 });

    await db.write('CREATE TABLE out_replace (old_col TEXT)');
    await db.write("INSERT INTO out_replace VALUES ('stale')");

    const out = db.output('out_replace', { n: 'INTEGER' });
    out.enqueue({ n: 42 });
    await out.close();

    const rows = await db.read<{ n: number }>('SELECT * FROM out_replace');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(42);
    expect('old_col' in rows[0]).toBe(false);

    db.close();
  });

  it('resolves with 0 and still creates the table when nothing is enqueued', async () => {
    const db = await createTestClient();

    const out = db.output('out_empty', { id: 'INTEGER' });
    const affected = await out.close();

    expect(affected).toBe(0);

    const rows = await db.read('SELECT id FROM out_empty');
    expect(rows).toHaveLength(0);

    db.close();
  });
});

describe('output() schema modifiers', () => {
  it('emits NOT NULL and UNIQUE from required/unique', async () => {
    const db = await createTestClient();

    const out = db.output('out_modifiers', {
      id: 'INTEGER',
      code: { type: 'TEXT', required: true, unique: true },
    });
    out.enqueue({ id: 1, code: 'A' });
    await out.close();

    const ddl = await db.first<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ['out_modifiers'],
    );
    expect(ddl?.sql).toContain('NOT NULL');
    expect(ddl?.sql).toContain('UNIQUE');

    await expect(
      db.write("INSERT INTO out_modifiers (id, code) VALUES (2, 'A')"),
    ).rejects.toThrow();

    db.close();
  });

  it('excludes generated columns from the insert and lets SQLite compute them', async () => {
    const db = await createTestClient();

    const out = db.output('out_generated', {
      base: 'INTEGER',
      doubled: { type: 'INTEGER', generated: '(base * 2)' },
    });
    out.enqueue({ base: 21 });
    const affected = await out.close();

    expect(affected).toBe(1);

    const row = await db.first<{ base: number; doubled: number }>(
      'SELECT base, doubled FROM out_generated',
    );
    expect(row?.base).toBe(21);
    expect(row?.doubled).toBe(42);

    db.close();
  });
});

describe('output() indexes', () => {
  it('creates a single-column index named <table>_<col>_IDX', async () => {
    const db = await createTestClient();

    const out = db.output(
      'out_idx',
      { id: 'INTEGER', name: 'TEXT' },
      { indexes: ['name'] },
    );
    out.enqueue({ id: 1, name: 'x' });
    await out.close();

    const indexes = await db.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      ['out_idx'],
    );
    expect(indexes.map((i) => i.name)).toContain('out_idx_name_IDX');

    db.close();
  });

  it('creates a multi-column unique index named <table>_<cols>_U', async () => {
    const db = await createTestClient();

    const out = db.output(
      'out_idx_u',
      { a: 'INTEGER', b: 'INTEGER' },
      { indexes: [{ columns: ['a', 'b'], unique: true }] },
    );
    out.enqueue({ a: 1, b: 1 });
    out.enqueue({ a: 1, b: 2 });
    await out.close();

    const indexes = await db.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      ['out_idx_u'],
    );
    expect(indexes.map((i) => i.name)).toContain('out_idx_u_a_b_U');

    await expect(
      db.write('INSERT INTO out_idx_u VALUES (1, 1)'),
    ).rejects.toThrow();

    db.close();
  });
});

describe('output() atomicity and sweep', () => {
  // Falsifiability pin: deleting `await tx.write('ALTER TABLE ... RENAME TO
  // ...')` from output.close() makes `created` empty → test fails.
  it('does not create the target until close()', async () => {
    const db = await createTestClient();

    try {
      const out = db.output('late_target', { id: 'INTEGER' });
      out.enqueue({ id: 1 });

      // The staging table (__bsq_staging_<uuid>) may be created by now, but
      // the final target must not exist until the atomic RENAME in close().
      const existing = await db.read(
        "SELECT name FROM sqlite_master WHERE name = 'late_target'",
      );
      expect(existing).toHaveLength(0);

      await out.close();

      const created = await db.read(
        "SELECT name FROM sqlite_master WHERE name = 'late_target'",
      );
      expect(created).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  // Falsifiability pin: deleting `await tx.write('ALTER TABLE ... RENAME TO
  // ...')` from output.close() makes `after` keep the old rows → test fails.
  it('leaves the previous table intact and complete until close()', async () => {
    const db = await createTestClient();

    try {
      const first = db.output('swap_target', { id: 'INTEGER' });
      first.enqueue({ id: 1 });
      first.enqueue({ id: 2 });
      await first.close();

      const second = db.output('swap_target', { id: 'INTEGER' });
      second.enqueue({ id: 99 });

      // Mid-load: the OLD rows are still there, whole — DROP happens only inside
      // the atomic transaction in close(), not eagerly at output() call time.
      const during = await db.read<{ id: number }>(
        'SELECT id FROM swap_target ORDER BY id',
      );
      expect(during.map((r) => r.id)).toEqual([1, 2]);

      await second.close();

      const after = await db.read<{ id: number }>('SELECT id FROM swap_target');
      expect(after.map((r) => r.id)).toEqual([99]);
    } finally {
      await db.close();
    }
  });

  // Falsifiability pin: deleting `await dropStaging()` from the first catch
  // block in output.close() leaves the staging table behind → test fails.
  it('leaves the target untouched and no staging table behind when the load fails', async () => {
    const db = await createTestClient();

    try {
      await db.write('CREATE TABLE keep_me (id INTEGER PRIMARY KEY)');
      await db.write('INSERT INTO keep_me (id) VALUES (1), (2)');

      const out = db.output('keep_me', { id: 'INTEGER PRIMARY KEY' as string });
      out.enqueue({ id: 7 });
      out.enqueue({ id: 7 }); // duplicate primary key → the batch fails

      await expect(out.close()).rejects.toMatchObject({
        code: 'BULK_WRITE_FAILED',
      });

      // The original table must be untouched — the DROP only happens inside the
      // atomic transaction which never ran because the load failed first.
      const rows = await db.read<{ id: number }>(
        'SELECT id FROM keep_me ORDER BY id',
      );
      expect(rows.map((r) => r.id)).toEqual([1, 2]);

      // The failed staging table must be cleaned up by the error path.
      const staging = await db.read(
        "SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'",
      );
      expect(staging).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  // Falsifiability pin: removing `swept ??= locks.withLock(sweepLockName ...)`
  // from sweepOnce() makes it a no-op → orphan persists → test fails.
  it('collects an orphan staging table at the first output()', async () => {
    const db = await createTestClient();

    try {
      // An orphan exactly as a crashed tab would leave: no lock is held for it.
      await db.write('CREATE TABLE __bsq_staging_deadbeef (id INTEGER)');

      const out = db.output('sweep_target', { id: 'INTEGER' });
      out.enqueue({ id: 1 });
      await out.close();

      // Both the orphan and the output's own staging table must be gone: the
      // orphan was swept, and the output's staging was renamed to sweep_target.
      const staging = await db.read<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'",
      );
      expect(staging).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  // Falsifiability pin: deleting the `if (closed) throw` guard in bulkWrite's
  // close() lets the second call re-enter the transaction; the error it then
  // throws does NOT contain "closed" → the message assertion turns red.
  // The rows assertion pins the transaction's rollback: without it the DROP is
  // not undone and the table is gone (createTransaction.ts rollback block).
  it('second close() throws with a "closed" message and leaves the target untouched', async () => {
    const db = await createTestClient();

    try {
      const out = db.output('double_close_target', { id: 'INTEGER' });
      out.enqueue({ id: 1 });
      out.enqueue({ id: 2 });
      await out.close(); // first close: succeeds

      // Second close() must throw. After the closed-flag fix it throws before
      // the transaction is entered, so the error message says "closed".
      const error = await out.close().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/closed/i);

      // The target table must survive with its rows intact.
      const rows = await db.read<{ id: number }>(
        'SELECT id FROM double_close_target ORDER BY id',
      );
      expect(rows.map((r) => r.id)).toEqual([1, 2]);
    } finally {
      await db.close();
    }
  });

  // Falsifiability pin: removing the `staleStagingTables` filter in sweepOnce()
  // (so every staging-like table is dropped) makes the sweep destroy A's live
  // staging table → outA.close() fails with "no such table".
  it('does not collect a staging table that is still in flight', async () => {
    // Two clients share the same OPFS file so their sweeps interact.
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    // poolSize: 1 removes an unrelated variable: cross-worker propagation lag
    // (OPFSPermutedVFS read-your-own-writes is not guaranteed across workers;
    // see the RYOW caveat on read/chunk/stream/first). With a single connection
    // per client every read sees the same page map as the preceding write.
    // This does NOT weaken the cross-client sweep property being tested: dbA
    // and dbB are still two separate connections holding two separate Web Locks
    // over the same OPFS file, so the sweep interaction is exercised exactly
    // as before.
    const dbA = createSQLiteClient(dbName, { poolSize: 1 });
    const dbB = createSQLiteClient(dbName, { poolSize: 1 });

    onTestFinished(async () => {
      try {
        await dbA.close();
      } catch {
        /* ignore */
      }
      try {
        await dbB.close();
      } catch {
        /* ignore */
      }
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* ignore */
      }
    });

    // Start A's output — the staging lock is acquired inside output() before
    // sweepOnce() runs, so A's lock is held from this point even before the
    // staging table exists in sqlite_master.
    const outA = dbA.output('target_a', { id: 'INTEGER' });
    outA.enqueue({ id: 1 });

    // Poll until A's staging table appears in sqlite_master. At that point A's
    // staging lock has been held since the output() call above.
    let stagingName: string | undefined;
    for (let i = 0; i < 100 && !stagingName; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      const rows = await dbA.read<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'",
      );
      if (rows.length) stagingName = rows[0].name;
    }
    expect(stagingName).toBeDefined();

    // B does its own output — its sweep runs and must leave A's live staging
    // table alone (A's staging lock is still held).
    const outB = dbB.output('target_b', { id: 'INTEGER' });
    outB.enqueue({ id: 2 });
    await outB.close();

    // A's staging table must still exist — B's sweep left it intact.
    const stillThere = await dbA.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'",
    );
    // B's staging was renamed to target_b; only A's staging should remain.
    expect(stillThere.some((r) => r.name === stagingName)).toBe(true);

    // A can still complete successfully with its staging table intact.
    await outA.close();

    const target = await dbA.read<{ id: number }>('SELECT id FROM target_a');
    expect(target).toHaveLength(1);
    expect(target[0].id).toBe(1);
  });
});
