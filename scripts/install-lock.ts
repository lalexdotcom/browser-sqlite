/**
 * Elects one installer among the processes that need the same thing installed,
 * through a local socket: the process that binds it leads, the others connect
 * and wait for its one-line answer. The kernel releases the socket when its
 * owner dies, so a killed leader never leaves a lock behind that blocks anyone.
 *
 * Wire protocol: the leader writes `ready\n` or `error <message>\n` to every
 * connection, held or later, and closes it.
 */
import { createHash } from 'node:crypto';
import { statSync, unlinkSync } from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Longest an install may run before its leader gives up. Unscaled: callers multiply by `timeScale()`. */
export const INSTALL_BOUND_MS = 600_000;
/** What a waiter adds to the leader's bound before giving up on it. Unscaled. */
export const WAIT_MARGIN_MS = 60_000;

/** Pause before retrying a socket that is gone or refusing on Windows. */
const RETRY_MS = 25;
/** Grace for waiters to hang up before the leader destroys their sockets. */
const CLOSE_GRACE_MS = 2000;

/**
 * The socket one cache directory elects its installer on: short, because a
 * Unix socket path is limited to 104 bytes on macOS, and a function of the
 * directory alone so that two checkouts do not share a lock.
 */
export function lockPath(key: string): string {
  const id = createHash('sha256')
    .update(resolve(key))
    .digest('hex')
    .slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\bsq-browsers-${id}`
    : join(tmpdir(), `bsq-browsers-${id}.sock`);
}

export interface RunOnceOptions {
  path: string;
  /** True when what this process needs is installed. */
  done: () => Promise<boolean>;
  install: () => Promise<void>;
  /** Milliseconds the leader's `install` may take, already scaled. */
  installBound: number;
  /** Milliseconds a waiter hears nothing from its leader before failing, already scaled. */
  waitBound: number;
  log?: (line: string) => void;
}

/**
 * Resolves once `done()` is true after the protocol: at once when it already is,
 * else after this process installed or after the leader it waited for did.
 * Rejects with the leader's error, or with a bound error.
 */
export async function runOnce(options: RunOnceOptions): Promise<void> {
  const { path, done, install, installBound, waitBound, log } = options;
  if (await done()) return;
  for (;;) {
    const server = await tryListen(path);
    if (server !== 'busy') {
      log?.(`browsers: installing (lock ${path})`);
      await lead(server, installBound, async () => {
        if (!(await done())) await install();
      });
      return;
    }
    const heard = await listenTo(path, waitBound);
    switch (heard.kind) {
      case 'line':
        if (heard.line === 'ready') {
          if (await done()) return;
        } else if (heard.line.startsWith('error ')) {
          throw new Error(heard.line.slice('error '.length));
        }
        break;
      case 'dead':
        break;
      case 'missing':
        await sleep(RETRY_MS);
        break;
      case 'refused':
        if (process.platform === 'win32') await sleep(RETRY_MS);
        else unlinkIfSame(path, heard.inode);
        break;
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** `work()`, rejected with `message` if it takes longer than `ms`. */
function bounded<T>(
  ms: number,
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work()
      .then(resolvePromise, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** The server bound to `path`, or `'busy'` when something already is. */
function tryListen(path: string): Promise<Server | 'busy'> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolvePromise('busy');
      else reject(error);
    });
    server.listen(path, () => {
      server.on('error', () => {});
      resolvePromise(server);
    });
  });
}

/** Runs `work` as the leader, answers every waiter with its outcome, then rethrows its error. */
async function lead(
  server: Server,
  installBound: number,
  work: () => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  let line: string | undefined;
  server.on('connection', (socket: Socket) => {
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (line === undefined) sockets.add(socket);
    else socket.end(line);
  });

  let failure: unknown;
  try {
    await bounded(
      installBound,
      `browsers: install did not finish within ${installBound / 1000} s`,
      work,
    );
  } catch (error) {
    failure = error;
  }
  line =
    failure === undefined
      ? 'ready\n'
      : `error ${(failure instanceof Error ? failure.message : String(failure)).replace(/\s*\n\s*/g, ' ')}\n`;
  for (const socket of sockets) socket.end(line);

  await new Promise<void>((closed) => {
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, CLOSE_GRACE_MS);
    server.close(() => {
      clearTimeout(grace);
      closed();
    });
  });
  if (failure !== undefined) throw failure;
}

type Heard =
  | { kind: 'line'; line: string }
  | { kind: 'dead' }
  | { kind: 'missing' }
  | { kind: 'refused'; inode: number | undefined };

/** Connects to the leader's socket and reports what came back. */
function listenTo(path: string, waitBound: number): Promise<Heard> {
  return new Promise<Heard>((resolvePromise, reject) => {
    const inode = inodeOf(path);
    const socket = createConnection(path);
    let buffer = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      finish();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(
              `browsers: waited ${waitBound / 1000} s for the install led by another process (${path})`,
            ),
          ),
        ),
      waitBound,
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        settle(() =>
          resolvePromise({ kind: 'line', line: buffer.slice(0, end) }),
        );
      }
    });
    socket.on('close', () => settle(() => resolvePromise({ kind: 'dead' })));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      switch (error.code) {
        case 'ECONNREFUSED':
          settle(() => resolvePromise({ kind: 'refused', inode }));
          break;
        case 'ENOENT':
          settle(() => resolvePromise({ kind: 'missing' }));
          break;
        case 'ECONNRESET':
        case 'EPIPE':
          settle(() => resolvePromise({ kind: 'dead' }));
          break;
        default:
          settle(() => reject(error));
      }
    });
  });
}

function inodeOf(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

/**
 * Removes a socket file nobody listens on. Only the file that refused the
 * connection: if another process already replaced it, that one is alive.
 */
function unlinkIfSame(path: string, inode: number | undefined): void {
  if (inode === undefined || inodeOf(path) !== inode) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
