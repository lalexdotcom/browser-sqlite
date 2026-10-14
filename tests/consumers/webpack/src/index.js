// Deliberately imports by bare specifier: this exercises the published
// package resolution, not the repo sources. Plain JS on purpose — a TS loader
// is not what this fixture is here to prove.
import { createSQLiteClient } from 'browser-sqlite';

async function run() {
  const db = createSQLiteClient(`consumer-smoke-${crypto.randomUUID()}`, {
    vfs: 'OPFSAdaptiveVFS',
  });

  await db.write('CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT)');
  await db.write(
    "INSERT INTO smoke (id, label) VALUES (1, 'alpha'), (2, 'beta')",
  );

  const rows = await db.read('SELECT id, label FROM smoke ORDER BY id');

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
  (error) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    window.__SMOKE__ = { ok: false, detail };
    if (out) out.textContent = `FAILED — ${detail}`;
  },
);
