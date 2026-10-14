import { afterEach, beforeEach } from 'vitest';
import { takeTargetReads } from '../helpers';

/**
 * Under `BSQ_TEST_TRACE=1` (vitest.config.ts), records for each test how
 * many times it read its pair and how many workers it started, in
 * `task.meta.bsqTrace`, which the JSON reporter keeps
 * (`scripts/trace-diff.ts`). Registered after the guard, whose own reads
 * of the pair the `beforeEach` below discards.
 */
let workers = 0;
const Traced = globalThis.Worker;
globalThis.Worker = class extends Traced {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers++;
  }
} as typeof Worker;

beforeEach(() => {
  takeTargetReads();
  workers = 0;
});

afterEach(({ task }) => {
  task.meta.bsqTrace = {
    targetReads: takeTargetReads(),
    workers,
    tags: [...(task.tags ?? [])],
  };
});
