import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * src/worker/step.ts copies parts of the installed wa-sqlite (spec 2026-10-16,
 * § What the fast step reproduces). Each fragment is fingerprinted here: a
 * repin that changes one fails until step.ts is reviewed against it.
 */
const PKG = fileURLToPath(
  new URL('../../../node_modules/wa-sqlite/', import.meta.url),
);

const read = (path: string) => readFileSync(PKG + path, 'utf8');

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

const fingerprint = (text: string) =>
  createHash('sha256').update(normalise(text)).digest('hex');

/** From `start` (included) to the first `end` after it (included or not). */
const between = (
  source: string,
  start: string,
  end: string,
  includeEnd = true,
): string | undefined => {
  const from = source.indexOf(start);
  if (from < 0) return undefined;
  const to = source.indexOf(end, from + start.length);
  if (to < 0) return undefined;
  return source.slice(from, includeEnd ? to + end.length : to);
};

const stepFn = (s: string) =>
  between(s, 'sqlite3.step = (function() {', '})();');
const checkFn = (s: string) => between(s, 'function check(', '\n  }\n');
const retryFn = (s: string) =>
  between(s, 'async function retry(f) {', '\n  }\n');
const opsInit = (s: string) =>
  between(s, 'Module.retryOps = [];', 'Module.pendingOps = [];');
const ccall = (s: string) =>
  between(
    s,
    'ccall=(ident,returnType,argTypes,args,opts)=>{',
    ';var cwrap=',
    false,
  );
// The pattern and the loop of instrumentWasmExports that makes a match promising.
const exportPattern = (s: string) =>
  between(s, 'exportPattern=/^(', 'else{ret[x]=original}}return ret}');
const makeAsync = (s: string) =>
  between(s, 'makeAsyncFunction(original){', '}');

/** Every line of src/**\/*.js that mentions retryOps or pendingOps, by path. */
const opsUses = (): string | undefined => {
  const files = readdirSync(`${PKG}src`, { recursive: true })
    .map((f) => String(f).replaceAll('\\', '/'))
    .filter((f) => f.endsWith('.js'))
    .sort();
  const lines = files.flatMap((file) =>
    read(`src/${file}`)
      .split('\n')
      .filter((line) => /retryOps|pendingOps/.test(line))
      .map((line) => `${file}: ${line.trim()}`),
  );
  return lines.length ? lines.join('\n') : undefined;
};

const verify = (
  name: string,
  fragment: string | undefined,
  recorded: string,
) => {
  if (fragment === undefined) {
    throw new Error(
      `${name}: not found in the installed wa-sqlite — re-read src/worker/step.ts against it`,
    );
  }
  expect(
    fingerprint(fragment),
    `${name} changed in the installed wa-sqlite: re-read src/worker/step.ts against it (spec 2026-10-16, § What the fast step reproduces), then update its fingerprint here`,
  ).toBe(recorded);
};

describe('the wa-sqlite code the fast step reproduces', () => {
  it('sqlite3.step in sqlite-api.js', () => {
    verify(
      'sqlite3.step',
      stepFn(read('src/sqlite-api.js')),
      '2362b07080c6bef1befb65f5e27cf4ac3412109f0cb49aaa3dde86dcd9a280d2',
    );
  });

  it('check in sqlite-api.js', () => {
    verify(
      'check',
      checkFn(read('src/sqlite-api.js')),
      '9243632eea7ab9d8aed3084a2438f8a60524027d5f7d4f368deb0c51c2cbd942',
    );
  });

  it('retry in sqlite-api.js', () => {
    verify(
      'retry',
      retryFn(read('src/sqlite-api.js')),
      'c3f1e3e5c8baea8d39bece1858fe3db8a1bcde3219c41c9100fcc42ae2c2bfd7',
    );
  });

  it('the retryOps and pendingOps initialisation in sqlite-api.js', () => {
    verify(
      'Module.retryOps/pendingOps init',
      opsInit(read('src/sqlite-api.js')),
      'bfc7ca346ba4236368a75ab9bac8cba5cd42002e72d21ddd219c7c596f2ea88b',
    );
  });

  it('ccall in the sync build', () => {
    verify(
      'ccall (wa-sqlite.mjs)',
      ccall(read('dist/wa-sqlite.mjs')),
      '496e8721116717fab475a0ab8651bcdd78b0defe303cf8b2819c379cf4502cc4',
    );
  });

  it('ccall in the async build', () => {
    verify(
      'ccall (wa-sqlite-async.mjs)',
      ccall(read('dist/wa-sqlite-async.mjs')),
      '11d34a4ef1e37c514f713ad40291b8f0f5ad570ff40573656ce79446801bd356',
    );
  });

  it('ccall in the jspi build', () => {
    verify(
      'ccall (wa-sqlite-jspi.mjs)',
      ccall(read('dist/wa-sqlite-jspi.mjs')),
      'd2b11fa7fe374b6f645b331c743fdce95786bf621b24c4be6965e57793a41720',
    );
  });

  it('the promising exports of the jspi build', () => {
    verify(
      'exportPattern (wa-sqlite-jspi.mjs)',
      exportPattern(read('dist/wa-sqlite-jspi.mjs')),
      '968dce8376a09e12c3cd3de120065ef50de5a996039dd3fd40f4021c4c95bf32',
    );
  });

  it('makeAsyncFunction of the jspi build', () => {
    verify(
      'makeAsyncFunction (wa-sqlite-jspi.mjs)',
      makeAsync(read('dist/wa-sqlite-jspi.mjs')),
      'a24be1bad0b06d6c3fd9d75a946bef7ccfaf2e1382c38bf989eb99b35755f062',
    );
  });

  it('every use of retryOps and pendingOps in src', () => {
    verify(
      'retryOps/pendingOps uses in src',
      opsUses(),
      '0b20e1acad81b7313d009fb1f88f55ef75db7d9e9f060674bea0d702f08056c6',
    );
  });

  it('a changed fragment changes its fingerprint', () => {
    // Falsifiable: node_modules cannot be edited, so alter the source text.
    const source = read('src/sqlite-api.js');
    const altered = source.replace(
      'rc === SQLite.SQLITE_OK',
      'rc === SQLite.SQLITE_OL',
    );
    expect(altered).not.toBe(source);
    const before = retryFn(source);
    const after = retryFn(altered);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(fingerprint(after as string)).not.toBe(
      fingerprint(before as string),
    );
  });
});
