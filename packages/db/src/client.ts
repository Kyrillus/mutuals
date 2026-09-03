/**
 * The connection pool and the Kysely instance built on it.
 *
 * Nothing here reads a file or exits a process: `packages/db` is a library, and the one place that
 * is allowed to be opinionated about the environment is `src/bin/migrate.ts`.
 */

import { Kysely, PostgresDialect } from 'kysely'
// pg is CommonJS and its `module.exports` is a constructed object, so `cjs-module-lexer` cannot
// see the named exports from an ES module. The default import is the whole namespace.
import pg from 'pg'
import type { CustomTypesConfig, Pool } from 'pg'

import type { DB } from './schema.ts'

/**
 * Raised on every pooled connection (storage-DECISION §2.10). The list compiler pulls up one
 * semi-join per filter chip on top of four base relations, so Postgres 16's defaults
 * (`join_collapse_limit` 8, `geqo_threshold` 12) hand the query to the genetic optimiser — and
 * therefore to non-deterministic plans — at roughly five chips. These move that to ~12.
 *
 * They travel in the libpq `options` startup parameter rather than in a `pool.on('connect')`
 * handler, so the server applies them while the connection is being established and there is no
 * window in which a checked-out connection is still running on the defaults.
 */
export const PLANNER_SETTINGS = {
  join_collapse_limit: 16,
  from_collapse_limit: 16,
  geqo_threshold: 20,
} as const

const PLANNER_OPTIONS = Object.entries(PLANNER_SETTINGS)
  .map(([name, value]) => `-c ${name}=${value}`)
  .join(' ')

const DATE_OID = 1082

/**
 * A `date` is a calendar day with no zone, which is what `CivilDate` is. node-pg's default parser
 * turns it into a `Date` at local midnight, so a birthday of `1990-03-01` read back in
 * `America/Los_Angeles` becomes `1990-02-28`. Handing the string through keeps the value the one
 * the domain wrote.
 */
const TYPE_PARSERS: CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format),
}

export interface DbOptions {
  /** Defaults to `DATABASE_URL`. */
  readonly connectionString?: string
  readonly max?: number
  /** Shows up in `pg_stat_activity`, which is the only way to tell two pools apart. */
  readonly applicationName?: string
}

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super('DATABASE_URL is not set. Copy .env.example to .env, or pass connectionString.')
    this.name = 'MissingDatabaseUrlError'
  }
}

export function resolveConnectionString(options: DbOptions = {}): string {
  const url = options.connectionString ?? process.env.DATABASE_URL
  if (!url) throw new MissingDatabaseUrlError()
  return url
}

export function makePool(options: DbOptions = {}): Pool {
  return new pg.Pool({
    connectionString: resolveConnectionString(options),
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'mutuals',
    options: PLANNER_OPTIONS,
    types: TYPE_PARSERS,
  })
}

/** For a caller that owns its pool: the bulk `COPY` path, and the test harness. */
export function dbFromPool(pool: Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}

/** The normal entry point. `db.destroy()` ends the pool, so nothing else needs a handle on it. */
export function makeDb(options: DbOptions = {}): Kysely<DB> {
  return dbFromPool(makePool(options))
}
