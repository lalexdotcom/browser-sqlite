import { RECOMMENDED_VFS } from '../../scripts/recommended-vfs';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import { holds as propertyHolds, type TestContext } from '../need';

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
 * - `shared-storage`: the database outlives the worker that opened it, so a
 *   second realm can see that it exists. Weaker than `shared-second-client`,
 *   and the difference is load-bearing: an exclusive VFS REFUSES a second
 *   client yet is perfectly inspectable, so a test that only reads the lock
 *   registry must not ask for the stronger one and exile itself from
 *   `OPFSWriteAheadVFS`.
 * - `opfs-file`: the database is an OPFS file at its own name, so a test can
 *   put bytes there before anything opens it.
 * - `in-place-file`: an `opfs-file` with no write-ahead files beside it, so
 *   what its files occupy follows the database's own size.
 */
export type Need =
  | 'two-workers'
  | 'interruptible'
  | 'shared-second-client'
  | 'shared-storage'
  | 'opfs-file'
  | 'in-place-file';

/**
 * What this browser offers. A parameter, so the resolver runs in Node.
 *
 * One field, deliberately: `cross-origin-isolated` IS a `PlatformFeature` with
 * a probe of its own (`PROBES` in src/capabilities.ts), so it arrives in
 * `features` like every other. A second boolean beside the set held the same
 * fact twice and made the caller re-implement the probe by hand.
 */
export type Here = {
  readonly features: ReadonlySet<PlatformFeature>;
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
      ...(BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]),
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
/**
 * The need model's context for a pair here. `browser` is not read by the six
 * properties this resolver asks for, so any value does; isolation is the
 * feature the probe already reports.
 */
const contextOf = ({ vfs, build }: TestTarget, here: Here): TestContext => ({
  vfs,
  build,
  browser: 'chrome',
  isolated: here.features.has('cross-origin-isolated'),
  features: here.features,
});

export const sharedSecondClient = (vfs: SQLiteVFS, here: Here): boolean =>
  // The property reads no build; any declared one makes the context.
  propertyHolds(
    'shared-second-client',
    contextOf({ vfs, build: VFS_CAPABILITIES[vfs].builds[0] }, here),
  );

const holds = (need: Need, target: TestTarget, here: Here): boolean =>
  // One definition (tests/need.ts): this resolver goes with the planner (plan B).
  propertyHolds(need, contextOf(target, here));

const pairsOf = (vfs: SQLiteVFS): TestTarget[] =>
  (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map((build) => ({
    vfs,
    build,
  }));

/**
 * What a test whose need the target lacks does (spec 2026-09-15, A7):
 * `fallback` runs it on the nearest pair of this browser that has the need,
 * `skip` skips it. `pnpm test` falls back so that no engine loses coverage;
 * the matrix skips, since every pair a fallback could reach is a cell of its
 * own there, and a fallback would only report its failures under another name.
 */
export type OnUnmetNeed = 'fallback' | 'skip';

/**
 * The pair a test runs on, `'skip'`, or `null`:
 *
 * 1. A target this browser cannot run is not runnable — `null`, no fallback
 *    and no skip. Otherwise a matrix would report green a pair that never ran.
 * 2. A target that has every need is the pair.
 * 3. Under `skip`, anything else is `'skip'`.
 * 4. Under `fallback`, the first pair that runs here and has every need: the
 *    target's VFS on its other builds, then each recommended VFS, then every
 *    other VFS on the target's `storage`, then every remaining VFS — each
 *    group in `VFS_CAPABILITIES` order, each VFS on its builds in declared
 *    order. The `storage` step keeps an OPFS test on OPFS: without
 *    `readwrite-unsafe` a two-worker test lands on OPFSAnyContextVFS, not on
 *    IDBBatchAtomicVFS, which precedes it in key order.
 */
export function resolvePair(
  target: TestTarget,
  needs: readonly Need[],
  here: Here,
  onUnmet?: 'fallback',
): TestTarget | null;
export function resolvePair(
  target: TestTarget,
  needs: readonly Need[],
  here: Here,
  onUnmet: OnUnmetNeed,
): TestTarget | 'skip' | null;
export function resolvePair(
  target: TestTarget,
  needs: readonly Need[],
  here: Here,
  onUnmet: OnUnmetNeed = 'fallback',
): TestTarget | 'skip' | null {
  if (!runsHere(target, here)) return null;
  const satisfies = (pair: TestTarget): boolean =>
    runsHere(pair, here) && needs.every((need) => holds(need, pair, here));
  if (onUnmet === 'skip') return satisfies(target) ? target : 'skip';
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
    ].find(satisfies) ?? null
  );
}
