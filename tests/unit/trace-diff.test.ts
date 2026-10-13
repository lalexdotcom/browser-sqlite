import { describe, expect, it } from 'vitest';
import { diffTraces, readTrace } from '../../scripts/trace-diff.ts';

/**
 * The conversion's proof (spec § 8): no test loses its last run, and every
 * test that reads no pair is standalone. Fixtures carry only the fields of
 * Vitest's JSON reporter that readTrace reads.
 */
const report = (
  tests: {
    file: string;
    ancestors: string[];
    title: string;
    /** Vitest's status for the entry; a test that ran passed. */
    status?: string;
    trace?: { targetReads: number; workers: number; tags: string[] };
  }[],
) =>
  JSON.stringify({
    testResults: [...new Set(tests.map((t) => t.file))].map((file) => ({
      name: `/repo/tests/browser/${file}`,
      assertionResults: tests
        .filter((t) => t.file === file)
        .map((t) => ({
          ancestorTitles: t.ancestors,
          title: t.title,
          status: t.status ?? 'passed',
          meta: t.trace ? { bsqTrace: t.trace } : {},
        })),
    })),
  });

const traced = (targetReads: number, tags: string[] = []) => ({
  targetReads,
  workers: 1,
  tags,
});

describe('readTrace', () => {
  it('keys a test by its file basename and its titles, and sums its runs', () => {
    // Falsifiable: key by the full path and a moved file reads as lost.
    const trace = readTrace(
      report([
        {
          file: 'isolated/a.test.ts',
          ancestors: ['d'],
          title: 't',
          trace: traced(1),
        },
        { file: 'a.test.ts', ancestors: ['d'], title: 't', trace: traced(3) },
      ]),
    );
    expect([...trace.keys()]).toEqual(['a.test.ts › d > t']);
    expect(trace.get('a.test.ts › d > t')).toMatchObject({
      runs: 2,
      targetReads: 3,
    });
  });
});

describe('diffTraces', () => {
  it('lists the tests that lost their last run and the new ones', () => {
    // Falsifiable: compare by count instead of by key and a rename passes.
    const before = readTrace(
      report([
        { file: 'a.test.ts', ancestors: ['d'], title: 'old', trace: traced(1) },
        {
          file: 'a.test.ts',
          ancestors: ['d'],
          title: 'kept',
          trace: traced(1),
        },
      ]),
    );
    const after = readTrace(
      report([
        {
          file: 'a.test.ts',
          ancestors: ['d'],
          title: 'kept',
          trace: traced(1),
        },
        { file: 'a.test.ts', ancestors: ['d'], title: 'new', trace: traced(1) },
      ]),
    );
    expect(diffTraces(before, after)).toMatchObject({
      lost: ['a.test.ts › d > old'],
      added: ['a.test.ts › d > new'],
    });
  });

  it('counts a test reported only as skipped after the change as lost', () => {
    // Falsifiable: count every assertion result as a run and a test whose tags
    // exclude every pair (skipped in each planned cell, file still run) is
    // never reported lost.
    const before = readTrace(
      report([
        { file: 'a.test.ts', ancestors: ['d'], title: 't', trace: traced(1) },
      ]),
    );
    const after = readTrace(
      report([
        { file: 'a.test.ts', ancestors: ['d'], title: 't', status: 'skipped' },
        { file: 'a.test.ts', ancestors: ['d'], title: 'u', trace: traced(1) },
      ]),
    );
    expect(diffTraces(before, after)).toMatchObject({
      lost: ['a.test.ts › d > t'],
      added: ['a.test.ts › d > u'],
    });
    expect(diffTraces(after, before)).toMatchObject({
      lost: ['a.test.ts › d > u'],
      added: ['a.test.ts › d > t'],
    });
  });

  it('flags a test that reads no pair and is not standalone', () => {
    // Falsifiable: skip the tag check and a forgotten standalone passes.
    const after = readTrace(
      report([
        {
          file: 'a.test.ts',
          ancestors: ['d'],
          title: 'reads',
          trace: traced(2),
        },
        {
          file: 'a.test.ts',
          ancestors: ['d'],
          title: 'alone',
          trace: traced(0, ['standalone']),
        },
        {
          file: 'a.test.ts',
          ancestors: ['d'],
          title: 'forgot',
          trace: traced(0),
        },
      ]),
    );
    expect(diffTraces(after, after).unread).toEqual(['a.test.ts › d > forgot']);
  });

  it('does not flag a test that carries no trace at all', () => {
    // Falsifiable: drop the traced check and every unit test and every test
    // skipped before its afterEach reads as a forgotten standalone.
    const after = readTrace(
      report([
        { file: 'a.test.ts', ancestors: ['d'], title: 'ran', trace: traced(0) },
        { file: 'a.test.ts', ancestors: ['d'], title: 'skipped' },
      ]),
    );
    expect(diffTraces(after, after).unread).toEqual(['a.test.ts › d > ran']);
  });

  it('refuses a report with no trace in it', () => {
    // Falsifiable: a run without BSQ_TEST_TRACE=1 would compare as all-unread.
    expect(() =>
      readTrace(report([{ file: 'a.test.ts', ancestors: [], title: 't' }])),
    ).toThrow(/BSQ_TEST_TRACE/);
  });
});
