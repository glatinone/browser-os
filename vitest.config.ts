import { defineConfig } from 'vitest/config';

// Tests always run against the `source` export condition (integration §1), never
// a stale dist/. The three projects mirror TESTING.md §4.
const resolve = { conditions: ['source', 'module', 'browser', 'development|production'] };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'fixtures/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts'],
          pool: 'threads',
          testTimeout: 5000,
        },
      },
      {
        resolve,
        test: {
          name: 'browser',
          include: ['packages/*/test/**/*.browser.test.ts'],
          pool: 'forks',
          maxWorkers: 2,
          testTimeout: 30000,
          retry: 1,
        },
      },
      {
        resolve,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 120000,
          retry: 1,
        },
      },
    ],
  },
});
