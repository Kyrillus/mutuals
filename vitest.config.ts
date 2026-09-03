import { defineConfig } from 'vitest/config'

/**
 * Two projects (ADR-073).
 *
 * `unit` never touches a database, so it runs on a fresh clone with nothing
 * installed but node_modules. `integration` runs against a real Postgres, one
 * cloned database per worker.
 *
 * TZ is pinned so a test cannot pass on the machine that wrote it and fail on
 * another one (ADR-081). Business timestamps are injected, never read from the
 * wall clock.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/db/src/**/*.db.test.ts', 'apps/api/src/**/*.db.test.ts'],
          environment: 'node',
          globalSetup: ['./packages/db/src/test-support/global-setup.ts'],
          setupFiles: ['./packages/db/src/test-support/setup.ts'],
          fileParallelism: true,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/test-support/**', '**/bin/**'],
      // Thresholds are enforced only on the domain modules the brief names in
      // section 8.1 -- a single global percentage averages a pure function
      // against a Fastify plugin and gets gamed the day it is introduced.
      thresholds: {
        perFile: true,
        'packages/core/src/{attributes,fields,filters,identity,followups,import,text,time}/**': {
          lines: 90,
          branches: 85,
          functions: 100,
        },
        // warmth and decimal are files, not directories. Written as a second
        // group because the directory glob above silently matches neither, and
        // warmth is one of the modules the brief names by hand in section 8.1.
        'packages/core/src/{warmth,decimal}.ts': { lines: 90, branches: 85, functions: 100 },
      },
    },
  },
})
