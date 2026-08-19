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

describe('debug history bounds (D5)', () => {
  const stubOrchestrator = { getStatus: () => 0 } as any;
  const options = { vfs: 'OPFSCoopSyncVFS', pragmas: {}, name: 'test' } as any;

  it('bounds the per-worker request history', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    debug.createWorkerDebugState(0, 'w0');

    for (let i = 0; i < 200; i++) {
      debug.createRequestDebugState().assign(0);
    }

    expect(debug.state.workers[0]!.requests.length).toBeLessThanOrEqual(50);
  });

  it('bounds the per-request query history at exactly the maximum', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState().assign(0);

    for (let i = 0; i < 200; i++) {
      debug.createQueryDebugState(0, `SELECT ${i}`);
    }

    // Off-by-one: the old `> MAX` let it peak at 51 before trimming to 50.
    expect(debug.state.workers[0]!.currentRequest!.queries.length).toBe(50);
  });

  it('exposes queue depths from the scheduler, never a stale copy', () => {
    let depth = { read: 1, write: 2 };
    const debug = createClientDebug(
      'f.db',
      stubOrchestrator,
      options,
      () => depth,
    );

    expect(debug.state.queue.read).toBe(1);
    depth = { read: 7, write: 9 };
    expect(debug.state.queue.read).toBe(7);
    expect(debug.state.queue.write).toBe(9);
  });

  it('reports a real worker status, not a placeholder', () => {
    const debug = createClientDebug('f.db', stubOrchestrator, options, () => ({
      read: 0,
      write: 0,
    }));
    const state = debug.createWorkerDebugState(0, 'w0');
    expect(state.status).not.toBe('HAHA');
  });
});
