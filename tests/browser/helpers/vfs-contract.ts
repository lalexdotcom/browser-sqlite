import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/types';
import { AVAILABLE_FEATURES } from '../../conformance/helpers';

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
