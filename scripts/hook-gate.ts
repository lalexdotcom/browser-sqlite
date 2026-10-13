#!/usr/bin/env node
/**
 * Decides whether a git hook has anything to check.
 *
 *   node scripts/hook-gate.ts <pre-commit|pre-merge-commit|pre-push>
 *
 * Exit code: 0 = run the full checks, 10 = only the generated docs
 * (`pnpm docs:vfs`), 11 = nothing to check. Any other code — an internal error
 * included — makes the hook fall back to the full checks.
 *
 * Paths are classified by exclusion: what is not known to be ignorable runs
 * the checks, so a new kind of file is checked by default.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Hook = 'pre-commit' | 'pre-merge-commit' | 'pre-push';
export type Decision = 'full' | 'docs' | 'skip';

const IGNORED_DIRS = ['.github/', '.serena/', 'docs/', '.claude/'];
// `pnpm docs:vfs` generates spans of these two, which only pre-push checks.
const GENERATED_DOCS = ['README.md', 'VFS.md'];

const isDocs = (file: string) => GENERATED_DOCS.includes(file);
const isIgnored = (file: string) =>
  IGNORED_DIRS.some((dir) => file.startsWith(dir)) ||
  (file.endsWith('.md') && !isDocs(file));

export function classify(files: readonly string[], hook: Hook): Decision {
  let docs = false;
  for (const file of files) {
    if (isDocs(file)) docs = true;
    else if (!isIgnored(file)) return 'full';
  }
  return docs && hook === 'pre-push' ? 'docs' : 'skip';
}

export type Check =
  | 'tsc'
  | 'lint-staged'
  | 'biome'
  | 'actionlint'
  | 'docs'
  | 'unit'
  | 'test'
  | 'conformance'
  | 'bench'
  | 'consumer';

/** The order checks run in: cheap first, so a fast failure comes first. */
export const CHECK_ORDER: readonly Check[] = [
  'tsc',
  'lint-staged',
  'biome',
  'actionlint',
  'docs',
  'unit',
  'test',
  'conformance',
  'bench',
  'consumer',
];

export type GateHook = Hook | 'delivery';
export const HOOKS: readonly GateHook[] = [
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'delivery',
];

export type FileClass = 'workflow' | 'ignored' | 'docs' | 'code';

export type Facts = {
  /** The files at stake for this hook. */
  files: readonly string[];
  /** pre-commit only: a conflicted merge is being concluded. */
  merging?: boolean;
  /** pre-push only: a pushed branch carries a non-merge, first-parent commit touching code. */
  directCodeCommit?: boolean;
  /** pre-push only: a `refs/tags/v*` ref is pushed. */
  tagPushed?: boolean;
};

// What conformance depends on besides its tests: the VFS code, the wa-sqlite
// patch, and the wa-sqlite pin, which lives in the lockfile.
const CONFORMANCE_PATHS = [
  'src/',
  'tests/conformance/',
  'patches/',
  'pnpm-lock.yaml',
];
const BENCH_PATHS = ['scripts/bench/'];

export function classOf(file: string): FileClass {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return 'workflow';
  if (isDocs(file)) return 'docs';
  if (isIgnored(file)) return 'ignored';
  return 'code';
}

const touches = (files: readonly string[], paths: readonly string[]) =>
  files.some((file) =>
    paths.some((path) => file === path || file.startsWith(path)),
  );

/** What runs when the facts cannot be gathered. */
export const FULL: Readonly<Record<GateHook, readonly Check[]>> = {
  'pre-commit': ['tsc', 'lint-staged', 'test'],
  'pre-merge-commit': [
    'tsc',
    'biome',
    'actionlint',
    'docs',
    'test',
    'conformance',
    'bench',
  ],
  'pre-push': ['tsc', 'biome', 'actionlint', 'docs', 'test'],
  delivery: [
    'tsc',
    'biome',
    'actionlint',
    'docs',
    'test',
    'conformance',
    'bench',
  ],
};

export function checksFor(hook: GateHook, facts: Facts): Check[] {
  const classes = new Set(facts.files.map(classOf));
  const code = classes.has('code');
  const docsOnly = !code && classes.has('docs');
  const out = new Set<Check>();
  if (classes.has('workflow')) out.add('actionlint');

  const mergeRules =
    hook === 'pre-merge-commit' ||
    hook === 'delivery' ||
    (hook === 'pre-commit' && facts.merging === true);

  if (mergeRules) {
    if (code) {
      for (const check of ['tsc', 'biome', 'docs', 'test'] as const) {
        out.add(check);
      }
      if (hook === 'pre-commit') out.add('lint-staged');
      if (touches(facts.files, CONFORMANCE_PATHS)) out.add('conformance');
      if (touches(facts.files, BENCH_PATHS)) out.add('bench');
    } else if (docsOnly) {
      out.add('docs');
    }
  } else if (hook === 'pre-commit') {
    if (code) {
      for (const check of ['tsc', 'lint-staged', 'unit'] as const) {
        out.add(check);
      }
    }
  } else {
    if (code) {
      for (const check of ['tsc', 'biome', 'docs'] as const) out.add(check);
    } else if (docsOnly) {
      out.add('docs');
    }
    if (facts.directCodeCommit) out.add('test');
    if (facts.tagPushed) out.add('consumer');
  }
  return CHECK_ORDER.filter((check) => out.has(check));
}

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(Boolean);

/** The files the hook is about to check, one path per entry. */
function changedFiles(hook: Hook): string[] {
  if (hook !== 'pre-push') {
    return git('diff', '--cached', '--no-renames', '--name-only');
  }
  // stdin lines: <local ref> <local sha> <remote ref> <remote sha>. Only the
  // commits no remote branch has yet count, so a tag on a pushed commit is empty.
  const files: string[] = [];
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    const sha = line.split(' ')[1];
    if (!sha || /^0+$/.test(sha)) continue;
    files.push(
      ...git(
        'log',
        '--no-renames',
        '--name-only',
        '--format=',
        sha,
        '--not',
        '--remotes',
      ),
    );
  }
  return files;
}

function main() {
  const hook = process.argv[2];
  if (
    hook !== 'pre-commit' &&
    hook !== 'pre-merge-commit' &&
    hook !== 'pre-push'
  ) {
    throw new Error(`unknown hook: ${hook}`);
  }
  const decision = classify(changedFiles(hook), hook);
  if (decision === 'full') return;
  console.error(
    decision === 'skip'
      ? `hook-gate: ${hook} — no code changed, checks skipped`
      : `hook-gate: ${hook} — only generated docs changed, docs check only`,
  );
  process.exitCode = decision === 'skip' ? 11 : 10;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
