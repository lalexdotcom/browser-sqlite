/**
 * SPIKE fix/safari-restart-budget, deleted before the merge.
 *
 * `lifecycle` › "fails the client permanently once the restart budget is
 * spent" fails on Safari 26 with its replacement not ready within 5 s. This
 * replays its steps round by round with no bound of 5 s, and writes every
 * event as it happens (`commands.spikeLog`, `.work/spike-live.log`): the kill,
 * the rejection, each message of the replacement with its boot stage, its
 * `ready`, and the second kill. A baseline first: a fresh client's startup and
 * an uncut `longQuery(20_000_000)`.
 */
import { describe, it } from 'vitest';
import { commands } from 'vitest/browser';
import {
  createTestClient,
  ENVIRONMENT,
  interceptWorkers,
  longQuery,
  sleep,
  TEST_TARGET,
  type WorkerRecord,
} from '../helpers';

declare module 'vitest/browser' {
  interface BrowserCommands {
    spikeLog: (line: string) => Promise<void>;
  }
}

const ROUNDS = 10;
const PATIENCE = 60_000;
/** The per-statement traffic: the round's own lines say when a read settles. */
const QUIET = new Set(['query', 'done', 'credit', 'chunk']);

describe('SPIKE: a restart after a kill mid-statement', () => {
  it('times the replacement, round by round', {
    timeout: 1_500_000,
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const version = /Version\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? 'ua?';
    const label = `${ENVIRONMENT.browser} ${version} ${vfs}/${build}`;
    let t0 = performance.now();
    let round = 'base';
    const log = (line: string) => {
      const text = `SPIKE ${label} [${round}] ${Math.round(performance.now() - t0)} ms ${line}`;
      console.log(text);
      void commands.spikeLog(text);
    };

    const records = interceptWorkers();
    const record = records.push.bind(records);
    records.push = (...added: WorkerRecord[]) => {
      for (const { worker } of added) {
        const n = records.length;
        log(`worker #${n} created`);
        worker.addEventListener('message', (event: MessageEvent) => {
          const d = event.data as { type?: string; stage?: string };
          if (QUIET.has(String(d?.type))) return;
          log(`worker #${n} -> ${d?.type}${d?.stage ? ` (${d.stage})` : ''}`);
        });
        const post = worker.postMessage.bind(worker) as (
          m: unknown,
          ...r: unknown[]
        ) => void;
        worker.postMessage = (message: unknown, ...rest: unknown[]) => {
          const m = message as { type?: string; afterDeath?: unknown };
          if (QUIET.has(String(m?.type))) {
            post(message, ...rest);
            return;
          }
          log(
            `worker #${n} <- ${m?.type}${m?.afterDeath ? ' afterDeath' : ''}`,
          );
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

    // Baseline: a client's startup, and the statement the test kills, uncut.
    t0 = performance.now();
    {
      const db = await createTestClient({ poolSize: 1 });
      log('baseline client ready');
      const start = performance.now();
      await db.read(longQuery(20_000_000));
      log(
        `baseline longQuery(20M) uncut: ${Math.round(performance.now() - start)} ms`,
      );
      await db.close();
      log('baseline client closed');
    }

    const summary: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      round = `round ${r + 1}/${ROUNDS}`;
      t0 = performance.now();
      const first = records.length;
      const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 1 });
      await db.write('CREATE TABLE t (a)');
      log('client ready, table created');

      const running = db.read(longQuery(20_000_000));
      await sleep(100);
      const killedAt = performance.now();
      log(`kill #${first}`);
      records[first]?.worker.dispatchEvent(new ErrorEvent('error'));
      const outcome = await running.then(
        () => 'resolved',
        (e: { code?: string }) => e.code ?? String(e),
      );
      log(`the killed read settled: ${outcome}`);

      const ready = await waitFor(
        () => records[first + 1]?.received.includes('ready') ?? false,
      );
      const readyMs = Math.round(performance.now() - killedAt);
      log(
        ready
          ? `replacement #${first + 1} ready ${readyMs} ms after the kill`
          : `replacement #${first + 1} NOT ready ${PATIENCE} ms after the kill (received: ${records[first + 1]?.received.join(',') ?? 'no worker'})`,
      );
      summary.push(
        `${round}: replacement ${ready ? `ready in ${readyMs} ms` : 'never ready'}`,
      );

      if (ready) {
        const second = db.read(longQuery(20_000_000));
        await sleep(100);
        log(`kill #${first + 1}`);
        records[first + 1]?.worker.dispatchEvent(new ErrorEvent('error'));
        const again = await second.then(
          () => 'resolved',
          (e: { code?: string }) => e.code ?? String(e),
        );
        const after = await db.read('SELECT 1').then(
          () => 'resolved',
          (e: { code?: string }) => e.code ?? String(e),
        );
        log(`second kill: read ${again}, then SELECT 1 ${after}`);
      }
      await db.close().catch(() => {});
      log('client closed');
    }
    round = 'summary';
    for (const line of summary) log(line);
  });
});
