import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root-only option: Vitest rejects it inside a project.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
          // configDefaults.exclude keeps node_modules out: the consumer
          // fixtures under tests/ install their own.
          exclude: [
            ...configDefaults.exclude,
            'tests/browser/**',
            'tests/conformance/**',
            'tests/consumer*/**',
          ],
          // Pure Node tests with no I/O: anything near this bound is a deadlock.
          testTimeout: 10_000,
        },
      },
    ],
  },
});
