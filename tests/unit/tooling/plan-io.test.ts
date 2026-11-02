import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { namedTestFiles } from '../../../scripts/plan-io.ts';

describe('namedTestFiles', () => {
  it('finds a file argument among the files Vitest globbed', () => {
    const globbed = ['/repo/tests/a.test.ts', '/repo/tests/b.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/b.test.ts'], posix, '/repo'),
    ).toEqual(['/repo/tests/b.test.ts']);
  });

  it('keeps nothing for an argument that names no test file', () => {
    const globbed = ['/repo/tests/a.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/typo.test.ts'], posix, '/repo'),
    ).toEqual([]);
  });

  // Falsifiable: compare `resolve(root, file)` with the globbed path, as
  // before — on Windows it has `\` and Vitest's paths `/`, so nothing matches
  // (seen on windows-latest, 2026-10-30).
  it("finds it on Windows, where Vitest globs with '/' and resolve() gives '\\'", () => {
    const globbed = ['C:/repo/tests/a.test.ts', 'C:/repo/tests/b.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/b.test.ts'], win32, 'C:\\repo'),
    ).toEqual(['C:/repo/tests/b.test.ts']);
    expect(
      namedTestFiles(globbed, ['tests\\a.test.ts'], win32, 'C:\\repo'),
    ).toEqual(['C:/repo/tests/a.test.ts']);
  });
});
