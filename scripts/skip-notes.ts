/**
 * A Vitest reporter that prints every test skipped with a reason
 * (`ctx.skip(note)`), grouped by reason, after a merged report — then every
 * test that passed only on its retry (`timeoutRetry`, scripts/processes.ts),
 * then every test whose case was not reached (`exercised`,
 * tests/browser/helpers/exercised.ts).
 *
 * A browser-defect skip shows its reason in every run's output
 * (`mem:conventions`), and the default reporter prints a test line, hence its
 * `[note]`, only for a failed module once several files are merged.
 * `scripts/test-plan.ts` adds it to `--merge-reports`.
 */
import { relative } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';

/**
 * One test in one cell; `note` only when it skipped with a reason, `retried`
 * (its retry count) only when it passed on a retry.
 */
export type TestOutcome = {
  file: string;
  test: string;
  cell: string;
  note?: string | undefined;
  retried?: number | undefined;
  /** Why its case was not reached, when it was not. */
  notExercised?: string | undefined;
};

export function formatSkipNotes(outcomes: readonly TestOutcome[]): string {
  const cellsOf = new Map<string, number>();
  // reason → test → skipped cells
  const byNote = new Map<string, Map<string, string[]>>();
  for (const { file, test, cell, note } of outcomes) {
    const key = `${file} › ${test}`;
    cellsOf.set(key, (cellsOf.get(key) ?? 0) + 1);
    if (note === undefined) continue;
    const tests = byNote.get(note) ?? new Map<string, string[]>();
    byNote.set(note, tests);
    tests.set(key, [...(tests.get(key) ?? []), cell]);
  }
  if (byNote.size === 0) return '';
  const count = [...byNote.values()].reduce((n, t) => n + t.size, 0);
  const lines = [
    '',
    `Skipped with a reason (${count} test${count > 1 ? 's' : ''})`,
  ];
  for (const note of [...byNote.keys()].sort()) {
    lines.push(`  ${note}`);
    const tests = byNote.get(note) as Map<string, string[]>;
    for (const key of [...tests.keys()].sort()) {
      const skipped = (tests.get(key) as string[]).sort();
      const ran = cellsOf.get(key) as number;
      lines.push(
        `    ${key}`,
        skipped.length === ran
          ? `      on every cell that ran it (${ran})`
          : `      on ${skipped.length} of ${ran} cells: ${skipped.join(', ')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The tests that passed on a retry, each with its cells. A pass on retry is a
 * pass, but one a starved runner may not be the only cause of: the report
 * says so and lists them.
 */
export function formatRetried(outcomes: readonly TestOutcome[]): string {
  // test → cells where it passed on its retry
  const cellsOf = new Map<string, string[]>();
  for (const { file, test, cell, retried } of outcomes) {
    if (!retried) continue;
    const key = `${file} › ${test}`;
    cellsOf.set(key, [...(cellsOf.get(key) ?? []), cell]);
  }
  if (cellsOf.size === 0) return '';
  const count = cellsOf.size;
  const lines = [
    '',
    `Passed on retry (${count} test${count > 1 ? 's' : ''}) — it ran out of time first: look at it`,
  ];
  for (const key of [...cellsOf.keys()].sort()) {
    lines.push(
      `  ${key}`,
      `    on ${(cellsOf.get(key) as string[]).sort().join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The tests whose case was not reached, by reason, each with its cells: a pass
 * that proved nothing, which the report says rather than counting it green.
 */
export function formatNotExercised(outcomes: readonly TestOutcome[]): string {
  // reason → test → cells
  const byReason = new Map<string, Map<string, string[]>>();
  for (const { file, test, cell, notExercised } of outcomes) {
    if (notExercised === undefined) continue;
    const tests = byReason.get(notExercised) ?? new Map<string, string[]>();
    byReason.set(notExercised, tests);
    const key = `${file} › ${test}`;
    tests.set(key, [...(tests.get(key) ?? []), cell]);
  }
  if (byReason.size === 0) return '';
  const count = [...byReason.values()].reduce((n, t) => n + t.size, 0);
  const lines = [
    '',
    `Not exercised (${count} test${count > 1 ? 's' : ''}) — a precondition was not reached, nothing was proven: look at it`,
  ];
  for (const reason of [...byReason.keys()].sort()) {
    lines.push(`  ${reason}`);
    const tests = byReason.get(reason) as Map<string, string[]>;
    for (const key of [...tests.keys()].sort()) {
      lines.push(
        `    ${key}`,
        `      on ${(tests.get(key) as string[]).sort().join(', ')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export default class SkipNotesReporter implements Reporter {
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    if (this.vitest === undefined) return;
    const root = this.vitest.config.root;
    const outcomes: TestOutcome[] = [];
    for (const module of modules) {
      for (const test of module.children.allTests()) {
        const result = test.result();
        const diagnostic = test.diagnostic();
        outcomes.push({
          file: relative(root, module.moduleId),
          test: test.fullName,
          cell: test.project.name,
          note: result.state === 'skipped' ? result.note : undefined,
          retried: diagnostic?.flaky ? diagnostic.retryCount : undefined,
          notExercised: test
            .annotations()
            .find((annotation) => annotation.type === 'not-exercised')?.message,
        });
      }
    }
    const text =
      formatSkipNotes(outcomes) +
      formatRetried(outcomes) +
      formatNotExercised(outcomes);
    if (text !== '') this.vitest.logger.log(text);
  }
}
