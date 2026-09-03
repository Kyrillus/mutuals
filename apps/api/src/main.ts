/**
 * The process. The only file that reads the environment, opens a pool and binds a port.
 *
 * The boot order is the point: validate the environment, open the database, **check the schema**,
 * then serve. `assertSchemaCurrent` is a check and never a mutation (ADR-028) — migrations run
 * explicitly through `pnpm db:migrate`, because a server that migrates on boot migrates on every
 * restart, including the one somebody does at 2 a.m. to make a problem go away.
 */
import { assertSchemaCurrent, makeDb } from '@mutuals/db'

import { buildApp } from './app.ts'
import { loadEnv } from './env.ts'

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
}

await main()
