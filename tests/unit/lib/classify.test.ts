import { describe, expect, it } from 'vitest';
import {
  classifyStatement,
  type PrepareFacts,
  type StatementKind,
} from '../../../src/classify';

// Measured on 2026-10-27 against wa-sqlite's SQLite at prepare time.
const cases: Array<[string, PrepareFacts, StatementKind]> = [
  ['SELECT', { explain: false, readonly: true }, 'read'],
  ['INSERT', { explain: false, readonly: false }, 'write'],
  ['EXPLAIN INSERT', { explain: true, readonly: false }, 'read'],
  ['EXPLAIN SELECT', { explain: true, readonly: true }, 'read'],
  [
    'EXPLAIN PRAGMA optimize (never runs the program)',
    {
      pragma: { name: 'optimize', value: null },
      explain: true,
      readonly: true,
    },
    'read',
  ],
  [
    'PRAGMA journal_mode (bare, readonly 0)',
    {
      pragma: { name: 'journal_mode', value: null },
      explain: false,
      readonly: false,
    },
    'read',
  ],
  [
    'PRAGMA journal_mode = wal',
    {
      pragma: { name: 'journal_mode', value: 'wal' },
      explain: false,
      readonly: false,
    },
    'write',
  ],
  [
    'PRAGMA optimize (bare, readonly 1)',
    {
      pragma: { name: 'optimize', value: null },
      explain: false,
      readonly: true,
    },
    'write',
  ],
  [
    'PRAGMA cache_size(10) (readonly 1)',
    {
      pragma: { name: 'cache_size', value: '10' },
      explain: false,
      readonly: true,
    },
    'write',
  ],
  [
    'PRAGMA table_info(t)',
    {
      pragma: { name: 'table_info', value: 't' },
      explain: false,
      readonly: true,
    },
    'read',
  ],
  [
    'PRAGMA TABLE_INFO(t) (case)',
    {
      pragma: { name: 'TABLE_INFO', value: 't' },
      explain: false,
      readonly: true,
    },
    'read',
  ],
  [
    'PRAGMA user_version = 3',
    {
      pragma: { name: 'user_version', value: '3' },
      explain: false,
      readonly: false,
    },
    'write',
  ],
  [
    'PRAGMA wal_checkpoint',
    {
      pragma: { name: 'wal_checkpoint', value: null },
      explain: false,
      readonly: false,
    },
    'write',
  ],
  [
    'PRAGMA cache_size (bare)',
    {
      pragma: { name: 'cache_size', value: null },
      explain: false,
      readonly: true,
    },
    'read',
  ],
  [
    'ATTACH (readonly 1)',
    { attach: true, explain: false, readonly: true },
    'write',
  ],
];

describe('classifyStatement', () => {
  it.each(cases)('%s', (_, facts, kind) => {
    expect(classifyStatement(facts)).toBe(kind);
  });
});
