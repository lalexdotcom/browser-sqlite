import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * INT-02 : createSQLiteClient initialise et les workers atteignent READY
 *
 * Stratégie : createSQLiteClient est synchrone mais les workers s'initialisent
 * de façon asynchrone. La première requête (`db.read('SELECT 1')`) est mise en
 * queue jusqu'à ce qu'un worker soit READY — si ça échoue, le pool n'est pas initialisé.
 * Aucun changement au code source requis (pas de propriété `ready` exposée).
 */
describe('createSQLiteClient (INT-02)', () => {
  it('initialise le pool workers et répond à une requête simple', async () => {
    const db = await createTestClient();

    // Si les workers ne sont pas READY, cette requête va rejeter ou timeout (30s)
    const rows = await db.read<{ value: number }>('SELECT 1 AS value');

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);

    db.close();
  });

  it('supporte poolSize: 1 (minimum)', async () => {
    // createTestClient utilise le défaut poolSize: 2
    // Vérifier qu'avec un pool minimal le client fonctionne
    const { createSQLiteClient } = await import('../../src/client');
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;

    const cleanup = async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* ok */
      }
    };

    // afterEach n'est pas disponible ici directement — nettoyer manuellement
    try {
      const db = createSQLiteClient(dbName, { poolSize: 1 });
      const rows = await db.read<{ n: number }>('SELECT 42 AS n');
      expect(rows[0].n).toBe(42);
      db.close();
    } finally {
      await cleanup();
    }
  });

  it('retourne le même résultat sur plusieurs appels consécutifs', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE init_test (id INTEGER PRIMARY KEY)');
    await db.write('INSERT INTO init_test VALUES (1)');
    await db.write('INSERT INTO init_test VALUES (2)');

    const rows = await db.read<{ id: number }>(
      'SELECT id FROM init_test ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);

    db.close();
  });
});
