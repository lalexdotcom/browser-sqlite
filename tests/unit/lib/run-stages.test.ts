import { describe, expect, it } from 'vitest';
import type { WorkerMessageData } from '../../../src/types/protocol';
import { createRunStageTracker } from '../../../src/worker/run-stages';

type RunMessage = Extract<WorkerMessageData, { type: 'run' }>;

/** A tracker posting into an array, on a clock the test moves with `at`. */
const harness = () => {
  let t = 0;
  const posted: RunMessage[] = [];
  const tracker = createRunStageTracker(
    (message) => {
      posted.push(message);
    },
    () => t,
  );
  return {
    tracker,
    posted,
    at: (ms: number) => {
      t = ms;
    },
  };
};

describe('createRunStageTracker', () => {
  it('posts the first stage without elapsed', () => {
    const { tracker, posted } = harness();
    tracker.start(7);
    tracker.enter('preparing');
    expect(posted).toStrictEqual([
      { type: 'run', callId: 7, stage: 'preparing' },
    ]);
  });

  it('posts each change with the duration of the stage it ends', () => {
    const { tracker, posted, at } = harness();
    tracker.start(1);
    at(10);
    tracker.enter('preparing');
    at(13);
    tracker.enter('stepping');
    at(20);
    tracker.enter('awaiting-credit');
    expect(posted).toStrictEqual([
      { type: 'run', callId: 1, stage: 'preparing' },
      { type: 'run', callId: 1, stage: 'stepping', elapsed: 3 },
      { type: 'run', callId: 1, stage: 'awaiting-credit', elapsed: 7 },
    ]);
  });

  it('posts nothing for the stage already current', () => {
    const { tracker, posted } = harness();
    tracker.start(1);
    tracker.enter('stepping');
    tracker.enter('stepping');
    expect(posted).toHaveLength(1);
  });

  it('treats stepping during computing as no change', () => {
    const { tracker, posted, at } = harness();
    tracker.start(1);
    tracker.enter('stepping');
    at(4);
    tracker.enter('computing');
    tracker.enter('stepping');
    expect(posted).toHaveLength(2);
    at(9);
    tracker.enter('awaiting-credit');
    expect(posted[2]).toStrictEqual({
      type: 'run',
      callId: 1,
      stage: 'awaiting-credit',
      elapsed: 5,
    });
  });

  it("end returns the current stage's duration, undefined when none", () => {
    const { tracker, at } = harness();
    tracker.start(1);
    expect(tracker.end()).toBeUndefined();
    tracker.start(2);
    at(5);
    tracker.enter('stepping');
    at(9);
    expect(tracker.end()).toBe(4);
  });

  it('start forgets the previous query', () => {
    const { tracker, posted } = harness();
    tracker.start(1);
    tracker.enter('stepping');
    tracker.start(2);
    tracker.enter('stepping');
    expect(posted[1]).toStrictEqual({
      type: 'run',
      callId: 2,
      stage: 'stepping',
    });
  });
});
