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
    files: ['scripts/**/*.mjs'],
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
            { name: '@mutuals/db', message: 'The dependency graph is one-way: db depends on core.' },
          ],
        },
      ],
    },
  },

  prettier,
)
