/**
 * The background worker, in its own process (ADR-062).
 *
 * It exists so the scale-out path is **config-only**. The API runs the worker in-process by
 * default, because §12 asks for one command on a laptop with no process manager; when that stops
 * being right, `MUTUALS_WORKER=off` on the API and this process alongside it is the whole change.
 * No code moves, because the handler was never in the API's request path to begin with — it lives
 * in `apps/api/src/import/`, and `startWorker` is what both entry points call.
 *
 * Deliberately thin. If this file ever grows logic of its own, the two ways of running a job have
 * started to differ, and the one that is not exercised by the test suite will be the one that
 * breaks.
 */
import { assertSchemaCurrent, makeDb } from '@mutuals/db'
import { loadEnv } from '@mutuals/api/env'
import { startWorker } from '@mutuals/api/jobs'

const env = loadEnv()
const db = makeDb({ connectionString: env.DATABASE_URL, applicationName: 'mutuals-worker' })

try {
  // The same boot order as the API: check the schema, then work. A worker that writes records
  // against a schema the checkout disagrees with is worse than one that refuses to start (ADR-028).
  await assertSchemaCurrent(db)
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
  await db.destroy()
  process.exit(1)
}

const logger = {
  info: (object: unknown, message?: string) => console.log(message ?? '', object),
  warn: (object: unknown, message?: string) => console.warn(message ?? '', object),
  error: (object: unknown, message?: string) => console.error(message ?? '', object),
}

/**
 * `MUTUALS_WORKER` is what the *API* reads to decide whether to run jobs itself. This process is
 * the worker, so it starts one regardless — otherwise the variable that turns the API's worker off
 * would turn this one off too, and the config that is supposed to move the work would stop it.
 */
const queue = await startWorker({
  env: { ...env, MUTUALS_WORKER: 'on' },
  logger,
  context: { db, env, now: () => new Date() },
})

if (queue === undefined) {
  console.error('the job queue would not start; nothing will be imported')
  await db.destroy()
  process.exit(1)
}

console.log('worker running — import.run')

const shutdown = (signal: string): void => {
  console.log(`${signal}: stopping`)
  void queue
    .stop()
    .then(() => db.destroy())
    .then(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
