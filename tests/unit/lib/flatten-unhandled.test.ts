import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A rejected next()/throw() whose promise the caller drops raises an
 * `unhandledrejection` on an async generator. `flatten` must too: it is not
 * for flatten to decide that nobody needed that error. Vitest intercepts
 * unhandled rejections, so the comparison runs in child Node processes.
 */

const flattenUrl = pathToFileURL(
  fileURLToPath(new URL('../../../src/flatten.ts', import.meta.url)),
).href;

const script = `
import { flatten } from ${JSON.stringify(flattenUrl)};
const [shape, scenario] = process.argv.slice(2);
let count = 0;
process.on('unhandledRejection', () => { count++; });
const failure = new Error('source failed');
const failing = () => (async function* () { throw failure; })();
const chunks = () => (async function* () { yield [1, 2]; yield [3]; })();
// The async generator flatten replaces, over the same source.
const rows = (source) => (async function* () {
  for await (const chunk of source) for (const row of chunk) yield row;
})();
const make = (source) => (shape === 'flatten' ? flatten(source) : rows(source));
if (scenario === 'fetch') {
  const it = make(failing());
  void it.next();
} else if (scenario === 'throw-idle') {
  const it = make(chunks());
  void it.throw(failure);
} else if (scenario === 'throw-open') {
  const it = make(chunks());
  await it.next();
  void it.throw(failure);
} else if (scenario === 'abort-buffered') {
  const controller = new AbortController();
  const it = flatten(chunks(), { signal: controller.signal });
  await it.next();
  void it.next();
  controller.abort(failure);
}
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(count);
`;

const dir = mkdtempSync(join(tmpdir(), 'flatten-unhandled-'));
const file = join(dir, 'drop.mjs');
writeFileSync(file, script);

const count = (shape: string, scenario: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [file, shape, scenario], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('exit', (code) =>
      code === 0
        ? resolve(Number(out.trim()))
        : reject(new Error(`node exited ${code}: ${err}`)),
    );
  });

describe('flatten and a dropped rejection', () => {
  it('raises the unhandled rejection an async generator raises', async () => {
    for (const scenario of ['fetch', 'throw-idle', 'throw-open']) {
      const [generator, flattened] = await Promise.all([
        count('generator', scenario),
        count('flatten', scenario),
      ]);
      // Falsifiability: observe the request's own promise (a `.then` on it
      // that is not the one returned) and flatten's count is 0.
      expect(generator, scenario).toBeGreaterThanOrEqual(1);
      expect(flattened, scenario).toBe(generator);
    }
  }, 30_000);

  it('raises the unhandled rejection of a buffered row rejected by an abort', async () => {
    // There is no generator to compare with: the signal belongs to flatten. A
    // `.then` on the delivery's own promise would hide the rejection.
    expect(await count('flatten', 'abort-buffered')).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
