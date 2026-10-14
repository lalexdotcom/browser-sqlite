import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECK_ORDER,
  type Check,
  checksFor,
  classOf,
  FULL,
  gatherFacts,
  runChecks,
} from '../../../scripts/hook-gate.ts';

const ZERO = '0'.repeat(40);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A repository with `origin` (bare) and `main` pushed, hooks disabled. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'hook-gate-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const dir = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const write = (file: string, content = `${Math.random()}`) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  const commit = (file: string, content?: string) => {
    write(file, content);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  commit('README.md', 'base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { dir, git, write, commit };
}

describe('hook-gate checksFor', () => {
  const merges = ['pre-merge-commit', 'delivery'] as const;

  it('classes files by exclusion', () => {
    expect(classOf('.github/workflows/ci.yaml')).toBe('workflow');
    expect(classOf('.github/workflows/pages.yml')).toBe('workflow');
    expect(classOf('.github/dependabot.yml')).toBe('ignored');
    expect(classOf('.serena/memories/a.md')).toBe('ignored');
    expect(classOf('docs/x.html')).toBe('ignored');
    expect(classOf('API.md')).toBe('ignored');
    expect(classOf('README.md')).toBe('docs');
    expect(classOf('VFS.md')).toBe('docs');
    expect(classOf('src/client.ts')).toBe('code');
    expect(classOf('pnpm-lock.yaml')).toBe('code');
    expect(classOf('some/new.kind')).toBe('code');
  });

  it('runs nothing for nothing', () => {
    for (const hook of ['pre-commit', ...merges, 'pre-push'] as const) {
      expect(checksFor(hook, { files: [] })).toEqual([]);
      expect(checksFor(hook, { files: ['.serena/memories/a.md'] })).toEqual([]);
    }
  });

  it('lints a workflow, and only that, on every hook', () => {
    for (const hook of ['pre-commit', ...merges, 'pre-push'] as const) {
      expect(checksFor(hook, { files: ['.github/workflows/ci.yaml'] })).toEqual(
        ['actionlint'],
      );
    }
  });

  it('pre-commit: tsc, lint-staged and unit for code', () => {
    expect(checksFor('pre-commit', { files: ['src/a.ts'] })).toEqual([
      'tsc',
      'lint-staged',
      'unit',
    ]);
    expect(checksFor('pre-commit', { files: ['README.md'] })).toEqual([]);
  });

  it('a merge: tsc, biome, docs and test for code', () => {
    for (const hook of merges) {
      expect(checksFor(hook, { files: ['tests/unit/x.ts'] })).toEqual([
        'tsc',
        'biome',
        'docs',
        'test',
      ]);
    }
  });

  it('a merge: docs alone for the generated docs alone', () => {
    for (const hook of merges) {
      expect(checksFor(hook, { files: ['VFS.md'] })).toEqual(['docs']);
    }
  });

  it('a merge: conformance when the VFS surface moves', () => {
    for (const file of [
      'src/client.ts',
      'tests/browser/conformance/invariants.test.ts',
      'patches/wa-sqlite@1.1.2.patch',
      'pnpm-lock.yaml',
    ]) {
      for (const hook of merges) {
        expect(checksFor(hook, { files: [file] })).toContain('conformance');
      }
    }
    expect(
      checksFor('pre-merge-commit', { files: ['scripts/x.ts'] }),
    ).not.toContain('conformance');
  });

  it('a merge: bench when scripts/bench/ moves', () => {
    expect(
      checksFor('pre-merge-commit', {
        files: ['scripts/bench/html/index.html'],
      }),
    ).toEqual(['tsc', 'biome', 'docs', 'test', 'bench']);
  });

  it('pre-commit concluding a conflicted merge: the merge rules, plus lint-staged', () => {
    expect(
      checksFor('pre-commit', { files: ['src/a.ts'], merging: true }),
    ).toEqual(['tsc', 'lint-staged', 'biome', 'docs', 'test', 'conformance']);
  });

  it('pre-push: tsc, biome and docs for code; the suite only for a direct commit', () => {
    expect(checksFor('pre-push', { files: ['src/a.ts'] })).toEqual([
      'tsc',
      'biome',
      'docs',
    ]);
    expect(
      checksFor('pre-push', { files: ['src/a.ts'], directCodeCommit: true }),
    ).toEqual(['tsc', 'biome', 'docs', 'test']);
    expect(checksFor('pre-push', { files: ['README.md'] })).toEqual(['docs']);
  });

  it('pre-push: the consumer smoke for a v* tag, even with no new commit', () => {
    expect(checksFor('pre-push', { files: [], tagPushed: true })).toEqual([
      'consumer',
    ]);
  });

  it('answers in the fixed order, and the full lists use it too', () => {
    const all = checksFor('pre-merge-commit', {
      files: ['scripts/bench/x.ts', 'src/a.ts', '.github/workflows/ci.yaml'],
    });
    expect(all).toEqual(CHECK_ORDER.filter((c) => all.includes(c)));
    for (const list of Object.values(FULL)) {
      expect(list).toEqual(CHECK_ORDER.filter((c) => list.includes(c)));
    }
  });
});

describe('hook-gate gatherFacts', () => {
  it('pre-commit: the staged files, not merging', () => {
    const r = repo();
    r.write('src/a.ts');
    r.git('add', 'src/a.ts');
    r.write('src/unstaged.ts');
    expect(gatherFacts('pre-commit', { cwd: r.dir })).toEqual({
      files: ['src/a.ts'],
      merging: false,
    });
  });

  it('pre-commit: merging while a conflicted merge is concluded', () => {
    const r = repo();
    r.git('switch', '-q', '-c', 'feat');
    r.commit('src/a.ts', 'feat');
    r.git('switch', '-q', 'main');
    r.commit('src/a.ts', 'main');
    expect(() => r.git('merge', '--no-ff', 'feat')).toThrow();
    r.write('src/a.ts', 'resolved');
    r.git('add', 'src/a.ts');
    expect(gatherFacts('pre-commit', { cwd: r.dir }).merging).toBe(true);
  });

  it('pre-push: a commit made on main directly is a direct code commit', () => {
    const r = repo();
    const sha = r.commit('src/a.ts');
    const facts = gatherFacts('pre-push', {
      cwd: r.dir,
      stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    });
    expect(facts).toEqual({
      files: ['src/a.ts'],
      directCodeCommit: true,
      tagPushed: false,
    });
  });

  it('pre-push: commits merged from a branch are not direct', () => {
    const r = repo();
    r.git('switch', '-q', '-c', 'feat');
    r.commit('src/a.ts');
    r.git('switch', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'merge', 'feat');
    const sha = r.git('rev-parse', 'HEAD');
    const facts = gatherFacts('pre-push', {
      cwd: r.dir,
      stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    });
    expect(facts.files).toEqual(['src/a.ts']);
    expect(facts.directCodeCommit).toBe(false);
  });

  it('pre-push: a direct commit of docs only is not a direct code commit', () => {
    const r = repo();
    const sha = r.commit('.serena/memories/x.md');
    expect(
      gatherFacts('pre-push', {
        cwd: r.dir,
        stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
      }).directCodeCommit,
    ).toBe(false);
  });

  it('pre-push: the release push, main and its tag together', () => {
    const r = repo();
    const sha = r.commit('package.json', '{}');
    r.git('tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
    const tag = r.git('rev-parse', 'v1.2.3');
    const facts = gatherFacts('pre-push', {
      cwd: r.dir,
      stdin:
        `refs/heads/main ${sha} refs/heads/main ${ZERO}\n` +
        `refs/tags/v1.2.3 ${tag} refs/tags/v1.2.3 ${ZERO}\n`,
    });
    expect(facts.directCodeCommit).toBe(true);
    expect(facts.tagPushed).toBe(true);
    expect(facts.files).toEqual(['package.json']);
  });

  it('pre-push: a tag alone on a pushed commit brings no file', () => {
    const r = repo();
    r.git('tag', 'v1.2.3');
    const sha = r.git('rev-parse', 'v1.2.3');
    expect(
      gatherFacts('pre-push', {
        cwd: r.dir,
        stdin: `refs/tags/v1.2.3 ${sha} refs/tags/v1.2.3 ${ZERO}\n`,
      }),
    ).toEqual({ files: [], directCodeCommit: false, tagPushed: true });
  });

  it('pre-push: a v* tag created on the remote from another local ref', () => {
    const r = repo();
    const sha = r.git('rev-parse', 'HEAD');
    // git push origin HEAD:refs/tags/v1.2.3 — no local tag exists.
    expect(
      gatherFacts('pre-push', {
        cwd: r.dir,
        stdin: `HEAD ${sha} refs/tags/v1.2.3 ${ZERO}\n`,
      }).tagPushed,
    ).toBe(true);
  });

  it('pre-push: a deleted ref triggers nothing, a v* tag included', () => {
    const r = repo();
    const remote = r.git('rev-parse', 'HEAD');
    expect(
      gatherFacts('pre-push', {
        cwd: r.dir,
        stdin:
          `(delete) ${ZERO} refs/heads/feat ${remote}\n` +
          `(delete) ${ZERO} refs/tags/v1.2.3 ${remote}\n`,
      }),
    ).toEqual({ files: [], directCodeCommit: false, tagPushed: false });
  });

  it('pre-push: a new branch counts its own commits only', () => {
    const r = repo();
    r.git('switch', '-q', '-c', 'feat');
    const sha = r.commit('src/a.ts');
    const facts = gatherFacts('pre-push', {
      cwd: r.dir,
      stdin: `refs/heads/feat ${sha} refs/heads/feat ${ZERO}\n`,
    });
    expect(facts.files).toEqual(['src/a.ts']);
    expect(facts.directCodeCommit).toBe(true);
  });

  it('delivery: the branch against main, uncommitted and untracked files', () => {
    const r = repo();
    r.git('switch', '-q', '-c', 'feat');
    r.commit('src/a.ts');
    r.write('README.md', 'changed');
    r.write('scripts/bench/new.ts');
    expect([...gatherFacts('delivery', { cwd: r.dir }).files].sort()).toEqual([
      'README.md',
      'scripts/bench/new.ts',
      'src/a.ts',
    ]);
  });
});

describe('hook-gate CLI', () => {
  it('pre-push with no refs on stdin says so instead of "nothing to check"', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../../../scripts/hook-gate.ts'), 'pre-push'],
      { input: '', encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/pre-push — no refs on stdin/);
    expect(result.stderr).not.toMatch(/nothing to check/);
  });
});

describe('hook-gate runChecks', () => {
  it('runs every step in order and stops at the first failure, with its code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-gate-run-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const touch = (name: string) => ({
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(join(dir, name))}, '')`,
      ],
    });
    const fail = { argv: [process.execPath, '-e', 'process.exit(3)'] };
    const commands = Object.fromEntries(
      CHECK_ORDER.map((check) => [check, [touch(check)]]),
    ) as unknown as Record<Check, { argv: string[] }[]>;
    commands.biome = [touch('biome-1'), fail, touch('biome-2')];
    expect(runChecks(['tsc', 'biome', 'test'], { commands })).toBe(3);
    expect(existsSync(join(dir, 'tsc'))).toBe(true);
    expect(existsSync(join(dir, 'biome-1'))).toBe(true);
    expect(existsSync(join(dir, 'biome-2'))).toBe(false);
    expect(existsSync(join(dir, 'test'))).toBe(false);
  });

  it('passes a step its environment', () => {
    const commands = {
      bench: [
        {
          argv: [
            process.execPath,
            '-e',
            'process.exit(process.env.BENCH_PORT === "8123" ? 0 : 4)',
          ],
          env: { BENCH_PORT: '8123' },
        },
      ],
    } as unknown as Record<Check, { argv: string[] }[]>;
    expect(runChecks(['bench'], { commands })).toBe(0);
  });

  it('answers 0 for nothing to run', () => {
    expect(runChecks([])).toBe(0);
  });
});
