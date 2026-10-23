/**
 * SPIKE fix/safari-restart-budget, deleted before the merge.
 *
 * `lifecycle` › "fails the client permanently once the restart budget is
 * spent" fails on Safari 26 with its replacement not ready within 5 s. This
 * replays its steps round by round with no bound of 5 s, and writes every
 * event as it happens (a POST to the dev server, appended to `.work/spike-live.log`): the kill,
 * the rejection, each message of the replacement with its boot stage, its
 * `ready`, and the second kill. A baseline first: a fresh client's startup and
 * an uncut `longQuery(20_000_000)`.
 */
import { describe, it } from 'vitest';

type Client = Awaited<ReturnType<typeof createTestClient>>;

import {
  createTestClient,
  ENVIRONMENT,
  interceptWorkers,
  longQuery,
  sleep,
  TEST_TARGET,
  type WorkerRecord,
} from '../helpers';

const ROUNDS = 10;
const PATIENCE = 60_000;
/** The per-statement traffic: the round's own lines say when a read settles. */
const QUIET = new Set(['query', 'done', 'credit', 'chunk']);

describe('SPIKE: a restart after a kill mid-statement', () => {
  it('times the replacement, round by round', {
    tags: ['browser:safari'],
    timeout: 1_500_000,
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const version = /Version\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? 'ua?';
    const label = `${ENVIRONMENT.browser} ${version} ${vfs}/${build}`;
    let t0 = performance.now();
    let round = 'base';
    // In order: each line waits for the previous one to be written.
    let sent = Promise.resolve();
    const log = (line: string) => {
      const text = `SPIKE ${label} [${round}] ${Math.round(performance.now() - t0)} ms ${line}`;
      console.log(text);
      sent = sent.then(() =>
        fetch('/__spike-log', { method: 'POST', body: text }).then(
          () => {},
          () => {},
        ),
      );
    };

    // Per variant, how long each worker spent in `instantiating wasm` (until
    // `loading the VFS module`): the stage the slow replacements stalled in.
    const instantiate = new Map<string, number[]>();
    const records = interceptWorkers();
    const record = records.push.bind(records);
    records.push = (...added: WorkerRecord[]) => {
      for (const { worker } of added) {
        const n = records.length;
        let began: number | undefined;
        log(`worker #${n} created`);
        worker.addEventListener('message', (event: MessageEvent) => {
          const d = event.data as { type?: string; stage?: string };
          if (QUIET.has(String(d?.type))) return;
          log(`worker #${n} -> ${d?.type}${d?.stage ? ` (${d.stage})` : ''}`);
          if (d?.stage === 'instantiating wasm') began = performance.now();
          if (d?.stage === 'loading the VFS module' && began !== undefined) {
            const ms = Math.round(performance.now() - began);
            log(`worker #${n} instantiated in ${ms} ms`);
            const list = instantiate.get(round) ?? [];
            list.push(ms);
            instantiate.set(round, list);
          }
        });
        const post = worker.postMessage.bind(worker) as (
          m: unknown,
          ...r: unknown[]
        ) => void;
        worker.postMessage = (message: unknown, ...rest: unknown[]) => {
          const m = message as { type?: string; afterDeath?: unknown };
          if (!QUIET.has(String(m?.type))) {
            log(
              `worker #${n} <- ${m?.type}${m?.afterDeath ? ' afterDeath' : ''}`,
            );
          }
          post(message, ...rest);
        };
      }
      return record(...added);
    };

    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + PATIENCE;
      while (!predicate()) {
        if (performance.now() > deadline) return false;
        await sleep(10);
      }
      return true;
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: { code?: string }) => e.code ?? String(e),
      );

    /** One round: a client of one worker, then what the variant does to it. */
    const variants: [
      string,
      number,
      (db: Client, first: number) => Promise<void>,
    ][] = [
      ['A open and close', ROUNDS, async () => {}],
      [
        'B long query run out',
        5,
        async (db) => {
          const start = performance.now();
          await db.read(longQuery(2_000_000));
          log(
            `longQuery(2M) uncut: ${Math.round(performance.now() - start)} ms`,
          );
        },
      ],
      [
        'C kill an idle worker',
        ROUNDS,
        async (db, first) => {
          log(`kill #${first} (idle)`);
          records[first]?.worker.dispatchEvent(new ErrorEvent('error'));
          const ready = await waitFor(
            () => records[first + 1]?.received.includes('ready') ?? false,
          );
          log(
            `replacement ${ready ? 'ready' : 'NOT ready'}, SELECT 1 ${await settle(db.read('SELECT 1'))}`,
          );
        },
      ],
      [
        'D kill mid-statement',
        ROUNDS,
        async (db, first) => {
          const running = db.read(longQuery(20_000_000));
          await sleep(100);
          log(`kill #${first} (running)`);
          records[first]?.worker.dispatchEvent(new ErrorEvent('error'));
          log(`the killed read settled: ${await settle(running)}`);
          const ready = await waitFor(
            () => records[first + 1]?.received.includes('ready') ?? false,
          );
          log(`replacement ${ready ? 'ready' : 'NOT ready'}`);
        },
      ],
    ];

    for (const [name, rounds, act] of variants) {
      for (let r = 0; r < rounds; r++) {
        round = name;
        t0 = performance.now();
        const first = records.length;
        const db = await createTestClient({
          poolSize: 1,
          maxWorkerRestarts: 1,
        });
        await db.write('CREATE TABLE t (a)');
        log(`round ${r + 1}/${rounds}: client ready`);
        await act(db, first);
        await db.close().catch(() => {});
        log(`round ${r + 1}/${rounds}: client closed`);
      }
    }
    round = 'summary';
    for (const [name] of variants) {
      const list = instantiate.get(name) ?? [];
      const slow = list.filter((ms) => ms > 1000).length;
      log(
        `${name}: ${list.length} instantiations, ${slow} over 1 s, max ${Math.max(0, ...list)} ms — ${list.join(' ')}`,
      );
    }
    await sent;
  });
});
