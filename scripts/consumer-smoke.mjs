#!/usr/bin/env node
/**
 * Consumer smoke test — exercises the PUBLISHED package, not the sources.
 *
 * The rstest browser suite bundles `src/` with rsbuild, so it never touches
 * `dist/`, the `exports` map, or the way a third-party bundler resolves the
 * Web Worker. This script closes that gap:
 *
 *   1. build + `pnpm pack` — exactly the tarball npm would publish
 *   2. scaffold `tests/consumer/` into a temp dir OUTSIDE the repo, so the
 *      bare `browser-sqlite` specifier cannot resolve back to the local
 *      sources and make the test lie
 *   3. `npm install` the tarball there
 *   4. drive the app with Playwright in BOTH Vite modes — dev server and
 *      `vite build` + `vite preview`. Worker resolution differs between the
 *      two, so a single mode proves nothing.
 *
 * Set KEEP_TMP=1 to keep the scaffolded app for inspection.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;
const NOBUNDLER_PORT = 5197;
const RSBUILD_PORT = 5196;
const RSBUILD_DEV_PORT = 5195;
const VITE6_DEV_PORT = 5194;
const VITE6_PREVIEW_PORT = 5193;
const WEBPACK_DEV_PORT = 5192;
const WEBPACK_SERVE_PORT = 5191;
const PARCEL_DEV_PORT = 5190;
const PARCEL_SERVE_PORT = 5189;
// 127.0.0.1, not `localhost`: Node resolves `localhost` to ::1 first while Vite
// binds IPv4, so every request would hang.
const HOST = '127.0.0.1';

const results = [];

/** execFileSync puts the useful half on either stream depending on the tool. */
function errText(error) {
  return (
    [error.stdout, error.stderr].filter(Boolean).join('\n').trim() ||
    error.message
  );
}

/**
 * A published ESM bundle must resolve without an import map. Anything that is
 * not relative, root-absolute or a URL is unresolvable in a bare browser and
 * pushes a dependency into the consumer's lockfile.
 */
function assertNoBareSpecifiers(distDir) {
  const offenders = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const source = readFileSync(full, 'utf8');
        for (const pattern of patterns) {
          for (const [, specifier] of source.matchAll(pattern)) {
            const isRelative = specifier.startsWith('.');
            const isAbsolute = specifier.startsWith('/');
            const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(specifier);
            if (!isRelative && !isAbsolute && !isUrl) {
              offenders.push(`${relative(distDir, full)}: ${specifier}`);
            }
          }
        }
      }
    }
  };

  walk(distDir);
  return offenders;
}

function stage(name) {
  process.stdout.write(`\n▶ ${name}\n`);
  return {
    pass: (detail = '') => {
      results.push({ name, ok: true, detail });
      process.stdout.write(`  ✓ ${detail}\n`);
    },
    fail: (detail) => {
      results.push({ name, ok: false, detail });
      process.stdout.write(`  ✗ ${detail}\n`);
    },
  };
}

function run(cmd, args, cwd, timeout = 300_000) {
  return execFileSync(cmd, args, {
    cwd,
    timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up within ${timeoutMs}ms`);
}

function startServer(args, cwd) {
  const [cmd, ...rest] = args[0] === 'node' ? args : ['npx', ...args];
  // `detached` puts the child in its own process group. Killing the direct
  // child is not enough: `npx` and the rsbuild/vite CLIs fork the actual
  // server, which survives, holds the port, and makes the NEXT run fail with
  // "port is occupied" — a failure that looks like a packaging defect and is
  // not one. `stopServer` signals the whole group instead.
  const child = spawn(cmd, rest, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

/** Signals the child's whole process group; falls back to the child alone. */
function stopServer(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Loads the fixture and returns what `window.__SMOKE__` ended up holding. */
async function driveBrowser(url) {
  const browser = await chromium.launch();
  const noise = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') noise.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) =>
      noise.push(`requestfailed: ${r.url()} (${r.failure()?.errorText})`),
    );
    page.on('response', (r) => {
      if (r.status() >= 400) noise.push(`http ${r.status()}: ${r.url()}`);
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__SMOKE__ !== undefined, null, {
      timeout: 45_000,
    });
    const smoke = await page.evaluate(() => window.__SMOKE__);
    return { smoke, noise };
  } catch (error) {
    return { smoke: undefined, noise: [...noise, `driver: ${error.message}`] };
  } finally {
    await browser.close();
  }
}

async function checkMode(name, serverArgs, url, appDir) {
  const s = stage(name);
  const { child, log } = startServer(serverArgs, appDir);
  try {
    await waitForServer(url);
    const { smoke, noise } = await driveBrowser(url);
    if (smoke?.ok) {
      s.pass(smoke.detail);
    } else {
      const detail = [
        smoke ? smoke.detail : 'the page never set window.__SMOKE__',
        ...noise,
      ].join('\n    ');
      s.fail(detail);
    }
  } catch (error) {
    s.fail(`${error.message}\n    ${log.join('').trim()}`);
  } finally {
    stopServer(child);
  }
}

/** The packed tarball every consumer app installs. Set by the pack stage. */
let tarball;

/**
 * Copies a fixture outside the repo and installs the tarball into it. Returns
 * false rather than throwing: one bundler failing to install must not cancel
 * the others, or a single npm hiccup hides the whole matrix.
 */
function scaffoldApp(label, fixture, dir, nested) {
  const s = stage(`scaffold and install the ${label} consumer app`);
  try {
    cpSync(join(ROOT, 'tests', fixture), dir, { recursive: true });
    for (const [sub, from] of Object.entries(nested ?? {})) {
      cpSync(join(ROOT, 'tests', from), join(dir, sub), { recursive: true });
    }
    // npm, not pnpm, and outside the repo: nothing can resolve
    // `browser-sqlite` back to the local sources.
    run('npm', ['install', '--no-audit', '--no-fund'], dir);
    run('npm', ['install', '--no-audit', '--no-fund', tarball], dir);
    s.pass(dir);
    return true;
  } catch (error) {
    s.fail(errText(error));
    return false;
  }
}

/** Runs a production build and reports whether there is output worth serving. */
function buildStage(label, args, dir) {
  const s = stage(label);
  try {
    run('npx', args, dir);
    s.pass('production bundle emitted');
    return true;
  } catch (error) {
    s.fail(errText(error));
    return false;
  }
}

/** A mode that never ran still owes the summary a line, with the reason. */
function skipped(name, why) {
  results.push({ name, ok: false, detail: `skipped — ${why}` });
}

/** Serves a built directory with the repo's own static server. */
const staticServe = (dir, port) => [
  'node',
  join(ROOT, 'scripts', 'static-server.mjs'),
  dir,
  String(port),
];

const tmp = mkdtempSync(join(tmpdir(), 'browser-sqlite-smoke-'));
const appDir = join(tmp, 'app');
const rsbuildAppDir = join(tmp, 'app-rsbuild');
const vite6AppDir = join(tmp, 'app-vite6');
const webpackAppDir = join(tmp, 'app-webpack');
const parcelAppDir = join(tmp, 'app-parcel');

try {
  {
    const s = stage('build the library');
    try {
      run('pnpm', ['build'], ROOT);
      s.pass('dist/ generated');
    } catch (error) {
      s.fail(errText(error));
      throw error;
    }
  }

  {
    const s = stage('no bare specifiers in dist/');
    const offenders = assertNoBareSpecifiers(join(ROOT, 'dist'));
    if (offenders.length === 0) {
      s.pass('every specifier is relative, absolute or a URL');
    } else {
      s.fail(offenders.join('\n    '));
    }
  }

  // Assigned to the module-scope binding: scaffoldApp reads it from there.
  {
    const s = stage('pack the tarball');
    try {
      run('pnpm', ['pack', '--pack-destination', tmp], ROOT);
      const found = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
      if (!found) throw new Error('pnpm pack produced no .tgz');
      tarball = join(tmp, found);
      s.pass(found);
    } catch (error) {
      s.fail(errText(error));
      throw error;
    }
  }

  // ── Vite, newest (the fixture range resolves to the current major) ────────
  if (scaffoldApp('Vite', 'consumer', appDir, { nobundler: 'consumer-nobundler' })) {
    await checkMode(
      'Vite dev server',
      ['vite', '--host', HOST, '--port', String(DEV_PORT), '--strictPort'],
      `http://${HOST}:${DEV_PORT}/`,
      appDir,
    );

    if (buildStage('vite build', ['vite', 'build'], appDir)) {
      await checkMode(
        'Vite preview (production bundle)',
        ['vite', 'preview', '--host', HOST, '--port', String(PREVIEW_PORT), '--strictPort'],
        `http://${HOST}:${PREVIEW_PORT}/`,
        appDir,
      );
    } else {
      skipped('Vite preview (production bundle)', 'vite build failed');
    }

    await checkMode(
      'No bundler (static server)',
      staticServe(appDir, NOBUNDLER_PORT),
      `http://${HOST}:${NOBUNDLER_PORT}/nobundler/index.html`,
      appDir,
    );
  } else {
    for (const m of [
      'Vite dev server',
      'Vite preview (production bundle)',
      'No bundler (static server)',
    ]) {
      skipped(m, 'the Vite app did not install');
    }
  }

  // ── Vite 6, pinned ────────────────────────────────────────────────────────
  // Not redundant with the app above. That one resolves to the newest Vite,
  // where `optimizeDeps.exclude` is a no-op, so it never exercised the single
  // line of configuration the README asks a consumer to write. This one is
  // pinned to the range where that line decides whether dev works at all.
  if (scaffoldApp('Vite 6', 'consumer-vite6', vite6AppDir)) {
    await checkMode(
      'Vite 6 dev server',
      ['vite', '--host', HOST, '--port', String(VITE6_DEV_PORT), '--strictPort'],
      `http://${HOST}:${VITE6_DEV_PORT}/`,
      vite6AppDir,
    );

    if (buildStage('vite 6 build', ['vite', 'build'], vite6AppDir)) {
      await checkMode(
        'Vite 6 preview (production bundle)',
        ['vite', 'preview', '--host', HOST, '--port', String(VITE6_PREVIEW_PORT), '--strictPort'],
        `http://${HOST}:${VITE6_PREVIEW_PORT}/`,
        vite6AppDir,
      );
    } else {
      skipped('Vite 6 preview (production bundle)', 'vite 6 build failed');
    }
  } else {
    for (const m of ['Vite 6 dev server', 'Vite 6 preview (production bundle)']) {
      skipped(m, 'the Vite 6 app did not install');
    }
  }

  // ── rsbuild (which is rspack) ─────────────────────────────────────────────
  if (scaffoldApp('rsbuild', 'consumer-rsbuild', rsbuildAppDir)) {
    await checkMode(
      'rsbuild dev server',
      ['rsbuild', 'dev', '--host', HOST, '--port', String(RSBUILD_DEV_PORT)],
      `http://${HOST}:${RSBUILD_DEV_PORT}/`,
      rsbuildAppDir,
    );

    if (buildStage('rsbuild build', ['rsbuild', 'build'], rsbuildAppDir)) {
      await checkMode(
        'rsbuild preview (production bundle)',
        ['rsbuild', 'preview', '--host', HOST, '--port', String(RSBUILD_PORT), '--strict-port'],
        `http://${HOST}:${RSBUILD_PORT}/`,
        rsbuildAppDir,
      );
    } else {
      skipped('rsbuild preview (production bundle)', 'rsbuild build failed');
    }
  } else {
    for (const m of ['rsbuild dev server', 'rsbuild preview (production bundle)']) {
      skipped(m, 'the rsbuild app did not install');
    }
  }

  // ── webpack ───────────────────────────────────────────────────────────────
  if (scaffoldApp('webpack', 'consumer-webpack', webpackAppDir)) {
    await checkMode(
      'webpack dev server',
      ['webpack', 'serve', '--host', HOST, '--port', String(WEBPACK_DEV_PORT)],
      `http://${HOST}:${WEBPACK_DEV_PORT}/`,
      webpackAppDir,
    );

    if (buildStage('webpack build', ['webpack', 'build'], webpackAppDir)) {
      await checkMode(
        'webpack output (static server)',
        staticServe(join(webpackAppDir, 'dist'), WEBPACK_SERVE_PORT),
        `http://${HOST}:${WEBPACK_SERVE_PORT}/index.html`,
        webpackAppDir,
      );
    } else {
      skipped('webpack output (static server)', 'webpack build failed');
    }
  } else {
    for (const m of ['webpack dev server', 'webpack output (static server)']) {
      skipped(m, 'the webpack app did not install');
    }
  }

  // ── Parcel ────────────────────────────────────────────────────────────────
  // The only resolver here that does not read the `exports` map: it falls back
  // to `main`, which is why the package declares one. Keeping Parcel in the
  // matrix is what stops that field being dropped as dead weight.
  if (scaffoldApp('Parcel', 'consumer-parcel', parcelAppDir)) {
    await checkMode(
      'Parcel dev server',
      ['parcel', 'index.html', '--port', String(PARCEL_DEV_PORT)],
      `http://${HOST}:${PARCEL_DEV_PORT}/`,
      parcelAppDir,
    );

    if (buildStage('Parcel build', ['parcel', 'build', 'index.html'], parcelAppDir)) {
      await checkMode(
        'Parcel output (static server)',
        staticServe(join(parcelAppDir, 'dist'), PARCEL_SERVE_PORT),
        `http://${HOST}:${PARCEL_SERVE_PORT}/index.html`,
        parcelAppDir,
      );
    } else {
      skipped('Parcel output (static server)', 'Parcel build failed');
    }
  } else {
    for (const m of ['Parcel dev server', 'Parcel output (static server)']) {
      skipped(m, 'the Parcel app did not install');
    }
  }
} catch {
  // A thrown stage already recorded its failure; fall through to the summary.
} finally {
  if (process.env.KEEP_TMP) {
    process.stdout.write(`\nKEEP_TMP set — left ${tmp} in place\n`);
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.stdout.write('\n── consumer smoke summary ──\n');
for (const { name, ok, detail } of results) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!ok && detail) process.stdout.write(`      ${detail}\n`);
}

const failed = results.filter((r) => !r.ok).length;
process.stdout.write(
  `\n${results.length - failed}/${results.length} stages passed\n`,
);
process.exit(failed === 0 ? 0 : 1);
