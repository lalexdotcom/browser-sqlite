/**
 * The prefixed logger the `debug` option turns on.
 *
 * Lifecycle events only — worker created, ready, open-error, crash, restart,
 * eviction, close, skipped sweep. A line per query would be illegible under
 * real load and would put user values on the console; query throughput belongs
 * in `db.debug`, not here.
 */
export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type Sink = Pick<Console, 'debug' | 'warn' | 'error'>;

export const createLogger = (
  prefix: string,
  enabled: boolean,
  sink: Sink = console,
): Logger => {
  if (!enabled) return { info: () => {}, warn: () => {}, error: () => {} };

  const line = (message: string) => `[${prefix}] ${message}`;
  return {
    info: (message) => sink.debug(line(message)),
    warn: (message) => sink.warn(line(message)),
    error: (message) => sink.error(line(message)),
  };
};
