/**
 * Rows out of a generator of chunks, as `for await (c of source) yield* c`
 * gives them, minus a generator per row; `throw()` goes to the source and
 * `signal` is checked before each buffered row.
 */

type Status = 'idle' | 'open' | 'done';

const resolved = Promise.resolve();

const finished = (): IteratorReturnResult<void> => ({
  value: undefined,
  done: true,
});

class Flattened<T> implements AsyncIterator<T, void, unknown> {
  readonly #source: AsyncGenerator<T[], void, unknown>;
  readonly #signal: AbortSignal | undefined;
  #rows: readonly T[] = [];
  #index = 0;
  #status: Status = 'idle';
  // Requests queued or running. Zero is the only state in which a buffered row
  // can be served ahead of the queue.
  #pending = 0;
  // The newest request's promise: the next one waits for it to settle.
  #last: Promise<unknown> = Promise.resolve();

  constructor(
    source: AsyncGenerator<T[], void, unknown>,
    signal: AbortSignal | undefined,
  ) {
    this.#source = source;
    this.#signal = signal;
  }

  next(): Promise<IteratorResult<T, void>> {
    if (this.#pending === 0 && this.#index < this.#rows.length) {
      // The row is taken now and delivered one turn later: the signal is
      // checked then, so an abort() right after next() still wins, as it does
      // against an async generator's pending next().
      const row = this.#rows[this.#index++] as T;
      this.#pending++;
      const result = resolved.then(
        (): IteratorResult<T, void> | Promise<IteratorResult<T, void>> => {
          if (this.#signal?.aborted) {
            // Held until the rejection has settled, not until the source has
            // answered: a call in between must queue behind it.
            result.then(this.#release, this.#release);
            return this.#throwIntoSource(this.#signal.reason);
          }
          this.#pending--;
          return { value: row, done: false };
        },
      );
      this.#last = result;
      return result;
    }
    return this.#enqueue(() => this.#serve());
  }

  return(value?: void | PromiseLike<void>): Promise<IteratorResult<T, void>> {
    return this.#enqueue(async () => {
      if (this.#status !== 'open') {
        // Idle or ended: nothing to close, `value` is awaited here. Typed
        // `unknown`: a JavaScript caller's `return(42)` still gets 42 back.
        let awaited: unknown;
        try {
          awaited = await value;
        } finally {
          this.#end();
        }
        return { value: awaited as undefined, done: true };
      }
      // Open: the source gets `value` itself and settles the call, so a
      // rejecting `value` is thrown where the layers above the source catch it.
      this.#end();
      const step = await this.#source.return(value);
      // A source that yields again from its cleanup: close what is suspended.
      if (!step.done) await this.#source.return(undefined);
      return step.done ? { value: step.value, done: true } : finished();
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

  // With nothing pending the request runs now, as an async generator resumes
  // its body inside next(); otherwise it waits for the newest request.
  #enqueue<R>(request: () => Promise<R>): Promise<R> {
    const idle = this.#pending === 0;
    this.#pending++;
    const result = idle ? request() : this.#last.then(request, request);
    // Registered before the caller can attach its own handlers, so a call made
    // from one finds the iterator idle only once `result` has settled.
    result.then(this.#release, this.#release);
    this.#last = result;
    return result;
  }

  readonly #release = (): void => {
    this.#pending--;
  };

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

// An async generator inherits [Symbol.asyncIterator] and, where the engine has
// it, [Symbol.asyncDispose] from %AsyncIteratorPrototype%: so does this class.
const AsyncIteratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf(async function* () {}).prototype,
);
Object.setPrototypeOf(Flattened.prototype, AsyncIteratorPrototype);
Object.defineProperty(Flattened.prototype, Symbol.toStringTag, {
  value: 'AsyncGenerator',
  configurable: true,
});

export function flatten<T>(
  source: AsyncGenerator<T[], void, unknown>,
  options?: { signal?: AbortSignal | undefined },
): AsyncGenerator<T, void, unknown> {
  // The class is checked as an AsyncIterator; the cast adds what an
  // AsyncGenerator type requires on top, [Symbol.asyncIterator] and
  // [Symbol.asyncDispose], inherited from %AsyncIteratorPrototype% at runtime.
  const iterator: AsyncIterator<T, void, unknown> = new Flattened(
    source,
    options?.signal,
  );
  return iterator as AsyncGenerator<T, void, unknown>;
}
