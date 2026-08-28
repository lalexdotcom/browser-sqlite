/**
 * The prefixed logger the `debug` option turns on.
 *
 * Lifecycle events only — worker created, ready, open-error, crash, restart,
 * worker loss, close, skipped sweep. A line per query would be illegible under
 * real load and would put user values on the console; query throughput belongs
 * in `db.debug`, not here.
 */
export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /**
   * Always writes through the sink regardless of the `enabled` flag.
   * Use for events that must be visible even when debug logging is off —
   * permanent pool shrinkage being the primary case.
   */
  always: {
    warn: (message: string) => void;
  };
};

type Sink = Pick<Console, 'debug' | 'warn' | 'error'>;

export const createLogger = (
  prefix: string,
  enabled: boolean,
  sink: Sink = console,
): Logger => {
  const line = (message: string) => `[${prefix}] ${message}`;
  // always.warn bypasses the enabled gate — pool shrinkage must be visible
  // even when debug logging is off, so the sink is the point (it is injectable
  // by tests, unlike a bare console.warn call).
  const always = { warn: (message: string) => sink.warn(line(message)) };

  if (!enabled)
    return { info: () => {}, warn: () => {}, error: () => {}, always };

  return {
    info: (message) => sink.debug(line(message)),
    warn: (message) => sink.warn(line(message)),
    error: (message) => sink.error(line(message)),
    always,
  };
};
