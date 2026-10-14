import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SHA256,
  platformKey,
  verifyArchive,
} from '../../../scripts/actionlint.ts';

describe('actionlint', () => {
  it('maps the platforms it has a pinned build for', () => {
    expect(platformKey('linux', 'x64')).toBe('linux_amd64');
    expect(platformKey('linux', 'arm64')).toBe('linux_arm64');
    expect(platformKey('darwin', 'x64')).toBe('darwin_amd64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin_arm64');
  });

  it('refuses a platform with no pinned build', () => {
    expect(() => platformKey('win32', 'x64')).toThrow(/win32\/x64/);
    expect(() => platformKey('linux', 'ia32')).toThrow(/linux\/ia32/);
  });

  it('pins a checksum for every platform it maps', () => {
    for (const [p, a] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
    ] as const) {
      expect(ARCHIVE_SHA256[platformKey(p, a)]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts an archive matching its checksum and refuses any other', () => {
    const bytes = new TextEncoder().encode('archive');
    const good = createHash('sha256').update(bytes).digest('hex');
    expect(() => verifyArchive(bytes, good)).not.toThrow();
    expect(() => verifyArchive(bytes, '0'.repeat(64))).toThrow(/checksum/);
  });
});
