import { describe, expect, it } from '@rstest/core';
import { VFS_CAPABILITIES } from '../../src/types';
import { ALL_VFS, conformanceClient, HAS_JSPI } from './helpers';

/**
 * Every declared (vfs, build) pair is executed, never trusted. Declaring a
 * combination that does not work is the failure this exists to catch, and
 * IDBMirrorVFS is the row most at risk: it is absent from upstream's table, so
 * its builds were inferred from its source.
 *
 * Falsifiable: add 'sync' to OPFSAdaptiveVFS's builds — that pair goes red.
 */
describe('declared build combinations', () => {
  for (const vfs of ALL_VFS) {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      if (build === 'jspi' && !HAS_JSPI) {
        it.skip(`${vfs} on ${build} — skipped, no JSPI in this browser`, () => {});
        continue;
      }

      it(`${vfs} on ${build} opens and serves a query`, async () => {
        const { db } = conformanceClient(vfs, build);

        await db.write('CREATE TABLE t (a INTEGER)');
        await db.write('INSERT INTO t VALUES (1)');
        const rows = await db.read<{ n: number }>(
          'SELECT count(*) AS n FROM t',
        );

        expect(rows[0].n).toBe(1);
        await db.close();
      });
    }
  }
});
