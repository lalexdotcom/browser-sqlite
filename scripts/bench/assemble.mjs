#!/usr/bin/env node
/**
 * Assembles the servable benchmark page: scripts/bench/html/index.html beside
 * a verbatim copy of dist/.
 *
 * The copy is verbatim on purpose. dist/index.js carries a literal
 * `new URL('./worker/worker.js', import.meta.url)` and the three .wasm sit
 * beside worker.js under plain names; anything that rewrites those paths
 * breaks the page in exactly the way documented in mem:project-state.
 *
 * The only transformation is substituting __LIB_VERSION__, because the package
 * does not export its own version and the page has no build step to ask.
 *
 * Usage: node scripts/bench/assemble.mjs <outDir>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const argv = process.argv.slice(2);
const outDir = argv.find((a) => !a.startsWith('--'));
if (!outDir) {
  process.stderr.write(
    'usage: assemble.mjs <outDir> [--ref <label>] [--release]\n',
  );
  process.exit(2);
}

/**
 * An explicit label, and whether it may claim to be the release.
 *
 * These exist because THE ENVIRONMENT CANNOT BE MADE TO LIE HELPFULLY:
 * GitHub Actions reposes the `GITHUB_*` variables for every step and ignores a
 * step-level `env:` that tries to override them, so a workflow building a ref
 * OTHER than the one that triggered it cannot describe what it is building by
 * setting `GITHUB_REF_NAME`. It was tried; both halves of the site came out
 * labelled with the triggering tag and both claimed to be the release.
 *
 * Passed explicitly, the caller states what it built and the script believes
 * it. Absent, the env/git inference below still answers for local runs.
 */
const refFlag = argv.indexOf('--ref');
const explicitRef = refFlag === -1 ? undefined : argv[refFlag + 1];
const explicitRelease = argv.includes('--release');

const target = resolve(root, outDir);
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;

/**
 * What this build actually is, so the page cannot claim to be the published
 * package when it is not.
 *
 * A tag build is the only one that coincides with npm: the release workflow
 * publishes the package and then deploys this page for that same version.
 * Anything else — a branch preview, a local run — carries library code that is
 * not in any published tarball, even when `package.json` happens to name a
 * version that exists on the registry. Labelling those "the npm version" would
 * be false in the one place a stranger has no way to check.
 *
 * `--ref <label>` and `--release` override everything below, and CI must use
 * them: a workflow that builds a ref other than the one that triggered it
 * cannot say so through the environment, because Actions reposes `GITHUB_*` for
 * every step. Without them, GITHUB_REF_TYPE / GITHUB_REF_NAME are read as set
 * by Actions; outside it we fall back to the working copy, and a build with no
 * git at all reads as a local build.
 */
const buildRef = () => {
  if (explicitRef !== undefined) {
    return { release: explicitRelease, label: explicitRef };
  }

  const name = process.env.GITHUB_REF_NAME;

  // Two independent signals, because getting this wrong is silent and lands in
  // the one place a stranger cannot check. GITHUB_REF_TYPE is the documented
  // answer, and a reusable workflow inherits its caller's github context — but
  // if that ever failed to propagate, a genuine release would quietly label
  // itself a development build. The second test does not depend on it: a ref
  // named exactly `v<package version>` is a release tag by construction, since
  // that is how this project tags.
  if (name && (process.env.GITHUB_REF_TYPE === 'tag' || name === `v${version}`)) {
    return { release: true, label: name };
  }

  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  if (name) return { release: false, label: sha ? `${name} @ ${sha}` : name };
  try {
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const sha = git('rev-parse', '--short', 'HEAD');
    return { release: false, label: `${branch} @ ${sha}` };
  } catch {
    // No git, or not a repository: a build with no provenance to report.
    return { release: false, label: 'local build' };
  }
};

const build = buildRef();

const page = readFileSync(join(root, 'scripts/bench/html/index.html'), 'utf8')
  .replaceAll('__LIB_VERSION__', version)
  .replaceAll('__BUILD_RELEASE__', String(build.release))
  .replaceAll('__BUILD_REF__', build.label);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'index.html'), page);
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });

// Printed rather than merely decided: this line is where a release that
// mislabelled itself becomes visible in the run log, instead of on the
// deployed page.
process.stdout.write(
  `assembled ${target} — browser-sqlite ${version}, ` +
    `${build.release ? 'RELEASE build' : 'development build'} (${build.label})\n`,
);
