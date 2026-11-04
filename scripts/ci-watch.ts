#!/usr/bin/env node
/**
 * Follows the live progress of a GitHub run from a terminal:
 *
 *   node scripts/ci-watch.ts <run-id> [--interval <seconds>]
 *   node scripts/ci-watch.ts --sha <sha> [--interval <seconds>]
 *
 * Each planner of the run publishes a check run named `progress · …`
 * (scripts/ci-progress.ts); this polls them through `gh api` and prints each
 * new failure and `[n/N]` line once, one event per line, and each run's
 * conclusion as soon as that run completes; it exits once the runs and their
 * check runs are completed.
 * Meant for a background monitor. GitHub may file those check runs under
 * another workflow of the commit, so they are found by name and by
 * `external_id` (`<run id>/<attempt>`), never by check suite.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export type Snapshot = {
  name: string;
  status: string;
  conclusion: string | null;
  summary: string;
};

const OVERFLOW = /^- … and \d+ more$/;

/** The bullets under the summary's two headings, overflow lines left out. */
export function parseSummary(summary: string): {
  failures: string[];
  retried: string[];
  jobs: string[];
} {
  const failures: string[] = [];
  const retried: string[] = [];
  const jobs: string[] = [];
  let section: string[] | undefined;
  for (const line of summary.split('\n')) {
    if (line.startsWith('### Failed tests')) section = failures;
    else if (line.startsWith('### Passed on retry')) section = retried;
    else if (line === '### Jobs') section = jobs;
    else if (line.startsWith('#') || line.startsWith('**')) section = undefined;
    else if (section && line.startsWith('- ') && !OVERFLOW.test(line)) {
      section.push(line.slice(2));
    }
  }
  return { failures, retried, jobs };
}

/** What `snapshot` holds that `seen` has not: each event printed once. */
export function newEvents(seen: Set<string>, snapshot: Snapshot): string[] {
  const { failures, retried, jobs } = parseSummary(snapshot.summary);
  const events = [
    ...failures.map((f) => `${snapshot.name}: FAILED ${f}`),
    ...retried.map((f) => `${snapshot.name}: RETRIED ${f}`),
    ...jobs.map((j) => `${snapshot.name}: ${j}`),
    ...(snapshot.status === 'completed'
      ? [`${snapshot.name}: done, ${snapshot.conclusion}`]
      : []),
  ];
  const fresh = events.filter((e) => !seen.has(e));
  for (const event of fresh) seen.add(event);
  return fresh;
}

/** Each run's conclusion once, as soon as it completes: not when all have. */
export function runEvents(
  seen: Set<string>,
  runs: readonly Pick<Run, 'id' | 'name' | 'status' | 'conclusion'>[],
): string[] {
  const fresh = runs
    .filter((r) => r.status === 'completed')
    .map((r) => `run ${r.id} (${r.name}): ${r.conclusion}`)
    .filter((e) => !seen.has(e));
  for (const event of fresh) seen.add(event);
  return fresh;
}

export type WatchState = { endedPolls: number; failedPolls: number };

/** Polls a check run may stay open after its runs ended (a lost runner). */
const GRACE_POLLS = 4;
/** Failed polls in a row before giving up (a wrong id, gh logged out). */
const FAILED_POLLS = 4;

/** Whether to stop after a poll; a watcher always ends. */
export function nextStep(
  state: WatchState,
  poll:
    | { ok: false }
    | { ok: true; runsCompleted: boolean; open: readonly string[] },
): {
  state: WatchState;
  exit?: { code: number; stragglers: string[] };
} {
  if (!poll.ok) {
    const failedPolls = state.failedPolls + 1;
    return {
      state: { ...state, failedPolls },
      ...(failedPolls >= FAILED_POLLS
        ? { exit: { code: 2, stragglers: [] } }
        : {}),
    };
  }
  if (!poll.runsCompleted) return { state: { endedPolls: 0, failedPolls: 0 } };
  const endedPolls = state.endedPolls + 1;
  const done = poll.open.length === 0 || endedPolls >= GRACE_POLLS;
  return {
    state: { endedPolls, failedPolls: 0 },
    ...(done ? { exit: { code: 0, stragglers: [...poll.open] } } : {}),
  };
}

type Run = {
  id: number;
  name: string;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
};

const USAGE =
  'usage: node scripts/ci-watch.ts <run-id> | --sha <sha> [--interval <seconds>]';

function gh(args: readonly string[]): string {
  return execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function runsToFollow(target: {
  runId: string | undefined;
  sha: string | undefined;
}): Run[] {
  if (target.runId) {
    return [
      JSON.parse(gh([`repos/{owner}/{repo}/actions/runs/${target.runId}`])),
    ];
  }
  return (
    JSON.parse(
      gh([
        `repos/{owner}/{repo}/actions/runs?head_sha=${target.sha}&per_page=100`,
      ]),
    ) as { workflow_runs: Run[] }
  ).workflow_runs;
}

function progressCheckRuns(sha: string, ids: ReadonlySet<string>): Snapshot[] {
  // filter=all: two runs on one commit share names, and `latest` keeps one.
  const lines = gh([
    '--paginate',
    `repos/{owner}/{repo}/commits/${sha}/check-runs?filter=all&per_page=100`,
    '--jq',
    '.check_runs[] | {name, status, conclusion, external_id, summary: (.output.summary // "")}',
  ]);
  return lines
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Snapshot & { external_id: string | null })
    .filter(
      (c) => c.name.startsWith('progress · ') && ids.has(c.external_id ?? ''),
    );
}

function parseArgs(args: readonly string[]) {
  let runId: string | undefined;
  let sha: string | undefined;
  let interval = 15;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sha') sha = args[++i];
    else if (arg === '--interval') interval = Number(args[++i]);
    else if (arg && /^\d+$/.test(arg)) runId = arg;
    else throw new Error(`ci-watch: unexpected "${arg}". ${USAGE}`);
  }
  if (!runId === !sha || !(interval > 0)) throw new Error(USAGE);
  return { runId, sha, intervalMs: interval * 1000 };
}

async function main() {
  const { intervalMs, ...target } = parseArgs(process.argv.slice(2));
  const seen = new Set<string>();
  let state: WatchState = { endedPolls: 0, failedPolls: 0 };
  for (;;) {
    let runs: Run[] = [];
    let step: ReturnType<typeof nextStep>;
    try {
      runs = runsToFollow(target);
      const sha = runs[0]?.head_sha ?? target.sha;
      const ids = new Set(runs.map((r) => `${r.id}/${r.run_attempt}`));
      const checks = sha ? progressCheckRuns(sha, ids) : [];
      for (const check of checks) {
        for (const event of newEvents(seen, check)) console.log(event);
      }
      for (const event of runEvents(seen, runs)) console.log(event);
      step = nextStep(state, {
        ok: true,
        runsCompleted:
          runs.length > 0 && runs.every((r) => r.status === 'completed'),
        open: checks.filter((c) => c.status !== 'completed').map((c) => c.name),
      });
    } catch (error) {
      // A poll that fails is retried at the next one, up to a few in a row.
      console.log(`ci-watch: ${(error as Error).message.split('\n')[0]}`);
      step = nextStep(state, { ok: false });
    }
    state = step.state;
    if (step.exit) {
      for (const name of step.exit.stragglers) {
        console.log(`${name}: still open, its run has ended`);
      }
      process.exitCode = step.exit.code;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 2;
  });
}
