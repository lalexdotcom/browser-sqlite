#!/usr/bin/env node
/**
 * Minimal static file server for the bundler-free consumer mode. No
 * dependency, no transform, no resolution:
 * whatever the tarball shipped is what the browser gets.
 *
 * Usage: node scripts/static-server.mjs <rootDir> <port>
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [, , rootDir, portArg] = process.argv;
if (!rootDir || !portArg) {
  process.stderr.write('usage: static-server.mjs <rootDir> <port>\n');
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

createServer((req, res) => {

  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const filePath = join(rootDir, relative);

  try {
    if (!statSync(filePath).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
}).listen(Number(portArg), '127.0.0.1');
