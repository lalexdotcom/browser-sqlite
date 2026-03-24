import type { CreateSQLiteClientOptions } from './client';
import { type WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import type { SQLiteVFS } from './types';

export const debugSQLQuery = (sql: string, params?: any[]) => {
	if (!params || params.length === 0) return sql;

	let result = '';
	let paramIndex = 0;
	let i = 0;

	while (i < sql.length) {
		if (sql[i] === '?') {
			// Check if it's a positional parameter (?001, ?002, etc.)
			if (i + 3 < sql.length && /\d/.test(sql[i + 1]) && /\d/.test(sql[i + 2]) && /\d/.test(sql[i + 3])) {
				const position = sql.substring(i + 1, i + 4);
				const numIndex = parseInt(position, 10) - 1;

				if (!Number.isNaN(numIndex) && params[numIndex] !== undefined) {
					result += formatValue(params[numIndex]);
				} else {
					result += 'NULL';
				}
				i += 4; // Skip ? and 3 digits
			} else {
				// Simple parameter (?)
				if (paramIndex < params.length) {
					result += formatValue(params[paramIndex++]);
				} else {
					result += 'NULL';
				}
				i++;
			}
		} else if (sql[i] === "'" || sql[i] === '"') {
			// Skip string literals to avoid replacing ? inside them
			const quote = sql[i];
			result += sql[i++];
			while (i < sql.length) {
				result += sql[i];
				if (sql[i] === quote) {
					// Check for escaped quote
					if (i + 1 < sql.length && sql[i + 1] === quote) {
						result += sql[++i];
					} else {
						i++;
						break;
					}
				}
				i++;
			}
		} else {
			result += sql[i++];
		}
	}

	return result;

	function formatValue(value: any): string {
		if (value === null || value === undefined) {
			return 'NULL';
		}
		if (typeof value === 'string') {
			return `'${value.replace(/'/g, "''")}'`;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		if (value instanceof Date) {
			return `'${value.toISOString()}'`;
		}
		if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
			return `X'${Buffer.from(value).toString('hex')}'`;
		}
		return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
	}
};

export const statusToLabel = (status: number) => {
	return Object.entries(WorkerStatuses).find(([, v]) => v === status)?.[0] ?? '<unknown>';
};

type QueryDebugState = {
	sql: string;
	params?: any[];
	startTime: number;
	firstRowTime?: number;
	endTime?: number;
	error?: any;
	affectedRows: number;
};

type RequestDebugState = {
	startTime: number;
	acquireTime?: number;
	releaseTime?: number;
	affectedRows: number;
	queries: QueryDebugState[];
	currentQuery?: QueryDebugState;
};

type WorkerDebugState = {
	index: number;
	name: string;
	creationTime: number;
	initializationTime?: number;
	requests: RequestDebugState[];
	currentRequest?: RequestDebugState;
	readonly status: string;
};

type ClientDebugState = {
	readonly file: string;
	readonly vfs: SQLiteVFS;
	readonly pragmas: Record<string, string>;
	readonly name: string;
	readonly queue: {
		write: number;
		read: number;
	};
	workers: WorkerDebugState[];
};

const MAX_QUERY_HISTORY_LENGTH = 50;

export const createClientDebug = (
	file: string,
	orchestrator: WorkerOrchestrator,
	clientOptions: Required<Pick<CreateSQLiteClientOptions, 'vfs' | 'pragmas' | 'name'>>,
) => {
	const { vfs, pragmas, name } = clientOptions;
	const queue = { write: 0, read: 0 };

	const clientState: ClientDebugState = { file, vfs, pragmas, name, queue, workers: [] };

	const createWorkerDebugState = (index: number, name: string) => {
		const state: WorkerDebugState = new Proxy(
			{
				index,
				name,
				requests: [],
				status: 'HAHA',
				creationTime: Date.now(),
			},
			{
				get: (target, prop) => {
					if (prop === 'status') {
						return statusToLabel(orchestrator.getStatus(index));
					}
					return target[prop as keyof typeof target];
				},
			},
		);
		clientState.workers[index] = state;
		return state;
	};

	const createRequestDebugState = () => {
		const state: RequestDebugState = { queries: [], startTime: Date.now(), affectedRows: 0 };
		return {
			state,
			assign: (index: number) => {
				const worker = clientState.workers[index];
				if (worker) {
					state.acquireTime = Date.now();
					worker.requests.push(state);
					worker.currentRequest = state;
				}
			},
		};
	};

	const createQueryDebugState = (workerIndex: number, sql: string, params?: any[]) => {
		const state: QueryDebugState = {
			sql,
			params,
			startTime: Date.now(),
			affectedRows: 0,
		};
		const worker = clientState.workers[workerIndex];
		if (worker?.currentRequest) {
			if (worker.currentRequest.queries.length > MAX_QUERY_HISTORY_LENGTH) {
				worker.currentRequest.queries.shift();
			}
			worker.currentRequest.queries.push(state);
			worker.currentRequest.currentQuery = state;
		}
		return state;
	};

	return { state: clientState, createWorkerDebugState, createRequestDebugState, createQueryDebugState } as const;
};
