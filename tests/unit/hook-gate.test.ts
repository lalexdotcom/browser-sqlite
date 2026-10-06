import { describe, expect, it } from '@rstest/core';
import { classify } from '../../scripts/hook-gate.ts';

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
