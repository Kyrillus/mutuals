/**
 * Migrations (ADR-028): plain numbered `.sql` files, applied by Kysely's `Migrator`, run
 * explicitly by `pnpm db:migrate` and never on API boot.
 *
 * The whole run is one transaction — `Migrator` wraps every pending migration in a single
 * `transaction()` — so a failure in `0006` rolls `0004` and `0005` back with it. That is why
 * migration `0003` may reference a table migration `0004` creates: a plpgsql body is only
 * syntax-checked at `CREATE FUNCTION` time.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Kysely, sql } from 'kysely'
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration'

import type { DB } from './schema.ts'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** Postgres `undefined_table`. On a database nobody has migrated yet, the ledger is missing. */
const UNDEFINED_TABLE = '42P01'

/**
 * Reads `NNNN_name.sql` files as migrations. There is no `down`: rolling a schema back on a
 * single-user CRM is a restore, not a migration, and `Migration` in kysely 0.29 makes `down`
 * optional precisely so a provider can decline to offer one.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #dir: string

  constructor(dir: string = MIGRATIONS_DIR) {
    this.#dir = dir
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {}
    for (const name of await migrationNamesIn(this.#dir)) {
      const body = await readFile(join(this.#dir, `${name}.sql`), 'utf8')
      migrations[name] = {
        async up(db: Kysely<unknown>): Promise<void> {
          // An empty parameter list selects the simple query protocol, which is what lets a whole
          // DDL file — dollar-quoted plpgsql and all — run exactly as written.
          await sql.raw(body).execute(db)
        },
      }
    }
    return migrations
  }
}

/** The migration names on disk, sorted — which is the order `Migrator` applies them in. */
export async function migrationNamesIn(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir)
  return files
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.slice(0, -'.sql'.length))
    .sort()
}

export function createMigrator(db: Kysely<DB>, dir: string = MIGRATIONS_DIR): Migrator {
  return new Migrator({ db, provider: new SqlFileMigrationProvider(dir) })
}

/** Applies every pending migration. The caller decides what to print and whether to exit. */
export function migrateToLatest(db: Kysely<DB>, dir?: string): Promise<MigrationResultSet> {
  return createMigrator(db, dir).migrateToLatest()
}

export class SchemaBehindError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(
      `Database schema is behind by ${missing.length} migration(s): ${missing.join(', ')}\n` +
        'Run: pnpm db:migrate',
    )
    this.name = 'SchemaBehindError'
    this.missing = missing
  }
}

export class SchemaAheadError extends Error {
  readonly unknown: readonly string[]

  constructor(unknownNames: readonly string[]) {
    super(
      `The database has ${unknownNames.length} migration(s) this build does not know about: ` +
        `${unknownNames.join(', ')}\n` +
        'The checkout is older than the database. Pull, or point DATABASE_URL somewhere else.',
    )
    this.name = 'SchemaAheadError'
    this.unknown = unknownNames
  }
}

/**
 * The API's boot check (ADR-028). A check, never a mutation: it reads the ledger and refuses to
 * serve when the two disagree, in either direction — a database that is ahead means the checkout
 * is old, and serving from it would write rows the code cannot read back.
 */
export async function assertSchemaCurrent(db: Kysely<DB>, dir?: string): Promise<void> {
  const onDisk = await migrationNamesIn(dir)

  let applied: string[]
  try {
    const rows = await db.selectFrom('kysely_migration').select('name').execute()
    applied = rows.map((row) => row.name)
  } catch (error) {
    if (isUndefinedTable(error)) throw new SchemaBehindError(onDisk)
    throw error
  }

  const appliedSet = new Set(applied)
  const missing = onDisk.filter((name) => !appliedSet.has(name))
  if (missing.length > 0) throw new SchemaBehindError(missing)

  const onDiskSet = new Set(onDisk)
  const unknownNames = applied.filter((name) => !onDiskSet.has(name)).sort()
  if (unknownNames.length > 0) throw new SchemaAheadError(unknownNames)
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE
  )
}
