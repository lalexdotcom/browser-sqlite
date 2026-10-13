#!/usr/bin/env node
/**
 * Decides which checks a git hook runs, and runs them.
 *
 *   node scripts/hook-gate.ts <hook>         print the decision only
 *   node scripts/hook-gate.ts <hook> --run   run the checks in order and stop
 *                                            at the first failure, with its code
 *
 * Hooks: pre-commit, pre-merge-commit, pre-push (reads git's stdin), and
 * `delivery` — the merge rules applied to the branch against `main`, the
 * verification before a piece of work is reported.
 *
 * Paths are classified by exclusion: what is not known to be ignorable is
 * code, so a new kind of file is checked by default. If the facts cannot be
 * gathered, the hook's full list runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORED_DIRS = ['.github/', '.serena/', 'docs/', '.claude/'];
// `pnpm docs:vfs` generates spans of these two.
const GENERATED_DOCS = ['README.md', 'VFS.md'];

const isDocs = (file: string) => GENERATED_DOCS.includes(file);
const isIgnored = (file: string) =>
  IGNORED_DIRS.some((dir) => file.startsWith(dir)) ||
  (file.endsWith('.md') && !isDocs(file));

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

export type Hook = 'pre-commit' | 'pre-merge-commit' | 'pre-push' | 'delivery';
export const HOOKS: readonly Hook[] = [
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
export const FULL: Readonly<Record<Hook, readonly Check[]>> = {
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

export function checksFor(hook: Hook, facts: Facts): Check[] {
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(Boolean);

const staged = (cwd: string) =>
  git(cwd, 'diff', '--cached', '--no-renames', '--name-only');

export function gatherFacts(
  hook: Hook,
  { cwd = process.cwd(), stdin = '' }: { cwd?: string; stdin?: string } = {},
): Facts {
  switch (hook) {
    case 'pre-commit': {
      const [mergeHead = 'MERGE_HEAD'] = git(
        cwd,
        'rev-parse',
        '--git-path',
        'MERGE_HEAD',
      );
      return {
        files: staged(cwd),
        merging: existsSync(resolve(cwd, mergeHead)),
      };
    }
    case 'pre-merge-commit':
      // For a merge, the index against HEAD is what the merge brings.
      return { files: staged(cwd) };
    case 'delivery':
      return {
        files: [
          ...new Set([
            ...git(cwd, 'diff', '--no-renames', '--name-only', 'main...HEAD'),
            ...git(cwd, 'diff', '--no-renames', '--name-only', 'HEAD'),
            ...git(cwd, 'ls-files', '--others', '--exclude-standard'),
          ]),
        ],
      };
    case 'pre-push': {
      // stdin lines: <local ref> <local sha> <remote ref> <remote sha>. Only
      // the commits no remote has yet count; a deleted ref has a zero sha.
      const files = new Set<string>();
      let directCodeCommit = false;
      let tagPushed = false;
      for (const line of stdin.split('\n')) {
        const [localRef, sha] = line.split(' ');
        if (!localRef || !sha || /^0+$/.test(sha)) continue;
        if (localRef.startsWith('refs/tags/v')) tagPushed = true;
        for (const file of git(
          cwd,
          'log',
          '--no-renames',
          '--name-only',
          '--format=',
          sha,
          '--not',
          '--remotes',
        )) {
          files.add(file);
        }
        // First parent only: a commit that came in through a merge was
        // already tested by pre-merge-commit.
        const direct = git(
          cwd,
          'log',
          '--first-parent',
          '--no-merges',
          '--format=%H',
          sha,
          '--not',
          '--remotes',
        );
        directCodeCommit ||= direct.some((commit) =>
          git(
            cwd,
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--no-renames',
            '--name-only',
            '-r',
            commit,
          ).some((file) => classOf(file) === 'code'),
        );
      }
      return { files: [...files], directCodeCommit, tagPushed };
    }
  }
}

export type Step = {
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export const COMMANDS: Readonly<Record<Check, readonly Step[]>> = {
  tsc: [{ argv: ['pnpm', 'exec', 'tsc', '--noEmit'] }],
  'lint-staged': [{ argv: ['npx', 'lint-staged'] }],
  biome: [{ argv: ['pnpm', 'exec', 'biome', 'ci', '.'] }],
  actionlint: [{ argv: ['node', 'scripts/actionlint.ts'] }],
  docs: [
    { argv: ['pnpm', 'docs:vfs'] },
    { argv: ['git', 'diff', '--exit-code', 'VFS.md', 'README.md'] },
  ],
  unit: [{ argv: ['pnpm', 'test:unit'] }],
  test: [{ argv: ['pnpm', 'test'] }],
  conformance: [{ argv: ['pnpm', 'test:conformance'] }],
  // 8123, not bench:serve's 8099: the checker kills whatever holds its port.
  bench: [
    { argv: ['pnpm', 'bench:build'] },
    {
      argv: ['node', 'scripts/bench/check.ts', 'chrome', '--all'],
      env: { BENCH_PORT: '8123' },
    },
  ],
  consumer: [{ argv: ['pnpm', 'test:consumer'] }],
};

export function runChecks(
  checks: readonly Check[],
  {
    cwd,
    commands = COMMANDS,
  }: {
    cwd?: string;
    commands?: Readonly<Record<Check, readonly Step[]>>;
  } = {},
): number {
  for (const check of checks) {
    for (const step of commands[check]) {
      const [command = '', ...args] = step.argv;
      const result = spawnSync(command, args, {
        cwd,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...step.env },
      });
      if (result.status !== 0) {
        console.error(
          `hook-gate: ${check} failed — ${step.argv.join(' ')} (${result.error?.message ?? `exit ${result.status ?? result.signal}`})`,
        );
        return result.status || 1;
      }
    }
  }
  return 0;
}

function main(argv: readonly string[]): number {
  const [name, flag] = argv;
  const hook = HOOKS.find((h) => h === name);
  if (!hook) throw new Error(`unknown hook: ${name}`);
  let checks: readonly Check[];
  try {
    // A terminal on stdin means a hand run: reading it would wait forever.
    const stdin =
      hook === 'pre-push' && !process.stdin.isTTY
        ? readFileSync(0, 'utf8')
        : '';
    checks = checksFor(hook, gatherFacts(hook, { stdin }));
  } catch (error) {
    checks = FULL[hook];
    console.error(
      `hook-gate: ${hook} — could not read the change (${error instanceof Error ? error.message : error}), running the full list`,
    );
  }
  console.error(
    `hook-gate: ${hook} — ${checks.length > 0 ? checks.join(', ') : 'nothing to check'}`,
  );
  return flag === '--run' ? runChecks(checks) : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
