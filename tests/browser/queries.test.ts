import { describe, it, expect } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * INT-03 : db.read() exécute un SELECT et retourne des lignes typées
 */
describe('db.read() (INT-03)', () => {
  it('retourne un tableau de lignes pour un SELECT simple', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await db.write("INSERT INTO items VALUES (1, 'alpha'), (2, 'beta')");

    const rows = await db.read<{ id: number; name: string }>('SELECT * FROM items ORDER BY id');

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[0].name).toBe('alpha');
    expect(rows[1].id).toBe(2);
    expect(rows[1].name).toBe('beta');

    db.close();
  });

  it('retourne un tableau vide pour SELECT sans résultats', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE empty_table (id INTEGER)');
    const rows = await db.read('SELECT * FROM empty_table');

    expect(rows).toHaveLength(0);
    expect(Array.isArray(rows)).toBe(true);

    db.close();
  });

  it('supporte les paramètres positionnels', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE params_test (val INTEGER)');
    await db.write('INSERT INTO params_test VALUES (10), (20), (30)');

    const rows = await db.read<{ val: number }>('SELECT val FROM params_test WHERE val > ?', [15]);

    expect(rows).toHaveLength(2);
    expect(rows[0].val).toBe(20);
    expect(rows[1].val).toBe(30);

    db.close();
  });
});

/**
 * INT-04 : db.write() exécute INSERT/UPDATE/DELETE et retourne { result, affected }
 */
describe('db.write() (INT-04)', () => {
  it('INSERT retourne affected > 0', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE write_test (id INTEGER PRIMARY KEY, val TEXT)');
    const result = await db.write("INSERT INTO write_test VALUES (1, 'foo'), (2, 'bar')");

    expect(result.affected).toBe(2);
    expect(Array.isArray(result.result)).toBe(true);

    db.close();
  });

  it('UPDATE retourne le nombre de lignes modifiées', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE update_test (id INTEGER, status TEXT)');
    await db.write("INSERT INTO update_test VALUES (1, 'old'), (2, 'old'), (3, 'new')");
    const result = await db.write("UPDATE update_test SET status = 'updated' WHERE status = 'old'");

    expect(result.affected).toBe(2);

    db.close();
  });

  it('DELETE retourne le nombre de lignes supprimées', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE delete_test (id INTEGER)');
    await db.write('INSERT INTO delete_test VALUES (1), (2), (3), (4)');
    const result = await db.write('DELETE FROM delete_test WHERE id <= 2');

    expect(result.affected).toBe(2);

    // Vérifier que les lignes restantes sont correctes
    const remaining = await db.read<{ id: number }>('SELECT id FROM delete_test ORDER BY id');
    expect(remaining).toHaveLength(2);
    expect(remaining[0].id).toBe(3);

    db.close();
  });
});

/**
 * INT-05 : db.stream() yield des lignes en chunks respectant chunkSize
 */
describe('db.stream() (INT-05)', () => {
  it('yield des chunks dont la taille ne dépasse pas chunkSize', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE stream_test (n INTEGER)');
    // Insérer 50 lignes via des INSERTs en batch
    const values = Array.from({ length: 50 }, (_, i) => `(${i + 1})`).join(',');
    await db.write(`INSERT INTO stream_test VALUES ${values}`);

    const chunkSize = 10;
    const chunks: number[][] = [];

    for await (const chunk of db.stream<{ n: number }>('SELECT n FROM stream_test ORDER BY n', [], { chunkSize })) {
      chunks.push(chunk.map(r => r.n));
      expect(chunk.length).toBeLessThanOrEqual(chunkSize);
    }

    // Toutes les lignes doivent être présentes
    const allRows = chunks.flat();
    expect(allRows).toHaveLength(50);
    expect(allRows[0]).toBe(1);
    expect(allRows[49]).toBe(50);

    db.close();
  });

  it('yield au moins un chunk pour un résultat non vide', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE stream_one (x INTEGER)');
    await db.write('INSERT INTO stream_one VALUES (42)');

    let chunkCount = 0;
    for await (const chunk of db.stream<{ x: number }>('SELECT x FROM stream_one', [], { chunkSize: 100 })) {
      chunkCount++;
      expect(chunk[0].x).toBe(42);
    }

    expect(chunkCount).toBeGreaterThan(0);

    db.close();
  });
});

/**
 * INT-06 : db.one() retourne une seule ligne ou undefined
 */
describe('db.one() (INT-06)', () => {
  it('retourne la première ligne quand un résultat existe', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE one_test (id INTEGER, label TEXT)');
    await db.write("INSERT INTO one_test VALUES (1, 'premier'), (2, 'second')");

    const row = await db.one<{ id: number; label: string }>('SELECT * FROM one_test ORDER BY id LIMIT 1');

    expect(row).toBeDefined();
    expect(row!.id).toBe(1);
    expect(row!.label).toBe('premier');

    db.close();
  });

  it('retourne undefined quand aucun résultat', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE one_empty (id INTEGER)');
    const row = await db.one('SELECT * FROM one_empty WHERE id = 999');

    expect(row).toBeUndefined();

    db.close();
  });

  it('ne retourne que la première ligne même si plusieurs existent', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE one_multi (val INTEGER)');
    await db.write('INSERT INTO one_multi VALUES (100), (200), (300)');

    const row = await db.one<{ val: number }>('SELECT val FROM one_multi ORDER BY val');

    expect(row).toBeDefined();
    expect(row!.val).toBe(100);

    db.close();
  });
});
