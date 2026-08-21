import { SQLiteError } from './errors';

export const sqlParams = () => {
  const sqlParamsMap = new Map<any, number>();
  const sqlParams: any[] = [];

  const addParam = (v: any) => {
    let paramIndex = sqlParamsMap.get(v);
    if (!paramIndex) {
      paramIndex = sqlParams.length + 1;
      sqlParamsMap.set(v, paramIndex);
      sqlParams.push(v);
    }
    return `?${paramIndex.toString().padStart(3, '0')}`;
  };
  const addParamArray = (values: any[]) => {
    return values.map((v) => addParam(v)).join(',');
  };
  return {
    addParam,
    addParamArray,
    params: sqlParams,
  };
};

/**
 * Every statement SQLite treats as a write, or that must be serialized through
 * the single writer worker. Matched anywhere in the string, not just at the
 * start: the worker executes `;`-separated statements, so a write hiding after
 * a semicolon must still route to the writer.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP|ALTER|VACUUM|ANALYZE|REINDEX|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH|PRAGMA)\b/i;

/**
 * Routing predicate: is this statement provably a read?
 *
 * Two conditions, both required. The statement must OPEN with a read keyword,
 * and it must contain no write keyword anywhere. The first condition alone is
 * not enough — the worker executes `;`-separated statements, so `SELECT 1;
 * DROP TABLE t` opens as a read and is not one. The second alone is not enough
 * either — it would admit any unrecognised statement as a read.
 *
 * The previous blocklist missed VACUUM, ALTER, ANALYZE, REINDEX, SAVEPOINT and
 * a manual BEGIN, so those ran on the read pool: a VACUUM could execute on an
 * arbitrary worker while the writer held an open transaction, bypassing
 * exclusivity one layer above the pool.
 *
 * Misclassification now fails toward the writer — correct, merely slower. A
 * read whose text merely mentions a write keyword (`SELECT 'INSERT'`, or
 * `EXPLAIN INSERT ...`, which never executes) is serialized needlessly. That
 * is the accepted price of never routing a write to the read pool.
 */
/**
 * A statement that is nothing but a single PRAGMA lookup: no assignment, no
 * argument, nothing after it. Anchoring at `$` is what makes this safe for
 * free — `PRAGMA journal_mode; DROP TABLE t` does not match, and neither does
 * `PRAGMA journal_mode=WAL`, whose `=` breaks the match.
 */
const READ_PRAGMA = /^\s*PRAGMA\s+(\w+\.)?\w+\s*;?\s*$/i;

export const isReadQuery = (sql: string) =>
  READ_PRAGMA.test(sql) ||
  (/^\s*(SELECT|EXPLAIN|VALUES|WITH)\b/i.test(sql) &&
    !WRITE_KEYWORDS.test(sql));

export const isWriteQuery = (sql: string) => !isReadQuery(sql);

/**
 * Routing guard for the read-shaped methods (`read`, `chunk`, `stream`, `first`).
 * Throws before a lease is taken, so a rejected statement costs no pool capacity.
 *
 * A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns
 * (`PRAGMA journal_mode=WAL`), takes an argument, or is followed by anything
 * else must go through `write()`.
 */
export const assertReadable = (sql: string, method: string): void => {
  if (isReadQuery(sql)) return;
  const keyword = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  throw new SQLiteError(
    'NOT_A_READ_QUERY',
    `${method}() only accepts statements that are provably reads; "${keyword}" must go through write(). ` +
      `Note that a PRAGMA that assigns a value or takes an argument is a write.`,
  );
};

/**
 * Quotes an SQL identifier so it can never be read as anything but a name.
 *
 * The library interpolates table, column and index names into generated SQL —
 * `bulkWrite`, `output` and their indexes. wa-sqlite's `statements()` executes
 * `;`-separated statements, so an unquoted name is a stacked-query injection
 * (B4). Quoting is what makes `t"; DROP TABLE users; --` one identifier.
 *
 * Note that quoting preserves case in `sqlite_master`; SQLite still resolves
 * names case-insensitively.
 */
export const quoteIdent = (name: string): string => {
  if (!name)
    throw new SQLiteError('INVALID_IDENTIFIER', 'Identifier cannot be empty');
  if (name.includes('\0'))
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Identifier contains a NUL character: ${JSON.stringify(name)}`,
    );
  return `"${name.replace(/"/g, '""')}"`;
};

/** `INTEGER`, `TEXT`, `VARCHAR(255)`, `DECIMAL(10, 2)` — nothing else. */
const COLUMN_TYPE = /^[A-Za-z][A-Za-z0-9 ]*(\([0-9, ]+\))?$/;

/**
 * A column type is not an identifier and cannot be quoted — it is an SQL
 * fragment the caller writes. It is validated by shape instead: this is the
 * narrowed, not closed, channel documented in the spec (§1.2).
 */
export const assertColumnType = (type: string, column: string): string => {
  const trimmed = type.trim();
  if (!COLUMN_TYPE.test(trimmed))
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Column "${column}" declares an unsupported type ${JSON.stringify(type)}. ` +
        `A type must be a word, optionally followed by numeric arguments, e.g. "INTEGER" or "VARCHAR(255)".`,
    );
  return trimmed;
};

/**
 * A GENERATED ALWAYS AS expression is caller-authored SQL. It must at least be
 * parenthesised and free of statement separators, so it cannot escape its slot.
 */
export const assertGeneratedExpression = (
  expr: string,
  column: string,
): string => {
  const trimmed = expr.trim();
  if (
    !trimmed.startsWith('(') ||
    !trimmed.endsWith(')') ||
    trimmed.includes(';')
  )
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      `Column "${column}" declares an invalid generated expression ${JSON.stringify(expr)}. ` +
        `It must be parenthesised and contain no ";", e.g. "(base * 2)".`,
    );
  return trimmed;
};

const PRAGMA_NAME = /^[A-Za-z_]\w*$/;
const PRAGMA_INTEGER = /^-?\d+$/;
const PRAGMA_LITERAL = /^'([^']|'')*'$/;

/**
 * Renders the client's `pragmas` option into executable statements, rejecting
 * anything that is not provably a name and a scalar value (B4).
 *
 * Validation is syntactic rather than a closed list of the ~60 SQLite pragmas:
 * a fixed list makes every legitimate pragma outside it unreachable and drifts
 * with SQLite versions, for no additional protection — no ";", no parenthesis
 * and no comment marker survives these three shapes either.
 *
 * Called twice: by the client at construction, so a bad configuration fails at
 * `createSQLiteClient()` rather than inside an unrelated query, and by the
 * worker at open, which is the only place the statements actually run.
 */
export const renderPragmas = (pragmas: Record<string, string>): string[] =>
  Object.entries(pragmas).map(([key, value]) => {
    if (!PRAGMA_NAME.test(key))
      throw new SQLiteError(
        'INVALID_PRAGMA',
        `Invalid pragma name ${JSON.stringify(key)}: a pragma name must match ${PRAGMA_NAME}.`,
      );
    const raw = String(value).trim();
    if (PRAGMA_INTEGER.test(raw) || PRAGMA_NAME.test(raw))
      return `PRAGMA ${key}=${raw}`;
    // PRAGMA_LITERAL already guarantees raw is a well-formed SQLite string
    // literal (outer quotes present, internal single quotes doubled per '').
    // Using raw directly is correct and simpler than re-escaping the content.
    if (PRAGMA_LITERAL.test(raw)) return `PRAGMA ${key}=${raw}`;
    throw new SQLiteError(
      'INVALID_PRAGMA',
      `Invalid value ${JSON.stringify(value)} for pragma "${key}": expected an integer, a bare word such as WAL, or a quoted literal.`,
    );
  });

/**
 * The single definition of database identity.
 *
 * OPFS itself never sees this string: `getFileHandle` takes a *name*, not a
 * path, so each VFS resolves the path itself. Four of the five shipped VFS do
 * it with `new URL(zName, 'file://')` and `AccessHandlePoolVFS` with the same
 * parse against `'file://localhost/'` — identical `pathname`. This is the identity key for client-side registries and every lock name,
 * including `initLockName` inside the worker. The string handed to
 * `sqlite3_open_v2` stays exactly as the caller wrote it: SQLite core checks
 * `nPathname + 8 > mxPathname` (64, `node_modules/wa-sqlite/src/VFS.js:10`)
 * on that string before calling `xOpen`, so adding a leading `/` to a 56-char
 * name causes `SQLITE_CANTOPEN_FULLPATH` — measured: it broke all 96 browser
 * tests. The VFS re-parses internally (`new URL(zName, 'file://')` for four
 * of five; `AccessHandlePoolVFS` uses `'file://localhost/'`), so the OPFS
 * file opened is identical whether the caller passes `'data'` or `'/data'`.
 *
 * Idempotent: the VFS re-parse of an already-normalized name is a no-op.
 */
export const normalizeDatabaseFile = (file: string): string =>
  new URL(file, 'file://').pathname;
