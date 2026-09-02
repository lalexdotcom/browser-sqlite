import { describe, expect, it } from '@rstest/core';
import { createStatementCache } from '../../src/worker/statement-cache';

/**
 * The entry bound alone. `Number.POSITIVE_INFINITY` is not a magic value in
 * the module — it simply never satisfies `total >= maxBytes`, which is what
 * "this test is about the other bound" means.
 */
const entriesOnly = (maxEntries: number) =>
  createStatementCache({ maxEntries, maxBytes: Number.POSITIVE_INFINITY });

describe('statement cache — the entry bound', () => {
  it('returns a handle it was given', () => {
    const cache = entriesOnly(4);
    expect(cache.set('SELECT 1', 111, 0)).toEqual([]);
    // Falsifiability: delete the `entries.set` in `insert` and this is undefined.
    expect(cache.get('SELECT 1')).toBe(111);
  });

  it('evicts the least recently used, and hands it back to be finalised', () => {
    const cache = entriesOnly(2);
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    // 'a' becomes the most recent, so 'b' is next out — not 'a', which
    // insertion order alone would have chosen.
    expect(cache.get('a')).toBe(1);
    // Falsifiability: delete the re-insertion in `get` and this returns [1].
    expect(cache.set('c', 3, 0)).toEqual([2]);
    expect(cache.get('b')).toBeUndefined();
  });

  it('reports SQL that must not be cached', () => {
    const cache = entriesOnly(4);
    expect(cache.markUncacheable('SELECT 1; SELECT 2')).toEqual([]);
    // Falsifiability: return `entry.handle` instead of 'uncacheable' in `get`
    // and this is null, which the worker would read as a handle.
    expect(cache.get('SELECT 1; SELECT 2')).toBe('uncacheable');
  });

  it('bounds the uncacheable markings with everything else', () => {
    const cache = entriesOnly(2);
    cache.markUncacheable('x');
    cache.markUncacheable('y');
    // Falsifiability: keep the markings in a separate collection and 'x'
    // survives for ever — the second unbounded map the design refuses.
    expect(cache.set('z', 9, 0)).toEqual([]);
    expect(cache.get('x')).toBeUndefined();
  });

  it('returns a handle evicted by a marking', () => {
    const cache = entriesOnly(1);
    cache.set('a', 1, 0);
    // Falsifiability: give `markUncacheable` no return value and handle 1 is
    // leaked — nothing would ever finalise it.
    expect(cache.markUncacheable('b')).toEqual([1]);
  });

  it('drains every live handle and empties', () => {
    const cache = entriesOnly(4);
    cache.set('a', 1, 0);
    cache.markUncacheable('b');
    cache.set('c', 3, 0);
    // Falsifiability: push `null` handles too and close would finalise a
    // marking as if it were a statement.
    expect(cache.drain().sort()).toEqual([1, 3]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.drain()).toEqual([]);
  });

  it('caches nothing at capacity 0', () => {
    const cache = entriesOnly(0);
    // Falsifiability: remove the entry-bound loop from `insert` and this
    // returns [] instead of [1] — the handle is inserted but never ejected.
    expect(cache.set('a', 1, 0)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
  });

  it('forgets a deleted entry and returns its handle', () => {
    const cache = entriesOnly(4);
    cache.set('a', 1, 0);
    expect(cache.delete('a')).toBe(1);
    expect(cache.delete('a')).toBeUndefined();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('statement cache — the byte bound', () => {
  it('replaces the weight of a key it already holds', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 60);
    cache.set('a', 1, 60);
    // `settle` calls `set` on every successful exit, a cache hit included.
    // Falsifiability: add the weight instead of replacing it and the total is
    // 120, so this returns [1] and 'a' is gone.
    expect(cache.set('b', 2, 30)).toEqual([]);
    expect(cache.get('a')).toBe(1);
  });

  it('does not evict the entry it is replacing', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 10);
    // The handle re-set is the SAME statement the worker is still holding.
    // Falsifiability: return the dropped handle as evicted and the worker
    // finalises the statement it just cached — the worst defect available here.
    expect(cache.set('a', 1, 10)).toEqual([]);
    expect(cache.get('a')).toBe(1);
  });

  it('admits an entry while the total is under the bound, and overshoots', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    // 90 < 100 before the insertion, so 'b' goes in and the total reaches 180.
    // Falsifiability: test `total + weight > maxBytes` instead of `total >=
    // maxBytes` and this returns [1] — the shape that cannot hold two
    // bulkWrite templates.
    expect(cache.set('b', 2, 90)).toEqual([]);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('trims back under the bound before inserting', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    cache.set('b', 2, 90);
    // The total is 180, so the LRU goes until it is under 100 — one eviction,
    // not two: 90 is already under.
    // Falsifiability: evict while `total > 0` and this returns [1, 2].
    expect(cache.set('c', 3, 10)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('accepts an entry heavier than the whole bound', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    // Falsifiability: add a "refuse to cache what does not fit" branch and
    // this returns [1] — every bulkWrite template becomes uncacheable at any
    // budget below 3.4 MB.
    expect(cache.set('big', 1, 4000)).toEqual([]);
    expect(cache.get('big')).toBe(1);
    // The next insertion is what pays for it: the total is over the bound, so
    // the cache is emptied before 'small' goes in.
    expect(cache.set('small', 2, 10)).toEqual([1]);
    expect(cache.get('big')).toBeUndefined();
  });

  it('gives a marking no weight', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    cache.markUncacheable('m');
    // Falsifiability: give a marking any weight and the total crosses 100, so
    // this returns [1] and 'a' is evicted by a string that holds no statement.
    expect(cache.set('b', 2, 5)).toEqual([]);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('m')).toBe('uncacheable');
  });

  it('enforces the entry bound while the byte bound is slack', () => {
    const cache = createStatementCache({ maxEntries: 2, maxBytes: 1_000_000 });
    cache.set('a', 1, 1);
    cache.set('b', 2, 1);
    // Falsifiability: drop the entry-bound loop and this returns [] — the
    // churn the design keeps both bounds for.
    expect(cache.set('c', 3, 1)).toEqual([1]);
  });
});
