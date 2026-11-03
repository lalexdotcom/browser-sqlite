import { describe, expect, it } from 'vitest';
import {
  type Failure,
  renderSummary,
  SUMMARY_LIMIT,
} from '../../../scripts/ci-progress.ts';
import {
  newEvents,
  nextStep,
  parseSummary,
  runEvents,
  type Snapshot,
  type WatchState,
} from '../../../scripts/ci-watch.ts';

/**
 * scripts/ci-watch.ts follows a run's progress check runs and prints what is
 * new, once; it reads back what scripts/ci-progress.ts renders.
 */

const STARTED = new Date('2026-11-03T08:46:10Z');
const failure = (n: number, test = `test ${n}`): Failure => ({
  job: 'unit',
  file: 'tests/unit/x.test.ts',
  test,
  message: `Error: ${n}`,
});
const summary = (failures: Failure[], lines: string[]) =>
  renderSummary({ started: STARTED, total: 3, lines, failures }).summary;
const NAME = 'progress · CI · ubuntu-latest · test';
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  name: NAME,
  status: 'in_progress',
  conclusion: null,
  summary: summary([failure(1)], ['[1/3] unit: exit 1 in 5s']),
  ...patch,
});

describe('parseSummary', () => {
  it('reads back the failures and the job lines it was rendered from', () => {
    expect(
      parseSummary(
        summary(
          [failure(1), failure(2)],
          [
            '[1/3] a: exit 0 in 1s',
            '[2/3] b: exit 0 in 2s',
            '[3/3] c: exit 1 in 3s',
          ],
        ),
      ),
    ).toEqual({
      failures: [
        '`unit` · `tests/unit/x.test.ts` › test 1 — Error: 1',
        '`unit` · `tests/unit/x.test.ts` › test 2 — Error: 2',
      ],
      jobs: [
        '[1/3] a: exit 0 in 1s',
        '[2/3] b: exit 0 in 2s',
        '[3/3] c: exit 1 in 3s',
      ],
    });
  });

  it('reads a failure whose name held a newline as one failure', () => {
    expect(parseSummary(summary([failure(1, 'a\nb')], [])).failures).toEqual([
      '`unit` · `tests/unit/x.test.ts` › a ⏎ b — Error: 1',
    ]);
  });

  it('leaves out the line counting what did not fit', () => {
    const many = Array.from({ length: 3000 }, (_, n) => ({
      ...failure(n),
      message: `Error: ${'m'.repeat(120)}`,
    }));
    const text = summary(many, ['[1/3] a: exit 1 in 1s']);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    const { failures } = parseSummary(text);
    // Falsifiable: keep the overflow bullet and it reads as a failure.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.length).toBeLessThan(3000);
    expect(failures.some((f) => f.startsWith('…'))).toBe(false);
  });
});

describe('newEvents', () => {
  it('prints each failure and job line once', () => {
    const seen = new Set<string>();
    expect(newEvents(seen, snapshot())).toEqual([
      `${NAME}: FAILED \`unit\` · \`tests/unit/x.test.ts\` › test 1 — Error: 1`,
      `${NAME}: [1/3] unit: exit 1 in 5s`,
    ]);
    // Falsifiable: forget what was printed and the same two lines come again.
    expect(newEvents(seen, snapshot())).toEqual([]);
  });

  it('prints only the line a later poll adds', () => {
    const seen = new Set<string>();
    newEvents(seen, snapshot());
    expect(
      newEvents(
        seen,
        snapshot({
          summary: summary(
            [failure(1)],
            ['[1/3] unit: exit 1 in 5s', '[2/3] b: exit 0 in 9s'],
          ),
        }),
      ),
    ).toEqual([`${NAME}: [2/3] b: exit 0 in 9s`]);
  });

  it('ends with the conclusion once the check run completes', () => {
    const events = newEvents(
      new Set(),
      snapshot({ status: 'completed', conclusion: 'failure' }),
    );
    expect(events.at(-1)).toBe(`${NAME}: done, failure`);
  });
});

describe('nextStep', () => {
  const start: WatchState = { endedPolls: 0, failedPolls: 0 };
  const poll = (runsCompleted: boolean, open: string[] = []) =>
    ({ ok: true, runsCompleted, open }) as const;

  it('keeps watching while a run is going', () => {
    expect(nextStep(start, poll(false, ['a'])).exit).toBeUndefined();
  });

  it('stops once the runs and their check runs are completed', () => {
    expect(nextStep(start, poll(true)).exit).toEqual({
      code: 0,
      stragglers: [],
    });
  });

  it('stops a few polls after the runs ended, naming a check run left open', () => {
    // Falsifiable: wait for every check run and a lost runner watches forever.
    let state = start;
    for (let n = 1; n < 4; n++) {
      const step = nextStep(state, poll(true, ['a']));
      expect(step.exit).toBeUndefined();
      state = step.state;
    }
    expect(nextStep(state, poll(true, ['a'])).exit).toEqual({
      code: 0,
      stragglers: ['a'],
    });
  });

  it('gives up after four failed polls in a row, not after scattered ones', () => {
    let state = start;
    for (const ok of [false, false, false, true, false, false, false]) {
      const step = nextStep(state, ok ? poll(false) : { ok: false });
      expect(step.exit).toBeUndefined();
      state = step.state;
    }
    expect(nextStep(state, { ok: false }).exit).toEqual({
      code: 2,
      stragglers: [],
    });
  });
});

describe('runEvents', () => {
  const run = (id: number, status: string, conclusion: string | null) => ({
    id,
    name: `W${id}`,
    status,
    conclusion,
  });

  it('prints a run as soon as it completes, while the others go on', () => {
    // Falsifiable: print the runs only once every run has ended and the first
    // poll returns nothing for run 1.
    const seen = new Set<string>();
    expect(
      runEvents(seen, [
        run(1, 'completed', 'success'),
        run(2, 'in_progress', null),
      ]),
    ).toEqual(['run 1 (W1): success']);
  });

  it('prints each run once', () => {
    const seen = new Set<string>();
    runEvents(seen, [
      run(1, 'completed', 'success'),
      run(2, 'in_progress', null),
    ]);
    expect(
      runEvents(seen, [
        run(1, 'completed', 'success'),
        run(2, 'completed', 'failure'),
      ]),
    ).toEqual(['run 2 (W2): failure']);
  });
});
