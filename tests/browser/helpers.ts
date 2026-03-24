import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

/**
 * Crée un client SQLite avec un nom de base unique (UUID) et enregistre
 * un nettoyage OPFS automatique via afterEach.
 *
 * Décisions : D-06 (nom unique), D-07 (afterEach cleanup), D-08 (helper partagé)
 * VFS : OPFSPermutedVFS par défaut (D-05) — ne pas passer d'option `vfs`
 */
export async function createTestClient() {
  const dbName = `web-sqlite-test-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // L'entrée OPFS peut ne pas exister si le test a échoué avant la création de la DB
    }
  });

  // createSQLiteClient est synchrone — workers s'initialisent en arrière-plan.
  // La première requête queue jusqu'à ce qu'un worker soit READY.
  return createSQLiteClient(dbName);
}
