/**
 * A planner's progress on CI, published as a GitHub check run that can be read
 * while the job runs (docs/superpowers/specs/2026-11-03-ci-live-progress-design.md).
 *
 * A job's log cannot be read through the API until the job ends, and the OS
 * workflows run the whole suite in one step. The check run's summary carries
 * the planner's `[n/N]` lines and every failed test as it fails;
 * scripts/ci-watch.ts reads it back, so its layout is a contract.
 */

/** A test that failed, as the live reporter wrote it, in the job it ran in. */
export type Failure = {
  job: string;
  file: string;
  test: string;
  message: string;
};

export type Conclusion = 'success' | 'failure';

export type ProgressState = {
  started: Date;
  /** The planner's job count. */
  total: number;
  /** The planner's `[n/N] …` lines, in order: one per ended job. */
  lines: string[];
  failures: Failure[];
  conclusion?: Conclusion;
};

/** GitHub's bound on `output.summary`. */
export const SUMMARY_LIMIT = 65_535;

export type ProgressConfig = {
  api: string;
  repo: string;
  token: string;
  sha: string;
  name: string;
  externalId: string;
};

export function checkRunName(
  workflow: string,
  label: string,
  phase: string,
): string {
  return `progress · ${workflow} · ${label} · ${phase}`;
}

/**
 * The check run a job's planner publishes, or undefined when publishing is
 * off: outside CI, or without a token or a repository (a local run).
 */
export function progressConfig(
  env: NodeJS.ProcessEnv,
  phase: string,
): ProgressConfig | undefined {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (env.CI !== 'true' || !token || !repo) return undefined;
  return {
    api: env.GITHUB_API_URL || 'https://api.github.com',
    repo,
    token,
    // On a pull request GITHUB_SHA is the merge commit, which the PR's checks
    // do not show: the workflow passes the head.
    sha: env.BSQ_PROGRESS_SHA || env.GITHUB_SHA || '',
    name: checkRunName(
      env.GITHUB_WORKFLOW ?? '',
      env.BSQ_PROGRESS_LABEL || env.GITHUB_JOB || '',
      phase,
    ),
    // The name is the same across runs and attempts on one commit; this is not.
    externalId: `${env.GITHUB_RUN_ID ?? ''}/${env.GITHUB_RUN_ATTEMPT ?? ''}`,
  };
}

/** One bullet is one line, whatever a test name or message holds. */
const oneLine = (text: string) => text.replace(/\r?\n/g, ' ⏎ ');

const failureBullet = (f: Failure) =>
  `- \`${oneLine(f.job)}\` · \`${oneLine(f.file)}\` › ${oneLine(f.test)} — ${oneLine(f.message)}`;

const more = (n: number) => `- … and ${n} more`;

/** The bullets that fit in `budget` characters (a newline each), in order. */
function fitting(bullets: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const bullet of bullets) {
    if (used + bullet.length + 1 > budget) break;
    kept.push(bullet);
    used += bullet.length + 1;
  }
  return kept;
}

export function renderSummary(state: ProgressState): {
  title: string;
  summary: string;
} {
  const ended = `${state.lines.length}/${state.total}`;
  const failed = state.failures.length;
  const title = [
    ...(state.conclusion ? ['done'] : []),
    ended,
    ...(failed > 0 ? [`${failed} failed`] : []),
  ].join(' · ');
  const header = state.conclusion
    ? `**Done: ${state.conclusion}** · ${ended} jobs ended · started ${clock(state.started)}`
    : `**Running** · ${ended} jobs ended · started ${clock(state.started)}`;
  const failuresHeading = `### Failed tests (${failed})`;
  const jobsHeading = '### Jobs';

  // The failures take the room first, the newest job lines what is left;
  // each group that does not fit says how much it left out.
  const fixed = [header, '', failuresHeading, '', jobsHeading].join('\n');
  const reserve = 2 * (more(Number.MAX_SAFE_INTEGER).length + 1);
  let budget = SUMMARY_LIMIT - fixed.length - reserve;
  const failureBullets = fitting(state.failures.map(failureBullet), budget);
  budget -= failureBullets.reduce((n, b) => n + b.length + 1, 0);
  const jobBullets = fitting(
    state.lines.map((l) => `- ${oneLine(l)}`).reverse(),
    budget,
  ).reverse();
  if (failureBullets.length < failed) {
    failureBullets.push(more(failed - failureBullets.length));
  }
  if (jobBullets.length < state.lines.length) {
    jobBullets.unshift(more(state.lines.length - jobBullets.length));
  }
  const summary = [
    header,
    '',
    failuresHeading,
    ...failureBullets,
    '',
    jobsHeading,
    ...jobBullets,
  ].join('\n');
  return { title, summary };
}

const clock = (date: Date) => `${date.toISOString().slice(11, 19)} UTC`;
