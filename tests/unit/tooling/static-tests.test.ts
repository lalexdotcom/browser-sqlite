import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BROWSER = fileURLToPath(new URL('../../browser/pairs', import.meta.url));

/**
 * The planner selects a cell's tests by the ids static parsing gives them
 * (mem:measurements/suite-and-matrix § TEST-IDS): a test created in a loop,
 * an each or behind a condition shifts every later id or is never seen, and
 * would be run silently wrong. The parser flags the loops it sees (the
 * planner refuses them); these are the constructs it cannot see at all.
 */
// A `for` inside a test body is legitimate, and a loop that creates tests is
// flagged by the parser through its template name (PLAN_DYNAMIC).
const FORBIDDEN: readonly [RegExp, string][] = [
  [
    /\?\s*(it|test|describe)\s*:\s*(it|test|describe)\.skip/,
    'a conditional test: tag its need instead',
  ],
  [
    /\?\s*(it|test|describe)\.skip\s*:\s*(it|test|describe)\b/,
    'a conditional test, reversed: tag its need instead',
  ],
  [
    /\b(it|test|describe)\.(each|for)\b/,
    'an each: write one literal test per case, or loop inside one test',
  ],
  [
    /\b(it|test|describe)(\.\w+)*\(\s*[A-Za-z_$][\w$.]*\s*,/,
    'a test whose name is not a literal: the parser reads the identifier, and every planned run fails as dynamic',
  ],
  [
    /\bif\s*\([^)]*\)\s*\{?\s*(it|test|describe)(\.\w+)*\s*\(/,
    'a test behind an if: tag its need instead',
  ],
];

const files = readdirSync(BROWSER, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.ts'));

describe('browser test files declare their tests statically', () => {
  it('finds the browser test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('none creates a test the parser cannot see', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(BROWSER, file), 'utf8');
      return FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(
        ([, why]) => `${file}: ${why}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('refuses the constructs it lists', () => {
    // Falsifiable: break one pattern and its sample passes.
    const samples = [
      'const x = cond ? it : it.skip;',
      "it.each([1])('t', () => {});",
      'it(name, () => {});',
      "if (ok) {\n  it('t', () => {});\n}",
    ];
    for (const sample of samples) {
      expect(FORBIDDEN.some(([pattern]) => pattern.test(sample))).toBe(true);
    }
    expect(
      FORBIDDEN.some(([p]) =>
        p.test("it('t', { tags: ['standalone'] }, () => {});"),
      ),
    ).toBe(false);
  });
});
