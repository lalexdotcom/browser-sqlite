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
 * Routing predicate: is this statement provably a read?
 *
 * Deliberately an allowlist. The previous blocklist missed VACUUM, ALTER,
 * ANALYZE, REINDEX, SAVEPOINT and a manual BEGIN, which therefore ran on the
 * read pool — a VACUUM could execute on an arbitrary worker while the writer
 * held an open transaction, bypassing exclusivity one layer above the pool.
 *
 * A misclassification now fails toward the writer: correct, merely slower.
 * A CTE is only a read when no write keyword appears anywhere in the statement,
 * because `WITH ... INSERT` is a write wearing a read's opening keyword.
 */
export const isReadQuery = (sql: string) =>
  /^\s*(SELECT|EXPLAIN|VALUES)\b/i.test(sql) ||
  (/^\s*WITH\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));

export const isWriteQuery = (sql: string) => !isReadQuery(sql);
