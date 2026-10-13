import { describe, expect, it } from 'vitest';
import {
  CHECK_ORDER,
  checksFor,
  classify,
  classOf,
  FULL,
} from '../../scripts/hook-gate.ts';

const hooks = ['pre-commit', 'pre-merge-commit', 'pre-push'] as const;

describe('hook-gate classify', () => {
  it('skips a change limited to workflows, on every hook', () => {
    for (const hook of hooks) {
      expect(classify(['.github/workflows/ci.yml'], hook)).toBe('skip');
    }
  });

  it('skips a change limited to Serena memories, on every hook', () => {
    for (const hook of hooks) {
      expect(
        classify(['.serena/memories/a.md', '.serena/project.yml'], hook),
      ).toBe('skip');
    }
  });

  it('skips docs/, .claude/ and root markdown other than README and VFS', () => {
    for (const hook of hooks) {
      expect(
        classify(
          [
            'docs/guide.html',
            '.claude/settings.json',
            'API.md',
            'CHANGELOG.md',
          ],
          hook,
        ),
      ).toBe('skip');
    }
  });

  it('ignores a markdown file that is not at the repository root', () => {
    expect(classify(['tests/foo.md'], 'pre-push')).toBe('skip');
    expect(classify(['src/NOTES.md'], 'pre-commit')).toBe('skip');
  });

  it('checks README.md and VFS.md on pre-push only', () => {
    expect(classify(['README.md'], 'pre-push')).toBe('docs');
    expect(classify(['VFS.md'], 'pre-push')).toBe('docs');
    expect(classify(['README.md'], 'pre-commit')).toBe('skip');
    expect(classify(['VFS.md'], 'pre-merge-commit')).toBe('skip');
  });

  it('runs everything for any other path', () => {
    for (const file of [
      'src/x.ts',
      'package.json',
      'pnpm-lock.yaml',
      'patches/x.patch',
      'scripts/x.ts',
      'LICENSE',
    ]) {
      for (const hook of hooks) {
        expect(classify([file], hook)).toBe('full');
      }
    }
  });

  it('runs everything when one code file is among ignored ones', () => {
    for (const hook of hooks) {
      expect(
        classify(['.github/ci.yml', 'README.md', 'src/x.ts', 'API.md'], hook),
      ).toBe('full');
    }
  });

  it('prefers full over docs on pre-push', () => {
    expect(classify(['README.md', 'src/x.ts'], 'pre-push')).toBe('full');
  });

  it('skips an empty list', () => {
    for (const hook of hooks) {
      expect(classify([], hook)).toBe('skip');
    }
  });
});

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
      'tests/conformance/invariants.test.ts',
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
