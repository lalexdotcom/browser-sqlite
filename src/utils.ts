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
export const isReadQuery = (sql: string) =>
  /^\s*(SELECT|EXPLAIN|VALUES|WITH)\b/i.test(sql) && !WRITE_KEYWORDS.test(sql);

export const isWriteQuery = (sql: string) => !isReadQuery(sql);

/**
 * Routing guard for the read-shaped methods (`read`, `chunk`, `stream`, `first`).
 * Throws before a lease is taken, so a rejected statement costs no pool capacity.
 *
 * Note: `isReadQuery` classifies every PRAGMA as a write, so a read pragma has
 * to go through `write()` until B4 lands its pragma allowlist.
 */
export const assertReadable = (sql: string, method: string): void => {
  if (isReadQuery(sql)) return;
  const keyword = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  throw new SQLiteError(
    'NOT_A_READ_QUERY',
    `${method}() only accepts statements that are provably reads; "${keyword}" must go through write(). ` +
      `Note that every PRAGMA is currently classified as a write.`,
  );
};
