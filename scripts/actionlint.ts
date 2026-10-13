#!/usr/bin/env node
/**
 * actionlint at a pinned version, checked against its release checksum.
 *
 *   node scripts/actionlint.ts install   download and verify it into
 *                                        node_modules/.cache/actionlint
 *   node scripts/actionlint.ts           lint .github/workflows/ (installs
 *                                        first if missing)
 *
 * actionlint passes every `run:` block to shellcheck only when shellcheck is
 * on the PATH, and says nothing when it is not: linting refuses to run
 * without it rather than check less.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACTIONLINT_VERSION = '1.7.12';

/** SHA-256 of each release archive, from actionlint_1.7.12_checksums.txt. */
export const ARCHIVE_SHA256: Readonly<Record<string, string>> = {
  linux_amd64:
    '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  linux_arm64:
    '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
  darwin_amd64:
    '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
  darwin_arm64:
    'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(
  root,
  'node_modules/.cache/actionlint',
  ACTIONLINT_VERSION,
);
const binary = join(cacheDir, 'actionlint');

export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'linux' || platform === 'darwin' ? platform : null;
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) {
    throw new Error(`actionlint: no pinned build for ${platform}/${arch}`);
  }
  return `${os}_${cpu}`;
}

export function verifyArchive(bytes: Uint8Array, expected: string): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `actionlint: checksum mismatch (expected ${expected}, got ${actual})`,
    );
  }
}

export async function install(): Promise<string> {
  if (existsSync(binary)) return binary;
  const key = platformKey();
  const name = `actionlint_${ACTIONLINT_VERSION}_${key}.tar.gz`;
  const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${name}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`actionlint: ${url} answered ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyArchive(bytes, ARCHIVE_SHA256[key] ?? '');
  mkdirSync(cacheDir, { recursive: true });
  // Extracted aside, then renamed: an interrupted install leaves no binary
  // that `existsSync` would take for a complete one.
  const staging = mkdtempSync(join(cacheDir, 'staging-'));
  try {
    const archive = join(staging, name);
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', staging, 'actionlint']);
    renameSync(join(staging, 'actionlint'), binary);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return binary;
}

function lint(bin: string): number {
  const probe = spawnSync('shellcheck', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    console.error(
      'actionlint: shellcheck is not on the PATH (apt-get install shellcheck, brew install shellcheck); without it every run: block would go unchecked',
    );
    return 1;
  }
  return spawnSync(bin, [], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

async function main(): Promise<number> {
  const bin = await install();
  if (process.argv[2] === 'install') {
    console.log(`actionlint ${ACTIONLINT_VERSION}: ${bin}`);
    return 0;
  }
  return lint(bin);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
