#!/usr/bin/env node
/**
 * `pnpm db:migrate:e2e` — the migrator, pointed at `mutuals_e2e` (ADR-087).
 *
 * `db:migrate` resolves its database from `DATABASE_URL`, and prefixing a package script with
 * `DATABASE_URL=… ` does not work on Windows. So the swap happens here — and behind the same guard
 * the Playwright reset uses, so a mistyped `E2E_DATABASE_URL` is refused rather than migrated.
 */

import process from 'node:process'

import { sql } from 'kysely'

import { makeDb } from '../client.ts'
import { migrateToLatest } from '../migrate.ts'
import { assertSafeE2eDatabase, requireE2eDatabaseUrl } from '../test-support/index.ts'

const green = (text: string): string => `[32m${text}[0m`
const red = (text: string): string => `[31m${text}[0m`
const dim = (text: string): string => `[2m${text}[0m`

const url = requireE2eDatabaseUrl()
assertSafeE2eDatabase(url)

const databaseName = new URL(url).pathname.replace(/^\//, '')
const db = makeDb({ connectionString: url, applicationName: 'mutuals-migrate-e2e', max: 1 })

try {
  const { error, results } = await migrateToLatest(db)

  for (const result of results ?? []) {
    console.log(`${result.status === 'Success' ? green('✓') : red('✗')} ${result.migrationName}`)
  }

  if (error) {
    console.error(`\n${red('✗')} Migration failed. The whole run was rolled back.`)
    console.error(error)
    process.exitCode = 1
  } else {
    const server = await sql<{ version: string }>`select version()`.execute(db)
    const applied = results?.length ?? 0
    console.log(
      applied === 0
        ? `${green('✓')} ${databaseName} is up to date.`
        : `${green('✓')} ${databaseName}: ${applied} migration(s) applied.`,
    )
    console.log(dim(`  ${server.rows[0]?.version.split(' ').slice(0, 2).join(' ') ?? ''}`))
  }
} finally {
  await db.destroy()
}
