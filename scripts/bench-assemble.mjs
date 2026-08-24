#!/usr/bin/env node
/**
 * Assembles the servable benchmark page: bench/index.html beside a verbatim
 * copy of dist/.
 *
 * The copy is verbatim on purpose. dist/index.js carries a literal
 * `new URL('./worker/worker.js', import.meta.url)` and the three .wasm sit
 * beside worker.js under plain names; anything that rewrites those paths
 * breaks the page in exactly the way documented in mem:project-state.
 *
 * The only transformation is substituting __LIB_VERSION__, because the package
 * does not export its own version and the page has no build step to ask.
 *
 * Usage: node scripts/bench-assemble.mjs <outDir>
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const outDir = process.argv[2];
if (!outDir) {
  process.stderr.write('usage: bench-assemble.mjs <outDir>\n');
  process.exit(2);
}

const target = resolve(root, outDir);
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;

const page = readFileSync(join(root, 'bench/index.html'), 'utf8').replaceAll(
  '__LIB_VERSION__',
  version,
);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'index.html'), page);
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });

process.stdout.write(`assembled ${target} (browser-sqlite ${version})\n`);
