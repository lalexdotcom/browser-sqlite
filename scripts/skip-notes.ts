/**
 * A Vitest reporter that prints every test skipped with a reason
 * (`ctx.skip(note)`), grouped by reason, after a merged report.
 *
 * A browser-defect skip shows its reason in every run's output
 * (`mem:conventions`), and the default reporter prints a test line, hence its
 * `[note]`, only for a failed module once several files are merged.
 * `scripts/test-plan.ts` adds it to `--merge-reports`.
 */
import { relative } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';

/** One test in one cell; `note` only when it skipped with a reason. */
export type TestOutcome = {
  file: string;
  test: string;
  cell: string;
  note?: string | undefined;
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
        outcomes.push({
          file: relative(root, module.moduleId),
          test: test.fullName,
          cell: test.project.name,
          note: result.state === 'skipped' ? result.note : undefined,
        });
      }
    }
    const text = formatSkipNotes(outcomes);
    if (text !== '') this.vitest.logger.log(text);
  }
}
