#!/usr/bin/env node
/**
 * Compares two traced runs (`BSQ_TEST_TRACE=1 node scripts/test-plan.ts …
 * --json <file>`): the tests that ran before and not after, the new ones,
 * and every test of the second run that read no pair and is not standalone
 * (spec 2026-10-12 § 8). A test is keyed by its file's basename, so a file
 * moved out of `isolated/` or `firefox/` keeps its tests.
 *
 *   node scripts/trace-diff.ts <before.json> <after.json>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export type TracedTest = {
  key: string;
  targetReads: number;
  workers: number;
  tags: string[];
  /** Runs that passed or failed; a skipped or filtered-out entry is not a run. */
  runs: number;
  /** Some run of the test carried a trace (a skipped test or a unit test has none). */
  traced: boolean;
};

type Report = {
  testResults: {
    name: string;
    assertionResults: {
      ancestorTitles: string[];
      title: string;
      status?: string;
      meta?: {
        bsqTrace?: { targetReads: number; workers: number; tags: string[] };
      };
    }[];
  }[];
};

export function readTrace(json: string): Map<string, TracedTest> {
  const report = JSON.parse(json) as Report;
  const tests = new Map<string, TracedTest>();
  let traced = 0;
  for (const file of report.testResults) {
    for (const result of file.assertionResults) {
      const key = `${basename(file.name)} › ${[...result.ancestorTitles, result.title].join(' > ')}`;
      const trace = result.meta?.bsqTrace;
      const ran = result.status === 'passed' || result.status === 'failed';
      if (trace) traced++;
      const seen = tests.get(key);
      tests.set(key, {
        key,
        targetReads: Math.max(seen?.targetReads ?? 0, trace?.targetReads ?? 0),
        workers: Math.max(seen?.workers ?? 0, trace?.workers ?? 0),
        tags: trace?.tags ?? seen?.tags ?? [],
        runs: (seen?.runs ?? 0) + (ran ? 1 : 0),
        traced: (seen?.traced ?? false) || trace !== undefined,
      });
    }
  }
  if (tests.size > 0 && traced === 0) {
    throw new Error(
      'trace-diff: no test carries a trace — run with BSQ_TEST_TRACE=1',
    );
  }
  return tests;
}

/** Keys that ran in `from` and have no run in `other` (absent or only skipped). */
const ranOnlyIn = (
  from: Map<string, TracedTest>,
  other: Map<string, TracedTest>,
): string[] =>
  [...from.values()]
    .filter((t) => t.runs > 0 && !((other.get(t.key)?.runs ?? 0) > 0))
    .map((t) => t.key)
    .sort();

export function diffTraces(
  before: Map<string, TracedTest>,
  after: Map<string, TracedTest>,
): { lost: string[]; added: string[]; unread: string[] } {
  return {
    lost: ranOnlyIn(before, after),
    added: ranOnlyIn(after, before),
    unread: [...after.values()]
      .filter(
        (t) =>
          t.traced && t.targetReads === 0 && !t.tags.includes('standalone'),
      )
      .map((t) => t.key)
      .sort(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error(
      'usage: node scripts/trace-diff.ts <before.json> <after.json>',
    );
    process.exit(2);
  }
  const { lost, added, unread } = diffTraces(
    readTrace(readFileSync(beforeFile, 'utf8')),
    readTrace(readFileSync(afterFile, 'utf8')),
  );
  for (const [title, keys] of [
    ['Lost (before, not after)', lost],
    ['Added (after, not before)', added],
    ['Read no pair and not standalone', unread],
  ] as const) {
    console.log(
      `${title} (${keys.length}):${keys.map((k) => `\n  ${k}`).join('')}`,
    );
  }
}
