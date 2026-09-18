import { RECOMMENDED_VFS } from '../scripts/recommended-vfs.ts';
import {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../src/types.ts';
import type { TestTarget } from './browser/target.ts';

/**
 * The targets the browser configs make one project each for, read in Node by
 * `rstest.config.ts`, `rstest.firefox.config.ts` and `rstest.isolated.config.ts`
 * (spec 2026-09-15, A5).
 *
 * `BSQ_TEST_TARGETS` — prefixed, never a generic name: VS Code exports
 * `BROWSER` (mem:stack-and-build) — selects them:
 * - unset: each recommended VFS on its default build;
 * - `all`: every declared (vfs, build) pair;
 * - otherwise a comma list of `vfs/build`, each checked against
 *   `VFS_CAPABILITIES`, so a typo fails the run instead of testing nothing.
 */
export const targetsFromEnv = (env: string | undefined): TestTarget[] => {
  if (env === undefined) {
    return RECOMMENDED_VFS.map((vfs) => ({ vfs, build: defaultBuildFor(vfs) }));
  }
  if (env === 'all') {
    return (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).flatMap((vfs) =>
      (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).map((build) => ({
        vfs,
        build,
      })),
    );
  }
  return env.split(',').map(parseTarget);
};

/** `OPFSWriteAheadVFS/sync` — a project's name suffix, and the env syntax. */
export const targetLabel = (t: TestTarget): string => `${t.vfs}/${t.build}`;

const parseTarget = (label: string): TestTarget => {
  const [vfs, build, ...rest] = label.trim().split('/');
  if (
    rest.length === 0 &&
    vfs !== undefined &&
    build !== undefined &&
    Object.hasOwn(VFS_CAPABILITIES, vfs) &&
    (VFS_CAPABILITIES[vfs as SQLiteVFS].builds as readonly string[]).includes(
      build,
    )
  ) {
    return { vfs: vfs as SQLiteVFS, build: build as SQLiteBuild };
  }
  throw new Error(
    `BSQ_TEST_TARGETS: "${label}" is not a declared pair — expected <vfs>/<build>, a build that VFS declares, or "all"`,
  );
};
