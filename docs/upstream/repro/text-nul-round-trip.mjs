// Exercises the four TEXT paths of wa-sqlite's sqlite-api.js against an embedded NUL, a leading BOM
// and a SQL NULL column: bind_text, column_text, result_text, value_text.
//
// Thirteen checks; on wa-sqlite master seven of them fail. Run it against a wa-sqlite checkout —
// dist/ is committed there, so nothing has to be built.
//
//   node text-nul-round-trip.mjs /path/to/wa-sqlite [chromium|firefox]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import * as pw from 'playwright';

const ROOT = process.argv[2];
const engine = pw[process.argv[3] ?? 'chromium'];
const PORT = 8877;

const PAGE = `<!DOCTYPE html><html><body><script type="module">
import SQLiteESMFactory from '/dist/wa-sqlite.mjs';
import * as SQLite from '/src/sqlite-api.js';

const results = [];
const check = (name, actual, expected) => results.push({
  name,
  pass: JSON.stringify(actual) === JSON.stringify(expected),
  actual: JSON.stringify(actual),
  expected: JSON.stringify(expected),
});

try {
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);
  const db = await sqlite3.open_v2(':memory:');

  const one = async (sql, bind) => {
    let out;
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (bind !== undefined) await sqlite3.bind_text(stmt, 1, bind);
      while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        out = { text: sqlite3.column_text(stmt, 0), bytes: sqlite3.column_bytes(stmt, 0),
                col: sqlite3.column(stmt, 0) };
      }
    }
    return out;
  };

  // 1. bind_text keeps the NUL: hex() sees all twelve bytes.
  check('bind_text keeps an embedded NUL',
    (await one('SELECT hex(?)', 'Before\\0After')).text, '4265666F7265004166746572');

  // 2. column_text returns the NUL and the leading BOM.
  const r2 = await one("SELECT char(65279) || 'Before' || char(0) || 'After'");
  check('column_bytes counts the whole text', r2.bytes, 15);
  check('column_text keeps the NUL and the BOM', r2.text, '\\uFEFFBefore\\0After');
  check('column() agrees with column_text', r2.col, '\\uFEFFBefore\\0After');

  // 3. A SQL NULL column.
  const r3 = await one('SELECT NULL');
  check('column_text on SQL NULL is null', r3.text, null);
  check('column() on SQL NULL is null', r3.col, null);

  // 4. Ordinary values are unchanged.
  check('plain ASCII round-trips', (await one('SELECT ?', 'hello')).text, 'hello');
  check('empty string round-trips', (await one('SELECT ?', '')).text, '');
  check('non-ASCII round-trips', (await one('SELECT ?', 'héllo — ✓ 日本')).text, 'héllo — ✓ 日本');
  check('a lone BOM round-trips', (await one('SELECT ?', '\\uFEFF')).text, '\\uFEFF');

  // 5. A user-defined function: value_text in, result_text out.
  sqlite3.create_function(db, 'echo', 1, SQLite.SQLITE_UTF8, 0, (ctx, values) => {
    const received = sqlite3.value_text(values[0]);
    seen = received;
    sqlite3.result_text(ctx, received === null ? 'WAS-NULL' : received + '\\0tail');
  });
  let seen;
  const r5 = await one("SELECT echo('a' || char(0) || 'b')");
  check('value_text keeps the NUL', seen, 'a\\0b');
  check('result_text keeps the NUL', r5.text, 'a\\0b\\0tail');
  const r6 = await one('SELECT echo(NULL)');
  check('value_text on SQL NULL is null', r6.text, 'WAS-NULL');

  await sqlite3.close(db);
} catch (e) {
  results.push({ name: 'THREW', pass: false, actual: String(e && e.stack || e), expected: '' });
}
document.body.dataset.results = JSON.stringify(results);
</script></body></html>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = normalize(decodeURIComponent(url.pathname));
  if (p === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
  if (p.startsWith('/dist/') || p.startsWith('/src/')) {
    try {
      const buf = await readFile(join(ROOT, p));
      res.setHeader('Content-Type', TYPES[extname(p)] ?? 'application/octet-stream');
      res.end(buf); return;
    } catch {}
  }
  res.statusCode = 404; res.end('nf');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await engine.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.body.dataset.results, undefined, { timeout: 30000 })
  .catch(() => {});
const results = JSON.parse(await page.evaluate(() => document.body.dataset.results ?? '[]'));
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}` + (r.pass ? '' : `\n        got ${r.actual}\n        want ${r.expected}`));
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
