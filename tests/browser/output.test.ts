import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * Characterization tests for `db.output()` — the schema-driven
 * drop / create / populate / index ETL helper.
 *
 * Note: `output()` runs DROP, CREATE, the inserts and the CREATE INDEX
 * statements as separate un-transacted writes (B5). These tests cover the
 * happy paths and the schema DDL it generates; the crash-between-DROP-and-
 * CREATE window is not reproducible from the public API and is left to the
 * wave 3 fix.
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
    const db = await createTestClient();

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

  it('creates a TEMPORARY table when temp is set', async () => {
    // poolSize 1 — a TEMP table lives on a single connection, so reads must
    // land on the same worker that created it.
    const db = await createTestClient({ poolSize: 1 });

    const out = db.output('out_temp', { id: 'INTEGER' }, { temp: true });
    out.enqueue({ id: 1 });
    await out.close();

    const rows = await db.read<{ id: number }>('SELECT id FROM out_temp');
    expect(rows).toHaveLength(1);

    const persisted = await db.read(
      "SELECT name FROM sqlite_master WHERE name = 'out_temp'",
    );
    expect(persisted).toHaveLength(0);

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
