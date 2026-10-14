import { describe, expect, it } from 'vitest';
import type { SQLiteBuild } from '../../../src/const/builds';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/const/vfs';
import { allTargets, targetLabel } from '../../harness/target-projects';

describe('allTargets', () => {
  it('is every declared (vfs, build) pair, in declaration order', () => {
    // Falsifiable: keep the recommended VFS alone and the matrix loses 20 pairs.
    expect(allTargets().map(targetLabel)).toEqual(
      (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).flatMap((vfs) =>
        (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map(
          (build) => `${vfs}/${build}`,
        ),
      ),
    );
  });
});
