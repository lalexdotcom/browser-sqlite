import { beforeAll, beforeEach, inject } from 'vitest';
import { featureDifference, guardVerdict } from '../../harness/planner/guard';
import { TEST_TARGET } from '../helpers';
import { AVAILABLE_FEATURES } from '../helpers/environment';

/**
 * Every target project's guard (spec § 4.6). In a planned cell it fails, by
 * name, a test that runs against the plan and a page whose features differ
 * from the probe's; in a project run directly it skips the tests its pair
 * cannot run, saying what they need.
 */
const environment = inject('bsqEnvironment');
const planned = inject('bsqPlanned');

beforeAll(() => {
  if (planned === undefined) return;
  const difference = featureDifference(planned.features, AVAILABLE_FEATURES);
  if (difference !== null) throw new Error(`PLAN_FEATURES: ${difference}`);
});

beforeEach(({ task, skip }) => {
  const verdict = guardVerdict({
    tags: task.tags ?? [],
    id: task.id,
    name: task.fullTestName,
    vfs: TEST_TARGET.vfs,
    build: TEST_TARGET.build,
    browser: environment.browser,
    isolated: environment.isolated,
    features: AVAILABLE_FEATURES,
    planned,
  });
  if (verdict.kind === 'skip') skip(verdict.reason);
  if (verdict.kind === 'fail') throw new Error(verdict.reason);
});
