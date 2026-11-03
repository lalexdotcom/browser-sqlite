import { describe, expect, it } from 'vitest';
import {
  checkRunName,
  type Failure,
  type ProgressState,
  progressConfig,
  renderSummary,
  SUMMARY_LIMIT,
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
