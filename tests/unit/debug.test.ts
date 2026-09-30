import { describe, expect, it } from '@rstest/core';
import { createClientDebug, debugSQLQuery } from '../../src/debug';

describe('debugSQLQuery', () => {
  describe('no-params fast path', () => {
    it('returns sql unchanged when params is undefined', () => {
      expect(debugSQLQuery('SELECT 1')).toBe('SELECT 1');
    });

    it('returns sql unchanged when params is empty array', () => {
      expect(debugSQLQuery('SELECT 1', [])).toBe('SELECT 1');
    });
  });

  describe('positional ?NNN parameters', () => {
    it('interpolates string value with single quotes', () => {
      expect(debugSQLQuery('SELECT ?001', ['Alice'])).toBe("SELECT 'Alice'");
    });

    it('interpolates number value without quotes', () => {
      expect(debugSQLQuery('SELECT ?001', [42])).toBe('SELECT 42');
    });

    it('interpolates boolean value without quotes', () => {
      expect(debugSQLQuery('SELECT ?001', [true])).toBe('SELECT true');
    });

    it('interpolates null as NULL', () => {
      expect(debugSQLQuery('SELECT ?001', [null])).toBe('SELECT NULL');
    });

    it('interpolates undefined as NULL', () => {
      expect(debugSQLQuery('SELECT ?001', [undefined])).toBe('SELECT NULL');
    });

    it('interpolates Date as ISO string', () => {
      expect(
        debugSQLQuery('SELECT ?001', [new Date('2024-01-15T00:00:00.000Z')]),
      ).toBe("SELECT '2024-01-15T00:00:00.000Z'");
    });

    it('interpolates Buffer as hex literal', () => {
      expect(debugSQLQuery('SELECT ?001', [Buffer.from([0x41, 0x42])])).toBe(
        "SELECT X'4142'",
      );
    });

    it('interpolates Uint8Array as hex literal', () => {
      expect(debugSQLQuery('SELECT ?001', [new Uint8Array([0x41, 0x42])])).toBe(
        "SELECT X'4142'",
      );
    });

    it('reuses same index for repeated ?001', () => {
      expect(debugSQLQuery('SELECT ?001, ?001', ['x'])).toBe("SELECT 'x', 'x'");
    });

    it('interpolates two distinct positional params', () => {
      expect(debugSQLQuery('SELECT ?001, ?002', ['a', 'b'])).toBe(
        "SELECT 'a', 'b'",
      );
    });
  });

  describe('bare ? parameters', () => {
    it('interpolates single bare ?', () => {
      expect(debugSQLQuery('SELECT ?', [99])).toBe('SELECT 99');
    });

    it('interpolates multiple bare ? in order', () => {
      expect(debugSQLQuery('SELECT ?, ?', ['a', 'b'])).toBe("SELECT 'a', 'b'");
    });
  });

  describe('string escaping', () => {
    it("escapes embedded single quotes as ''", () => {
      expect(debugSQLQuery('SELECT ?001', ["it's a test"])).toBe(
        "SELECT 'it''s a test'",
      );
    });
  });

  describe('string literal skipping', () => {
    it('does not replace ? inside single-quoted string literal', () => {
      expect(debugSQLQuery("SELECT '?' FROM t", [])).toBe("SELECT '?' FROM t");
    });

    it('does not replace ? inside double-quoted identifier', () => {
      expect(debugSQLQuery('SELECT "?" FROM t', [])).toBe('SELECT "?" FROM t');
    });
  });
});

describe('the pool-level request history', () => {
  const options = {
    vfs: 'OPFSCoopSyncVFS',
    pragmas: {},
    name: 'test',
    poolSize: 1,
  } as any;
  const noQueue = () => ({ read: 0, write: 0, gated: 0 });
  const make = (pool: any[] = [], poolSize = 1) =>
    createClientDebug('f.db', pool, { ...options, poolSize }, noQueue);

  it('records a request at creation, before it has a worker', () => {
    const debug = make();
    debug.createRequestDebugState('write');
    const [request] = debug.state.requests;
    expect(request?.kind).toBe('write');
    expect(request?.startTime).toBeGreaterThan(0);
    expect(request?.acquireTime).toBeUndefined();
    expect(request?.worker).toBeUndefined();
  });

  it('stamps lock, acquisition and end, with the worker and its generation', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('write');
    handle.locked();
    handle.acquired(0);
    handle.released();
    const request = debug.state.requests[0]!;
    expect(request.lockTime).toBeGreaterThan(0);
    expect(request.acquireTime).toBeGreaterThanOrEqual(request.lockTime!);
    expect(request.endTime).toBeGreaterThanOrEqual(request.acquireTime!);
    expect(request.worker).toBe(0);
    expect(request.generation).toBe(0);
  });

  it('ends a request that fails before getting a worker at once', () => {
    const debug = make();
    const error = new Error('timed out');
    debug.createRequestDebugState('read').failed(error);
    const request = debug.state.requests[0]!;
    expect(request.error).toBe(error);
    expect(request.endTime).toBeGreaterThan(0);
  });

  it('ends a request that fails after getting a worker only at its release', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('read');
    handle.acquired(0);
    handle.failed(new Error('barrier'));
    expect(debug.state.requests[0]!.endTime).toBeUndefined();
    handle.released();
    expect(debug.state.requests[0]!.endTime).toBeGreaterThan(0);
  });

  it('keeps the first endTime when release is called twice', async () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('read');
    handle.acquired(0);
    handle.released();
    const first = debug.state.requests[0]!.endTime;
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.released();
    expect(debug.state.requests[0]!.endTime).toBe(first);
  });

  it('evicts only finished requests, oldest first', () => {
    const debug = make([], 1);
    debug.createWorkerDebugState(0, 'w0');
    const waiting = debug.createRequestDebugState('read'); // never ends
    for (let i = 0; i < 60; i++) {
      const handle = debug.createRequestDebugState('read');
      handle.acquired(0);
      handle.released();
    }
    const { requests } = debug.state;
    expect(requests.length).toBe(50);
    expect(requests[0]!.endTime).toBeUndefined(); // the waiting one survived
    for (let i = 1; i < requests.length; i++)
      expect(requests[i]!.startTime).toBeGreaterThanOrEqual(
        requests[i - 1]!.startTime,
      );
    waiting.failed(new Error('aborted'));
  });

  it('exceeds the bound while unfinished requests fill it, and returns to it as they end', () => {
    const debug = make([], 1);
    const handles = Array.from({ length: 80 }, () =>
      debug.createRequestDebugState('read'),
    );
    expect(debug.state.requests.length).toBe(80);
    for (const handle of handles) handle.failed(new Error('closed'));
    expect(debug.state.requests.length).toBe(50);
  });

  it('scales the bound with poolSize', () => {
    const debug = make([], 2);
    debug.createWorkerDebugState(0, 'w0');
    for (let i = 0; i < 150; i++) {
      const handle = debug.createRequestDebugState('read');
      handle.acquired(0);
      handle.released();
    }
    expect(debug.state.requests.length).toBe(100);
  });

  it('numbers the generations of a slot, and keeps each request on its own', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const before = debug.createRequestDebugState('read');
    before.acquired(0);
    before.released();
    debug.createWorkerDebugState(0, 'w0'); // the replacement
    const after = debug.createRequestDebugState('read');
    after.acquired(0);
    expect(debug.state.workers[0]!.generation).toBe(1);
    expect(debug.state.requests.map((r) => r.generation)).toEqual([0, 1]);
  });

  it('attaches a query to its slot active request, and to nothing after the release', () => {
    const debug = make([], 2);
    const w0 = debug.createWorkerDebugState(0, 'w0');
    const w1 = debug.createWorkerDebugState(1, 'w1');
    const zero = debug.createRequestDebugState('read');
    zero.acquired(0);
    const one = debug.createRequestDebugState('read');
    one.acquired(1);
    w1.query('SELECT 1');
    expect(debug.state.requests[0]!.queries).toEqual([]);
    expect(debug.state.requests[1]!.queries.map((q) => q.sql)).toEqual([
      'SELECT 1',
    ]);
    one.released();
    expect(w1.query('SELECT 2')).toBeUndefined();
    expect(debug.state.requests[1]!.queries.length).toBe(1);
  });

  it('does not let a dead worker late release clear its replacement active request', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const dead = debug.createRequestDebugState('read');
    dead.acquired(0);
    const fresh = debug.createWorkerDebugState(0, 'w0'); // replaced while the lease is out
    const live = debug.createRequestDebugState('read');
    live.acquired(0);
    dead.released(); // the old caller's finally, arriving late
    fresh.query('SELECT 1');
    expect(debug.state.requests[1]!.queries.map((q) => q.sql)).toEqual([
      'SELECT 1',
    ]);
  });

  it('binds a query to the worker handle generation, not the live slot', () => {
    const debug = make();
    const old = debug.createWorkerDebugState(0, 'w0');
    const r1 = debug.createRequestDebugState('write');
    r1.acquired(0);
    const fresh = debug.createWorkerDebugState(0, 'w0'); // slot 0 replaced
    const r2 = debug.createRequestDebugState('write');
    r2.acquired(0);
    expect(old.query('ROLLBACK')).toBeUndefined();
    expect(debug.state.requests[1]!.queries).toEqual([]);
    fresh.query('SELECT 1');
    expect(debug.state.requests[1]!.queries.map((q) => q.sql)).toEqual([
      'SELECT 1',
    ]);
  });

  it('adds rows and affected up from the query to the request', () => {
    const debug = make();
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('write').acquired(0);
    const first = w0.query('SELECT a FROM t')!;
    first.chunk(500);
    first.chunk(20);
    first.done(0, 1);
    const second = w0.query('UPDATE t SET a = 1')!;
    second.done(7, 0);
    const request = debug.state.requests[0]!;
    expect(request.queries[0]).toMatchObject({
      rows: 520,
      affected: 0,
      prepared: 1,
    });
    expect(request.queries[0]!.firstRowTime).toBeGreaterThan(0);
    expect(request.queries[0]!.endTime).toBeGreaterThan(0);
    expect(request.queries[1]).toMatchObject({
      rows: 0,
      affected: 7,
      prepared: 0,
    });
    expect(request).toMatchObject({ rows: 520, affected: 7 });
  });

  it('records a failed query with its error', () => {
    const debug = make();
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    const error = new Error('no such table');
    w0.query('SELECT x FROM missing')!.failed(error);
    const query = debug.state.requests[0]!.queries[0]!;
    expect(query.error).toBe(error);
    expect(query.endTime).toBeGreaterThan(0);
  });

  it('keeps a done query done when a late failure arrives', () => {
    const debug = make();
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    const q = w0.query('SELECT 1')!;
    q.done(0, 1);
    q.failed(new Error('worker crashed'));
    const query = debug.state.requests[0]!.queries[0]!;
    expect(query.affected).toBe(0);
    expect(query.error).toBeUndefined();
  });

  it('keeps a failed query failed when a late done arrives', () => {
    const debug = make();
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    const q = w0.query('SELECT 1')!;
    const error = new Error('worker crashed');
    q.failed(error);
    q.done(3, 1);
    const query = debug.state.requests[0]!.queries[0]!;
    expect(query.error).toBe(error);
    expect(query.affected).toBe(0);
  });

  it('bounds the per-request query history at exactly the maximum', () => {
    const debug = make();
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    for (let i = 0; i < 200; i++) w0.query(`SELECT ${i}`);
    expect(debug.state.requests[0]!.queries.length).toBe(50);
  });

  it('exposes queue depths from the scheduler, never a stale copy', () => {
    let depth = { read: 1, write: 2, gated: 3 };
    const debug = createClientDebug('f.db', [], options, () => depth);
    expect(debug.state.queue.read).toBe(1);
    expect(debug.state.queue.gated).toBe(3);
    depth = { read: 7, write: 9, gated: 0 };
    expect(debug.state.queue.read).toBe(7);
    expect(debug.state.queue.write).toBe(9);
    expect(debug.state.queue.gated).toBe(0);
  });

  it('reflects the live pool status, not a construction-time snapshot', () => {
    // A getter re-reads pool[index]?.status on every access; a plain field
    // would stay frozen at 'NEW'.
    const fakeWorker = { status: 'NEW' } as any;
    const debug = make([fakeWorker]);
    debug.createWorkerDebugState(0, 'w0');
    fakeWorker.status = 'READY';
    expect(debug.state.workers[0]!.status).toBe('READY');
  });

  it('survives structuredClone, capturing the current status', () => {
    const fakeWorker = { status: 'RUNNING' } as any;
    const debug = make([fakeWorker]);
    const w0 = debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    w0.query('SELECT ?', [1]);
    const snapshot = structuredClone(debug.state);
    expect(snapshot.workers[0]!.status).toBe('RUNNING');
    expect(snapshot.requests[0]!.queries[0]!.params).toEqual([1]);
    fakeWorker.status = 'READY';
    expect(snapshot.workers[0]!.status).toBe('RUNNING');
  });
});
