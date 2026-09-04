/**
 * The integration project's database: a migrated template, one clone per worker, truncated and
 * reseeded between tests (ADR-074).
 *
 * Transaction-rollback isolation is not an option here. The write path is an explicit
 * `BEGIN; SELECT … FOR UPDATE; UPDATE; INSERT; COMMIT`, so wrapping a test in an outer transaction
 * would nest those and make the two-concurrent-writers test impossible to express. A clone per
 * worker gives every worker a real, private database and costs one `CREATE DATABASE … TEMPLATE`.
 *
 * Nothing destructive happens before {@link assertSafeTestDatabase} has looked at the URL. That
 * guard is the only thing standing between a typo in `TEST_DATABASE_URL` and somebody's
 * development data, so it runs first, in `globalSetup`, and again per worker.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { dbFromPool, makePool } from '../client.ts'
import type { DB } from '../schema.ts'

/** The fixed workspace uuid migration 0001 inserts. Every fixture and every test binds this one. */
export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Rows that exist because the migrations put them there. `resetDatabase` truncates everything and
 * puts exactly these back, so a test that renames an attribute or archives an option does not
 * leave the next test running against a database the migrations never produced.
 *
 * The order is insert order, and it is the foreign-key order.
 */
const BASELINE_TABLES = [
  'workspace',
  'profile',
  'attribute_definition',
  'attribute_option',
] as const

/** Kysely owns these two and `assertSchemaCurrent` reads them; a truncate would undo the run. */
const LEDGER_TABLES = ['kysely_migration', 'kysely_migration_lock']

/**
 * One key, so two workers cloning the template at the same moment queue instead of racing.
 * `CREATE DATABASE` refuses to run while another session is connected to the source database, and
 * two concurrent creations from one template is not a case worth finding out about the hard way.
 */
const CLONE_LOCK_KEY = 7_239_518_273

export class MissingTestDatabaseUrlError extends Error {
  override readonly name = 'MissingTestDatabaseUrlError'

  constructor(variable = 'TEST_DATABASE_URL') {
    super(`${variable} is not set. Copy .env.example to .env, then run: pnpm db:up`)
  }
}

export class UnsafeTestDatabaseError extends Error {
  override readonly name = 'UnsafeTestDatabaseError'

  constructor(reason: string, variable = 'TEST_DATABASE_URL', suffix = '_test') {
    super(
      `Refusing to run destructive test setup: ${reason}\n` +
        `${variable} must name a database ending in "${suffix}" on a local host.`,
    )
  }
}

export class TestWorkerOutOfRangeError extends Error {
  override readonly name = 'TestWorkerOutOfRangeError'

  constructor(poolId: number, limit: number) {
    super(
      `Vitest worker ${poolId} is above MUTUALS_TEST_WORKERS=${limit}. ` +
        'Raise MUTUALS_TEST_WORKERS or lower maxWorkers for the integration project.',
    )
  }
}

export class UnexpectedBaselineRowsError extends Error {
  override readonly name = 'UnexpectedBaselineRowsError'

  constructor(tables: readonly string[]) {
    super(
      `A freshly migrated database already has rows in: ${tables.join(', ')}.\n` +
        'A migration now seeds a table the reset baseline does not know about. Add it to ' +
        'BASELINE_TABLES in packages/db/src/test-support/database.ts, in foreign-key order.',
    )
  }
}

/**
 * `vitest run` is not launched through `node --env-file-if-exists`, so the one root `.env` of
 * ADR-010 has to be read here. Node's own loader, no dotenv dependency, and a variable already in
 * the environment wins — which is what lets CI set `TEST_DATABASE_URL` without a file at all.
 */
const REPO_ENV = fileURLToPath(new URL('../../../../.env', import.meta.url))
let envLoaded = false

export function loadRepoEnv(): void {
  if (envLoaded) return
  envLoaded = true
  if (existsSync(REPO_ENV)) process.loadEnvFile(REPO_ENV)
}

export function requireTestDatabaseUrl(): string {
  loadRepoEnv()
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new MissingTestDatabaseUrlError()
  return url
}

/** Only `[a-z0-9_]` ever reaches a `CREATE`/`DROP DATABASE`, which cannot take a parameter. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])

export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '')
}

/**
 * The guard, in the two directions that matter: the database has to be the one this caller is
 * allowed to destroy, and the host has to be this machine unless somebody has explicitly said so.
 *
 * The suffix is a parameter rather than a widened check because the two callers must keep refusing
 * each other's database. Vitest drops `mutuals_test_w*` clones wholesale; the Playwright suite owns
 * `mutuals_e2e` and nothing else. One predicate accepting both would let a mistyped variable in
 * either direction through, and the whole point of this function is that it is the last line.
 */
function assertSafeDatabase(url: string, variable: string, suffix: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafeTestDatabaseError(`${variable} is not a URL (${url})`, variable, suffix)
  }

  const name = parsed.pathname.replace(/^\//, '')
  if (!name.endsWith(suffix)) {
    throw new UnsafeTestDatabaseError(
      `the database is named "${name}", which does not end in ${suffix}`,
      variable,
      suffix,
    )
  }
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new UnsafeTestDatabaseError(
      `the database name "${name}" is not a plain identifier`,
      variable,
      suffix,
    )
  }

  const host = parsed.hostname
  if (!LOCAL_HOSTS.has(host) && process.env.MUTUALS_ALLOW_DESTRUCTIVE !== '1') {
    throw new UnsafeTestDatabaseError(
      `the host is "${host}", not this machine. Set MUTUALS_ALLOW_DESTRUCTIVE=1 if you mean it`,
      variable,
      suffix,
    )
  }
}

/** The Vitest integration project's database: `*_test`, and the clones it templates. */
export function assertSafeTestDatabase(url: string): void {
  assertSafeDatabase(url, 'TEST_DATABASE_URL', '_test')
}

/** The Playwright suite's database: `*_e2e`, which {@link assertSafeTestDatabase} refuses. */
export function assertSafeE2eDatabase(url: string): void {
  assertSafeDatabase(url, 'E2E_DATABASE_URL', '_e2e')
}

function urlForDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * `postgres` by default: `CREATE DATABASE x TEMPLATE y` cannot be issued from a session connected
 * to `y`, so the maintenance connection has to live somewhere else.
 */
function maintenanceUrl(url: string): string {
  return urlForDatabase(url, process.env.MUTUALS_MAINTENANCE_DB ?? 'postgres')
}

export function workerDatabaseName(url: string, poolId: number): string {
  return `${databaseNameOf(url)}_w${poolId}`
}

async function withMaintenanceClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: maintenanceUrl(url) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Every clone from a previous run, dropped. They are recreated from the template that this run
 * migrates, so a migration added since yesterday is present in every worker's database rather than
 * in whichever ones happened to be rebuilt.
 */
export async function dropWorkerDatabases(url: string): Promise<string[]> {
  assertSafeTestDatabase(url)
  const template = databaseNameOf(url)
  const pattern = new RegExp(`^${template}_w\\d+$`)

  return withMaintenanceClient(url, async (client) => {
    const found = await client.query<{ datname: string }>(
      'select datname from pg_database where datname like $1 order by datname',
      [`${template}\\_w%`],
    )
    const dropped: string[] = []
    for (const { datname } of found.rows) {
      // The LIKE is a filter; this is the assertion. `_` is a LIKE wildcard, so the pattern alone
      // would also match `mutuals_testXw1`, and nothing here may drop a database on a near miss.
      if (!pattern.test(datname)) continue
      await client.query(`drop database if exists ${datname} with (force)`)
      dropped.push(datname)
    }
    return dropped
  })
}

/** Creates this worker's clone if it is not already there. Serialised by an advisory lock. */
export async function ensureWorkerDatabase(url: string, poolId: number): Promise<string> {
  assertSafeTestDatabase(url)
  const template = databaseNameOf(url)
  const name = workerDatabaseName(url, poolId)
  if (!SAFE_IDENTIFIER.test(name)) throw new UnsafeTestDatabaseError(`bad clone name "${name}"`)

  await withMaintenanceClient(url, async (client) => {
    await client.query('select pg_advisory_lock($1)', [CLONE_LOCK_KEY])
    try {
      const existing = await client.query('select 1 from pg_database where datname = $1', [name])
      if (existing.rowCount === 0) {
        await client.query(`create database ${name} template ${template}`)
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [CLONE_LOCK_KEY])
    }
  })

  return name
}

export interface BaselineTable {
  readonly table: string
  readonly rows: unknown
}

/** What `globalSetup` reads off the template and every worker restores between tests. */
export interface Snapshot {
  /** Every table a reset empties, which is every table but Kysely's ledger. */
  readonly tables: readonly string[]
  readonly baseline: readonly BaselineTable[]
}

interface WorkerDatabase {
  readonly name: string
  readonly pool: pg.Pool
  readonly db: Kysely<DB>
  /** One `TRUNCATE` naming every table, so the reset is a single statement. */
  readonly truncate: string
  readonly baseline: readonly BaselineTable[]
}

// One pool per process, shared by every module in it. Vitest's forks pool isolates a test file in
// its own process, so this is not a run-wide singleton — it is the guard against `setup.ts` and a
// test file each opening their own pool against the same clone.
const CACHE_KEY = Symbol.for('mutuals.test-support.worker-database')
type CacheHolder = { [CACHE_KEY]?: Promise<WorkerDatabase> }

function cache(): CacheHolder {
  return globalThis as unknown as CacheHolder
}

export function testWorkerId(): number {
  const poolId = Number(process.env.VITEST_POOL_ID ?? '1')
  const limit = process.env.MUTUALS_TEST_WORKERS
  if (limit !== undefined && poolId > Number(limit)) {
    throw new TestWorkerOutOfRangeError(poolId, Number(limit))
  }
  return poolId
}

async function tableNames(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `.execute(db)
  return rows.rows.map((row) => row.tablename).filter((name) => !LEDGER_TABLES.includes(name))
}

/**
 * The rows the migrations wrote, and the tables a reset has to empty.
 *
 * It is read from the **template**, in `globalSetup`, and only there. A worker cannot capture it
 * from its own clone: Vitest gives each test file a fresh process, so the second file in a worker
 * would "capture" whatever the first file left behind and every later reset would restore that.
 * The template is the one database in the run that nothing ever writes to.
 */
export async function captureBaseline(db: Kysely<DB>): Promise<Snapshot> {
  const tables = await tableNames(db)

  const baseline: BaselineTable[] = []
  for (const table of BASELINE_TABLES) {
    const row = await sql<{ rows: unknown }>`
      select coalesce(jsonb_agg(t order by t.id), '[]'::jsonb) as rows
        from ${sql.table(table)} t
    `.execute(db)
    baseline.push({ table, rows: row.rows[0]?.rows ?? [] })
  }

  const others = tables.filter((table) => !BASELINE_TABLES.includes(table as never))
  const probes = others.map(
    (table) =>
      sql`select ${sql.lit(table)} as name where exists (select 1 from ${sql.table(table)})`,
  )
  const populated = await sql<{ name: string }>`${sql.join(probes, sql` union all `)}`.execute(db)
  if (populated.rows.length > 0) {
    throw new UnexpectedBaselineRowsError(populated.rows.map((row) => row.name))
  }

  return { tables, baseline }
}

/**
 * `globalSetup` runs in the main process and every test file in a fresh one, so the snapshot
 * travels through a file rather than a module-level variable. It is keyed by the template's name,
 * so two checkouts pointed at two test databases do not read each other's.
 */
function snapshotPath(url: string): string {
  return join(tmpdir(), `mutuals-baseline-${databaseNameOf(url)}.json`)
}

export async function writeBaseline(url: string, snapshot: Snapshot): Promise<void> {
  await writeFile(snapshotPath(url), JSON.stringify(snapshot), 'utf8')
}

export async function readBaseline(url: string): Promise<Snapshot> {
  try {
    return JSON.parse(await readFile(snapshotPath(url), 'utf8')) as Snapshot
  } catch {
    throw new Error(
      `No baseline snapshot at ${snapshotPath(url)}. The integration project's globalSetup ` +
        'writes it; a test file that reaches this has been run without it.',
    )
  }
}

async function open(): Promise<WorkerDatabase> {
  const url = requireTestDatabaseUrl()
  const poolId = testWorkerId()
  const [name, snapshot] = await Promise.all([ensureWorkerDatabase(url, poolId), readBaseline(url)])

  const pool = makePool({
    connectionString: urlForDatabase(url, name),
    applicationName: `mutuals-test-w${poolId}`,
    max: 6,
  })
  // A pooled client whose backend goes away emits on the pool, and an unhandled 'error' event ends
  // the worker process with a stack that says nothing about the test that was running.
  pool.on('error', () => {})

  return {
    name,
    pool,
    db: dbFromPool(pool),
    truncate: truncateStatement(snapshot),
    baseline: snapshot.baseline,
  }
}

/** One statement naming every table, so a reset is a single round trip. */
export function truncateStatement(snapshot: Snapshot): string {
  return `truncate table ${snapshot.tables.join(', ')} restart identity cascade`
}

/**
 * Empty every table, then put the migrations' own rows back exactly as they were.
 *
 * **The one implementation of a reset.** The Vitest projects reach it through
 * {@link resetDatabase}; the Playwright suite reaches it through `resetE2eDatabase` in `./e2e.ts`.
 * ADR-079 requires those two to be the same thing, and this function is what makes that true rather
 * than merely claimed.
 */
export async function applyReset(
  db: Kysely<DB>,
  truncate: string,
  baseline: readonly BaselineTable[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql.raw(truncate).execute(trx)
    for (const { table, rows } of baseline) {
      if (Array.isArray(rows) && rows.length === 0) continue
      await sql`
        insert into ${sql.table(table)}
        select * from jsonb_populate_recordset(null::${sql.table(table)}, ${JSON.stringify(rows)}::jsonb)
      `.execute(trx)
    }
  })
}

/**
 * The worker's database as this test file sees it. The pool is cached on `globalThis` so it
 * survives the module registry Vitest rebuilds for every file; this binding is the per-file view of
 * it, set by `setup.ts`'s `beforeAll` before any test body runs.
 */
let worker: WorkerDatabase | undefined

/** Idempotent: the first caller in a worker process opens the database, the rest await it. */
export async function getTestDb(): Promise<Kysely<DB>> {
  const holder = cache()
  holder[CACHE_KEY] ??= open()
  worker = await holder[CACHE_KEY]
  return worker.db
}

/** The Kysely instance for this worker's own database. Available once `setup.ts` has run. */
export function testDb(): Kysely<DB> {
  if (worker === undefined) {
    throw new Error(
      'The test database is not open. An integration test must be named *.db.test.ts so the ' +
        'integration project picks it up with its setup files.',
    )
  }
  return worker.db
}

/**
 * Between tests: every table emptied, then the migrations' own rows put back exactly as they were.
 * `RESTART IDENTITY` is there for the day a sequence appears; nothing depends on it today.
 */
export async function resetDatabase(): Promise<void> {
  const db = await getTestDb()
  const state = worker
  if (state === undefined) throw new Error('the test database is not open')

  await applyReset(db, state.truncate, state.baseline)
}

/** Closes the worker's pool. `globalSetup` cannot do it: the pool lives in another process. */
export async function closeTestDatabase(): Promise<void> {
  const holder = cache()
  const pending = holder[CACHE_KEY]
  if (pending === undefined) return
  delete holder[CACHE_KEY]
  worker = undefined
  await (await pending).db.destroy()
}
