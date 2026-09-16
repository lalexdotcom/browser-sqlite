import { RECOMMENDED_VFS } from '../../scripts/recommended-vfs';
import {
  BUILD_REQUIREMENTS,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

/**
 * A (vfs, build) pair the browser suite runs on. Each browser project injects
 * one, and a test that names no VFS follows it (spec 2026-09-15, A5).
 */
export type TestTarget = {
  readonly vfs: SQLiteVFS;
  readonly build: SQLiteBuild;
};

/**
 * A property a test's subject requires of the pair it runs on. The list grows
 * only when a test's triage requires a new one, by decision, not by drift.
 *
 * - `two-workers`: the pool runs at least two workers here.
 * - `interruptible`: a running statement can be interrupted here.
 * - `shared-second-client`: a second client on the same database reaches the
 *   same bytes here — neither refused nor a database of its own.
 */
export type Need = 'two-workers' | 'interruptible' | 'shared-second-client';

/** What this browser offers. A parameter, so the resolver runs in Node. */
export type Here = {
  readonly features: ReadonlySet<PlatformFeature>;
  readonly crossOriginIsolated: boolean;
};

const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

// The widening casts mirror client.ts's build guard: `as const` on the tables
// narrows an empty list to `readonly []`, where `.every` takes never.
const allHere = (features: readonly PlatformFeature[], here: Here): boolean =>
  features.every((feature) => here.features.has(feature));

const runsHere = ({ vfs, build }: TestTarget, here: Here): boolean =>
  allHere(
    [
      ...(VFS_CAPABILITIES[vfs].requires as readonly PlatformFeature[]),
      ...(BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]),
    ],
    here,
  );

/**
 * Whether a second client of this VFS reaches the first one's database here.
 *
 * False two ways, and they are not the same failure: the memory VFS give the
 * second client a database of its own, while an exclusive VFS refuses it
 * (`DATABASE_IN_USE`). A test of two clients sharing one database has neither.
 *
 * Derived from `VFS_CAPABILITIES` so the rule exists once: `secondClientOutcome`
 * in `helpers/vfs-contract.ts` names the three outcomes from this same answer.
 */
export const sharedSecondClient = (vfs: SQLiteVFS, here: Here): boolean =>
  VFS_CAPABILITIES[vfs].layout !== 'memory' &&
  !VFS_CAPABILITIES[vfs].exclusiveConnection &&
  allHere(
    VFS_CAPABILITIES[vfs]
      .exclusiveConnectionWithout as readonly PlatformFeature[],
    here,
  );

const holds = (need: Need, { vfs, build }: TestTarget, here: Here): boolean => {
  switch (need) {
    case 'two-workers':
      return (
        VFS_CAPABILITIES[vfs].maxPoolSize !== 1 &&
        allHere(
          VFS_CAPABILITIES[vfs]
            .singleConnectionWithout as readonly PlatformFeature[],
          here,
        )
      );
    case 'interruptible':
      return build !== 'sync' || here.crossOriginIsolated;
    case 'shared-second-client':
      return sharedSecondClient(vfs, here);
  }
};

const pairsOf = (vfs: SQLiteVFS): TestTarget[] =>
  (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map((build) => ({
    vfs,
    build,
  }));

/**
 * The pair a test runs on, or `null`:
 *
 * 1. A target this browser cannot run is not runnable — `null`, no fallback.
 *    Otherwise a matrix would report green a pair that never ran.
 * 2. A target that has every need is the pair.
 * 3. Otherwise the first pair that runs here and has every need: the target's
 *    VFS on its other builds, then each recommended VFS, then every other VFS
 *    on the target's `storage`, then every remaining VFS — each group in
 *    `VFS_CAPABILITIES` order, each VFS on its builds in declared order. The
 *    `storage` step keeps an OPFS test on OPFS: without `readwrite-unsafe` a
 *    two-worker test lands on OPFSAnyContextVFS, not on IDBBatchAtomicVFS,
 *    which precedes it in key order.
 *
 * Never a skip: a test whose need the target lacks still runs, on the nearest
 * pair of this browser that has it.
 */
export const resolvePair = (
  target: TestTarget,
  needs: readonly Need[],
  here: Here,
): TestTarget | null => {
  if (!runsHere(target, here)) return null;
  const { storage } = VFS_CAPABILITIES[target.vfs];
  const sameStorage = ALL_VFS.filter(
    (vfs) => VFS_CAPABILITIES[vfs].storage === storage,
  );
  return (
    [
      target,
      ...pairsOf(target.vfs),
      ...RECOMMENDED_VFS.flatMap(pairsOf),
      ...sameStorage.flatMap(pairsOf),
      ...ALL_VFS.flatMap(pairsOf),
    ].find(
      (pair) =>
        runsHere(pair, here) && needs.every((need) => holds(need, pair, here)),
    ) ?? null
  );
};
