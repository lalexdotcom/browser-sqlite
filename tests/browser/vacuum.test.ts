import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/** The OPFS size of `path` read from the page, 0 when the file is absent. */
const opfsSize = async (path: string): Promise<number> => {
  const segments = path.split('/');
  const name = segments.pop() as string;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
};

/** What every file of the database occupies in OPFS. */
const footprint = async (files: readonly string[]): Promise<number> =>
  (await Promise.all(files.map(opfsSize))).reduce((a, b) => a + b, 0);

describe('a VACUUM that shrinks the database', () => {
  // Another context reads the files as soon as the write resolves; on Firefox
  // a read at the stale size then fails with SQLITE_IOERR_READ. Falsifiable:
  // revert rhashimoto/wa-sqlite#363 in the vendored wa-sqlite with a
  // `pnpm patch` of OPFSAnyContextVFS.js — its file keeps its pre-VACUUM size.
  it('has shrunk its files in OPFS when the write resolves', async ({
    skip,
  }) => {
    const db = await createTestClient({ needs: ['in-place-file'], skip });
    await db.write('CREATE TABLE t (a)');
    await db.write(
      'INSERT INTO t WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 20000) SELECT randomblob(100) FROM c',
    );
    await db.write('DELETE FROM t');
    const before = await footprint(db.files);

    await db.write('VACUUM');

    // Measured before any statement: the next one on the writer would publish
    // the truncation itself and hide a missing one.
    expect(await footprint(db.files)).toBeLessThan(before / 10);
  });
});
