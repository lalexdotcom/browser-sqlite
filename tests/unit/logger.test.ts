import { describe, expect, it } from '@rstest/core';
import { createLogger } from '../../src/logger';

const capture = () => {
  const lines: string[] = [];
  const sink = {
    debug: (m: string) => lines.push(`debug:${m}`),
    warn: (m: string) => lines.push(`warn:${m}`),
    error: (m: string) => lines.push(`error:${m}`),
  };
  return { lines, sink };
};

describe('createLogger', () => {
  it('prefixes every line', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.info('worker 1 ready');
    expect(lines).toEqual(['debug:[SQLite 1] worker 1 ready']);
  });

  it('routes warn and error to their own sinks', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.warn('restarting worker 2');
    log.error('worker 2 lost');
    expect(lines).toEqual([
      'warn:[SQLite 1] restarting worker 2',
      'error:[SQLite 1] worker 2 lost',
    ]);
  });

  it('writes nothing when disabled', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', false, sink);

    log.info('x');
    log.warn('y');
    log.error('z');
    expect(lines).toEqual([]);
  });
});

describe('createLogger — always channel', () => {
  // Falsifiable: make always.warn respect the `enabled` flag (return a no-op
  // when disabled) — the always.warn call then produces no output even though
  // the test expects one.
  it('always.warn writes through the sink even when enabled is false', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', false, sink);

    log.always.warn('worker 2 lost; pool is now 1 of 2');
    expect(lines).toEqual([
      'warn:[SQLite 1] worker 2 lost; pool is now 1 of 2',
    ]);
  });

  // Falsifiable: remove the `always` channel entirely, or wire always.warn
  // through the enabled gate — disabled gated methods still produce no output.
  it('gated warn and error still produce no output when disabled', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', false, sink);

    log.warn('this should be silent');
    log.error('this too');
    expect(lines).toEqual([]);
  });

  // Falsifiable: make always.warn use sink.debug instead of sink.warn — the
  // output would start with 'debug:' rather than 'warn:'.
  it('always.warn uses the warn sink method', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', false, sink);

    log.always.warn('test');
    expect(lines[0]).toMatch(/^warn:/);
  });

  // Falsifiable: remove the prefix from always.warn — the output would not
  // include '[SQLite 1]'.
  it('always.warn applies the same [prefix] format as gated channels', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.always.warn('pool shrunk');
    expect(lines).toContain('warn:[SQLite 1] pool shrunk');
  });

  // Falsifiable: remove always.warn from the enabled path — calling it on an
  // enabled logger would produce no output (the always object is lost).
  it('always.warn also works when enabled is true', () => {
    const { lines, sink } = capture();
    const log = createLogger('SQLite 1', true, sink);

    log.always.warn('something permanent');
    expect(lines).toContain('warn:[SQLite 1] something permanent');
  });
});
