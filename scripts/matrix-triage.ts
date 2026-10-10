#!/usr/bin/env node
/**
 * Turns a `.matrix/<run>/` directory into something a human can triage.
 *
 *   node scripts/matrix-triage.ts .matrix/<run>
 *
 * Each cell file is Vitest's own JSON report. The failures in it are individually
 * uninteresting — ~200 reds across 66 cells are a few dozen distinct causes
 * repeated. This groups them by (test file, test name, error shape) and says
 * WHICH cells each group hit, which is what tells a test that assumes a VFS
 * capability apart from a defect of the VFS itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/matrix-triage.ts .matrix/<run>');
  process.exit(2);
}

type Assertion = {
  ancestorTitles: string[];
  title: string;
  status: string;
  failureMessages: string[];
};
type Report = {
  success: boolean;
  testResults: { name: string; assertionResults: Assertion[] }[];
};
type Failure = { file: string; name: string; type: string; message: string };

const ROOT = process.cwd();

/** `chrome__OPFSWriteAheadVFS__sync.json` → `chrome OPFSWriteAheadVFS/sync`. */
const cellOf = (file: string) => {
  const [config, vfs, build] = basename(file, '.json').split('__');
  return { config, vfs, build, label: `${config} ${vfs}/${build}` };
};

/** The parsed report, or null when the run never wrote a readable one. */
const reportOf = (text: string): Report | null => {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.testResults) ? parsed : null;
  } catch {
    return null;
  }
};

/** Failed tests of a report: `Error: msg` → type `Error`, message `msg`. */
const failuresOf = (report: Report): Failure[] =>
  report.testResults.flatMap((f) =>
    f.assertionResults
      .filter((t) => t.status === 'failed')
      .map((t) => {
        const first = t.failureMessages[0] ?? '';
        const colon = first.indexOf(':');
        return {
          file: relative(ROOT, f.name),
          name: [...t.ancestorTitles, t.title].join(' > '),
          type: colon === -1 ? 'unknown' : first.slice(0, colon),
          message: (colon === -1 ? first : first.slice(colon + 1))
            .trim()
            .replace(/\n/g, ' ')
            .slice(0, 110),
        };
      }),
  );

/** Messages differ by uuid, ms and ids; group on their shape, not their text. */
const shapeOf = (message: string) =>
  message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<t>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 90);

const cells: (ReturnType<typeof cellOf> & {
  status: string;
  tests: number;
  failed: number;
  skipped: number;
  listed: number;
})[] = [];
const groups = new Map<string, Failure & { shape: string; cells: string[] }>();

for (const entry of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cell = cellOf(entry);
  const report = reportOf(readFileSync(join(dir, entry), 'utf8'));
  const failures = report ? failuresOf(report) : [];
  const tests = report?.testResults.flatMap((f) => f.assertionResults) ?? [];
  cells.push({
    ...cell,
    status: report
      ? report.success
        ? 'pass'
        : 'fail'
      : 'NO REPORT (killed or never started)',
    tests: tests.length,
    failed: failures.length,
    skipped: tests.filter((t) =>
      ['skipped', 'pending', 'todo'].includes(t.status),
    ).length,
    listed: failures.length,
  });
  for (const failure of failures) {
    const key = `${failure.file}\0${failure.name}\0${failure.type}\0${shapeOf(failure.message)}`;
    const group = groups.get(key) ?? {
      ...failure,
      shape: shapeOf(failure.message),
      cells: [],
    };
    group.cells.push(cell.label);
    groups.set(key, group);
  }
}

const byCells = [...groups.values()].sort(
  (a, b) => b.cells.length - a.cells.length,
);
const vfsOf = (label: string) => label.split(' ')[1].split('/')[0];

console.log(`# Matrix triage — ${dir}\n`);
console.log(`## Cells (${cells.length})\n`);
console.log('| cell | status | tests | failed | skipped |');
console.log('| --- | --- | ---: | ---: | ---: |');
for (const c of cells.sort((a, b) => a.label.localeCompare(b.label))) {
  console.log(
    `| ${c.label} | ${c.status} | ${c.tests} | ${c.failed} | ${c.skipped} |`,
  );
}

console.log(`\n## Distinct failures (${byCells.length} groups)\n`);
console.log('| # cells | VFS hit | test file | test | error |');
console.log('| ---: | --- | --- | --- | --- |');
for (const g of byCells) {
  const vfs = [...new Set(g.cells.map(vfsOf))].join(', ');
  console.log(
    `| ${g.cells.length} | ${vfs} | ${g.file.replace('tests/browser/', '')} | ${g.name.slice(0, 80)} | ${g.type}: ${g.shape} |`,
  );
}

const totalListed = cells.reduce((n, c) => n + c.listed, 0);
const totalFailed = cells.reduce((n, c) => n + c.failed, 0);
console.log(
  `\n${totalFailed} failing tests across ${cells.length} cells; ${totalListed} listed in reports; ${byCells.length} distinct groups.`,
);
