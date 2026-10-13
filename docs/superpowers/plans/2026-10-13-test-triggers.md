# Test triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every check runs where the spec puts it: the hooks decide per change (conformance and bench on the merge when their files move, the suite on a push only for a direct commit, the consumer smoke on a `v*` tag), workflows are linted, the package metadata is linted at release, the bench page is checked by Pages, and a release reuses the CI and matrix runs of the push of `main`.

**Architecture:** `scripts/hook-gate.ts` becomes a pure decision (`checksFor(hook, facts)`), a fact gatherer over git (`gatherFacts`), and a runner (`runChecks`); every hook command calls `node scripts/hook-gate.ts <hook> --run`. `scripts/actionlint.ts` pins and verifies actionlint. The workflows change in place: `ci.yaml` loses `consumer-smoke` and gains actionlint, `release-and-publish.yaml` gains a `prior` job that reuses the runs of the push of `main`, `pages.yaml` checks the bench half it builds.

**Tech Stack:** Node 24 (TypeScript run directly), TypeScript 7 (`tsc --noEmit`), Biome, Vitest 5.0.3 (`unit` project), git, GitHub Actions, `gh`, actionlint 1.7.12 + shellcheck, publint 0.3.24, `@arethetypeswrong/cli` 0.18.5, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-13-test-triggers-design.md` (approved 2026-10-13).

## Global Constraints

- One branch, `ci/test-triggers`, already created off `main` and holding the spec. Every commit green: `pnpm exec tsc --noEmit`, Biome, the tests the task names. Closing = format, lint, typecheck, the delivery command green, memories updated, **report to the user, merge only on their approval**, `git merge --no-ff`, branch deleted. Never push unless the user says so.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check the branch in the same command: `test "$(git branch --show-current)" = ci/test-triggers && git commit …`. Never `--no-verify`, never `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks` by hand; if a hook fails, stop and report its output verbatim; after committing, `git log --oneline -1` and `git show --stat HEAD`.
- **Main session only** (never a subagent): `pnpm add`, `pnpm install`, `pnpm exec simple-git-hooks`, `sudo apt-get`, and anything that pushes or calls GitHub with a write. Steps that need one say so.
- Code files are read and edited through Serena's symbolic tools (`AGENTS.md` § Tooling); built-in Read/Edit only on non-code files (YAML, JSON, shell, Markdown) or when Serena fails. Every subagent prompt that touches code carries this rule.
- After every modification `pnpm exec biome check --write <files>`; before every commit `pnpm exec tsc --noEmit`.
- Any run past ~2 minutes (`pnpm test`, the delivery command, a merge) goes to the background writing to a log, never through `| tail`, with a progress line to the user every 2 minutes from launch.
- Comments state the fact (one or two lines: the trap, what a reader would get wrong); no memory references in `.github/workflows/**` comments.
- Pinned versions, verbatim: actionlint `1.7.12`; publint `0.3.24`; `@arethetypeswrong/cli` `0.18.5` (each published more than two weeks before 2026-10-13). actionlint archive SHA-256 (from `actionlint_1.7.12_checksums.txt`): `linux_amd64` `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`, `linux_arm64` `325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6`, `darwin_amd64` `5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644`, `darwin_arm64` `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f`.
- Check names, verbatim and in this order: `tsc`, `lint-staged`, `biome`, `actionlint`, `docs`, `unit`, `test`, `conformance`, `bench`, `consumer`. Hook names: `pre-commit`, `pre-merge-commit`, `pre-push`, `delivery`.
- Conformance paths: `src/`, `tests/conformance/`, `patches/`, `pnpm-lock.yaml`. Bench paths: `scripts/bench/`. Workflow files: `.github/workflows/*.yml|*.yaml`.
- No CHANGELOG entry: nothing here changes what a consumer gets.

## Review Focus

- The release push sends two refs at once (`main` and `v1.2.3`): `pre-push` must see both the direct-commit fact and the tag in one stdin. Test in Task 3.
- A deleted ref (zero SHA: `git push origin --delete feat/x`, a deleted tag) must trigger nothing — not even `consumer` for a `v*` tag. Test in Task 3.
- A first push of a new branch must count only that branch's commits, not `main`'s history already on the remote. Test in Task 3.
- `node scripts/hook-gate.ts pre-push` typed by hand (stdin a terminal) must not hang waiting for input. Handled in Task 3's `main` (`process.stdin.isTTY`), checked by hand there.
- actionlint without shellcheck must fail, not pass with the `run:` blocks unchecked. Checked by hand in Task 1.

---

### Task 1: actionlint, and today's workflows made clean

**Files:**
- Create: `scripts/actionlint.ts`
- Test: `tests/unit/actionlint.test.ts`
- Modify: `.devcontainer/post-create.sh`, `.github/workflows/ci.yaml` (one step in `verify`), any workflow actionlint flags

**Interfaces:**
- Produces: `node scripts/actionlint.ts` (lint, exit code = actionlint's, 1 without shellcheck) and `node scripts/actionlint.ts install`. Exports `ACTIONLINT_VERSION`, `ARCHIVE_SHA256`, `platformKey(platform?, arch?): string`, `verifyArchive(bytes: Uint8Array, expected: string): void`, `install(): Promise<string>`.

- [ ] **Step 1: Write the failing test** — `tests/unit/actionlint.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SHA256,
  platformKey,
  verifyArchive,
} from '../../scripts/actionlint.ts';

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
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/actionlint.test.ts`
Expected: FAIL, cannot resolve `../../scripts/actionlint.ts`.

- [ ] **Step 3: Write `scripts/actionlint.ts`**

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/actionlint.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Install shellcheck here, and in the devcontainer** (main session for the `apt-get`)

Run: `sudo apt-get install -y --no-install-recommends shellcheck && shellcheck --version`.
In `.devcontainer/post-create.sh`, the browsers' apt line becomes the line below, and `node scripts/actionlint.ts install` is added after `node scripts/browsers.ts install`:

```bash
# shellcheck disable=SC2046
sudo apt-get update && sudo apt-get install -y --no-install-recommends shellcheck $(node scripts/browsers.ts deps)
node scripts/browsers.ts install
# actionlint at the version scripts/actionlint.ts pins; shellcheck above lets it
# check every run: block.
node scripts/actionlint.ts install
```

- [ ] **Step 6: Check the shellcheck guard by hand**

Run: `node scripts/actionlint.ts install` (so the binary is cached and the next command needs no `tar`), then `PATH=$(dirname "$(command -v node)") node scripts/actionlint.ts; echo "exit $?"`
Expected: the "shellcheck is not on the PATH" message and `exit 1`.

- [ ] **Step 7: Lint today's workflows and fix every finding**

Run: `node scripts/actionlint.ts`
For each finding: correct it when it is right; when it is wrong for us, disable it at its line — `# shellcheck disable=SCxxxx` on the line above the command inside the `run:` block, with a one-line reason on the same comment (`# shellcheck disable=SC2086 # word splitting wanted: …`). A non-shellcheck finding that is wrong for us goes in `.github/actionlint.yaml` under `paths: { .github/workflows/<file>: { ignore: [<regex>] } }` with a YAML comment giving the reason. If a finding would change what a workflow does (not just how it is written), stop and report it to the user before changing it.
Re-run until `node scripts/actionlint.ts` exits 0.

- [ ] **Step 8: Add the CI step** — in `.github/workflows/ci.yaml`, job `verify`, right after `- run: pnpm install --frozen-lockfile`:

```yaml
      # The only check a workflow gets before GitHub runs it: actionlint, and
      # shellcheck on every run: block (actionlint skips them silently without it).
      - name: Lint the workflows
        run: |
          command -v shellcheck || { sudo apt-get update && sudo apt-get install -y shellcheck; }
          node scripts/actionlint.ts
```

- [ ] **Step 9: Falsify** — add a deliberate fault in `.github/workflows/ci.yaml`: change one `${{ runner.os }}` to `${{ runner.oss }}`. Run `node scripts/actionlint.ts`; expected: non-zero, a finding naming `oss`. Revert, re-run, exit 0. Then in a `run:` block add `echo $UNQUOTED_VAR_X`, re-run: a shellcheck SC2086 finding. Revert, exit 0.

- [ ] **Step 10: Commit**

```bash
pnpm exec biome check --write scripts/actionlint.ts tests/unit/actionlint.test.ts
pnpm exec tsc --noEmit
git add scripts/actionlint.ts tests/unit/actionlint.test.ts .devcontainer/post-create.sh .github/
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "build(ci): lint the workflows with actionlint and shellcheck

Nothing checked a workflow before GitHub ran it, and the next commits
rewire three of them. The binary is pinned and verified against its
release checksum; linting refuses to run without shellcheck, which
actionlint would otherwise skip without a word.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 2: the decision — `checksFor`

**Files:**
- Modify: `scripts/hook-gate.ts` (add exports; `classify`, `changedFiles` and `main` stay until Task 3)
- Test: `tests/unit/hook-gate.test.ts` (new `describe`; the `classify` one stays until Task 3)

**Interfaces:**
- Produces: `type Hook = 'pre-commit' | 'pre-merge-commit' | 'pre-push' | 'delivery'`, `HOOKS: readonly Hook[]`, `type Check`, `CHECK_ORDER: readonly Check[]`, `type FileClass = 'workflow' | 'ignored' | 'docs' | 'code'`, `classOf(file: string): FileClass`, `type Facts = { files: readonly string[]; merging?: boolean; directCodeCommit?: boolean; tagPushed?: boolean }`, `checksFor(hook: Hook, facts: Facts): Check[]`, `FULL: Readonly<Record<Hook, readonly Check[]>>`.

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/hook-gate.test.ts` (and extend its import with `checksFor`, `classOf`, `FULL`, `CHECK_ORDER`):

```ts
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
      expect(checksFor(hook, { files: ['.serena/memories/a.md'] })).toEqual(
        [],
      );
    }
  });

  it('lints a workflow, and only that, on every hook', () => {
    for (const hook of ['pre-commit', ...merges, 'pre-push'] as const) {
      expect(
        checksFor(hook, { files: ['.github/workflows/ci.yaml'] }),
      ).toEqual(['actionlint']);
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
      files: [
        'scripts/bench/x.ts',
        'src/a.ts',
        '.github/workflows/ci.yaml',
      ],
    });
    expect(all).toEqual(CHECK_ORDER.filter((c) => all.includes(c)));
    for (const list of Object.values(FULL)) {
      expect(list).toEqual(CHECK_ORDER.filter((c) => list.includes(c)));
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/hook-gate.test.ts`
Expected: FAIL, `checksFor` (and the others) not exported.

- [ ] **Step 3: Implement** — insert into `scripts/hook-gate.ts` after `classify` (Serena `insert_after_symbol`), and widen nothing else yet:

```ts
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
```

Note: the type is `GateHook` here because the existing `Hook` (three hooks) is still used by `classify` and `changedFiles`; Task 3 deletes those and renames `GateHook` to `Hook` with Serena's `rename_symbol`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/hook-gate.test.ts`
Expected: PASS, the old `classify` describe and the new one.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write scripts/hook-gate.ts tests/unit/hook-gate.test.ts
pnpm exec tsc --noEmit
git add scripts/hook-gate.ts tests/unit/hook-gate.test.ts
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "feat(hooks): decide each hook's checks from the change

Three exit codes could not say 'conformance because src/ moved' or
'the suite because a commit was made on main directly'. The decision is
a pure function of the hook and its facts, so every rule is a unit
test; nothing calls it yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 3: facts from git, the runner, and the hooks rewired

**Files:**
- Modify: `scripts/hook-gate.ts` (add `gatherFacts`, `runChecks`, `COMMANDS`; replace `main`; delete `classify`, `changedFiles`, `Decision`, the old `Hook`; rename `GateHook` → `Hook`; rewrite the header comment)
- Modify: `package.json` (`simple-git-hooks`)
- Test: `tests/unit/hook-gate.test.ts` (delete the `classify` describe; add `gatherFacts` and `runChecks` describes)

**Interfaces:**
- Consumes: `checksFor`, `classOf`, `FULL`, `Facts`, `Check`, `HOOKS` from Task 2.
- Produces: `gatherFacts(hook: Hook, options?: { cwd?: string; stdin?: string }): Facts`; `type Step = { argv: readonly string[]; env?: Readonly<Record<string, string>> }`; `COMMANDS: Readonly<Record<Check, readonly Step[]>>`; `runChecks(checks: readonly Check[], options?: { cwd?: string; commands?: Readonly<Record<Check, readonly Step[]>> }): number`; CLI `node scripts/hook-gate.ts <hook> [--run]`.

- [ ] **Step 1: Write the failing tests** — in `tests/unit/hook-gate.test.ts`, delete the `describe('hook-gate classify', …)` block and its `hooks` constant, import `gatherFacts`, `runChecks` and `type Check` too, and add:

```ts
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';

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

  it('pre-push: a deleted ref triggers nothing, a v* tag included', () => {
    const r = repo();
    expect(
      gatherFacts('pre-push', {
        cwd: r.dir,
        stdin:
          `(delete) ${ZERO} refs/heads/feat ${ZERO.replace(/0$/, '1')}\n` +
          `(delete) ${ZERO} refs/tags/v1.2.3 ${ZERO.replace(/0$/, '1')}\n`,
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
    expect(
      [...gatherFacts('delivery', { cwd: r.dir }).files].sort(),
    ).toEqual(['README.md', 'scripts/bench/new.ts', 'src/a.ts']);
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/hook-gate.test.ts`
Expected: FAIL, `gatherFacts` and `runChecks` not exported.

- [ ] **Step 3: Implement** in `scripts/hook-gate.ts`, through Serena:
  - `safe_delete_symbol` (or delete by `replace_content`) `classify`, `Decision`, `changedFiles` and the old `Hook` type; then `rename_symbol` `GateHook` → `Hook`.
  - Replace the header comment with:

```ts
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
```

  - Imports become `execFileSync, spawnSync` from `node:child_process`, `existsSync, readFileSync` from `node:fs`, `resolve` from `node:path`, `pathToFileURL` from `node:url`.
  - Add after `checksFor`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run --configLoader runner --project unit tests/unit/hook-gate.test.ts`
Expected: PASS, every `checksFor`, `gatherFacts` and `runChecks` test.

- [ ] **Step 5: Rewire the hooks** — in `package.json`, `simple-git-hooks` becomes (the conditional installs are unchanged; `post-checkout` unchanged):

```json
"pre-commit": "if [ -f \"$(git rev-parse --git-path MERGE_HEAD)\" ] && ! git diff --cached --quiet HEAD -- package.json pnpm-lock.yaml patches/; then SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile; fi && node scripts/hook-gate.ts pre-commit --run",
"pre-merge-commit": "if ! git diff --cached --quiet HEAD -- package.json pnpm-lock.yaml patches/; then SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile; fi && node scripts/hook-gate.ts pre-merge-commit --run",
"pre-push": "node scripts/hook-gate.ts pre-push --run",
```

The installed hooks are still `main`'s until Step 7: they call `node scripts/hook-gate.ts <hook>` without `--run`, which now prints and exits 0, so they fall to their full checks — safe for this task's own commit.

- [ ] **Step 6: Check a hand run does not hang**

Run: `node scripts/hook-gate.ts pre-push` in a terminal (stdin a TTY). Expected: prints `hook-gate: pre-push — nothing to check` at once.
Run: `node scripts/hook-gate.ts delivery`. Expected: prints the branch's checks (`tsc, biome, actionlint, docs, test`… with `bench`/`conformance` only if their paths moved).

- [ ] **Step 7: Commit, then reinstall the hooks** (main session)

```bash
pnpm exec biome check --write scripts/hook-gate.ts tests/unit/hook-gate.test.ts
pnpm exec tsc --noEmit
git add scripts/hook-gate.ts tests/unit/hook-gate.test.ts package.json
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "feat(hooks): each hook runs what its change calls for

pre-push re-ran the suite on merges pre-merge-commit had already
tested; it now runs it only for a commit made on a branch directly, and
the consumer smoke for a v* tag. A merge adds conformance when the VFS
surface moves, the bench check when scripts/bench/ moves, and the
generated-docs check, which only pre-push had. 'delivery' applies the
merge rules to the branch, as one command.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
pnpm exec simple-git-hooks && grep -h 'hook-gate' .git/hooks/pre-commit .git/hooks/pre-merge-commit .git/hooks/pre-push
```

Expected: the three installed hooks call `hook-gate.ts … --run`. Ask the user before the `simple-git-hooks` line: it rewrites `.git/hooks`.

---

### Task 4: the release reuses the runs of the push of `main`; the consumer smoke moves to the release

**Files:**
- Modify: `.github/workflows/release-and-publish.yaml`, `.github/workflows/ci.yaml` (job `consumer-smoke` removed; the `workflow_call` comment), `.github/workflows/matrix.yaml` (header comment)

**Interfaces:**
- Consumes: `node scripts/actionlint.ts` (Task 1).
- Produces: jobs `prior` (outputs `ci`, `matrix`: `success` | `rerun`), `verify`, `matrix`, `consumer-smoke`, `untag`, `release`, `pages`.

- [ ] **Step 1: Prove the lookup by hand, before writing it** (read-only `gh` calls)

```bash
SHA=$(git rev-parse origin/main)
for WF in ci matrix; do
  ID=$(gh run list --workflow "$WF.yaml" --commit "$SHA" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  echo "$WF: ${ID:-none}"
  [ -n "$ID" ] && { gh run watch "$ID" --exit-status --interval 30 > /dev/null; echo "watch exit $?"; }
done
SHA=$(git rev-parse HEAD)   # a commit never pushed: no run
gh run list --workflow ci.yaml --commit "$SHA" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty'; echo "empty above = none"
```

Expected: both workflows give a run id on `origin/main`'s commit and `watch exit 0` immediately (completed runs); the unpushed commit gives an empty line. If `gh run watch` on a completed run does not return at once with its status, stop and report: the job below relies on it.

- [ ] **Step 2: Move `consumer-smoke`** — cut the whole `consumer-smoke:` job (its comment included) from `.github/workflows/ci.yaml` and paste it into `.github/workflows/release-and-publish.yaml` after the `matrix:` job, with this comment instead of the old one:

```yaml
  # The packed tarball, statically (publint, Are the Types Wrong?) and through
  # five bundlers and a page with none. It proves the package is usable once
  # published, so it runs for a release only, never on a PR or a push of main.
  consumer-smoke:
    permissions:
      contents: read
```

(the job's `runs-on` and `steps` unchanged). In `ci.yaml`, the `workflow_call:` comment becomes:

```yaml
  # From release-and-publish.yaml, when the push of `main` carrying the tagged
  # commit has no passing run of this workflow to reuse.
  workflow_call:
```

- [ ] **Step 3: Add `prior` and rewire** — in `release-and-publish.yaml`, replace the comment and the `verify:` and `matrix:` jobs with:

```yaml
  # The push of `main` that carries the tagged commit has run CI and the matrix
  # on it. Wait for those runs and reuse them; anything but a passing run — none,
  # cancelled by a later push of `main`, failed — makes the release run its own.
  prior:
    permissions:
      contents: read
      actions: read
    runs-on: ubuntu-latest
    timeout-minutes: 60
    outputs:
      ci: ${{ steps.runs.outputs.ci }}
      matrix: ${{ steps.runs.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - name: Reuse the runs of the push of main
        id: runs
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -uo pipefail
          SHA=$(git rev-parse HEAD)
          for WF in ci matrix; do
            ID=$(gh run list --workflow "$WF.yaml" --commit "$SHA" --event push \
              --limit 1 --json databaseId --jq '.[0].databaseId // empty')
            if [ -n "$ID" ] && gh run watch "$ID" --exit-status --interval 30 > /dev/null; then
              echo "$WF=success" >> "$GITHUB_OUTPUT"
              echo "$WF.yaml: run $ID passed on $SHA, reused"
            else
              echo "$WF=rerun" >> "$GITHUB_OUTPUT"
              echo "$WF.yaml: no passing run on $SHA (${ID:-none}), the release runs its own"
            fi
          done

  verify:
    needs: prior
    if: needs.prior.outputs.ci != 'success'
    permissions:
      contents: read
    uses: ./.github/workflows/ci.yaml

  # The 22 pairs, in matrix.yaml so that they can also be run by hand.
  matrix:
    needs: prior
    if: needs.prior.outputs.matrix != 'success'
    permissions:
      contents: read
    uses: ./.github/workflows/matrix.yaml
```

`untag` and `release` get `needs: [prior, verify, matrix, consumer-smoke]`; `untag` keeps `if: failure()`; `release` gets:

```yaml
    # A check reused from the push of main is skipped here, and a skipped need
    # would skip this job without the condition.
    if: ${{ !cancelled() && !failure() }}
```

- [ ] **Step 4: `matrix.yaml` header** — the first comment paragraph becomes:

```yaml
# Every declared VFS/build pair through the four columns of the matrix, one job
# per pair. Every push of `main` runs it, so a pair that regresses is seen at
# the merge; a release reuses that run, and calls this workflow only when the
# tagged commit has no passing one. workflow_dispatch runs it by hand on any
# branch, publishing nothing.
```

- [ ] **Step 5: Lint**

Run: `node scripts/actionlint.ts`
Expected: exit 0. Falsify once: rename `needs.prior.outputs.ci` to `needs.prior.outputs.cii` in `verify`'s `if`, re-run, expect a finding on the undefined output; revert, exit 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "ci(release): reuse the CI and matrix runs of the push of main

A release pushes main and its tag together, so the same commit ran CI
and the matrix twice. The release now waits for the runs of the push of
main and reuses them, running its own only when none passed. The
consumer smoke proves the package once published, so it leaves CI for
the release.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 5: publint and Are the Types Wrong? in the consumer smoke

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml` (two devDependencies), `scripts/consumer-smoke.ts` (two stages, header list)

**Interfaces:**
- Consumes: the module-scope `tarball` the pack stage sets, `stage`, `run`, `errText`, `ROOT` in `scripts/consumer-smoke.ts`.

- [ ] **Step 1: Add the dependencies** (main session)

Run: `pnpm add -D --save-exact publint@0.3.24 @arethetypeswrong/cli@0.18.5`
Expected: both in `devDependencies` at exact versions; `git diff --stat` shows `package.json` and `pnpm-lock.yaml` only.

- [ ] **Step 2: Run both on today's tarball, before wiring them**

```bash
mkdir -p .scratchpad/pack && rm -f .scratchpad/pack/*.tgz
pnpm build && pnpm pack --pack-destination .scratchpad/pack
T=$(ls .scratchpad/pack/*.tgz)
pnpm exec publint run "$T" --strict; echo "publint exit $?"
pnpm exec attw "$T" --profile esm-only; echo "attw exit $?"
```

Expected: both exit 0. **If either reports a finding, stop and report it to the user verbatim**: fixing it changes `package.json`'s exports or the published files, which is a consumer-visible decision.

- [ ] **Step 3: Add the stages** — in `scripts/consumer-smoke.ts`, right after the `pack the tarball` block (Serena `replace_content` anchored on the end of that block):

```ts
  // Static checks of the tarball, before any app installs it: publint reads
  // package.json against the files it ships, attw resolves the published
  // types the way each TypeScript resolution mode would. ESM only, hence the
  // esm-only profile: it does not ask `require` to work.
  {
    const s = stage('publint');
    try {
      run('pnpm', ['exec', 'publint', 'run', tarball as string, '--strict'], ROOT);
      s.pass('package.json agrees with the tarball');
    } catch (error) {
      s.fail(errText(error));
    }
  }

  {
    const s = stage('are the types wrong');
    try {
      run(
        'pnpm',
        ['exec', 'attw', tarball as string, '--profile', 'esm-only'],
        ROOT,
      );
      s.pass('the types resolve under every ESM resolution mode');
    } catch (error) {
      s.fail(errText(error));
    }
  }
```

And in the header comment's numbered list, after the pack item, add a line: `publint and attw on that tarball`. (Renumber the following items.)

- [ ] **Step 4: Run the smoke**

Run (background, log to `.scratchpad/consumer.log`, progress every 2 min): `pnpm test:consumer`
Expected: every stage green, the two new ones included; the stage count is one or two above the baseline's 24 (record it for Task 7).

- [ ] **Step 5: Falsify each linter on a broken copy** (scratch only, nothing committed)

```bash
rm -rf .scratchpad/broken && mkdir -p .scratchpad/broken && tar -xzf "$T" -C .scratchpad/broken
node -e "const f='.scratchpad/broken/package/package.json';const p=JSON.parse(require('fs').readFileSync(f));p.exports['.']={import:p.exports['.'].import,types:p.exports['.'].types,default:p.exports['.'].default};require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
pnpm exec publint run .scratchpad/broken/package --strict; echo "publint exit $? (expect non-zero: types after import)"
rm .scratchpad/broken/package/dist/index.d.ts && (cd .scratchpad/broken && tar -czf broken.tgz package)
pnpm exec attw .scratchpad/broken/broken.tgz --profile esm-only; echo "attw exit $? (expect non-zero: no types)"
```

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write scripts/consumer-smoke.ts
pnpm exec tsc --noEmit
git add package.json pnpm-lock.yaml scripts/consumer-smoke.ts
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "test(consumer): lint the tarball with publint and attw

The smoke drives five bundlers but compiles no TypeScript against the
published types and reads package.json only through them. Both linters
check the same tarball statically, in seconds, at the release.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 6: the bench page checked by Pages

**Files:**
- Modify: `scripts/bench/check.ts` (`--dir`, header), `.github/workflows/pages.yaml` (steps before `upload-pages-artifact`)

**Interfaces:**
- Produces: `node scripts/bench/check.ts [chrome|firefox] [--all] [--dir <path>]`, `--dir` relative to the repository root, default `_site`.

- [ ] **Step 1: `--dir` in `check.ts`** — through Serena (`replace_content`): after `const all = process.argv.includes('--all');` add:

```ts
/** The site to serve: `_site`, or one half of it (`_site/preview`). */
const dirFlag = process.argv.indexOf('--dir');
const siteDir = resolve(
  root,
  dirFlag === -1 ? '_site' : (process.argv[dirFlag + 1] ?? ''),
);
if (dirFlag !== -1 && !process.argv[dirFlag + 1]) {
  process.stderr.write('FAIL — --dir needs a path\n');
  process.exit(1);
}
if (!existsSync(join(siteDir, 'index.html'))) {
  process.stderr.write(`FAIL — no index.html in ${siteDir}\n`);
  process.exit(1);
}
```

replace `resolve(root, '_site'),` in the server spawn with `siteDir,`, add `existsSync` to the `node:fs` import, and change the header's first paragraph and usage to:

```ts
/**
 * Driver for the benchmark page: proves the page still works on an engine
 * without clicking through it. pages.yaml runs it on the half of the site a
 * run builds anew; locally the merge hook runs it when scripts/bench/ moves.
 *
 * It asserts that the PAGE works, never that a VFS passes: a red cell can be a
 * correct report about this engine.
 *
 * Usage:
 *   pnpm bench:build
 *   node scripts/bench/check.ts [chrome|firefox] [--all] [--dir <path>]
 */
```

- [ ] **Step 2: Check both halves locally**

```bash
pnpm bench:build
BENCH_PORT=8123 node scripts/bench/check.ts chrome --all; echo "root exit $?"
rm -rf _site/preview && cp -r _site _site.copy && mv _site.copy _site/preview
BENCH_PORT=8123 node scripts/bench/check.ts chrome --all --dir _site/preview; echo "preview exit $?"
BENCH_PORT=8123 node scripts/bench/check.ts chrome --dir _site/nowhere; echo "missing exit $? (expect 1)"
rm -rf _site/preview
```

Expected: `OK` and exit 0 twice (~2 min each, background with progress), then exit 1 with "no index.html".

- [ ] **Step 3: The Pages steps** — in `.github/workflows/pages.yaml`, after the `Build the preview, from the preview tag` step and before `actions/upload-pages-artifact`:

```yaml
      # The bench page of the half this run builds anew. Called by a release,
      # github.ref is its v* tag: the root. A push of `preview`: /preview/. A
      # `delete` rebuilds a root a release already checked: nothing.
      - name: Which half to check
        id: bench
        run: |
          case "$GITHUB_REF" in
            refs/tags/preview) echo "dir=_site/preview" >> "$GITHUB_OUTPUT" ;;
            refs/tags/v*) echo "dir=_site" >> "$GITHUB_OUTPUT" ;;
            *) echo "dir=" >> "$GITHUB_OUTPUT" ;;
          esac

      - name: Install the workspace tooling
        if: steps.bench.outputs.dir != ''
        run: pnpm install --frozen-lockfile

      - name: Cache WebdriverIO browsers
        if: steps.bench.outputs.dir != ''
        uses: actions/cache@v6
        with:
          path: node_modules/.cache/wdio
          key: wdio-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/browsers.ts') }}

      # Chrome for Testing has no AppArmor profile and exits at launch while
      # unprivileged user namespaces are restricted; lifting it keeps the sandbox.
      - name: Let Chrome's sandbox create user namespaces
        if: steps.bench.outputs.dir != ''
        run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

      - name: Install browsers
        if: steps.bench.outputs.dir != ''
        run: node scripts/browsers.ts install

      - name: Check the bench page
        if: steps.bench.outputs.dir != ''
        env:
          BENCH_PORT: "8123"
        run: node scripts/bench/check.ts chrome --all --dir "${{ steps.bench.outputs.dir }}"
```

Also replace the file's comment that says the bench is not tested in CI, if one exists (`grep -n "check" .github/workflows/pages.yaml` to find it).

- [ ] **Step 4: Lint** — `node scripts/actionlint.ts`, exit 0.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write scripts/bench/check.ts
pnpm exec tsc --noEmit
git add scripts/bench/check.ts .github/workflows/pages.yaml
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "ci(pages): check the bench page before deploying it

The page shipped with no check: the root is built from the release tag
and /preview/ from the preview tag, each with its own page, so each run
checks the half it builds anew, and a red page stops the deployment.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 7: memories, then the delivery run

**Files:**
- Modify (Serena `edit_memory` / `write_memory`, main session): `.serena/memories/conventions.md`, `git-hooks.md`, `stack-and-build.md`, `state.md`

- [ ] **Step 1: `mem:conventions`** — § "When to run the full matrix" rewritten to § 2 and § 4 of the spec: the matrix verdict comes from the push of `main`; a branch touching `src/pool.ts`, `src/transaction.ts`, `src/worker/`, the wa-sqlite pin or `patches/`, `VFS_CAPABILITIES`, the target machinery or the need vocabulary gets `gh workflow run matrix.yaml --ref <branch>` after the user agrees to push it, then its remote branch is deleted; `pnpm test:matrix` stays available by hand; "a new browser test with no needs" leaves the list; the premise "`pnpm test` covers two pairs" goes (complement mode runs every test once per browser). § "Releasing": the push of `main` and the tag may be one command or two (the release reuses the runs of the push of `main`; a tag pushed alone runs only the consumer smoke locally). The delivery verification (§ Phase workflow, "The full verification at delivery"): `node scripts/hook-gate.ts delivery --run`, its report read, `Test Files` line included.

- [ ] **Step 2: `mem:git-hooks`** — the gate section and "The three commit/push hooks" rewritten to § 3 of the spec: one script decides and runs (`--run`; without it, the decision only), the file classes with the new workflow class, each hook's rules, the full lists on a gathering error, and that `pre-push` no longer re-runs the suite on merges.

- [ ] **Step 3: `mem:stack-and-build`** — § CI and hooks: `verify` lints the workflows; `consumer-smoke` is a release job; `release-and-publish.yaml`'s `prior` job and its `success`/`rerun` outputs; `pages.yaml` checks the bench half; actionlint pinned in `scripts/actionlint.ts`, shellcheck required. § Test suites: "six invariants" → seven; the `consumer` row names publint and attw. § The benchmark page: `check.ts --dir`, run by Pages and by the merge hook.

- [ ] **Step 4: `mem:state`** — the baseline's `pnpm test:consumer` row: the new stage count from Task 5 Step 4; the bullet on what the full verification is points at the delivery command.

- [ ] **Step 5: Commit the memories**

```bash
git add .serena/memories/
test "$(git branch --show-current)" = ci/test-triggers && git commit -m "docs(memory): what runs where, after the test triggers review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
```

- [ ] **Step 6: The delivery run**

Run (background, log to `.scratchpad/delivery.log`, progress every 2 min): `node scripts/hook-gate.ts delivery --run`
Expected decision line: `tsc, biome, actionlint, docs, test, conformance, bench` (the lockfile moved, so conformance; `scripts/bench/` moved, so bench). Expected result: exit 0; read the `Test Files` line of `pnpm test` as well as `Tests`.

- [ ] **Step 7: Report to the user** — what each task delivered, the falsifications run, the delivery run's figures, and what only GitHub can prove: `verify`'s actionlint step at the next push of `main`, the `prior` wiring at the next release, the Pages bench step at the next push of `preview` — each asked for when it comes. Merge only on the user's approval.
