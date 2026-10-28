/**
 * What SQLite reports about a statement once prepared, enough to tell a read
 * from a write. `pragma` is set when the statement is a PRAGMA; `attach` when
 * it is an ATTACH.
 */
export type PrepareFacts = {
  pragma?: { name: string; value: string | null };
  attach?: true;
  explain: boolean;
  readonly: boolean;
};

export type StatementKind = 'read' | 'write';

/**
 * The pragmas that write the database file, with a value or without one.
 * Measured on 2026-10-01 — each took a write lock where the others never did —
 * except `optimize` and `wal_checkpoint`, which write only when they find
 * work, per SQLite's pragma.c.
 */
export const WRITING_PRAGMAS = new Set([
  'user_version',
  'application_id',
  'schema_version',
  'auto_vacuum',
  'incremental_vacuum',
  'optimize',
  'wal_checkpoint',
]);

/** Those of them that write with no value at all, so look like a lookup. */
export const BARE_WRITING_PRAGMAS = new Set([
  'incremental_vacuum',
  'optimize',
  'wal_checkpoint',
]);

/**
 * The pragmas whose argument names what to inspect rather than a value to set.
 * Everywhere else `PRAGMA x(v)` is SQLite's other assignment syntax. Probed on
 * wa-sqlite's SQLite 3.53.0, whose `pragma_list` holds no other: each ran on a
 * read-only connection, where `user_version(5)` fails. Closed by meaning, not
 * by that probe — `cache_size(10)` passes it too, and changes the connection.
 */
export const INTROSPECTION_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_info',
  'index_xinfo',
  'index_list',
  'foreign_key_list',
  'foreign_key_check',
  'integrity_check',
  'quick_check',
]);

/**
 * Read or write, from the facts SQLite reports at prepare. An EXPLAIN never
 * runs its program, so it reads whatever it explains. A pragma is decided by
 * its name and value alone; `readonly` does not apply to it.
 */
export const classifyStatement = (facts: PrepareFacts): StatementKind => {
  if (facts.explain) return 'read';
  if (facts.pragma) {
    const name = facts.pragma.name.toLowerCase();
    if (facts.pragma.value !== null && !INTROSPECTION_PRAGMAS.has(name))
      return 'write';
    return BARE_WRITING_PRAGMAS.has(name) ? 'write' : 'read';
  }
  if (facts.attach) return 'write';
  return facts.readonly ? 'read' : 'write';
};

/**
 * A text whose first keyword is EXPLAIN, past blanks, `;` and comments. A line
 * comment ends at its newline, so a long one cannot be re-split by backtracking.
 */
export const EXPLAIN_FIRST =
  /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*explain\b/i;
