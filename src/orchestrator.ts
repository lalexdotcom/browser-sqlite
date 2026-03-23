import { defer } from '@lalex/promises';

/**
 * Worker orchestrator for SQLite worker pool synchronization.
 *
 * Responsibilities:
 * - Establish an initialization lock to serialize worker database initialization
 * - Track worker status transitions throughout their lifecycle
 */

// SharedArrayBuffer layout indices
const FlagsIndexes = {
	INIT_LOCK: 0, // Binary lock (0/1) to serialize worker initialization
};

// Lock states for initialization synchronization
const WorkerLock = {
	FREE: 0,
	LOCKED: 1,
} as const satisfies Record<string, number>;

// Worker lifecycle status values
export const WorkerStatuses = {
	EMPTY: -3, // Worker slot not yet created
	NEW: -2, // Worker created but not initialized
	INITIALIZING: -1, // Worker is initializing database
	INITIALIZED: 0, // Database initialized, transitioning to READY

	READY: 10, // Worker available for queries

	RESERVED: 49, // Worker reserved for a query (not used in current implementation)
	RUNNING: 50, // Worker executing a query

	ABORTING: 99, // Worker aborting current query
	DONE: 100, // Worker finished query, awaiting release
} as const satisfies Record<string, number>;

export type WorkerStatus = (typeof WorkerStatuses)[keyof typeof WorkerStatuses];

// Offset to skip fixed flags and access per-worker status array
const FLAGS_WORKER_STATUS_OFFSET = Math.max(...Object.values(FlagsIndexes)) + 1;

/**
 * Worker pool orchestrator using SharedArrayBuffer for cross-thread synchronization.
 *
 * Key features:
 * - Serializes worker initialization via an atomic lock to prevent database conflicts
 * - Tracks individual worker status using atomic operations for thread-safe state management
 */
export class WorkerOrchestrator {
	readonly sharedArrayBuffer: SharedArrayBuffer;
	private flags: Int32Array;

	readonly size: number;

	/**
	 * Creates a new orchestrator instance.
	 * @param init - Pool size (creates new SharedArrayBuffer) or existing SharedArrayBuffer
	 */
	constructor(init: number | SharedArrayBuffer) {
		if (typeof init === 'number') {
			// Create new SharedArrayBuffer for the pool
			this.sharedArrayBuffer = new SharedArrayBuffer(
				(init + FLAGS_WORKER_STATUS_OFFSET) * Int32Array.BYTES_PER_ELEMENT,
			);
		} else {
			this.sharedArrayBuffer = init;
		}
		this.flags = new Int32Array(this.sharedArrayBuffer);
		if (typeof init === 'number') {
			this.size = init;

			// Initialize lock to FREE state
			this.flags[FlagsIndexes.INIT_LOCK] = WorkerLock.FREE;

			// Mark all worker slots as EMPTY
			this.flags.fill(WorkerStatuses.EMPTY, FLAGS_WORKER_STATUS_OFFSET);
		} else {
			// Calculate pool size from existing buffer
			this.size = init.byteLength / Int32Array.BYTES_PER_ELEMENT - FLAGS_WORKER_STATUS_OFFSET;
		}
	}

	/**
	 * Acquire initialization lock.
	 * Workers call this during startup to serialize database initialization.
	 * Uses busy-wait with Atomics.wait() for blocking.
	 */
	lock() {
		while (
			Atomics.compareExchange(this.flags, FlagsIndexes.INIT_LOCK, WorkerLock.FREE, WorkerLock.LOCKED) !==
			WorkerLock.FREE
		) {
			Atomics.wait(this.flags, FlagsIndexes.INIT_LOCK, WorkerLock.LOCKED);
		}
	}

	/**
	 * Release initialization lock.
	 * Notifies one waiting worker that the lock is now available.
	 */
	unlock() {
		if (
			Atomics.compareExchange(this.flags, FlagsIndexes.INIT_LOCK, WorkerLock.LOCKED, WorkerLock.FREE) ===
			WorkerLock.LOCKED
		) {
			Atomics.notify(this.flags, FlagsIndexes.INIT_LOCK, 1);
		}
	}

	/**
	 * Update worker status atomically.
	 * @param index - Worker index in the pool
	 * @param status - New status to set
	 * @param from - Optional: expected current status for conditional update (CAS)
	 * @returns true if status was successfully updated
	 */
	setStatus(index: number, status: WorkerStatus, from?: WorkerStatus) {
		let oldValue: WorkerStatus | undefined;
		const workerStatusIndex = index + FLAGS_WORKER_STATUS_OFFSET;

		if (from !== undefined) {
			if (Atomics.compareExchange(this.flags, workerStatusIndex, from, status) === from) {
				oldValue = from;
			}
		} else {
			const oldStatus = Atomics.exchange(this.flags, workerStatusIndex, status);
			if (oldStatus !== status) oldValue = oldStatus as WorkerStatus;
		}
		const success = oldValue !== undefined;
		return success;
	}

	/**
	 * Get current worker status.
	 * @param index - Worker index in the pool
	 * @returns Current worker status
	 */
	getStatus(index: number) {
		return Atomics.load(this.flags, index + FLAGS_WORKER_STATUS_OFFSET) as WorkerStatus;
	}
}
