import { afterEach, describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { createTestClient } from './helpers';

/**
 * The per-VFS PRAGMA defaults, end to end: what `VFS_CAPABILITIES` declares is
 * what the worker actually runs, and the consumer can still refuse it.
 *
 * `AccessHandlePoolVFS` is the only VFS that declares any, so it carries these
 * tests. It allows one connection per origin, so every client here is closed
 * before the next opens, and its directory — one for the whole origin, holding
 * files with random names — is scrubbed between tests.
 */

const scrubVfsDirectory = async () => {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('AccessHandlePoolVFS', { recursive: true });
  } catch {
    // Absent until the first test creates it.
  }
};

/** The mode SQLite reports, which is the only proof the pragma was applied. */
const modesOf = async (pragmas?: Record<string, string>) => {
  const db = createSQLiteClient(`default-pragmas-${crypto.randomUUID()}`, {
    vfs: 'AccessHandlePoolVFS',
    poolSize: 1,
    ...(pragmas ? { pragmas } : {}),
  });
  await db.write('CREATE TABLE t (a INTEGER)');
  const [journal] = await db.read<{ journal_mode: string }>(
    'PRAGMA journal_mode',
  );
  const [locking] = await db.read<{ locking_mode: string }>(
    'PRAGMA locking_mode',
  );
  await db.close();
  return { journal: journal?.journal_mode, locking: locking?.locking_mode };
};

describe('per-VFS default pragmas', () => {
  afterEach(scrubVfsDirectory);

  it('applies what the VFS declares, with no consumer pragmas', async () => {
    // Falsifiability: empty AccessHandlePoolVFS's `defaultPragmas` in types.ts
    // and this is 'delete' / 'normal' — SQLite's own defaults.
    expect(await modesOf()).toEqual({
      journal: 'wal',
      locking: 'exclusive',
    });
  });

  it('keeps them when the consumer sets an unrelated pragma', async () => {
    // The merge, live. `foreign_keys` is the pragma consumers actually pass and
    // it says nothing about journalling, so it must not cost them the defaults.
    // Falsifiability: make `resolvePragmas` return the consumer's set when it
    // is non-empty and this is 'delete' / 'normal'.
    expect(await modesOf({ foreign_keys: 'ON' })).toEqual({
      journal: 'wal',
      locking: 'exclusive',
    });
  });

  it('lets the consumer refuse a default by naming its key', async () => {
    // Falsifiability: spread the defaults after the consumer's in
    // `resolvePragmas` and this is 'wal' — the consumer could not opt out.
    const modes = await modesOf({ journal_mode: 'delete' });
    expect(modes.journal).toBe('delete');
    // The one they did NOT name is still applied.
    expect(modes.locking).toBe('exclusive');
  });

  it('applies nothing on a VFS that declares no defaults', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a INTEGER)');
    const [locking] = await db.read<{ locking_mode: string }>(
      'PRAGMA locking_mode',
    );
    // `locking_mode` rather than `journal_mode`: SQLite's default journal mode
    // is already 'delete', so it could not tell "nothing applied" from "delete
    // applied". Falsifiability: declare AccessHandlePoolVFS's defaults on every
    // VFS and this is 'exclusive'.
    expect(locking?.locking_mode).toBe('normal');
    await db.close();
  });
});
