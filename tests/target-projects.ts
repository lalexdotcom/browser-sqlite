import { RECOMMENDED_VFS } from '../scripts/recommended-vfs.ts';
import { defaultBuildFor } from '../src/capabilities.ts';
import type { SQLiteBuild } from '../src/const/builds.ts';
import type { PlatformFeature } from '../src/const/platform.ts';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../src/const/vfs.ts';
import type { OnUnmetNeed, TestTarget } from './browser/target.ts';

/**
 * What each engine the configs drive offers a build — the only features the
 * default build reads. Both Playwright engines expose `WebAssembly.Suspending`.
 */
export const CHROMIUM_FEATURES: ReadonlySet<PlatformFeature> =
  new Set<PlatformFeature>(['jspi']);
export const FIREFOX_FEATURES: ReadonlySet<PlatformFeature> =
  new Set<PlatformFeature>(['jspi']);

/**
 * The targets the browser configs make one project each for, read in Node by
 * `rstest.config.ts`, `rstest.firefox.config.ts` and `rstest.isolated.config.ts`
 * (spec 2026-09-15, A5).
 *
 * `BSQ_TEST_TARGETS` — prefixed, never a generic name: VS Code exports
 * `BROWSER` (mem:stack-and-build) — selects them:
 * - unset: each recommended VFS on the default build of `engine`;
 * - `all`: every declared (vfs, build) pair;
 * - otherwise a comma list of `vfs/build`, each checked against
 *   `VFS_CAPABILITIES`, so a typo fails the run instead of testing nothing.
 */
export const targetsFromEnv = (
  env: string | undefined,
  engine: ReadonlySet<PlatformFeature>,
): TestTarget[] => {
  if (env === undefined) {
    return RECOMMENDED_VFS.map((vfs) => ({
      vfs,
      build: defaultBuildFor(vfs, engine),
    }));
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

/**
 * What a test whose need the target lacks does, read in Node by the same
 * configs and injected beside the target as `__BSQ_TEST_NEEDS__` (spec
 * 2026-09-15, A7). `BSQ_TEST_NEEDS` unset or `fallback`: A5's fallback, what
 * `pnpm test` runs. `skip`: what `pnpm test:matrix` sets. Anything else throws,
 * so a typo fails the run instead of silently falling back.
 */
export const onUnmetFromEnv = (env: string | undefined): OnUnmetNeed => {
  if (env === undefined || env === 'fallback') return 'fallback';
  if (env === 'skip') return 'skip';
  throw new Error(`BSQ_TEST_NEEDS: "${env}" is neither "fallback" nor "skip"`);
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
