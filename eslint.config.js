import { builtinModules } from 'node:module'

import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * The import guard for `packages/core` bans the *whole* builtin set, not only
 * `node:`-prefixed specifiers: bare `fs` and `path` are exactly what a
 * copy-pasted helper drags into a browser bundle, and they pass a naive rule.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/**', 'fixtures/**', '**/*.d.ts'] },

  js.configs.recommended,

  // Plain .mjs scripts are linted WITHOUT the type-aware config. They are in no
  // tsconfig, and projectService would fail on them with "not found by the
  // project service" on the very first run.
  {
    files: ['scripts/**/*.mjs', 'apps/*/scripts/**/*.mjs', 'e2e/support/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts'],
  })),

  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The reason the whole TypeScript version decision was taken (ADR-003).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // `packages/core` ships to the browser. Nothing Node-only, nothing that talks
  // to a database, nothing that serves HTTP may enter it -- enforced, because a
  // sentence in a markdown table gets broken about half the time.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeBuiltins.map((name) => ({
              name,
              message:
                'packages/core ships to the browser. Node builtins belong in packages/db or apps/api.',
            })),
            {
              name: 'pg',
              message: 'packages/core must not know about the database. Put this in packages/db.',
            },
            {
              name: 'kysely',
              message:
                'The filter MODEL lives in core; the COMPILER lives in packages/db (ADR-033).',
            },
            { name: 'fastify', message: 'packages/core must not know about HTTP.' },
            {
              name: '@mutuals/db',
              message: 'The dependency graph is one-way: db depends on core.',
            },
            {
              name: '@mutuals/api',
              message: 'The dependency graph is one-way: apps/api depends on core.',
            },
          ],
          patterns: [
            {
              // ADR-071, the other direction. Nothing in the domain reaches a model, so its
              // decisions stay testable with no network and no fixtures.
              group: ['**/llm', '**/llm/**'],
              message:
                'ADR-071: the domain never calls a model. Extractor output enters core as plain ' +
                'validated data.',
            },
          ],
        },
      ],
    },
  },

  /**
   * ADR-071: **no LLM calls in business logic**, enforced rather than written down.
   *
   * §4.8's rule -- the LLM extracts, code decides -- is exactly the kind of boundary that decays
   * into a comment nobody enforces, in a repository future AI sessions will edit. So the LLM module
   * is a zone: `packages/core` and `packages/db` may never reach it (which keeps duplicate
   * matching, filter compilation and warmth unit-testable with no model, no network and no
   * fixtures), and among the routes only the ones listed below by **exact path** may.
   *
   * Listing exact paths fails safe. Rename `routes/ask.ts` and the rule starts applying to it; CI
   * goes red rather than the boundary quietly widening.
   *
   * `allowTypeImports` is on because `context.ts` has to name the client's type to declare the
   * slot, and a type import compiles to nothing -- it cannot call a model.
   */
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/llm/**',
      // The three routes §4.8 and §6.5 give a model to, by exact path. Everything else in
      // `routes/` -- including `search.ts`, which the palette calls on every keystroke -- is
      // refused, and `boundary.test.ts` asserts both directions.
      'apps/api/src/routes/ask.ts',
      'apps/api/src/routes/quick-capture.ts',
      'apps/api/src/routes/summary.ts',
      // The process entry point constructs the one client, and the CLI tools record and lock
      // prompts. Neither is business logic.
      'apps/api/src/main.ts',
      'apps/api/src/bin/**',
      'apps/api/src/test-support/**',
      // A test that proves the boundary has to be able to see both sides of it, and a test file
      // ships nothing. The rule is about which production code paths may reach a model.
      'apps/api/src/**/*.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm', '**/llm/**'],
              allowTypeImports: true,
              message:
                'ADR-071: only the routes listed in eslint.config.js may call the LLM module. ' +
                'Extractor output enters the domain as plain validated data.',
            },
          ],
        },
      ],
    },
  },

  /** ADR-071, for the storage layer: the filter compiler and the write path never call a model. */
  {
    files: ['packages/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fastify', message: 'packages/db must not know about HTTP.' },
            {
              name: '@mutuals/api',
              message: 'The dependency graph is one-way: apps/api depends on db.',
            },
          ],
          patterns: [
            {
              group: ['**/llm', '**/llm/**'],
              message: 'ADR-071: the storage layer never calls a model.',
            },
          ],
        },
      ],
    },
  },

  prettier,
)
