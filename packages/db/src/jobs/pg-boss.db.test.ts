/**
 * pg-boss, against a real database (ADR-058, ADR-059, ADR-061, ADR-063).
 *
 * The point of these is that pg-boss's behaviour is *assumed* by three ADRs and had never been
 * run. Every assertion here is one of those assumptions: that its schema is separable, that a
 * transactional enqueue really rolls back with its transaction, that `retryLimit: 0` means a failed
 * import is not silently replayed, and that a singleton key stops a double click starting two
 * importers.
 *
 * No test sleeps. `waitForJob` resolves on the state transition, which is both faster and the only
 * way to express "when this job has actually completed" rather than "after 200 ms".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'

import {
  requireTestDatabaseUrl,
  testDb,
  testWorkerId,
  workerDatabaseName,
} from '../test-support/index.ts'
import { PGBOSS_SCHEMA, PgBossQueue } from './pg-boss.ts'
import type { ImportRunPayload } from './queue.ts'

/**
 * Its own schema per worker, so parallel Vitest workers do not share a job table. The database is
 * already per-worker; this keeps pg-boss's own migration from racing between them.
 */
const SCHEMA = `${PGBOSS_SCHEMA}_test`

let queue: PgBossQueue

/** What the single worker did, so a test can assert on it without registering a second one. */
const handled: string[] = []
let attempts = 0

beforeAll(async () => {
  queue = new PgBossQueue({
    connectionString: connectionStringForThisWorker(),
    schema: SCHEMA,
    // Fast enough that a test does not wait a full default interval for the poll.
    pollingIntervalSeconds: 0.5,
    enableJobSpies: true,
  })
  await queue.start()

  /**
   * One worker for the whole suite, dispatching on the payload.
   *
   * Registering a worker per test does not isolate them — pg-boss hands a job to whichever worker
   * polls first, so the first test's handler happily eats the failure test's job and both assert
   * against the wrong run. The payload is what routes instead.
   */
  await queue.work<ImportRunPayload>('import.run', (job) => {
    handled.push(job.data.batchId)
    if (job.data.batchId === 'fails') {
      attempts++
      return Promise.reject(new Error('the importer fell over'))
    }
    return Promise.resolve()
  })
}, 60_000)

afterAll(async () => {
  await queue.stop()
  await sql`drop schema if exists ${sql.id(SCHEMA)} cascade`.execute(testDb())
})

/**
 * The worker's own database, as a URL.
 *
 * `testDb()` is already pointed at it, but pg-boss takes a connection string rather than a pool
 * (ADR-059 gives it its own), so the name has to be substituted into the base URL.
 */
function connectionStringForThisWorker(): string {
  const base = requireTestDatabaseUrl()
  const url = new URL(base)
  url.pathname = `/${workerDatabaseName(base, testWorkerId())}`
  return url.toString()
}

describe('the queue', () => {
  it('runs a job and reports it completed', async () => {
    const spy = queue.spy<ImportRunPayload>('import.run')
    const id = await queue.send('import.run', { batchId: 'batch-one' })
    expect(id).not.toBeNull()

    await spy.waitForJobWithId(id as string, 'completed')
    expect(handled).toContain('batch-one')
  })

  /**
   * ADR-058's claim, tested: "`send()` accepts a `db` option, so transactional enqueue is real
   * rather than aspirational". §6.8 needs it — the wizard flips `import_batch.status` to
   * `importing` and enqueues in one transaction, and if those can come apart a crash between them
   * leaves a batch that says it is importing with nothing that will ever import it.
   */
  it('discards an enqueue whose transaction rolls back', async () => {
    const before = await jobCount()

    await expect(
      testDb()
        .transaction()
        .execute(async (trx) => {
          await queue.send('import.run', { batchId: 'never-committed' }, { executor: trx })
          throw new Error('roll this back')
        }),
    ).rejects.toThrow('roll this back')

    expect(await jobCount()).toBe(before)
  })

  it('keeps an enqueue whose transaction commits', async () => {
    const id = await testDb()
      .transaction()
      .execute(async (trx) => queue.send('import.run', { batchId: 'committed' }, { executor: trx }))
    expect(id).not.toBeNull()

    const spy = queue.spy<ImportRunPayload>('import.run')
    await spy.waitForJobWithId(id as string, 'completed')
  })

  /**
   * So a double click on `Import` cannot start two importers for one batch.
   *
   * This is the test that found that `singletonKey` deduplicates nothing on its own: pg-boss 12
   * decides by the *queue's* policy, and the default `standard` has no notion of a key. The queue
   * is created `stately`, which caps `created` and `active` at one job per key.
   */
  it('suppresses a second send while the first is still pending', async () => {
    const first = await queue.send('import.run', { batchId: 'once' }, { singletonKey: 'once' })
    const second = await queue.send('import.run', { batchId: 'once' }, { singletonKey: 'once' })
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    // A different batch is a different key, so two files still import concurrently.
    const other = await queue.send('import.run', { batchId: 'twice' }, { singletonKey: 'twice' })
    expect(other).not.toBeNull()
  })

  /**
   * ADR-061: `retryLimit: 0`. A half-applied import must be resumed deliberately from
   * `last_committed_row + 1`, never replayed from the top by a supervisor — replaying would
   * re-apply every row the first attempt already committed.
   */
  it('does not retry a job that failed', async () => {
    const spy = queue.spy<ImportRunPayload>('import.run')
    const id = await queue.send('import.run', { batchId: 'fails' })
    await spy.waitForJobWithId(id as string, 'failed')

    expect(attempts).toBe(1)
  })

  /** R7's mitigation, as a fact rather than a claim: the uninstall is one statement. */
  it('keeps everything it owns in its own schema', async () => {
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = ${SCHEMA}
    `.execute(testDb())
    expect(rows.rows.length).toBeGreaterThan(0)

    // And nothing of pg-boss's leaked into ours, which is what the schema drift test would catch
    // one commit later and much less clearly.
    const publicTables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name like '%job%'
    `.execute(testDb())
    expect(publicTables.rows).toEqual([])
  })
})

async function jobCount(): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from ${sql.id(SCHEMA)}.job
  `.execute(testDb())
  return Number(rows.rows[0]?.count ?? '0')
}
