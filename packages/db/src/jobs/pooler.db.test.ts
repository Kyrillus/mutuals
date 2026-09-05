/**
 * pg-boss through a transaction pooler (ADR-058, ADR-095, §13's R7).
 *
 * **This is the falsifier for a claim that has never been measured.** ADR-058 says pg-boss is safe
 * through Supabase's transaction pooler, reasoned from `pg_advisory_xact_lock()` being
 * transaction-scoped and from leaving `useListenNotify` off. Reasoning is not measurement, and R7
 * has been open since Stage 1 for exactly that reason.
 *
 * It skips unless `POOLER_DATABASE_URL` is set. That is deliberate and is the whole point of
 * ADR-095: a skipped test with a named reason is visible in every run's output, while an absent
 * test is visible nowhere. **Do not point the variable at local Postgres.** It would pass while
 * measuring nothing, which is the one outcome worse than skipping — the claim is specifically about
 * a *pooled* connection, and a direct one cannot exercise it.
 *
 * What it proves, if it runs: that pg-boss can migrate its own schema, create a queue, accept a
 * job, work it to completion and shut down, all over a connection that is handed back to the pool
 * between statements. Those are the operations that would break if anything pg-boss does depended
 * on session state.
 */
import { afterAll, describe, expect, it } from 'vitest'

import { PgBossQueue } from './pg-boss.ts'
import type { ImportRunPayload } from './queue.ts'

const POOLER_URL = process.env.POOLER_DATABASE_URL

/**
 * Its own schema, so a run against a shared managed database cannot disturb anything, and so the
 * teardown is one statement.
 */
const SCHEMA = `pgboss_pooler_check_${String(process.pid)}`

let queue: PgBossQueue | undefined

afterAll(async () => {
  await queue?.stop()
})

/** A managed database over the network needs more than a local socket does. */
const TIMEOUT_MS = 120_000

const CONFIGURED = POOLER_URL !== undefined && POOLER_URL !== ''

/**
 * The reason lives in the suite's *name*, not in a `console.info`.
 *
 * Vitest swallows module-scope console output, and `describe.skip` on its own reports "skipped"
 * with no explanation — so a green run would read as though R7 had been closed. The name is printed
 * by every reporter, in every run, including CI's.
 */
const describePooler = CONFIGURED ? describe : describe.skip
const SUITE = CONFIGURED
  ? 'pg-boss through a transaction pooler'
  : 'pg-boss through a transaction pooler [R7 UNVERIFIED — set POOLER_DATABASE_URL to measure it]'

describePooler(SUITE, () => {
  it(
    'migrates, enqueues, works and stops over a pooled connection',
    async () => {
      queue = new PgBossQueue({
        connectionString: POOLER_URL as string,
        schema: SCHEMA,
        pollingIntervalSeconds: 1,
        enableJobSpies: true,
      })

      // Each of these is a statement that would fail if pg-boss depended on session state: the
      // schema migration is DDL, `createQueue` writes catalog rows, and the worker polls.
      await queue.start()

      const handled: string[] = []
      await queue.work<ImportRunPayload>('import.run', (job) => {
        handled.push(job.data.batchId)
        return Promise.resolve()
      })

      const spy = queue.spy<ImportRunPayload>('import.run')
      const id = await queue.send('import.run', { batchId: 'pooler-check' })
      expect(id).not.toBeNull()

      await spy.waitForJobWithId(id as string, 'completed')
      expect(handled).toEqual(['pooler-check'])
    },
    // A managed database over the network is not a local socket, and pg-boss migrating its own
    // schema on a first run is the slow part.
    TIMEOUT_MS,
  )
})
