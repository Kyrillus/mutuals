/**
 * The Playwright suite's view of the database (ADR-079, ADR-087).
 *
 * ADR-079 says the e2e run is "seeded from the same `resetDatabase()` the Vitest projects use". It
 * cannot literally call that function: `resetDatabase` reaches its database through
 * `TEST_DATABASE_URL`, a `_test` suffix guard that deliberately refuses `mutuals_e2e`, and a
 * per-worker `CREATE DATABASE … TEMPLATE` clone keyed on `VITEST_POOL_ID`. None of those three
 * things exist under Playwright.
 *
 * So this module reuses the *reset itself* — {@link applyReset}, one implementation, shared — and
 * supplies the two pieces around it that differ: its own connection, and its own guard. The thing
 * ADR-079 was protecting is that a reset means the same thing in both suites, and it still does.
 */
import type { Kysely } from 'kysely'
import type pg from 'pg'
import { dbFromPool, makePool } from '../client.ts'
import type { DB } from '../schema.ts'
import {
  applyReset,
  assertSafeE2eDatabase,
  captureBaseline,
  loadRepoEnv,
  MissingTestDatabaseUrlError,
  readBaseline,
  type Snapshot,
  truncateStatement,
  writeBaseline,
} from './database.ts'

export function requireE2eDatabaseUrl(): string {
  loadRepoEnv()
  const url = process.env.E2E_DATABASE_URL
  if (!url) throw new MissingTestDatabaseUrlError('E2E_DATABASE_URL')
  return url
}

interface E2eDatabase {
  readonly pool: pg.Pool
  readonly db: Kysely<DB>
  readonly truncate: string
  readonly baseline: Awaited<ReturnType<typeof readBaseline>>['baseline']
}

// Playwright's globalSetup and its worker run in the same process here (`workers: 1`), but the
// fixture that resets between tests is called once per test. One pool, opened lazily.
let open: Promise<E2eDatabase> | undefined

async function openE2eDatabase(): Promise<E2eDatabase> {
  const url = requireE2eDatabaseUrl()
  assertSafeE2eDatabase(url)

  const snapshot = await readBaseline(url)
  const pool = makePool({ connectionString: url, applicationName: 'mutuals-e2e', max: 4 })
  pool.on('error', () => {})

  return {
    pool,
    db: dbFromPool(pool),
    truncate: truncateStatement(snapshot),
    baseline: snapshot.baseline,
  }
}

/**
 * Read the migrations' own rows off the freshly migrated e2e database and write them where the
 * per-test reset will find them.
 *
 * Timing is the whole correctness argument: `captureBaseline` throws if any non-baseline table has
 * rows, so this has to run after `db:migrate` and before the first test writes anything. Playwright's
 * `globalSetup` is exactly that window.
 */
export async function captureE2eBaseline(): Promise<void> {
  const url = requireE2eDatabaseUrl()
  assertSafeE2eDatabase(url)

  const pool = makePool({ connectionString: url, applicationName: 'mutuals-e2e-setup', max: 1 })
  pool.on('error', () => {})
  const db = dbFromPool(pool)
  try {
    // `captureBaseline` refuses to read a baseline off a database that has been written to, and the
    // previous run left it full of whatever the last spec created. Unlike the Vitest projects there
    // is no untouched template to read instead, so the snapshot from last time is used to put the
    // database back to its migrated state first. On the very first run there is none, and a freshly
    // migrated database is already in that state.
    const previous = await previousBaseline(url)
    if (previous !== undefined) {
      await applyReset(db, truncateStatement(previous), previous.baseline)
    }
    await writeBaseline(url, await captureBaseline(db))
  } finally {
    await db.destroy()
  }
}

async function previousBaseline(url: string): Promise<Snapshot | undefined> {
  try {
    return await readBaseline(url)
  } catch {
    return undefined
  }
}

/** Between tests: every table emptied, the migrations' rows put back. Same reset as Vitest's. */
export async function resetE2eDatabase(): Promise<void> {
  open ??= openE2eDatabase()
  const state = await open
  await applyReset(state.db, state.truncate, state.baseline)
}

/** The e2e database as a spec sees it, for the few assertions the UI cannot make. */
export async function e2eDb(): Promise<Kysely<DB>> {
  open ??= openE2eDatabase()
  return (await open).db
}

export async function closeE2eDatabase(): Promise<void> {
  const pending = open
  if (pending === undefined) return
  open = undefined
  await (await pending).db.destroy()
}
