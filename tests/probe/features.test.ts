import { it } from 'vitest';
import { AVAILABLE_FEATURES } from '../conformance/helpers';

// The planner's view of this environment (spec § 4.2): the library's own
// detectFeatures plus the worker probe for sync access handles and
// readwrite-unsafe, read back from this test's meta by scripts/plan-io.ts.
it('records the features of this environment', ({ task }) => {
  task.meta.features = [...AVAILABLE_FEATURES].sort();
});
