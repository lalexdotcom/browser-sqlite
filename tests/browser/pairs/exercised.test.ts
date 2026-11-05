import { describe, expect, it } from 'vitest';
import { exercised } from '../helpers';

/**
 * A precondition a slow runner can miss with nothing wrong in the library: the
 * test is annotated `not-exercised` and returns early — neither red nor
 * silently green; the merged report and the progress check run list it
 * (scripts/skip-notes.ts, scripts/progress-reporter.ts). The helper's own
 * behaviour, so one VFS is enough.
 */
describe('exercised', { tags: ['vfs:MemoryVFS'] }, () => {
  it('says yes, and notes nothing, when the case was reached', async ({
    task,
  }) => {
    expect(await exercised(true, 'the case')).toBe(true);
    expect(task.annotations).toEqual([]);
  });

  // Falsifiable: return false without annotating — the report then counts the
  // test as a pass that proved its subject. A stand-in annotate: a real one
  // would list this very test as not exercised in every run.
  it('says no, and notes why, when it was not', async () => {
    const notes: [string, string][] = [];
    const annotate = async (message: string, type: string) => {
      notes.push([message, type]);
    };
    expect(await exercised(false, 'the verdict was not parked', annotate)).toBe(
      false,
    );
    expect(notes).toEqual([['the verdict was not parked', 'not-exercised']]);
  });
});
