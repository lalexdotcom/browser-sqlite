import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// raceAbort of src/queries.ts, verbatim.
const raceAbort = (signal, pending) => {
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};
// Mirrors the savepointed branch of releasing (src/transaction.ts): races the
// signal per next(), drains what is left once it fires. mark.posted models the
// query having reached the worker, which the first source.next() does.
const layer = (source, signal) => (async function* () {
  const mark = { posted: false };
  let left = false;
  signal.throwIfAborted();
  try {
    for (;;) {
      const pulled = source.next();
      mark.posted = true;
      const next = await raceAbort(signal, pulled);
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (mark.posted && signal.aborted && error === signal.reason) {
      left = true;
      void (async () => { for (;;) if ((await source.next()).done) return; })()
        .catch(() => {});
    }
    throw error;
  } finally {
    if (!left) await source.return(undefined);
  }
})();
// Today's chain races per row over the row generator; with flatten, per chunk
// under the adapter, which checks the signal before each buffered row.
const chain = (signal) =>
  shape === 'flatten'
    ? flatten(layer(chunks(), signal), { signal })
    : layer(rows(chunks()), signal);

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
} else if (scenario === 'abort-then-call') {
  const controller = new AbortController();
  const it = chain(controller.signal);
  await it.next();
  void it.next();
  controller.abort(failure);
  void it.next();
} else if (scenario === 'call-then-abort') {
  const controller = new AbortController();
  const it = chain(controller.signal);
  await it.next();
  void it.next();
  void it.next();
  controller.abort(failure);
}
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(count);
`;

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatten-unhandled-'));
  file = join(dir, 'drop.mjs');
  writeFileSync(file, script);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const count = (shape: string, scenario: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, shape, scenario], {
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
    child.on('error', reject);
    child.on('close', (code) =>
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

  it('raises it for a buffered row rejected by an abort, as the real chain does', async () => {
    // Today's chain: the savepointed layer racing the signal per row over the
    // row generator. The plain generator is not a reference for an abort.
    for (const scenario of ['abort-then-call', 'call-then-abort']) {
      const [chain, flattened] = await Promise.all([
        count('generator', scenario),
        count('flatten', scenario),
      ]);
      // Falsifiability: make the next request wait on the delivery's own
      // promise (`#last = result`) and flatten's count is 0.
      expect(chain, scenario).toBeGreaterThanOrEqual(1);
      expect(flattened, scenario).toBe(chain);
    }
  }, 30_000);
});
