import { describe, expect, it } from '@rstest/core';
import { createStatementCache } from '../../src/worker/statement-cache';

describe('statement cache', () => {
  it('returns a handle it was given', () => {
    const cache = createStatementCache(4);
    expect(cache.set('SELECT 1', 111)).toEqual([]);
    // Falsifiability: delete `touch(sql, handle)` in `set` and this is undefined.
    expect(cache.get('SELECT 1')).toBe(111);
  });

  it('evicts the least recently used, and hands it back to be finalised', () => {
    const cache = createStatementCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // 'a' becomes the most recent, so 'b' is next out — not 'a', which
    // insertion order alone would have chosen.
    expect(cache.get('a')).toBe(1);
    // Falsifiability: delete `touch` from `get` and this returns [1].
    expect(cache.set('c', 3)).toEqual([2]);
    expect(cache.get('b')).toBeUndefined();
  });

  it('reports SQL that must not be cached', () => {
    const cache = createStatementCache(4);
    expect(cache.markUncacheable('SELECT 1; SELECT 2')).toEqual([]);
    // Falsifiability: return `entry` instead of 'uncacheable' in `get` and
    // this is null, which the worker would read as a handle.
    expect(cache.get('SELECT 1; SELECT 2')).toBe('uncacheable');
  });

  it('bounds the uncacheable markings with everything else', () => {
    const cache = createStatementCache(2);
    cache.markUncacheable('x');
    cache.markUncacheable('y');
    // Falsifiability: keep the markings in a separate collection and 'x'
    // survives for ever — the second unbounded map the design refuses.
    expect(cache.set('z', 9)).toEqual([]);
    expect(cache.get('x')).toBeUndefined();
  });

  it('returns a handle evicted by a marking', () => {
    const cache = createStatementCache(1);
    cache.set('a', 1);
    // Falsifiability: give `markUncacheable` no return value and handle 1 is
    // leaked — nothing would ever finalise it.
    expect(cache.markUncacheable('b')).toEqual([1]);
  });

  it('drains every live handle and empties', () => {
    const cache = createStatementCache(4);
    cache.set('a', 1);
    cache.markUncacheable('b');
    cache.set('c', 3);
    // Falsifiability: push `null` entries too and close would finalise a
    // marking as if it were a statement.
    expect(cache.drain().sort()).toEqual([1, 3]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.drain()).toEqual([]);
  });

  it('caches nothing at capacity 0', () => {
    const cache = createStatementCache(0);
    // Falsifiability: remove the `evict()` call from `set` and this returns []
    // instead of [1] — the handle is inserted but never ejected.
    expect(cache.set('a', 1)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
  });

  it('forgets a deleted entry and returns its handle', () => {
    const cache = createStatementCache(4);
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(1);
    expect(cache.delete('a')).toBeUndefined();
    expect(cache.get('a')).toBeUndefined();
  });
});
