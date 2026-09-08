# Abandoned generator — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `chunk()`/`stream()` generator the consumer drops gives its worker back — at collection through a `FinalizationRegistry`, and at once when a `signal` or `timeout` fires.

**Architecture:** A new `src/abandon.ts` owns the registry and the cleanup. `queries.chunk` becomes a factory that creates the transport iterator, builds the generator, and registers the pair; its existing `finally` unregisters. Each layer that owns a resource — the lease in `streamWithRetry`, the deadline in `chunk()`/`stream()`, the merged signal in `transaction.ts` — contributes an `onAbandon` callback that the cleanup runs.

**Tech Stack:** TypeScript, rstest (four projects: `unit` on Node, `chromium`, `firefox`, `isolated`), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-08-abandoned-generator-design.md` — read it before Task 1. Its §5 states what this does not promise, and its D1-D8 are the decisions each task implements.

## Global Constraints

- **Every commit must land on green.** This repository's pre-commit hook runs `pnpm test`, which chains three rstest configs and refuses a red tree. **A "write the failing test / commit" step is impossible here.** Observe RED, then implement, then commit once green — the RED observation is a step, never a commit.
- **Read four fields from a test report**, not three: `status`, `failedFiles`, `tests`, `failedTests`. A file-level failure — an unhandled rejection outside any test — is invisible in the per-test counters.
- **The verification baseline**, which every task's final run must match: `pnpm test` gives THREE reports, each `status: pass` / `failedFiles: 0` — **635 tests / 50 files** (unit + chromium), **243 / 33** (firefox), **5 / 2** (isolated). New tests raise these counts; nothing may lower them.
- **`pnpm check` after every modification** (`AGENTS.md`). `pnpm lint` must stay at 102 files, 13 warnings, 1 info.
- **Serena's symbolic tools are primary for code.** `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` to read; `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `replace_content` to edit. Built-in Read/Edit only for `.md` and config.
- **No new runtime dependency.** `package.json` has no `dependencies` at all and must keep none.
- **Assert falsifiability by experiment, not by argument.** For every test added: delete the line it claims to pin, observe red, restore, observe green — and report both. Four reasoned falsifiability claims on an earlier branch were wrong.
- **A streaming test must `await` in its loop body.** `await sleep(0)` is enough. A consumer that never pauses cannot see a suspension defect.

---

### Task 1: `src/abandon.ts` — the registry and the cleanup

**Files:**
- Create: `src/abandon.ts`
- Test: `tests/unit/abandon.test.ts`

**Interfaces:**
- Consumes: `PoolWorker` from `src/pool.ts` (types only).
- Produces: `type Abandoned`, `type AbandonState`, `type AbandonRegistry`, `const reclaim`, `const createAbandonRegistry`, `const abandonRegistry`. Task 2 imports all but `reclaim`'s internals.

**Why `started` exists, and it is not optional.** `reclaim` calls `worker.interrupt()`, which acts on whatever query the worker is running *now* — it does not know which query asked. A generator created and dropped without ever being started holds no query, and on the transaction path that worker is meanwhile serving the transaction's other statements. Interrupting it there would abort a healthy, unrelated query. So the cleanup interrupts only when our query actually began. `iterator.return()` needs no guard: `return()` on a generator whose body never ran is a no-op, because the body never entered its `try`.

- [ ] **Step 1: Write the tests**

Create `tests/unit/abandon.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import {
  type Abandoned,
  type AbandonState,
  createAbandonRegistry,
  reclaim,
} from '../../src/abandon';

/** A worker and a transport iterator that only record what was asked of them. */
const spies = (state: AbandonState, release?: () => void) => {
  const calls: string[] = [];
  const held: Abandoned = {
    worker: {
      interrupt: () => {
        calls.push('interrupt');
      },
    },
    iterator: {
      return: async () => {
        calls.push('return');
        return { value: undefined, done: true as const };
      },
    },
    state,
    release: release
      ? () => {
          calls.push('release');
          release();
        }
      : undefined,
  };
  return { held, calls };
};

describe('reclaim', () => {
  it('does what the lost finally would have done, in the same order', async () => {
    const { held, calls } = spies({ started: true });
    reclaim(held);
    await Promise.resolve();
    expect(calls).toEqual(['interrupt', 'return', 'release']);
  });

  it('does not interrupt a worker whose query never started', async () => {
    const { held, calls } = spies({ started: false });
    reclaim(held);
    await Promise.resolve();
    // return() on an unstarted generator is inert, so it is still called;
    // interrupt() is not, because the worker may be serving someone else.
    expect(calls).toEqual(['return', 'release']);
  });

  it('survives an iterator whose return() rejects', async () => {
    const held: Abandoned = {
      worker: { interrupt: () => {} },
      iterator: { return: async () => Promise.reject(new Error('gone')) },
      state: { started: true },
    };
    expect(() => reclaim(held)).not.toThrow();
    // The rejection must not escape as an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('runs release even when there is no work to interrupt', () => {
    let released = false;
    const { held } = spies({ started: false }, () => {
      released = true;
    });
    reclaim(held);
    expect(released).toBe(true);
  });
});

describe('createAbandonRegistry', () => {
  it('watch and forget delegate to one FinalizationRegistry', () => {
    // Nothing here forces a collection — that is not a schedule a test can
    // assert against. What is pinned is that both calls accept the token and
    // do not throw, which is the contract Task 2 relies on.
    const registry = createAbandonRegistry(() => {});
    const target = {};
    const token = {};
    const { held } = spies({ started: true });
    expect(() => registry.watch(target, held, token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec rstest --project unit run tests/unit/abandon.test.ts`
Expected: FAIL — `Cannot find module '../../src/abandon'`.

- [ ] **Step 3: Write `src/abandon.ts`**

```ts
import type { PoolWorker } from './pool';

/**
 * Whether the query this cleanup belongs to ever began.
 *
 * Shared between the generator, which sets it, and the held value, which reads
 * it. A plain object rather than a boolean because the held value must observe
 * a change the generator makes after registration.
 */
export type AbandonState = { started: boolean };

/**
 * What the cleanup needs, and all it may hold.
 *
 * **It must never refer to the registered generator.** A `FinalizationRegistry`
 * held value that reaches its own target keeps the target alive and the
 * callback then never fires. Every field here points downward: the worker and
 * the transport iterator are reachable from the pool anyway, `state` is a plain
 * flag, and `release` is the owning layer's teardown.
 */
export type Abandoned = {
  worker: Pick<PoolWorker, 'interrupt'>;
  iterator: { return: (value?: undefined) => Promise<unknown> };
  state: AbandonState;
  release?: (() => void) | undefined;
};

/**
 * What the `finally` of `queries.chunk` would have done, for a generator that
 * will never run it.
 *
 * The order is that `finally`'s and for its reason: `interrupt()` first, so the
 * queued `return()` is not parked behind a `next()` that will not settle.
 *
 * **`interrupt()` is guarded by `state.started`.** It acts on whatever query the
 * worker is running now and cannot know which query asked, so interrupting on
 * behalf of a generator that never started would abort an unrelated statement —
 * reachable on the transaction path, where the same worker serves the rest of
 * the callback. `return()` needs no guard: on a generator whose body never ran
 * it is a no-op, the body having never entered its `try`.
 */
export const reclaim = ({
  worker,
  iterator,
  state,
  release,
}: Abandoned): void => {
  if (state.started) worker.interrupt();
  void iterator.return(undefined).catch(() => {});
  release?.();
};

export type AbandonRegistry = {
  /** Watch `target`; `held` is what the cleanup receives, `token` unregisters. */
  watch: (target: object, held: Abandoned, token: object) => void;
  /** The generator ended by an ordinary route — there is nothing to reclaim. */
  forget: (token: object) => void;
};

/**
 * `run` is injected so that tests drive the cleanup without a collection.
 * Nothing else here is observable: a `FinalizationRegistry` fires when the
 * engine decides, which is not a schedule a test can assert against.
 */
export const createAbandonRegistry = (
  run: (held: Abandoned) => void = reclaim,
): AbandonRegistry => {
  const registry = new FinalizationRegistry<Abandoned>(run);
  return {
    watch: (target, held, token) => registry.register(target, held, token),
    forget: (token) => registry.unregister(token),
  };
};

/** The one this library uses. */
export const abandonRegistry = createAbandonRegistry();
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec rstest --project unit run tests/unit/abandon.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the falsifiers and report both observations**

For each, edit, run, record, restore:
1. Remove `if (state.started)` so `interrupt()` is unconditional → *does not interrupt a worker whose query never started* must go RED.
2. Remove `.catch(() => {})` → *survives an iterator whose return() rejects* must report an unhandled rejection.
3. Move `release?.()` above `worker.interrupt()` → *in the same order* must go RED.

Report the red output for each, then confirm green after restoring.

- [ ] **Step 6: `pnpm check`, then commit**

```bash
pnpm check
git add src/abandon.ts tests/unit/abandon.test.ts
git commit -m "feat(abandon): the registry and the cleanup an abandoned generator owes"
```

---

### Task 2: `queries.chunk` becomes a factory that registers and unregisters

**Files:**
- Modify: `src/queries.ts` — `chunk` (currently lines 35-74)
- Test: `tests/unit/queries-abandon.test.ts`

**Interfaces:**
- Consumes: `Abandoned`, `AbandonState`, `AbandonRegistry`, `abandonRegistry` from Task 1.
- Produces: `export type InternalChunkOptions = SQLiteChunkOptions & { credits?: number; onAbandon?: () => void; registry?: AbandonRegistry }`. `chunk` keeps its call signature and its return type `AsyncGenerator<T[]>`; it stops being an `async function*` and becomes an arrow returning one. Tasks 4 and 5 pass `onAbandon`.

**The trap this task must not spring (spec D2).** `if (signal?.aborted) throw signal.reason` currently sits at the top of the generator body, so it throws on the first `next()`. Lifted into the factory it would throw at call time, which every caller would feel — `read()`, `first()`, `streamRows`, and every transaction method. **It stays inside the inner generator.**

**Why creating the iterator eagerly is safe.** `worker.query()` is an async generator function: calling it builds the generator and runs no code, so the `postMessage` and the `deferredChunk` reuse guard still happen on the first `next()`. Nothing moves earlier except the object's construction.

- [ ] **Step 1: Write the tests**

Create `tests/unit/queries-abandon.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import type { Abandoned, AbandonRegistry } from '../../src/abandon';
import { chunk } from '../../src/queries';

/** Records what was watched and forgotten, and can run the cleanup on demand. */
const fakeRegistry = () => {
  const watched: { held: Abandoned; token: object }[] = [];
  const forgotten: object[] = [];
  const registry: AbandonRegistry = {
    watch: (_target, held, token) => {
      watched.push({ held, token });
    },
    forget: (token) => {
      forgotten.push(token);
    },
  };
  return { registry, watched, forgotten };
};

/** A worker that yields `chunks` and records the calls that matter. */
const fakeWorker = (chunks: Record<string, unknown>[][]) => {
  const calls: string[] = [];
  return {
    calls,
    index: 0,
    interrupt: () => {
      calls.push('interrupt');
    },
    quiesce: async () => {},
    query: async function* () {
      calls.push('query');
      try {
        for (const c of chunks) yield c;
      } finally {
        calls.push('transport-finally');
      }
    },
  };
};

describe('chunk() and abandonment', () => {
  it('registers the generator before it is started', () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    chunk(worker as never, 'SELECT 1', undefined, { registry });
    expect(watched).toHaveLength(1);
    // Not started yet, so the cleanup must not interrupt.
    expect(watched[0]?.held.state.started).toBe(false);
  });

  it('marks the query started once the generator runs', async () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    await gen.next();
    expect(watched[0]?.held.state.started).toBe(true);
  });

  it('forgets the token when the consumer exhausts the generator', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    for await (const _rows of gen) {
      // A streaming test must await in its loop body.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('forgets the token when the consumer breaks out', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    for await (const _rows of gen) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      break;
    }
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('carries the owner onAbandon into the held value', () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const onAbandon = () => {};
    chunk(worker as never, 'SELECT 1', undefined, { registry, onAbandon });
    expect(watched[0]?.held.release).toBe(onAbandon);
  });

  it('rejects an already-aborted signal on the first next(), not at the call', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const reason = new Error('already gone');
    const signal = AbortSignal.abort(reason);
    // The call itself must not throw: D2. Lifting the check into the factory
    // would change this line from "returns a generator" to "throws".
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal,
    });
    await expect(gen.next()).rejects.toBe(reason);
    // And the transport was never asked for anything.
    expect(worker.calls).not.toContain('query');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec rstest --project unit run tests/unit/queries-abandon.test.ts`
Expected: FAIL — `registry`/`onAbandon` are not accepted options and nothing is watched.

- [ ] **Step 3: Rewrite `chunk` in `src/queries.ts`**

Add the import at the top of the file, beside the existing type imports:

```ts
import {
  type AbandonRegistry,
  type AbandonState,
  abandonRegistry,
} from './abandon';
```

Add the internal options type just above `chunk`:

```ts
/**
 * `SQLiteChunkOptions` plus what only this library passes. `registry` is
 * TEST-ONLY and unsupported; it exists so the abandonment path can be driven
 * without a garbage collection.
 */
export type InternalChunkOptions = SQLiteChunkOptions & {
  credits?: number;
  /** The owning layer's teardown, run if the generator is abandoned. */
  onAbandon?: (() => void) | undefined;
  registry?: AbandonRegistry;
};
```

Replace `chunk` with a factory plus the inner generator. The loop body is unchanged; only the wrapper and the `finally`'s first line are new:

```ts
/**
 * The single query primitive. Every other read path is a thin derivation, and
 * abort is implemented here exactly once.
 *
 * **A factory, not a generator function**, so that the transport iterator
 * exists before the generator does and can be handed to the abandonment
 * registry. Building it early costs nothing: `worker.query()` runs no code
 * until its first `next()`, so the query message and the reuse guard still
 * happen when the consumer first pulls.
 */
export const chunk = <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: InternalChunkOptions,
): AsyncGenerator<T[]> => {
  const {
    signal,
    chunkSize,
    credits,
    onAbandon,
    registry = abandonRegistry,
  } = options ?? {};
  const iterator = worker.query<T>(sql, params, {
    chunkSize,
    credits,
    abortable: signal !== undefined,
  });
  const state: AbandonState = { started: false };
  const token = {};
  const gen = drain<T>(iterator, worker, signal, state, registry, token);
  registry.watch(gen, { worker, iterator, state, release: onAbandon }, token);
  return gen;
};

const drain = async function* <T extends Record<string, unknown>>(
  iterator: AsyncGenerator<T[] | number>,
  worker: PoolWorker,
  signal: AbortSignal | undefined,
  state: AbandonState,
  registry: AbandonRegistry,
  token: object,
): AsyncGenerator<T[]> {
  // B9: addEventListener never fires for a signal that is already aborted.
  // D2: this stays HERE and not in the factory above. Lifted, it would throw
  // at call time instead of on the first next(), which every caller feels.
  //
  // This path throws BEFORE the try, so the finally below never runs: it owes
  // its teardown itself.
  if (signal?.aborted) {
    registry.forget(token);
    throw signal.reason;
  }

  const { aborted, teardown } = makeAbortRace(signal);
  state.started = true;
  try {
    while (true) {
      // Racing the pending chunk, not testing a flag after it: an ORDER BY
      // sorts entirely inside the first step(), so waiting for a chunk before
      // noticing the abort makes AbortSignal.timeout(n) return minutes late.
      const next = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (next.done) break;
      // FLK-1: chunks already queued are not delivered once the signal fired.
      if (typeof next.value !== 'number') yield next.value;
    }
  } finally {
    // First, so that no collection of this generator can run the cleanup a
    // second time on a worker that has already been given back.
    registry.forget(token);
    teardown();
    // Start the stop-and-drain, never await it. The caller must not wait for a
    // sort that may still have minutes to run; the lease returns through
    // quiesce() instead. interrupt() first, so the queued return() is not
    // parked behind a next() that will not settle.
    worker.interrupt();
    void iterator.return(undefined).catch(() => {});
  }
};
```

Note that `state.started = true` is set **after** the aborted check and **before** the loop: an already-aborted call never began a query, so its cleanup must not interrupt.

- [ ] **Step 4: Run the whole unit project**

Run: `pnpm exec rstest --project unit run`
Expected: PASS. `chunk`'s existing consumers — `readWorker`, `firstWorker`, `streamRows`, `transaction.ts` — are unchanged and their tests must stay green.

- [ ] **Step 5: Run the falsifiers and report both observations**

1. Move the aborted check from `drain` into the factory → *rejects an already-aborted signal on the first next()* must go RED.
2. Remove `registry.forget(token)` from the `finally` → both *forgets the token* tests must go RED.
3. Remove `state.started = true` → *marks the query started* must go RED.

- [ ] **Step 6: `pnpm check`, then commit**

```bash
pnpm check
git add src/queries.ts tests/unit/queries-abandon.test.ts
git commit -m "feat(queries): register the streaming generator for abandonment"
```

---

### Task 3: An abort reclaims, it does not merely reject (spec D7)

**Files:**
- Modify: `src/queries.ts` — the `chunk` factory from Task 2
- Test: `tests/unit/queries-abandon.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: no new export. The behaviour: when `signal` fires, the cleanup runs at once rather than waiting for a collection.

**Why this is not a new promise.** Since the uniform-timeout lot, `timeout` is a wall-clock deadline counted from the call, so a generator still suspended at the deadline is already expired by contract. Today that contract is honoured for a live generator — its next `.next()` rejects with `OPERATION_TIMEOUT` — and silently broken for an abandoned one, because `makeAbortRace` rejects a promise nobody is awaiting and `aborted.catch(() => {})` swallows it. This makes the two agree.

**A live generator is affected too, and that is correct.** If the abort fires while the consumer is merely suspended between chunks, the cleanup runs and the lease goes back early; the consumer's next `.next()` then rejects with the abort reason without touching the worker. The second teardown from the `finally` is inert — `iterator.return()` twice is a no-op and `lease.release()` is idempotent.

- [ ] **Step 1: Append the tests**

```ts
describe('an abort reclaims rather than only rejecting', () => {
  it('runs the cleanup when the signal fires on a suspended generator', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const released: string[] = [];
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
      onAbandon: () => released.push('released'),
    });
    // Take one chunk, then stop pulling: the generator is suspended at yield.
    await gen.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toEqual([]);

    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(released).toEqual(['released']);
    expect(worker.calls).toContain('interrupt');
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('does not interrupt when the signal fires before the generator started', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const controller = new AbortController();
    chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.calls).not.toContain('interrupt');
  });

  it('still rejects the consumer that comes back for another chunk', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const reason = new Error('deadline');
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    await gen.next();
    controller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(gen.next()).rejects.toBe(reason);
  });

  it('detaches its listener when the generator ends normally', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const controller = new AbortController();
    const released: string[] = [];
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
      onAbandon: () => released.push('released'),
    });
    for await (const _rows of gen) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The generator is finished; its abandonment cleanup must not run.
    expect(released).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch the four fail**

Run: `pnpm exec rstest --project unit run tests/unit/queries-abandon.test.ts`
Expected: FAIL — nothing runs the cleanup on abort, so `released` stays empty.

- [ ] **Step 3: Wire the abort to the cleanup**

In `src/queries.ts`, import `reclaim` and `type Abandoned` alongside the Task 2 imports, then extend the factory. The `drain` signature gains `detach`:

```ts
export const chunk = <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: InternalChunkOptions,
): AsyncGenerator<T[]> => {
  const {
    signal,
    chunkSize,
    credits,
    onAbandon,
    registry = abandonRegistry,
  } = options ?? {};
  const iterator = worker.query<T>(sql, params, {
    chunkSize,
    credits,
    abortable: signal !== undefined,
  });
  const state: AbandonState = { started: false };
  const token = {};
  const held: Abandoned = { worker, iterator, state, release: onAbandon };

  /**
   * D7: an abort must reclaim, not merely reject. `makeAbortRace` inside the
   * generator rejects a promise that an abandoned consumer is no longer
   * awaiting, and that rejection is swallowed — so without this listener a
   * `timeout` buys an abandoned generator nothing at all.
   *
   * This closure captures the factory's scope and never the generator object,
   * so a signal the caller keeps alive does not prevent the collection the
   * registry depends on.
   */
  let detach = () => {};
  if (signal) {
    const onAbort = () => {
      registry.forget(token);
      reclaim(held);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  }

  const gen = drain<T>(iterator, worker, signal, state, registry, token, detach);
  registry.watch(gen, held, token);
  return gen;
};
```

and in `drain`, take `detach` as the last parameter. **Two places gain it, not one** — the already-aborted branch throws before the `try`, so the `finally` never runs there and it owes its own teardown. The listener matters even on an already-aborted signal, which can never fire it: the caller may hold that signal far longer than this call.

```ts
  if (signal?.aborted) {
    detach();
    registry.forget(token);
    throw signal.reason;
  }
```

```ts
  } finally {
    // First, so that neither a later abort nor a collection can run the
    // cleanup a second time on a worker already given back.
    detach();
    registry.forget(token);
    teardown();
    worker.interrupt();
    void iterator.return(undefined).catch(() => {});
  }
```

- [ ] **Step 4: Run the unit project**

Run: `pnpm exec rstest --project unit run`
Expected: PASS.

- [ ] **Step 5: Run the falsifiers and report both observations**

1. Remove the `signal.addEventListener` block → *runs the cleanup when the signal fires* must go RED.
2. Remove `detach()` from the `finally` → *detaches its listener when the generator ends normally* must go RED.
3. Remove `if (state.started)` from `reclaim` in `src/abandon.ts` → *does not interrupt when the signal fires before the generator started* must go RED.

- [ ] **Step 6: `pnpm check`, then commit**

```bash
pnpm check
git add src/queries.ts tests/unit/queries-abandon.test.ts
git commit -m "feat(queries): an abort reclaims the worker instead of only rejecting"
```

---

### Task 4: The client path composes its `onAbandon`

**Files:**
- Modify: `src/client.ts` — `streamWithRetry` (941-970), `chunk` (1010-1023), `stream` (1031-1043)
- Test: `tests/browser/abandon.test.ts`

**Interfaces:**
- Consumes: `InternalChunkOptions` from Task 2.
- Produces: `streamWithRetry`'s `body` parameter becomes `(worker: PoolWorker, onAbandon: () => void) => AsyncGenerator<Y, void, unknown>`. Task 5 does not use it — the transaction owns no lease per generator.

**What each layer owes.** `streamWithRetry` owns the lease, so its contribution returns it the way its own `finally` does — through `quiesce()`, because a worker still inside `step()` must not be re-lent. `chunk()` and `stream()` own the deadline, so theirs is `withDeadline`'s `release()`, which clears the timer and detaches the listeners `mergeSignals` put on the caller's signal. Each wraps the callback it received.

- [ ] **Step 1: Write the browser test**

Create `tests/browser/abandon.test.ts`. This is the test the design should be judged on: it exercises the whole repair with no GC and no flag, on both engines.

**Three house facts this test obeys, and none of them is guessable:**
- **`generate_series` does not exist in wa-sqlite** — `tests/browser/concurrency.test.ts:121` says so. Rows come from a recursive CTE, the form every other test here uses.
- **Browser tests build their client with `createTestClient` from `./helpers`**, not with `createSQLiteClient`: it gives each test a unique database name and registers the OPFS cleanup.
- **A read issued against a wedged pool never settles**, so its promise gets a `catch` sink before it is raced. Without one it surfaces later as an unhandled rejection *outside any test*, which shows up as `failedFiles` and not in the per-test counters.

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

const ROWS = 4000;
const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) ` +
  'SELECT x FROM c';

const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE t (n INTEGER)');
  await db.write(SEED);
};

/**
 * Whether the pool served a read within `ms`.
 *
 * The read is given a rejection sink before it is raced: against a wedged pool
 * it never settles, and at `close()` it rejects — long after this function has
 * returned, and outside any test if nothing is listening.
 */
const servesWithin = (
  db: Awaited<ReturnType<typeof createTestClient>>,
  ms: number,
) => {
  const read = db.read('SELECT 1 AS ok').then(() => true);
  read.catch(() => {});
  return Promise.race([read, sleep(ms).then(() => false)]);
};

/** Takes one chunk and drops the generator: no break, no return(), no throw. */
const abandon = async (make: () => AsyncGenerator<unknown>) => {
  const rows = make();
  await rows.next();
  await sleep(0);
};

describe('an abandoned generator gives its worker back', () => {
  it('at the deadline, when the caller set a timeout', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      await abandon(() =>
        db.chunk('SELECT n FROM t', [], { chunkSize: 10, timeout: 2000 }),
      );

      // poolSize 1: the only worker is leased and parked between two step()
      // calls. Before the deadline nothing may be served — this half is what
      // proves the leak is real rather than assuming it.
      expect(await servesWithin(db, 300)).toBe(false);

      // After it, the reclaim has run and the pool serves again.
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('at once, when the caller aborts the signal', async () => {
    const controller = new AbortController();
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      await abandon(() =>
        db.stream('SELECT n FROM t', [], {
          chunkSize: 10,
          signal: controller.signal,
        }),
      );

      expect(await servesWithin(db, 300)).toBe(false);
      controller.abort(new Error('the consumer changed its mind'));
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('leaves a correct consumer untouched', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      let seen = 0;
      for await (const rows of db.chunk<{ n: number }>('SELECT n FROM t', [], {
        chunkSize: 500,
      })) {
        seen += rows.length;
        // A streaming test must await in its loop body: consuming at full
        // speed exercises only the transport's happy interleaving.
        await sleep(0);
      }
      expect(seen).toBe(ROWS);
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run it on Chromium and watch the first two fail**

Run: `pnpm exec rstest --project chromium run tests/browser/abandon.test.ts`
Expected: the third passes; the first two FAIL, because nothing gives the worker back.

- [ ] **Step 3: Thread `onAbandon` through `streamWithRetry`**

In `src/client.ts`, replace `streamWithRetry`'s body:

```ts
  const streamWithRetry = async function* <Y>(
    signal: AbortSignal | undefined,
    body: (
      worker: PoolWorker,
      onAbandon: () => void,
    ) => AsyncGenerator<Y, void, unknown>,
  ): AsyncGenerator<Y, void, unknown> {
    for (let attempt = 1; ; attempt++) {
      let delivered = false;
      const lease = await acquireInstrumented('read', signal);
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent. This
      // is the same teardown the finally below runs, and it is idempotent, so
      // an abandoned generator reaching it first costs nothing.
      const giveBack = () => {
        void lease.worker.quiesce().then(
          () => lease.release(),
          () => lease.release(),
        );
      };
      try {
        for await (const item of body(lease.worker, giveBack)) {
          delivered = true;
          yield item;
        }
        return;
      } catch (error) {
        if (
          delivered ||
          attempt > 1 ||
          !isRetryableBusy(error) ||
          signal?.aborted
        ) {
          throw error;
        }
      } finally {
        giveBack();
      }
    }
  };
```

Then `chunk` and `stream` each compose the deadline onto it:

```ts
    const { signal, release } = withDeadline(options, 'chunk');
    try {
      yield* streamWithRetry(signal, (worker, onAbandon) =>
        chunkWorker<T>(worker, sql, params, {
          ...options,
          signal,
          onAbandon: () => {
            onAbandon();
            release();
          },
        }),
      );
    } finally {
      release();
    }
```

and the same in `stream`, with `streamRows` and `'stream'`.

- [ ] **Step 4: Run both engines and watch all three pass**

Run: `pnpm exec rstest --project chromium run tests/browser/abandon.test.ts`
Then: `pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/abandon.test.ts`
Expected: PASS on both, 3 tests each.

- [ ] **Step 5: Run the falsifiers and report both observations**

1. Drop `onAbandon` from `chunk`'s options object → *at the deadline* must go RED.
2. Make `giveBack` a no-op → both abandonment tests must go RED while *leaves a correct consumer untouched* stays green, which is what proves the third test is a control and not a duplicate.

- [ ] **Step 6: `pnpm check`, then commit**

```bash
pnpm check
git add src/client.ts tests/browser/abandon.test.ts
git commit -m "feat(client): return the lease of an abandoned chunk() or stream()"
```

---

### Task 5: The transaction path, and `GENERATOR_ABANDONED`

**Files:**
- Modify: `src/errors.ts:17-32` — add the code
- Modify: `src/pool.ts:455-458` — the reuse guard
- Modify: `src/transaction.ts:185-210` — `db.chunk` and `db.stream`
- Test: `tests/unit/errors.test.ts` (append), `tests/browser/abandon-transaction.test.ts`

**Interfaces:**
- Consumes: `InternalChunkOptions` from Task 2.
- Produces: `'GENERATOR_ABANDONED'` on `SQLiteErrorCode`.

**What the transaction owes, and what it does not.** Its `onAbandon` is only the `withSignal` merge teardown. **No lease handling**: `iterator.return()` runs `pool.query`'s `finally`, which resolves `idle`, which settles the `quiesce().then(release)` already pending in the transaction's own `finally`. That is the permanent case, and it is what this repairs.

**The loud case remains, and is only made legible.** A callback that abandons a generator and then issues another statement — or simply returns, since the auto-COMMIT is itself a statement — trips the reuse guard long before any collection. That still evicts the worker. What changes is that the consumer gets a `SQLiteError` naming what happened instead of a bare `Error` naming an internal invariant. **The guard stays structural**: it fires on "a query is already in flight on this worker", not on a diagnosis.

- [ ] **Step 1: Write the tests**

Append to `tests/unit/errors.test.ts`:

```ts
describe('GENERATOR_ABANDONED', () => {
  it('is a public error code', () => {
    const error = new SQLiteError('GENERATOR_ABANDONED', 'test');
    expect(error.code).toBe('GENERATOR_ABANDONED');
    expect(error.name).toBe('GENERATOR_ABANDONED');
  });
});
```

Create `tests/browser/abandon-transaction.test.ts`. Same three house facts as Task 4: recursive CTE rather than `generate_series`, `createTestClient` rather than `createSQLiteClient`, and a rejection sink on anything raced against a wedged pool.

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTestClient, sleep } from './helpers';

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) ' +
  'SELECT x FROM c';

describe('an abandoned generator inside a transaction', () => {
  it('fails the transaction with GENERATOR_ABANDONED, not a bare Error', async () => {
    // NOT MemoryVFS, and the pool size is incidental. An earlier draft of this
    // plan said a single worker would make the supervisor's verdict
    // fail-client rather than restart; that is FALSE — `supervisor.ts`'s
    // 'died' handler returns 'restart' for a first death of a slot that has
    // served queries, without consulting the live count. The real reason is
    // the VFS: MemoryVFS is volatile and single-connection, so an evicted and
    // restarted worker comes back with an EMPTY database, and this test's
    // closing "the client survives" assertion would then be satisfied by
    // `SELECT 1`, which touches no data. A persistent VFS makes the restarted
    // slot reopen the same database, which is what gives that line meaning.
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      const failure = await db
        .transaction(async (tx) => {
          const rows = tx.chunk('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await sleep(0);
          // The generator is abandoned here. The auto-COMMIT is itself a
          // statement on the same worker, so it trips the reuse guard long
          // before any collection could run — which is the ordinary
          // trajectory, and the one this assertion pins.
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(SQLiteError);
      expect((failure as SQLiteError).code).toBe('GENERATOR_ABANDONED');
      // The message must tell the consumer what to do, not name an invariant.
      expect((failure as SQLiteError).message).toContain('break');

      // The client survives: the worker was evicted and the slot restarted.
      const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('leaves a correct transaction untouched', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);
      const seen = await db.transaction(async (tx) => {
        let count = 0;
        for await (const rows of tx.chunk<{ n: number }>('SELECT n FROM t')) {
          count += rows.length;
          await sleep(0);
        }
        return count;
      });
      expect(seen).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);
});
```

**What no test here can reach.** The `onAbandon: release` added in Step 5 repairs the case where the transaction has ENDED and its pending `quiesce()` would never settle — which needs a collection to observe. Nothing in this file pins it, and the file says so rather than implying coverage.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec rstest --project unit run tests/unit/errors.test.ts`
Expected: FAIL — `'GENERATOR_ABANDONED'` is not assignable to `SQLiteErrorCode`.

Run: `pnpm exec rstest --project chromium run tests/browser/abandon-transaction.test.ts`
Expected: the first FAILS with a bare `Error`; the second passes.

- [ ] **Step 3: Add the code**

In `src/errors.ts`, add to the union, after `'UNSUPPORTED'`:

```ts
  | 'GENERATOR_ABANDONED'
```

- [ ] **Step 4: Replace the reuse guard in `src/pool.ts`**

The guard currently reads:

```ts
      if (deferredChunk) {
        console.error(`Previous query not finished on worker ${index + 1}`);
        throw new Error('Worker is already processing a query');
      }
```

Replace it with:

```ts
      if (deferredChunk) {
        // Structural: this fires on "a query is already in flight on this
        // worker", not on a diagnosis. But the only way a consumer reaches it
        // is a chunk()/stream() generator abandoned inside a transaction,
        // whose next statement lands on the worker the generator still holds —
        // so the message names that, and what to do about it.
        throw new SQLiteError(
          'GENERATOR_ABANDONED',
          `Worker ${index + 1} is still serving a chunk()/stream() generator. ` +
            'Exhaust it, break out of it, or call its return() before issuing ' +
            'another statement on the same transaction.',
        );
      }
```

`SQLiteError` is already imported in `src/pool.ts`; confirm with `find_symbol` rather than assuming.

- [ ] **Step 5: Give the transaction its `onAbandon`**

In `src/transaction.ts`, `db.chunk` and `db.stream` currently pass `options` straight through. Add the merge teardown as the abandonment callback — and nothing else, because the lease is the transaction's:

```ts
        chunk: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return releasing(
            // No lease work here: the transaction owns the lease, and
            // iterator.return() resolves `idle`, which settles the
            // quiesce().then(release) already pending in its own finally.
            chunkWorker<T>(worker, query, params, {
              ...options,
              onAbandon: release,
            }),
            release,
          );
        },
```

and the same shape for `stream`, with `streamRows`.

- [ ] **Step 6: Run everything**

Run: `pnpm test`
Expected: THREE reports, each `status: pass` and `failedFiles: 0`, with counts at or above the baseline.

- [ ] **Step 7: Run the falsifiers and report both observations**

1. Restore the bare `Error` in `pool.ts` → *fails the transaction with GENERATOR_ABANDONED* must go RED.
2. Remove `onAbandon: release` from `transaction.ts` → nothing in the suite goes red, and that is expected: it repairs a case no test can reach without a collection. **Say so in the test file's comment rather than claiming coverage.**

- [ ] **Step 8: `pnpm check`, then commit**

```bash
pnpm check
git add src/errors.ts src/pool.ts src/transaction.ts tests/unit/errors.test.ts tests/browser/abandon-transaction.test.ts
git commit -m "feat(errors): GENERATOR_ABANDONED replaces a bare reuse Error"
```

---

### Task 6: The floor, and the three consumer pages

**Files:**
- Modify: `scripts/render-vfs-matrix.ts` — `LIB_REQUIRES`
- Modify: `API.md` — *How they run* (line 402), the error-code table (line 469), the transaction sentence (line 215)
- Regenerate: `VFS.md`, `API.md`'s generated span

**Interfaces:**
- Consumes: nothing. Produces: nothing the code imports.

- [ ] **Step 1: Add `FinalizationRegistry` to `LIB_REQUIRES`**

```ts
const LIB_REQUIRES: Record<string, { __compat?: { support: object } }> = {
  'Array.prototype.at': bcd.javascript.builtins.Array.at,
  'crypto.randomUUID': bcd.api.Crypto.randomUUID,
  FinalizationRegistry: bcd.javascript.builtins.FinalizationRegistry,
  MessageChannel: bcd.api.MessageChannel,
};
```

- [ ] **Step 2: Re-render and diff — the expected diff is empty**

```bash
pnpm docs:vfs
git diff --stat VFS.md API.md
```

Expected: **no change**. `FinalizationRegistry` is Chrome 84 / Firefox 79 / Safari 14.1 / iOS 14.5, below the floor `crypto.randomUUID` already sets. **A non-empty diff is a finding, not a rubber stamp** — stop, report the moved cells, and do not commit a table nobody expected.

- [ ] **Step 3: Edit the three prose spots in `API.md`**

Use Serena's `replace_content`, which fails loudly on a missing or ambiguous match.

At line 402, the sentence currently ends `so always exhaust the generator or `break` out of it.` Extend it:

> **A generator holds its worker for its whole lifetime.** `stream()` and `chunk()` keep the worker that serves them until the loop ends, so always exhaust the generator, `break` out of it, or call its `return()`. `await using` does the same where your engine supports the syntax, with nothing to install. A generator you simply drop is recovered when the engine collects it, which is not a schedule you can rely on — a `timeout` or a `signal` bounds it, an abandoned one does not.

In the transaction section at line 215, after the sentence listing `tx`'s surface, add:

> One difference: a `chunk()` or `stream()` generator abandoned inside the callback fails the transaction with `GENERATOR_ABANDONED` rather than being recovered quietly, because the next statement lands on the worker the generator still holds.

In the error-code table, add the row in the union's order:

> | `GENERATOR_ABANDONED` | A `chunk()` or `stream()` generator was left open on a worker another statement then needed. Reachable inside a `transaction()`, whose statements all share one worker. Exhaust the generator, `break` out of it, or call its `return()`. |

**No measurements in these pages.** No timings, no percentages, no engine counts.

- [ ] **Step 4: Verify the cross-references still resolve**

Every anchor added or touched must exist. There is no link checker in CI, so check by hand: `grep -n '(#' API.md | wc -l` before and after should differ only by what you added, and each new `#anchor` must match a heading.

- [ ] **Step 5: `pnpm check` and the full suite**

Run: `pnpm check && pnpm test`
Expected: THREE reports, all pass.

- [ ] **Step 6: Commit**

```bash
pnpm check
git add scripts/render-vfs-matrix.ts API.md VFS.md
git commit -m "docs: name the deterministic doors, and put FinalizationRegistry in the floor"
```

---

### Task 7: The garbage-collected path, and it may not survive

**Files:**
- Create: `tests/browser/abandon-gc.test.ts`

**Interfaces:** none.

**Read this before writing it.** Everything the design promises is already pinned deterministically by Tasks 4 and 5. This test covers only the half that depends on a collection, and a test that depends on a collection is flaky by construction. **It is a bonus, and it is deletable.**

- [ ] **Step 1: Find out whether Chromium can be given `--expose-gc` here**

Check `rstest.config.ts` for how the chromium project launches its browser, and whether a launch argument can be added for one file without changing the project's defaults. If it cannot be done without changing what every other browser test runs under, **stop and report that** — do not weaken the other tests' environment for this one.

- [ ] **Step 2: Write the test, gated**

`describe.skipIf` is not used anywhere in this repository; the house form is a conditional around `it` / `it.skip`, as in `tests/conformance/invariants.test.ts`. Follow it.

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

const forceGC = (globalThis as { gc?: () => void }).gc;

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000) ' +
  'SELECT x FROM c';

describe('an abandoned generator is recovered at collection', () => {
  if (!forceGC) {
    it.skip('skipped — this browser was not launched with --expose-gc', () => {});
  } else {
    it('gives the worker back with no timeout and no signal', async () => {
      const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
      try {
        await db.write('CREATE TABLE t (n INTEGER)');
        await db.write(SEED);

        await (async () => {
          const rows = db.chunk('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await sleep(0);
        })();

        // Bounded retry: one collection is not a guarantee, and a hang is not
        // a report. Ten rounds, then a verdict either way.
        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          forceGC();
          await sleep(100);
          const read = db.read('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
      } finally {
        await db.close();
      }
    }, 60_000);
  }
});
```

- [ ] **Step 3: Run it 13 times**

```bash
for i in $(seq 1 13); do
  pnpm exec rstest --project chromium run tests/browser/abandon-gc.test.ts \
    || echo "RUN $i FAILED"
done
```

13 is this repository's own bar — the number that closed the `barrier` flake. Record each run's outcome.

- [ ] **Step 4: Decide, and say which you did**

- **13 green:** keep it, and commit it.
- **Anything else:** delete the file and add a comment at the top of `tests/browser/abandon.test.ts` saying that the collection path is deliberately not pinned, that the deterministic tests cover the repair itself, and what was observed over the 13 runs. A test quietly believed to cover something it does not is worse than an absent one.

- [ ] **Step 5: Commit whichever outcome**

```bash
pnpm check
git add tests/browser/
git commit -m "test(abandon): the collection path, pinned or deliberately not"
```

---

## Closing the branch

Not part of any task, and not to be done without the user saying so. When they do: `mem:conventions` § *"On clôture la session"* is the procedure — merge with `--no-ff` and a body explaining the change, verify the whole baseline table on the merged result, update `mem:state`, `mem:follow-ups` (delete the abandoned-generator entry, never annotate it) and `mem:history`, then delete the branch locally and on the remote after proving containment with `git merge-base --is-ancestor`.

`CHANGELOG.md` carries a fixed data-holding leak and a new public error code. **Opening the unreleased section is the user's instruction and is never inferred.**
