/**
 * A planner's progress on CI, published as a GitHub check run that can be read
 * while the job runs (docs/superpowers/specs/2026-11-03-ci-live-progress-design.md).
 *
 * A job's log cannot be read through the API until the job ends, and the OS
 * workflows run the whole suite in one step. The check run's summary carries
 * the planner's `[n/N]` lines and every failed test as it fails;
 * scripts/ci-watch.ts reads it back, so its layout is a contract.
 *
 * The planner is the only writer: each Vitest process it starts appends its
 * failed tests to an events file (scripts/progress-reporter.ts), which the
 * publisher reads on its own tick. Publishing is a side channel — a refusal,
 * a timeout or an unreachable API stops it with one warning and changes
 * nothing else.
 *
 *   node scripts/ci-progress.ts close <conclusion>
 *
 * closes, with the job's status, the check runs this job created and left
 * open: the workflow's `if: always()` step after a cancel, a timeout or a
 * planner killed by bounded.ts.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A test that failed, as the live reporter wrote it, in the job it ran in;
 * `retried` when it passed on its retry instead (`timeoutRetry`,
 * scripts/processes.ts), `notExercised` when its case was not reached
 * (`exercised`, tests/browser/helpers/exercised.ts); the summary lists each
 * apart.
 */
export type Failure = {
  job: string;
  file: string;
  test: string;
  message: string;
  retried?: true;
  notExercised?: true;
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
  const failures = state.failures.filter((f) => !f.retried && !f.notExercised);
  const retries = state.failures.filter((f) => f.retried);
  const missed = state.failures.filter((f) => f.notExercised);
  const failed = failures.length;
  const title = [
    ...(state.conclusion ? ['done'] : []),
    ended,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(retries.length > 0 ? [`${retries.length} retried`] : []),
    ...(missed.length > 0 ? [`${missed.length} not exercised`] : []),
  ].join(' · ');
  const header = state.conclusion
    ? `**Done: ${state.conclusion}** · ${ended} jobs ended · started ${clock(state.started)}`
    : `**Running** · ${ended} jobs ended · started ${clock(state.started)}`;
  const failuresHeading = `### Failed tests (${failed})`;
  const retriesHeading = `### Passed on retry (${retries.length})`;
  const jobsHeading = '### Jobs';
  const missedHeading = `### Not exercised (${missed.length})`;
  const retriesBlock = retries.length > 0 ? ['', retriesHeading] : [];
  const missedBlock = missed.length > 0 ? ['', missedHeading] : [];

  // The failures take the room first, then the retries, the newest job lines
  // what is left; each group that does not fit says how much it left out.
  const fixed = [
    header,
    '',
    failuresHeading,
    ...retriesBlock,
    ...missedBlock,
    '',
    jobsHeading,
  ].join('\n');
  const reserve = 4 * (more(Number.MAX_SAFE_INTEGER).length + 1);
  let budget = SUMMARY_LIMIT - fixed.length - reserve;
  const failureBullets = fitting(failures.map(failureBullet), budget);
  budget -= failureBullets.reduce((n, b) => n + b.length + 1, 0);
  const retryBullets = fitting(retries.map(failureBullet), budget);
  budget -= retryBullets.reduce((n, b) => n + b.length + 1, 0);
  const missedBullets = fitting(missed.map(failureBullet), budget);
  budget -= missedBullets.reduce((n, b) => n + b.length + 1, 0);
  const jobBullets = fitting(
    state.lines.map((l) => `- ${oneLine(l)}`).reverse(),
    budget,
  ).reverse();
  if (failureBullets.length < failed) {
    failureBullets.push(more(failed - failureBullets.length));
  }
  if (retryBullets.length < retries.length) {
    retryBullets.push(more(retries.length - retryBullets.length));
  }
  if (missedBullets.length < missed.length) {
    missedBullets.push(more(missed.length - missedBullets.length));
  }
  if (jobBullets.length < state.lines.length) {
    jobBullets.unshift(more(state.lines.length - jobBullets.length));
  }
  const summary = [
    header,
    '',
    failuresHeading,
    ...failureBullets,
    ...(retries.length > 0 ? ['', retriesHeading, ...retryBullets] : []),
    ...(missed.length > 0 ? ['', missedHeading, ...missedBullets] : []),
    '',
    jobsHeading,
    ...jobBullets,
  ].join('\n');
  return { title, summary };
}

const clock = (date: Date) => `${date.toISOString().slice(11, 19)} UTC`;

/** Rejects when `promise` has not settled within `ms`; never holds the process. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

type Api = Pick<ProgressConfig, 'api' | 'repo' | 'token'>;

/** A request to the repository's check runs; rejects on any non-2xx answer. */
function checkRuns(config: Api, fetchImpl: typeof fetch, timeoutMs: number) {
  return (method: string, path: string, body?: unknown): Promise<unknown> =>
    bounded(
      (async () => {
        const response = await fetchImpl(
          `${config.api}/repos/${config.repo}/check-runs${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${config.token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(timeoutMs),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }
        return response.json();
      })(),
      timeoutMs,
    );
}

/**
 * The failures appended to `eventsDir/<job>.ndjson` since the last call:
 * complete lines only, so a line read mid-write is taken whole next time.
 */
export function readEvents(
  eventsDir: string,
  offsets: Map<string, number>,
): Failure[] {
  if (!existsSync(eventsDir)) return [];
  const failures: Failure[] = [];
  const files = readdirSync(eventsDir).filter((n) => n.endsWith('.ndjson'));
  for (const name of files.sort()) {
    const file = join(eventsDir, name);
    const from = offsets.get(file) ?? 0;
    const bytes = readFileSync(file);
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end <= from) continue;
    offsets.set(file, end);
    const job = name.slice(0, -'.ndjson'.length);
    for (const line of bytes.subarray(from, end).toString('utf8').split('\n')) {
      if (line === '') continue;
      try {
        const {
          file: path,
          test,
          message,
          retried,
          notExercised,
        } = JSON.parse(line) as Omit<Failure, 'job'>;
        failures.push({
          job,
          file: path,
          test,
          message,
          ...(retried ? { retried } : {}),
          ...(notExercised ? { notExercised } : {}),
        });
      } catch {
        // A line the reporter did not write whole: nothing to show for it.
      }
    }
  }
  return failures;
}

export interface Progress {
  /** Records one of the planner's `[n/N]` lines; sent on the next tick. */
  line(text: string): void;
  /** Closes the check run; bounded, never rejects. */
  finish(conclusion: Conclusion): Promise<void>;
}

const OFF: Progress = {
  line() {},
  async finish() {},
};

export async function startProgress(options: {
  config: ProgressConfig | undefined;
  total: number;
  eventsDir: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  finishTimeoutMs?: number;
  idsFile?: string;
  log?: (message: string) => void;
}): Promise<Progress> {
  const {
    config,
    total,
    eventsDir,
    fetch: fetchImpl = fetch,
    intervalMs = 10_000,
    finishTimeoutMs = 15_000,
    log = console.log,
  } = options;
  if (!config) return OFF;
  const idsFile = options.idsFile ?? defaultIdsFile(process.env);
  const request = checkRuns(config, fetchImpl, finishTimeoutMs);
  const state: ProgressState = {
    started: new Date(),
    total,
    lines: [],
    failures: [],
  };
  let stopped = false;
  const stop = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    log(
      `ci-progress: publishing stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  let id: number;
  try {
    const created = (await request('POST', '', {
      name: config.name,
      head_sha: config.sha,
      external_id: config.externalId,
      status: 'in_progress',
      started_at: state.started.toISOString(),
      output: renderSummary(state),
    })) as { id: number; html_url: string };
    id = created.id;
    log(`Live progress: ${created.html_url}`);
    // For the workflow's closing step, should this job not end normally.
    if (idsFile) appendFileSync(idsFile, `${id}\n`);
  } catch (error) {
    stop(error);
    return OFF;
  }

  const offsets = new Map<string, number>();
  let dirty = false;
  let inFlight: Promise<void> | undefined;
  const collect = () => {
    const fresh = readEvents(eventsDir, offsets);
    if (fresh.length > 0) {
      state.failures.push(...fresh);
      dirty = true;
    }
  };
  const send = (body: object) =>
    request('PATCH', `/${id}`, body).then(() => {}, stop);
  // Only when something changed: the token's 1 000 requests an hour are
  // shared by every job of the repository.
  const tick = () => {
    if (stopped) return;
    try {
      collect();
    } catch (error) {
      stop(error);
      return;
    }
    if (!dirty || inFlight) return;
    dirty = false;
    inFlight = send({ output: renderSummary(state) }).finally(() => {
      inFlight = undefined;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    line(text) {
      state.lines.push(text);
      dirty = true;
    },
    async finish(conclusion) {
      clearInterval(timer);
      if (stopped) return;
      const closing = async () => {
        try {
          collect();
        } catch {
          // The summary goes out with what was read.
        }
        await inFlight;
        if (stopped) return;
        state.conclusion = conclusion;
        await send({
          status: 'completed',
          conclusion,
          completed_at: new Date().toISOString(),
          output: renderSummary(state),
        });
      };
      await bounded(closing(), finishTimeoutMs).catch(stop);
    },
  };
}

function defaultIdsFile(env: NodeJS.ProcessEnv): string | undefined {
  return env.RUNNER_TEMP
    ? join(env.RUNNER_TEMP, 'bsq-progress-ids')
    : undefined;
}

/** Completes, with `conclusion`, every check run of `ids` still open. */
export async function closeOpen(
  ids: readonly string[],
  conclusion: string,
  config: Api,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const request = checkRuns(config, fetchImpl, 15_000);
  const failed: string[] = [];
  // One by one, each on its own: a refused id must not leave the next open.
  for (const id of ids) {
    try {
      const run = (await request('GET', `/${id}`)) as { status: string };
      if (run.status === 'completed') continue;
      await request('PATCH', `/${id}`, {
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
      });
    } catch (error) {
      failed.push(`${id}: ${(error as Error).message}`);
    }
  }
  return failed;
}

async function closeFromCli(args: readonly string[]) {
  const [command, conclusion] = args;
  if (command !== 'close' || !conclusion) {
    console.error('usage: node scripts/ci-progress.ts close <conclusion>');
    process.exitCode = 2;
    return;
  }
  const config = progressConfig(process.env, '');
  const idsFile = defaultIdsFile(process.env);
  if (!config || !idsFile || !existsSync(idsFile)) return;
  const ids = readFileSync(idsFile, 'utf8').split('\n').filter(Boolean);
  // A warning only: the job's own status already says how it ended.
  for (const failure of await closeOpen(ids, conclusion, config)) {
    console.warn(`ci-progress: could not close ${failure}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  closeFromCli(process.argv.slice(2));
}
