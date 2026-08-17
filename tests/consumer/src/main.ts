// Deliberately imports by bare specifier: this exercises the published
// package's `exports` map, not the repo sources.
import { createSQLiteClient } from 'browser-sqlite';

declare global {
  interface Window {
    __SMOKE__?: { ok: boolean; detail: string };
  }
}

async function run(): Promise<string> {
  if (!crossOriginIsolated) {
    throw new Error(
      'crossOriginIsolated is false — COOP/COEP headers are missing, SharedArrayBuffer is unavailable',
    );
  }

  const db = createSQLiteClient(`consumer-smoke-${crypto.randomUUID()}`);

  await db.write('CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT)');
  await db.write(
    "INSERT INTO smoke (id, label) VALUES (1, 'alpha'), (2, 'beta')",
  );

  const rows = await db.read<{ id: number; label: string }>(
    'SELECT id, label FROM smoke ORDER BY id',
  );

  db.close();

  if (rows.length !== 2 || rows[1].label !== 'beta') {
    throw new Error(`unexpected rows: ${JSON.stringify(rows)}`);
  }

  return `read back ${rows.length} rows`;
}

const out = document.getElementById('out');

run().then(
  (detail) => {
    window.__SMOKE__ = { ok: true, detail };
    if (out) out.textContent = `OK — ${detail}`;
  },
  (error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    window.__SMOKE__ = { ok: false, detail };
    if (out) out.textContent = `FAILED — ${detail}`;
  },
);
