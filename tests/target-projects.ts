import type { SQLiteBuild } from '../src/const/builds.ts';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../src/const/vfs.ts';
import type { TestTarget } from './browser/target.ts';

/**
 * Every declared (vfs, build) pair, in declaration order: the pairs
 * `vitest.config.ts` makes one project each for, whatever the environment
 * (spec 2026-10-10, D8). Which of them a run uses is the planner's choice
 * (`scripts/test-plan.ts`), never the config's.
 */
export const allTargets = (): TestTarget[] =>
  (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).flatMap((vfs) =>
    (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map((build) => ({
      vfs,
      build,
    })),
  );

/** `OPFSWriteAheadVFS/sync` — a project's name suffix. */
export const targetLabel = (t: TestTarget): string => `${t.vfs}/${t.build}`;
