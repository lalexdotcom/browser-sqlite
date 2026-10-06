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
