import { describe, expect, it } from '@rstest/core';
import { createBulk } from '../../src/bulk';

/** Records every statement the unit under test emits. */
const recorder = () => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 0 };
  };
  return { sql, write };
};

describe('bulkWrite quoting (B4)', () => {
  it('quotes the table and every column in the INSERT', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('my table', ['a b', 'c']);
    bulk.enqueue({ 'a b': 1, c: 2 });
    await bulk.close();

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('INSERT INTO "my table"');
    expect(sql[0]).toContain('("a b","c")');
  });

  it('neutralises an injection in the table name', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t"; DROP TABLE users; --', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close();

    expect(sql[0]).toContain('INSERT INTO "t""; DROP TABLE users; --"');
    // One statement, not two: the injected text never leaves the quotes.
    expect(sql[0].replace(/"[^"]*(""[^"]*)*"/g, '<ident>')).not.toContain(
      'DROP TABLE',
    );
  });
});
