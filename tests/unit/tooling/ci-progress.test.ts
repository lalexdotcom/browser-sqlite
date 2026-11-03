import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkRunName,
  closeOpen,
  type Failure,
  type ProgressConfig,
  type ProgressState,
  progressConfig,
  readEvents,
  renderSummary,
  SUMMARY_LIMIT,
  startProgress,
} from '../../../scripts/ci-progress.ts';

/**
 * A planner on CI publishes its progress as a check run that Claude reads
 * while the job runs (docs/superpowers/specs/2026-11-03-ci-live-progress-design.md).
 * The summary's layout is a contract with scripts/ci-watch.ts.
 */

const STARTED = new Date('2026-11-03T08:46:10Z');
const failure = (n: number, message = `Error: boom ${n}`): Failure => ({
  job: 'chrome__OPFSWriteAheadVFS__sync',
  file: 'tests/browser/x.test.ts',
  test: `suite > test ${n}`,
  message,
});
const jobLine = (n: number, total = 27) =>
  `[${n}/${total}] cell-${n}: exit 0 in ${n}s`;
const state = (patch: Partial<ProgressState> = {}): ProgressState => ({
  started: STARTED,
  total: 27,
  lines: [jobLine(1), jobLine(2), jobLine(3)],
  failures: [failure(1), failure(2)],
  ...patch,
});

describe('checkRunName', () => {
  it('names the workflow, the job label and the phase', () => {
    expect(checkRunName('Tests (macOS 27)', 'xcode-27', 'test')).toBe(
      'progress · Tests (macOS 27) · xcode-27 · test',
    );
  });
});

describe('renderSummary', () => {
  it('heads a running summary with the jobs ended and the start time', () => {
    const { title, summary } = renderSummary(state());
    expect(summary.startsWith('**Running** · 3/27 jobs ended · started ')).toBe(
      true,
    );
    expect(summary).toContain('08:46:10 UTC');
    expect(title).toBe('3/27 · 2 failed');
  });

  it('puts the failed tests before the job lines', () => {
    const { summary } = renderSummary(state());
    // Falsifiable: render the jobs first and the failures fall below them.
    expect(summary.indexOf('### Failed tests (2)')).toBeGreaterThan(-1);
    expect(summary.indexOf('### Failed tests (2)')).toBeLessThan(
      summary.indexOf('### Jobs'),
    );
    expect(summary).toContain(
      '- `chrome__OPFSWriteAheadVFS__sync` · `tests/browser/x.test.ts` › suite > test 1 — Error: boom 1',
    );
    expect(summary).toContain(`- ${jobLine(3)}`);
  });

  it('titles a run with no failure by its count alone', () => {
    expect(renderSummary(state({ failures: [] })).title).toBe('3/27');
  });

  it('heads a concluded summary with its conclusion', () => {
    const { title, summary } = renderSummary(
      state({ conclusion: 'failure', lines: [jobLine(1, 1)] }),
    );
    expect(summary.startsWith('**Done: failure**')).toBe(true);
    expect(title).toBe('done · 1/27 · 2 failed');
  });

  it('keeps a failure on one line whatever its name and message hold', () => {
    const { summary } = renderSummary(
      state({
        failures: [{ ...failure(1), test: 'a\nb', message: 'x\r\ny' }],
      }),
    );
    const bullet = summary.split('\n').find((l) => l.includes('a ⏎ b'));
    expect(bullet).toBeDefined();
    expect(bullet).toContain('x ⏎ y');
  });

  it('stays within the limit when every test failed, failures first', () => {
    const { summary } = renderSummary(
      state({
        failures: Array.from({ length: 3000 }, (_, n) =>
          failure(n, `Error: ${'m'.repeat(93)}`),
        ),
        lines: Array.from({ length: 30 }, (_, n) => jobLine(n + 1, 30)),
      }),
    );
    // Falsifiable: drop the truncation and 3000 bullets of ~170 characters overflow.
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary).toContain('### Failed tests (3000)');
    expect(summary).toMatch(/^- … and \d+ more$/m);
    expect(summary).toContain('### Jobs');
  });
});

describe('progressConfig', () => {
  const CI_ENV = {
    CI: 'true',
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_SHA: 's',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_JOB: 'test',
    GITHUB_RUN_ID: '9',
    GITHUB_RUN_ATTEMPT: '2',
  };

  it('reads the check run from a job environment', () => {
    expect(progressConfig(CI_ENV, 'test')).toEqual({
      api: 'https://api.github.com',
      repo: 'o/r',
      token: 't',
      sha: 's',
      name: 'progress · CI · test · test',
      externalId: '9/2',
    });
  });

  it('takes the head SHA, the job label and the API given', () => {
    expect(
      progressConfig(
        {
          ...CI_ENV,
          BSQ_PROGRESS_SHA: 'h',
          BSQ_PROGRESS_LABEL: 'ubuntu-latest',
          GITHUB_API_URL: 'https://ghe.example/api/v3',
        },
        'conformance',
      ),
    ).toMatchObject({
      api: 'https://ghe.example/api/v3',
      sha: 'h',
      name: 'progress · CI · ubuntu-latest · conformance',
    });
  });

  it('is off outside CI, without a token or without a repository', () => {
    const { CI: _ci, ...noCi } = CI_ENV;
    const { GITHUB_TOKEN: _t, ...noToken } = CI_ENV;
    const { GITHUB_REPOSITORY: _r, ...noRepo } = CI_ENV;
    expect(progressConfig(noCi, 'test')).toBeUndefined();
    expect(progressConfig(noToken, 'test')).toBeUndefined();
    expect(progressConfig(noRepo, 'test')).toBeUndefined();
  });
});

type Call = { method: string; url: string; body: Record<string, unknown> };

/** A GitHub that records each request and answers from `answer`. */
function fakeGitHub(
  answer: (call: Call) => Promise<Response> | Response = () =>
    Response.json({ id: 7, html_url: 'https://github.com/o/r/runs/7' }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    patches: () => calls.filter((c) => c.method === 'PATCH'),
  };
}

const CONFIG: ProgressConfig = {
  api: 'https://api.github.com',
  repo: 'o/r',
  token: 't',
  sha: 'h',
  name: 'progress · CI · ubuntu-latest · test',
  externalId: '9/2',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const summaryOf = (call: Call | undefined) =>
  (call?.body.output as { summary: string } | undefined)?.summary ?? '';

describe('startProgress', () => {
  let dir: string;
  let eventsDir: string;
  let idsFile: string;
  let logs: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-progress-'));
    eventsDir = join(dir, 'events');
    mkdirSync(eventsDir);
    idsFile = join(dir, 'ids');
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const start = (
    fetchImpl: typeof fetch,
    config: ProgressConfig | null = CONFIG,
    finishTimeoutMs = 1000,
  ) =>
    startProgress({
      config: config ?? undefined,
      total: 2,
      eventsDir,
      fetch: fetchImpl,
      intervalMs: 20,
      finishTimeoutMs,
      idsFile,
      log: (m) => logs.push(m),
    });

  it('creates the check run in progress, prints its link and records its id', async () => {
    const gh = fakeGitHub();
    const progress = await start(gh.fetchImpl);
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/o/r/check-runs',
      body: {
        name: CONFIG.name,
        head_sha: 'h',
        external_id: '9/2',
        status: 'in_progress',
      },
    });
    expect(logs).toContain('Live progress: https://github.com/o/r/runs/7');
    expect(readFileSync(idsFile, 'utf8')).toBe('7\n');
    await progress.finish('success');
  });

  it('sends a job line once, and nothing while nothing changes', async () => {
    const gh = fakeGitHub();
    const progress = await start(gh.fetchImpl);
    progress.line('[1/2] unit: exit 0 in 5s');
    await sleep(60);
    // Falsifiable: PATCH on every tick and the second wait adds more.
    expect(gh.patches()).toHaveLength(1);
    expect(gh.patches()[0]?.url).toBe(
      'https://api.github.com/repos/o/r/check-runs/7',
    );
    expect(summaryOf(gh.patches()[0])).toContain('- [1/2] unit: exit 0 in 5s');
    await sleep(60);
    expect(gh.patches()).toHaveLength(1);
    await progress.finish('success');
  });

  it('publishes a failure from a job events file', async () => {
    const gh = fakeGitHub();
    const progress = await start(gh.fetchImpl);
    appendFileSync(
      join(eventsDir, 'chrome__A__x.ndjson'),
      '{"file":"f.test.ts","test":"t","message":"boom"}\n',
    );
    await sleep(60);
    expect(summaryOf(gh.patches().at(-1))).toContain(
      '- `chrome__A__x` · `f.test.ts` › t — boom',
    );
    await progress.finish('failure');
  });

  it('closes the check run with the conclusion given', async () => {
    const gh = fakeGitHub();
    const progress = await start(gh.fetchImpl);
    progress.line('[1/2] unit: exit 1 in 5s');
    await progress.finish('failure');
    expect(gh.calls.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { status: 'completed', conclusion: 'failure' },
    });
    expect(summaryOf(gh.calls.at(-1))).toContain('[1/2] unit: exit 1 in 5s');
  });

  it('stops publishing after a refusal, saying so once', async () => {
    const gh = fakeGitHub(() => new Response('{}', { status: 403 }));
    const progress = await start(gh.fetchImpl);
    progress.line('[1/2] unit: exit 0 in 5s');
    await sleep(60);
    await progress.finish('success');
    expect(gh.calls).toHaveLength(1);
    expect(logs.filter((m) => m.startsWith('ci-progress:'))).toEqual([
      expect.stringMatching(/^ci-progress: publishing stopped: 403/),
    ]);
  });

  it('gives up finishing when GitHub does not answer', async () => {
    const gh = fakeGitHub((call) =>
      call.method === 'POST'
        ? Response.json({ id: 7, html_url: 'u' })
        : new Promise<Response>(() => {}),
    );
    const progress = await start(gh.fetchImpl, CONFIG, 50);
    const began = Date.now();
    await progress.finish('success');
    expect(Date.now() - began).toBeLessThan(500);
  });

  it('does nothing without a config', async () => {
    const gh = fakeGitHub();
    const progress = await start(gh.fetchImpl, null);
    progress.line('[1/2] unit: exit 0 in 5s');
    await progress.finish('success');
    expect(gh.calls).toHaveLength(0);
    expect(logs).toEqual([]);
    expect(existsSync(idsFile)).toBe(false);
  });
});

describe('readEvents', () => {
  it('reads complete lines only, and the rest of a line once it is whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-events-'));
    try {
      const file = join(dir, 'unit.ndjson');
      writeFileSync(file, '{"file":"f","test":"a","message":"m"}\n{"file":"g');
      const offsets = new Map<string, number>();
      expect(readEvents(dir, offsets)).toEqual([
        { job: 'unit', file: 'f', test: 'a', message: 'm' },
      ]);
      // Falsifiable: parse the partial line and this throws or loses "b".
      appendFileSync(file, '","test":"b","message":"n"}\n');
      expect(readEvents(dir, offsets)).toEqual([
        { job: 'unit', file: 'g', test: 'b', message: 'n' },
      ]);
      expect(readEvents(dir, offsets)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads nothing from a directory that does not exist', () => {
    expect(readEvents('/nonexistent/ci-events', new Map())).toEqual([]);
  });
});

describe('closeOpen', () => {
  it('closes the open check runs only', async () => {
    const gh = fakeGitHub((call) =>
      call.method === 'GET'
        ? Response.json({
            status: call.url.endsWith('/1') ? 'in_progress' : 'completed',
          })
        : Response.json({}),
    );
    await closeOpen(['1', '2'], 'cancelled', CONFIG, gh.fetchImpl);
    expect(gh.patches()).toEqual([
      expect.objectContaining({
        url: 'https://api.github.com/repos/o/r/check-runs/1',
        body: expect.objectContaining({
          status: 'completed',
          conclusion: 'cancelled',
        }),
      }),
    ]);
  });
});

describe('closeOpen, a failing request', () => {
  it('still closes the other check runs, and names the one it could not', async () => {
    const gh = fakeGitHub((call) =>
      call.method === 'GET'
        ? call.url.endsWith('/1')
          ? new Response('{}', { status: 502 })
          : Response.json({ status: 'in_progress' })
        : Response.json({}),
    );
    // Falsifiable: stop at the first error and check run 2 stays open.
    const failed = await closeOpen(
      ['1', '2'],
      'cancelled',
      CONFIG,
      gh.fetchImpl,
    );
    expect(gh.patches().map((c) => c.url)).toEqual([
      'https://api.github.com/repos/o/r/check-runs/2',
    ]);
    expect(failed).toEqual(['1: 502']);
  });
});
