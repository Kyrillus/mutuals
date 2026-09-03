#!/usr/bin/env node
/**
 * `pnpm db:migrate` — apply every pending migration, explicitly (ADR-028).
 *
 * `pnpm db:migrate status` lists what is applied and what is pending without touching anything,
 * which answers "is my database behind?" without booting the API.
 */

import process from 'node:process'

import { sql } from 'kysely'

import { makeDb, resolveConnectionString } from '../client.ts'
import { createMigrator, migrateToLatest } from '../migrate.ts'

const green = (text: string): string => `\u001b[32m${text}\u001b[0m`
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`

const command = process.argv[2] ?? 'up'
if (command !== 'up' && command !== 'status') {
  console.error(`Unknown command "${command}". Use: migrate [up|status]`)
  process.exit(2)
}

// Named before anything runs: migrating the wrong database is the expensive mistake, and the URL
// itself must never reach a log because it carries a password.
const databaseName = new URL(resolveConnectionString()).pathname.replace(/^\//, '')
const db = makeDb({ applicationName: 'mutuals-migrate', max: 1 })

try {
  if (command === 'status') {
    console.log(dim(`database: ${databaseName}`))
    for (const migration of await createMigrator(db).getMigrations()) {
      const state = migration.executedAt
        ? green(`applied ${migration.executedAt.toISOString()}`)
        : dim('pending')
      console.log(`  ${migration.name}  ${state}`)
    }
  } else {
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
  }
} finally {
  await db.destroy()
}
