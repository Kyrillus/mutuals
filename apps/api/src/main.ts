/**
 * The process. The only file that reads the environment, opens a pool and binds a port.
 *
 * The boot order is the point: validate the environment, open the database, **check the schema**,
 * then serve. `assertSchemaCurrent` is a check and never a mutation (ADR-028) — migrations run
 * explicitly through `pnpm db:migrate`, because a server that migrates on boot migrates on every
 * restart, including the one somebody does at 2 a.m. to make a problem go away.
 */
import { todayIn } from '@mutuals/core'
import { assertSchemaCurrent, makeDb, sweepIfStale, type Executor } from '@mutuals/db'

import { buildApp } from './app.ts'
import { loadEnv, type Env } from './env.ts'

async function main(): Promise<void> {
  const env = loadEnv()
  const db = makeDb({ connectionString: env.DATABASE_URL, applicationName: 'mutuals-api' })

  try {
    await assertSchemaCurrent(db)
  } catch (error) {
    // A schema mismatch is not a stack trace, it is an instruction. `SchemaBehindError` already
    // ends with "Run: pnpm db:migrate".
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
    await db.destroy()
    process.exitCode = 1
    return
  }

  const app = await buildApp({ db, env, now: () => new Date() })

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down')
    void app
      .close()
      .then(() => db.destroy())
      .then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await app.listen({ port: env.PORT, host: '127.0.0.1' })
  app.log.info(
    `API on http://127.0.0.1:${String(env.PORT)}/api/v1 — docs at http://127.0.0.1:${String(env.PORT)}/api/docs`,
  )

  // Q6, answered: warmth decays with time, and the 03:30 sweep does not happen on a laptop that is
  // shut. So it is caught up here — **after** `listen`, deliberately: the API is already serving by
  // the time this starts, so a slow sweep can never delay a request. Measured at 27 ms for 10,000
  // contacts, which is why "on startup" was affordable at all (ADR-093).
  void catchUpMetrics(app, db, env)
}

await main()

/**
 * Never throws and never blocks. A failed sweep leaves warmth a little stale, which is a worse day
 * than a fresh sweep and a much better one than an API that would not start.
 */
async function catchUpMetrics(
  app: Awaited<ReturnType<typeof buildApp>>,
  db: Executor,
  env: Env,
): Promise<void> {
  try {
    const timeZone = env.DEFAULT_TIME_ZONE
    const result = await sweepIfStale(db, { today: todayIn(timeZone, new Date()), timeZone })
    if (result.ran) {
      app.log.info(
        { contacts: result.contacts, ms: result.milliseconds },
        'warmth was stale; recomputed the contacts that could have changed',
      )
    }
  } catch (error) {
    app.log.warn({ err: error }, 'could not refresh warmth on startup; it stays as it was')
  }
}
