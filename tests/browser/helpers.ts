import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

/**
 * Creates a SQLite client with a unique database name (UUID) and registers
 * automatic OPFS cleanup via afterEach.
 *
 * Decisions: D-06 (unique name), D-07 (afterEach cleanup), D-08 (shared helper)
 * VFS: OPFSPermutedVFS by default (D-05) — do not pass a `vfs` option
 */
export async function createTestClient() {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // OPFS entry may not exist if the test failed before DB creation
    }
  });

  // createSQLiteClient is synchronous — workers initialize in the background.
  // The first query queues until a worker reaches READY.
  return createSQLiteClient(dbName);
}
