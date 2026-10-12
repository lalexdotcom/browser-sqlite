import { describe, expect, it } from 'vitest';

// The cell guard compares this runtime name with the name static parsing
// gives the test (tests/planner/guard.ts): no file prefix, " > " between levels.
describe('the runtime name the guard reads', () => {
  it("is the parser's full name", ({ task }) => {
    expect(task.fullTestName).toBe(
      "the runtime name the guard reads > is the parser's full name",
    );
  });
});
