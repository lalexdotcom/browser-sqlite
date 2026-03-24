/**
 * Logger abstraction for wsqlite.
 *
 * Attempts to use @lalex/console if installed (optional dependency).
 * Falls back to a native console shim with the same interface.
 *
 * Exports:
 * - ScopedLogger: type matching @lalex/console's scoped logger interface
 * - makeConsoleShim(scopeName?): returns a shim implementing ScopedLogger
 * - shouldLog(messageLevel, currentLevel): boolean — level filter for worker.ts
 * - LL: module-level logger instance (either real or shim), ready at import time
 */

export type ScopedLogger = {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	verb: (...args: unknown[]) => void;
	wth: (...args: unknown[]) => void;
	success: (...args: unknown[]) => void;
	set level(l: string);
	set date(d: boolean);
	scope: (name: string) => ScopedLogger;
};

/**
 * Level numeric ordering from @lalex/console LEVEL_METHODS.
 * Lower number = higher severity (more critical).
 * "should log" means: message severity <= configured threshold.
 * Example: currentLevel='warn'(4). messageLevel='debug'(9). 9 > 4 → false (suppressed).
 * Example: currentLevel='warn'(4). messageLevel='error'(3). 3 <= 4 → true (emitted).
 */
const LEVEL_NUMERIC: Record<string, number> = {
	emerg: 0,
	alert: 1,
	crit: 2,
	error: 3,
	warn: 4,
	notice: 5,
	success: 6,
	info: 7,
	verb: 8,
	debug: 9,
	wth: 10,
};

/**
 * Returns true if a message at `messageLevel` should be emitted
 * given the current `currentLevel` threshold.
 *
 * Non-standard levels (verb, wth) are treated as debug (numeric 9).
 * Unknown levels default to debug (permissive).
 */
export function shouldLog(messageLevel: string, currentLevel: string): boolean {
	const msg = LEVEL_NUMERIC[messageLevel] ?? LEVEL_NUMERIC.debug;
	const cur = LEVEL_NUMERIC[currentLevel] ?? LEVEL_NUMERIC.warn;
	return msg <= cur;
}

/**
 * Creates a native console shim that implements ScopedLogger.
 * Used as a fallback when @lalex/console is not installed.
 *
 * @param scopeName - Optional scope prefix included in logged output as "[scopeName] ".
 */
export function makeConsoleShim(scopeName?: string): ScopedLogger {
	const prefix = scopeName ? `[${scopeName}]` : '';
	let _level = 'warn';
	const shim: ScopedLogger = {
		debug: (...args: unknown[]) => console.debug(prefix, ...args),
		info: (...args: unknown[]) => console.info(prefix, ...args),
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
		verb: (...args: unknown[]) => console.debug(prefix, ...args),
		wth: (...args: unknown[]) => console.debug(prefix, ...args),
		success: (...args: unknown[]) => console.log(prefix, ...args),
		set level(l: string) {
			_level = l; // stored but filtering is done worker-side (D-12)
		},
		set date(_: boolean) {
			// no-op: native console handles timestamps
		},
		scope: (name: string) => makeConsoleShim(name),
	};
	return shim;
}

/**
 * Module-level logger instance.
 *
 * Initialized synchronously with the console shim, then upgraded to
 * @lalex/console asynchronously if the package is available.
 * The async swap has an acceptable race window: log calls during module
 * initialization (before createSQLiteClient is first called) use the shim.
 */
export let LL: ScopedLogger = makeConsoleShim('sqlite/client');

// Attempt to upgrade to @lalex/console if installed (D-09)
// Using async IIFE instead of top-level await to support CJS build output (Pitfall 1).
(async () => {
	try {
		const { Logger } = await import('@lalex/console');
		const realLL = Logger.scope('sqlite/client') as unknown as ScopedLogger;
		(realLL as unknown as { date: boolean }).date = true;
		LL = realLL;
	} catch {
		// @lalex/console not installed — keep the native console shim
	}
})();
