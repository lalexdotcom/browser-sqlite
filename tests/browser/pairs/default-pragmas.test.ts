import { describe, expect, it, onTestFinished } from 'vitest';
import { createTestClient, TEST_TARGET } from '../helpers';

/**
 * The per-VFS PRAGMA defaults, end to end: what `VFS_CAPABILITIES` declares is
 * what the worker actually runs, and the consumer can still refuse it.
 *
 * Several VFS declare default pragmas; the first three tests are about
 * `AccessHandlePoolVFS`'s own (`journal_mode` and `locking_mode`), so they
 * carry its `vfs:` tag. It allows one connection per origin, so every client
 * here is closed before the next opens, and its directory — one for the whole
 * origin, holding files with random names — is scrubbed between tests.
 */

// The VFS's directory is named after the VFS, which the cell's pair names.
const scrubVfsDirectory = async () => {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(TEST_TARGET.vfs, { recursive: true });
  } catch {
    // Absent until the first test creates it.
  }
};

/** The mode SQLite reports, which is the only proof the pragma was applied. */
const modesOf = async (pragmas?: Record<string, string>) => {
  // The tests that call this carry `vfs:AccessHandlePoolVFS`: the subject is
  // its own `defaultPragmas` (journal_mode: wal, locking_mode: exclusive).
  // Registered before createTestClient's own cleanup: onTestFinished hooks run
  // in reverse, so the scrub comes after that cleanup has given the slot back.
  // Here and not in an afterEach, which would also scrub after the test that
  // runs on another VFS.
  onTestFinished(scrubVfsDirectory);
  const db = await createTestClient({
    poolSize: 1,
    ...(pragmas ? { pragmas } : {}),
  });
  await db.run('CREATE TABLE t (a INTEGER)');
  const [journal] = await db.all<{ journal_mode: string }>(
    'PRAGMA journal_mode',
  );
  const [locking] = await db.all<{ locking_mode: string }>(
    'PRAGMA locking_mode',
  );
  await db.close();
  return { journal: journal?.journal_mode, locking: locking?.locking_mode };
};

describe('per-VFS default pragmas', () => {
  it('applies what the VFS declares, with no consumer pragmas', {
    tags: ['vfs:AccessHandlePoolVFS'],
  }, async () => {
    // Falsifiability: empty AccessHandlePoolVFS's `defaultPragmas` in const/vfs.ts
    // and this is 'delete' / 'normal' — SQLite's own defaults.
    expect(await modesOf()).toEqual({
      journal: 'wal',
      locking: 'exclusive',
    });
  });

  it('keeps them when the consumer sets an unrelated pragma', {
    tags: ['vfs:AccessHandlePoolVFS'],
  }, async () => {
    // The merge, live. `foreign_keys` is the pragma consumers actually pass and
    // it says nothing about journalling, so it must not cost them the defaults.
    // Falsifiability: make `resolvePragmas` return the consumer's set when it
    // is non-empty and this is 'delete' / 'normal'.
    expect(await modesOf({ foreign_keys: 'ON' })).toEqual({
      journal: 'wal',
      locking: 'exclusive',
    });
  });

  it('lets the consumer refuse a default by naming its key', {
    tags: ['vfs:AccessHandlePoolVFS'],
  }, async () => {
    // Falsifiability: spread the defaults after the consumer's in
    // `resolvePragmas` and this is 'wal' — the consumer could not opt out.
    const modes = await modesOf({ journal_mode: 'delete' });
    expect(modes.journal).toBe('delete');
    // The one they did NOT name is still applied.
    expect(modes.locking).toBe('exclusive');
  });

  it('applies nothing on a VFS that declares no defaults', {
    tags: ['excludes:default-pragmas'],
  }, async () => {
    // The property is the premise: against a VFS that declares defaults
    // (AccessHandlePoolVFS declares `locking_mode: exclusive`) this read 'exclusive'.
    const db = await createTestClient({ poolSize: 1 });
    await db.run('CREATE TABLE t (a INTEGER)');
    const [locking] = await db.all<{ locking_mode: string }>(
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
