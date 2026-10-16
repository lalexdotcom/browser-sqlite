import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteError } from 'wa-sqlite/src/sqlite-api.js';
import type { SQLiteBuild } from '../../../src/const/builds';
import { createStep } from '../../../src/worker/step';

const ROW = 100;
const DONE = 101;
const OK = 0;
const BUSY = 5;
const ERROR = 1;
const DB = 42;

type Outcome = number | Promise<number>;

/** A script entry is a return value, or a function run at the call (it may queue ops). */
type Entry = Outcome | ((module: FakeModule) => Outcome);

type FakeModule = {
  _sqlite3_step: ReturnType<typeof vi.fn>;
  ccall: ReturnType<typeof vi.fn>;
  retryOps: Promise<unknown>[];
  pendingOps: Promise<unknown>[];
};

/** A module whose step answers the script in order, whichever way the build calls it. */
const fakeModule = (script: Entry[]): FakeModule => {
  const module: FakeModule = {
    _sqlite3_step: vi.fn(),
    ccall: vi.fn(),
    retryOps: [],
    pendingOps: [],
  };
  const next = (): Outcome => {
    const entry = script.shift();
    if (entry === undefined) throw new Error('the script ran out');
    return typeof entry === 'function' ? entry(module) : entry;
  };
  module._sqlite3_step.mockImplementation(next);
  module.ccall.mockImplementation((name: string) =>
    name === 'sqlite3_errmsg' ? 'fake message' : next(),
  );
  return module;
};

const stepOf = (module: FakeModule, build: SQLiteBuild) =>
  createStep(module as unknown as WASQLiteModule, build, DB);

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every already-settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the fast step', () => {
  it('returns a number, synchronously, when the call returned a number and nothing is queued', () => {
    for (const code of [ROW, DONE]) {
      const module = fakeModule([code]);
      const step = stepOf(module, 'sync');
      const result = step(7);
      expect(typeof result).toBe('number');
      expect(result).toBe(code);
      expect(module._sqlite3_step).toHaveBeenCalledTimes(1);
      expect(module._sqlite3_step).toHaveBeenCalledWith(7);
    }
  });

  it("throws SQLiteError synchronously on any other code, with sqlite3_errmsg's text", () => {
    expect(() => stepOf(fakeModule([19]), 'sync')(7)).toThrow(SQLiteError);
    const failing = fakeModule([19]);
    let caught: unknown;
    try {
      stepOf(failing, 'sync')(7);
    } catch (e) {
      caught = e;
    }
    expect((caught as SQLiteError).code).toBe(19);
    expect((caught as SQLiteError).message).toBe('fake message');
    expect(failing.ccall).toHaveBeenCalledWith(
      'sqlite3_errmsg',
      'string',
      ['number'],
      [DB],
    );
  });

  it('looks at what came back, not at the build', async () => {
    const module = fakeModule([Promise.resolve(ROW)]);
    const result = stepOf(module, 'sync')(7);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(ROW);
  });

  it('waits for retryOps queued before the call, then empties them', async () => {
    const module = fakeModule([ROW]);
    const queued = deferred();
    module.retryOps = [queued.promise];
    const result = stepOf(module, 'sync')(7);
    expect(result).toBeInstanceOf(Promise);
    await flush();
    expect(module._sqlite3_step).not.toHaveBeenCalled();
    queued.resolve();
    await expect(result).resolves.toBe(ROW);
    expect(module._sqlite3_step).toHaveBeenCalledTimes(1);
    expect(module.retryOps).toEqual([]);
  });

  it('retries once when the call returns a non-OK code with retryOps queued', async () => {
    const module = fakeModule([
      (m) => {
        m.retryOps.push(Promise.resolve());
        return BUSY;
      },
      ROW,
    ]);
    await expect(stepOf(module, 'sync')(7)).resolves.toBe(ROW);
    expect(module._sqlite3_step).toHaveBeenCalledTimes(2);
  });

  it('retries at most once', async () => {
    const busy: Entry = (m) => {
      m.retryOps.push(Promise.resolve());
      return BUSY;
    };
    const module = fakeModule([busy, busy]);
    const result = stepOf(module, 'sync')(7);
    await expect(result).rejects.toBeInstanceOf(SQLiteError);
    await expect(result).rejects.toMatchObject({ code: BUSY });
    expect(module._sqlite3_step).toHaveBeenCalledTimes(2);
  });

  it('does not retry SQLITE_OK even with retryOps queued', async () => {
    const module = fakeModule([
      (m) => {
        m.retryOps.push(Promise.resolve());
        return OK;
      },
    ]);
    let outcome: unknown;
    try {
      outcome = await stepOf(module, 'sync')(7);
    } catch (e) {
      outcome = e;
    }
    expect(outcome).toBeInstanceOf(SQLiteError);
    expect((outcome as SQLiteError).code).toBe(OK);
    expect(module._sqlite3_step).toHaveBeenCalledTimes(1);
  });

  it('waits for pendingOps after the call, then empties them', async () => {
    const pending = deferred();
    const module = fakeModule([
      (m) => {
        m.pendingOps.push(pending.promise);
        return DONE;
      },
    ]);
    const result = stepOf(module, 'sync')(7);
    expect(result).toBeInstanceOf(Promise);
    let settled = false;
    void (result as Promise<number>).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(result).resolves.toBe(DONE);
    expect(module.pendingOps).toEqual([]);
  });

  it('turns a rejected pendingOp into its code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = { code: 10 };
    const module = fakeModule([
      (m) => {
        m.pendingOps.push(Promise.reject(failure));
        return DONE;
      },
    ]);
    const result = stepOf(module, 'sync')(7);
    await expect(result).rejects.toBeInstanceOf(SQLiteError);
    await expect(result).rejects.toMatchObject({ code: 10 });
    expect(error).toHaveBeenCalledWith('Error in pendingOps:', failure);
    expect(module.pendingOps).toEqual([]);

    const bare = fakeModule([
      (m) => {
        m.pendingOps.push(Promise.reject(new Error('no code')));
        return DONE;
      },
    ]);
    await expect(stepOf(bare, 'sync')(7)).rejects.toMatchObject({
      code: ERROR,
    });
    expect(bare.pendingOps).toEqual([]);
  });

  it('reads retryOps and pendingOps from the module at every call', async () => {
    const queued = deferred();
    const pending = deferred();
    const module = fakeModule([
      (m) => {
        // wa-sqlite assigns new arrays; the fast step must not hold the old ones.
        m.retryOps = [queued.promise];
        m.pendingOps = [pending.promise];
        return BUSY;
      },
      (m) => {
        m.pendingOps = [pending.promise];
        return ROW;
      },
    ]);
    const result = stepOf(module, 'sync')(7);
    expect(result).toBeInstanceOf(Promise);
    await flush();
    expect(module._sqlite3_step).toHaveBeenCalledTimes(1);
    queued.resolve();
    await flush();
    expect(module._sqlite3_step).toHaveBeenCalledTimes(2);
    let settled = false;
    void (result as Promise<number>).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(result).resolves.toBe(ROW);
    expect(module.retryOps).toEqual([]);
    expect(module.pendingOps).toEqual([]);
  });

  it('async: calls ccall without the async option', async () => {
    const module = fakeModule([ROW]);
    const result = stepOf(module, 'async')(7);
    expect(result).toBe(ROW);
    expect(module._sqlite3_step).not.toHaveBeenCalled();
    expect(module.ccall).toHaveBeenCalledWith(
      'sqlite3_step',
      'number',
      ['number'],
      [7],
    );
    expect(module.ccall.mock.calls[0]).toHaveLength(4);

    const unwound = fakeModule([Promise.resolve(DONE)]);
    await expect(stepOf(unwound, 'async')(7)).resolves.toBe(DONE);
  });

  it('jspi: awaits the promising export', async () => {
    const module = fakeModule([Promise.resolve(ROW)]);
    const result = stepOf(module, 'jspi')(7);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(ROW);
    expect(module._sqlite3_step).toHaveBeenCalledWith(7);
  });
});
