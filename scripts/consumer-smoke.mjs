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
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;
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
  const child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
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
    child.kill('SIGTERM');
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'browser-sqlite-smoke-'));
const appDir = join(tmp, 'app');

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

  let tarball;
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

  {
    const s = stage('scaffold and install the consumer app');
    try {
      cpSync(join(ROOT, 'tests', 'consumer'), appDir, { recursive: true });
      // npm, not pnpm, and outside the repo: nothing can resolve
      // `browser-sqlite` back to the local sources.
      run('npm', ['install', '--no-audit', '--no-fund'], appDir);
      run('npm', ['install', '--no-audit', '--no-fund', tarball], appDir);
      s.pass(appDir);
    } catch (error) {
      s.fail(errText(error));
      throw error;
    }
  }

  await checkMode(
    'Vite dev server',
    ['vite', '--host', HOST, '--port', String(DEV_PORT), '--strictPort'],
    `http://${HOST}:${DEV_PORT}/`,
    appDir,
  );

  let built = false;
  {
    const s = stage('vite build');
    try {
      run('npx', ['vite', 'build'], appDir);
      built = true;
      s.pass('production bundle emitted');
    } catch (error) {
      s.fail(errText(error));
    }
  }

  if (built) {
    await checkMode(
      'Vite preview (production bundle)',
      ['vite', 'preview', '--host', HOST, '--port', String(PREVIEW_PORT), '--strictPort'],
      `http://${HOST}:${PREVIEW_PORT}/`,
      appDir,
    );
  } else {
    results.push({
      name: 'Vite preview (production bundle)',
      ok: false,
      detail: 'skipped — vite build failed',
    });
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
