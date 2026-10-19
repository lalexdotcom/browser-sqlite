/**
 * Rows out of a generator of chunks, as `for await (c of source) yield* c`
 * gives them, minus a generator per row; `throw()` goes to the source and
 * `signal` is checked before each buffered row.
 */

type Status = 'idle' | 'open' | 'done';

const finished = (): IteratorReturnResult<void> => ({
  value: undefined,
  done: true,
});

class Flattened<T> implements AsyncGenerator<T, void, unknown> {
  readonly #source: AsyncGenerator<T[], void, unknown>;
  readonly #signal: AbortSignal | undefined;
  #rows: readonly T[] = [];
  #index = 0;
  #status: Status = 'idle';
  // Requests queued or running. Zero is the only state in which a buffered row
  // can be served ahead of the queue.
  #pending = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    source: AsyncGenerator<T[], void, unknown>,
    signal: AbortSignal | undefined,
  ) {
    this.#source = source;
    this.#signal = signal;
  }

  next(): Promise<IteratorResult<T, void>> {
    if (
      this.#pending === 0 &&
      this.#index < this.#rows.length &&
      !this.#signal?.aborted
    ) {
      return Promise.resolve({
        value: this.#rows[this.#index++] as T,
        done: false,
      });
    }
    return this.#enqueue(() => this.#serve());
  }

  return(value?: void | PromiseLike<void>): Promise<IteratorResult<T, void>> {
    return this.#enqueue(async () => {
      // `value` first, as an async generator awaits it: when both it and the
      // source's return() reject, its error is the one that surfaces.
      let failure: { error: unknown } | undefined;
      // Typed `unknown`: the declared type is void, a JavaScript caller's
      // `return(42)` still gets 42 back, as from an async generator.
      let awaited: unknown;
      try {
        awaited = await value;
      } catch (error) {
        failure = { error };
      }
      if (this.#status === 'open') {
        this.#end();
        try {
          await this.#source.return(undefined);
        } catch (error) {
          failure ??= { error };
        }
      }
      this.#end();
      if (failure) throw failure.error;
      return { value: awaited as undefined, done: true };
    });
  }

  throw(error?: unknown): Promise<IteratorResult<T, void>> {
    return this.#enqueue(async () => {
      if (this.#status !== 'open') {
        this.#end();
        throw error;
      }
      return this.#throwIntoSource(error);
    });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  // What `await using` calls; an async generator closes itself the same way.
  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }

  #enqueue<R>(request: () => Promise<R>): Promise<R> {
    this.#pending++;
    const result = this.#tail.then(request);
    const settled = () => {
      this.#pending--;
    };
    this.#tail = result.then(settled, settled);
    return result;
  }

  #end(): void {
    this.#status = 'done';
    this.#rows = [];
    this.#index = 0;
  }

  async #serve(): Promise<IteratorResult<T, void>> {
    if (this.#status === 'done') return finished();
    if (this.#index < this.#rows.length) {
      if (this.#signal?.aborted) {
        return this.#throwIntoSource(this.#signal.reason);
      }
      return { value: this.#rows[this.#index++] as T, done: false };
    }
    this.#status = 'open';
    for (;;) {
      let step: IteratorResult<T[], void>;
      try {
        step = await this.#source.next();
      } catch (error) {
        this.#end();
        throw error;
      }
      if (step.done) {
        this.#end();
        return finished();
      }
      if (step.value.length > 0) {
        this.#rows = step.value;
        this.#index = 1;
        return { value: step.value[0] as T, done: false };
      }
    }
  }

  async #throwIntoSource(error: unknown): Promise<IteratorResult<T, void>> {
    this.#end();
    const step = await this.#source.throw(error);
    // The source caught the error and yielded again: close what is suspended.
    if (!step.done) await this.#source.return(undefined);
    return finished();
  }
}

export function flatten<T>(
  source: AsyncGenerator<T[], void, unknown>,
  options?: { signal?: AbortSignal | undefined },
): AsyncGenerator<T, void, unknown> {
  return new Flattened(source, options?.signal);
}
