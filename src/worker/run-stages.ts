import type { RunStage, WorkerMessageData } from '../types/protocol';

/**
 * Follows the stage of the query in flight on a debug worker, and posts a `run`
 * message at each change. Pure, so Node tests can drive it with a fake clock.
 */

export type RunStageTracker = {
  /** A query begins: no stage yet. */
  start(callId: number): void;
  /** Posts a `run` message when `stage` differs from the current one. */
  enter(stage: RunStage): void;
  /** The query ends: the current stage's duration, undefined when none was entered. */
  end(): number | undefined;
};

export const createRunStageTracker = (
  post: (message: Extract<WorkerMessageData, { type: 'run' }>) => void,
  now: () => number = () => performance.now(),
): RunStageTracker => {
  let callId = 0;
  let stage: RunStage | undefined;
  let since = 0;
  return {
    start(id) {
      callId = id;
      stage = undefined;
    },
    enter(next) {
      // A statement's step after a computing stretch continues the computing.
      if (next === stage || (stage === 'computing' && next === 'stepping')) {
        return;
      }
      const at = now();
      post({
        type: 'run',
        callId,
        stage: next,
        ...(stage === undefined ? {} : { elapsed: at - since }),
      });
      stage = next;
      since = at;
    },
    end() {
      if (stage === undefined) {
        return undefined;
      }
      const elapsed = now() - since;
      stage = undefined;
      return elapsed;
    },
  };
};
