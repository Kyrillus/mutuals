/**
 * `globalSetup` for the `integration` project (ADR-074).
 *
 * It runs once, in the main process, before any worker exists: assert the URL is safe, drop the
 * clones the last run left behind, then migrate the template every worker will be cloned from.
 * Cloning itself is lazy and happens in the worker, so the number of Vitest workers is not a number
 * this file has to guess — and worker 5 finding no database is a case that cannot arise.
 *
 * The order is the point. `assertSafeTestDatabase` is the first statement that touches
 * `TEST_DATABASE_URL`, and nothing drops anything until it has returned.
 */
import { sql } from 'kysely'
import {
  assertSafeTestDatabase,
  captureBaseline,
  databaseNameOf,
  dropWorkerDatabases,
  requireTestDatabaseUrl,
  writeBaseline,
} from './database.ts'
import { makeDb } from '../client.ts'
import { assertSchemaCurrent, migrateToLatest } from '../migrate.ts'

export default async function setup(): Promise<void> {
  const url = requireTestDatabaseUrl()
  assertSafeTestDatabase(url)

  await dropWorkerDatabases(url)
  await migrateTemplate(url)
}

/**
 * The schema is dropped and migrated from nothing, every run.
 *
 * Migrating in place would be faster and is what a development database does, but the template is
 * the thing every worker is cloned from and the drift test then compares against `schema.ts` — so
 * "whatever this database happened to accumulate" is not an acceptable starting point. A test
 * database that someone once loaded the `.sql` files into by hand has the objects and an empty
 * ledger, and migrating that reports `function "mutuals_norm" already exists` rather than anything
 * useful. Dropping the schema is one statement and removes the entire class.
 */
async function migrateTemplate(url: string): Promise<void> {
  const db = makeDb({ connectionString: url, max: 1, applicationName: 'mutuals-test-template' })
  try {
    await sql`drop schema if exists public cascade`.execute(db)
    await sql`create schema public`.execute(db)

    const { error, results } = await migrateToLatest(db)
    if (error !== undefined) {
      const failed = results?.find((result) => result.status === 'Error')?.migrationName
      throw new Error(
        `Migrating the test template ${databaseNameOf(url)} failed` +
          `${failed === undefined ? '' : ` at ${failed}`}: ${describeError(error)}`,
      )
    }
    // Catches the other direction too: a database carrying a migration this checkout no longer has
    // would otherwise hand every worker a column `schema.ts` has never heard of.
    await assertSchemaCurrent(db)

    // Read here, from the one database in the run that nothing writes to, and handed to the
    // workers: every reset restores exactly what the migrations produced.
    await writeBaseline(url, await captureBaseline(db))
  } finally {
    await db.destroy()
  }
}

/** `error` is `unknown` on a `MigrationResultSet`, and a driver error is not a string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error)
}
