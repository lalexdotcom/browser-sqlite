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
    log.error('worker 2 evicted');
    expect(lines).toEqual([
      'warn:[SQLite 1] restarting worker 2',
      'error:[SQLite 1] worker 2 evicted',
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
