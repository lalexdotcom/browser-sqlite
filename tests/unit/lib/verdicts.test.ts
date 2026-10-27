import { describe, expect, it } from 'vitest';
import { createVerdictMemo } from '../../../src/verdicts';

/** The client's bounds (`VERDICT_MEMO_ENTRIES`, `VERDICT_MEMO_MAX_LENGTH`). */
const memo = () => createVerdictMemo({ maxEntries: 256, maxLength: 4096 });

describe('verdict memo', () => {
  // Falsifiable: evict by insertion order (drop the re-insertion in get()) —
  // the entry read last goes first.
  it('evicts the least recently used entry past 256', () => {
    const verdicts = memo();
    for (let i = 0; i < 256; i++) verdicts.set(`SELECT ${i}`, 'read');
    expect(verdicts.get('SELECT 0')).toBe('read');
    verdicts.set('SELECT 256', 'write');
    expect(verdicts.size).toBe(256);
    expect(verdicts.get('SELECT 0')).toBe('read');
    expect(verdicts.get('SELECT 1')).toBeUndefined();
    expect(verdicts.get('SELECT 256')).toBe('write');
  });

  // Falsifiable: compare with `>=` in set().
  it('stores a text of 4096 characters and not one of 4097', () => {
    const verdicts = memo();
    const at = `SELECT '${'x'.repeat(4096 - 9)}'`;
    const over = `SELECT '${'x'.repeat(4097 - 9)}'`;
    expect(at.length).toBe(4096);
    expect(over.length).toBe(4097);
    verdicts.set(at, 'read');
    verdicts.set(over, 'read');
    expect(verdicts.get(at)).toBe('read');
    expect(verdicts.get(over)).toBeUndefined();
    expect(verdicts.size).toBe(1);
  });

  // Falsifiable: store only settled verdicts in set().
  it('returns a verdict in flight to every get', () => {
    const verdicts = memo();
    const asking = new Promise<'read'>(() => {});
    verdicts.set('SELECT 1', asking);
    expect(verdicts.get('SELECT 1')).toBe(asking);
    expect(verdicts.get('SELECT 1')).toBe(asking);
  });

  // Falsifiable: make delete() a no-op.
  it('forgets a deleted entry', () => {
    const verdicts = memo();
    verdicts.set('SELECT 1', 'refused');
    verdicts.delete('SELECT 1');
    expect(verdicts.get('SELECT 1')).toBeUndefined();
    expect(verdicts.size).toBe(0);
  });
});
