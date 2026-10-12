import type { BrowserName } from '../../scripts/browsers.ts';
import type { SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import type { SQLiteVFS } from '../../src/const/vfs';
import { needFromTags, shouldTestRun } from '../need';

/** What a cell's process provides as `bsqPlanned` (scripts/run-cell.ts). */
export type Planned = {
  /** Planned test ids, each with the name the parser gave it. */
  readonly tests: Readonly<Record<string, string>>;
  readonly features: readonly PlatformFeature[];
  readonly fullIsolation: boolean;
  readonly target: { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild };
};

export type GuardInput = {
  readonly tags: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly vfs: SQLiteVFS;
  readonly build: SQLiteBuild;
  readonly browser: BrowserName;
  readonly isolated: boolean;
  readonly features: ReadonlySet<PlatformFeature>;
  readonly planned: Planned | undefined;
};

export type Verdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string };

/** The static parser keeps a literal's escapes (`\"`); the runtime name does not. */
const unescapeName = (name: string) => name.replace(/\\(["'`\\])/g, '$1');

/**
 * Whether the running test may run here (spec § 4.6). Throws NEED_TAG on a
 * tag outside the vocabulary, which fails the test by name.
 */
export const guardVerdict = (input: GuardInput): Verdict => {
  const { standalone, need } = needFromTags(input.tags);
  const pair = `${input.vfs}/${input.build}${input.isolated ? ' isolated' : ''}`;
  const eligible =
    standalone ||
    shouldTestRun(
      {
        vfs: input.vfs,
        build: input.build,
        browser: input.browser,
        isolated: input.isolated,
        features: input.features,
      },
      need,
      { dedupeIsolation: !(input.planned?.fullIsolation ?? false) },
    );
  const { planned } = input;
  if (planned === undefined) {
    return eligible
      ? { kind: 'run' }
      : {
          kind: 'skip',
          reason: `not eligible on ${pair}: needs [${input.tags.join(', ')}]`,
        };
  }
  if (
    planned.target.vfs !== input.vfs ||
    planned.target.build !== input.build
  ) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: this cell runs ${input.vfs}/${input.build}, planned ${planned.target.vfs}/${planned.target.build}`,
    };
  }
  const plannedName = planned.tests[input.id];
  if (plannedName === undefined) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: "${input.name}" ran outside the plan`,
    };
  }
  if (unescapeName(plannedName) !== input.name) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: id ${input.id} was planned as "${plannedName}" and ran as "${input.name}" — the file declares tests dynamically`,
    };
  }
  if (!eligible) {
    return {
      kind: 'fail',
      reason: `PLAN_GUARD: "${input.name}" is planned on ${pair}, where its tags [${input.tags.join(', ')}] do not run`,
    };
  }
  return { kind: 'run' };
};

/** Null when this page has exactly the planned features; otherwise both differences. */
export const featureDifference = (
  planned: readonly PlatformFeature[],
  here: ReadonlySet<PlatformFeature>,
): string | null => {
  const missing = planned.filter((feature) => !here.has(feature));
  const extra = [...here].filter((feature) => !planned.includes(feature));
  if (missing.length === 0 && extra.length === 0) return null;
  return `planned for [${missing.join(', ')}], missing here; here [${extra.join(', ')}], not planned`;
};
