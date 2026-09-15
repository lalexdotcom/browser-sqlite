import { RECOMMENDED_VFS } from '../../../scripts/recommended-vfs';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/types';
import {
  ALL_VFS,
  AVAILABLE_FEATURES,
  missingHere,
} from '../../conformance/helpers';

export type SecondClientOutcome = 'shared' | 'isolated' | 'refused';

/**
 * What a second client on the same database gets from `vfs` in this browser
 * (spec 2026-09-15, D3). Derived from `VFS_CAPABILITIES` and never listed by
 * hand: a hand list is a second copy of the truth, and it drifts.
 *
 * - `isolated`: the memory VFS — two clients on one name are two databases.
 * - `refused`: the VFS is exclusive here — `DATABASE_IN_USE`, fast.
 * - `shared`: everything else — each client reads what the other wrote.
 *   `IDBMirrorVFS` is counted here; its behaviour under load across clients
 *   is measured, not asserted (spec §6).
 */
export const secondClientOutcome = (vfs: SQLiteVFS): SecondClientOutcome => {
  const cap = VFS_CAPABILITIES[vfs];
  if (cap.layout === 'memory') return 'isolated';
  if (cap.exclusiveConnection) return 'refused';
  if (cap.exclusiveConnectionWithout.some((f) => !AVAILABLE_FEATURES.has(f))) {
    return 'refused';
  }
  return 'shared';
};

/**
 * The VFS a test of two clients sharing one database can run on in this
 * browser, on their default build, the recommended first (spec 2026-09-15,
 * D7). The refused and the isolated drop out by the same rule the matrix
 * asserts: a refused second client cannot exist, and the memory VFS take no
 * write lock and publish no epoch, so these tests would test nothing there.
 */
export const SHARED_VFS: readonly SQLiteVFS[] = [
  ...RECOMMENDED_VFS,
  ...ALL_VFS.filter((vfs) => !RECOMMENDED_VFS.includes(vfs)),
].filter(
  (vfs) => secondClientOutcome(vfs) === 'shared' && missingHere(vfs) === null,
);
