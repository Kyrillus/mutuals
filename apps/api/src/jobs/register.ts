/**
 * Starting the queue and registering the handlers (ADR-062).
 *
 * In-process by default: §12 asks for one command on a laptop with no process manager, so the API
 * runs the worker unless told not to. `MUTUALS_WORKER=off` turns it off, which is the whole
 * scale-out path — `apps/worker` is then the same two calls in their own process.
 *
 * Nothing here decides *what* a job does. `runImport` is the handler and lives beside the rest of
 * the import; this file is the wiring, so adding a queue is one entry in `JOB_QUEUES` and one
 * `work()` call rather than a new module that knows how to start pg-boss.
 */
import { PgBossQueue, updateImportBatch, type ImportRunPayload, type JobQueue } from '@mutuals/db'

import { runImport } from '../import/commit.ts'
import type { AppContext } from '../context.ts'
import type { Env } from '../env.ts'

/** What the queue needs to say something. Narrow, so a test can pass `console`. */
export interface JobLogger {
  info(object: unknown, message?: string): void
  warn(object: unknown, message?: string): void
  error(object: unknown, message?: string): void
}

export interface StartWorkerOptions {
  readonly env: Env
  readonly logger: JobLogger
  /** The context the handler runs with, minus the queue it is about to be given. */
  readonly context: Omit<AppContext, 'jobs'>
}

/**
 * Starts the queue and registers every handler. Returns the queue, or `undefined` when disabled.
 *
 * A failure to start is logged and swallowed. The reasoning is the warmth sweep's: an API that
 * serves every read and cannot import is a much better day than an API that will not start, and
 * `commitImportBatch` answers with a clear conflict when `ctx.jobs` is absent rather than failing
 * somewhere deeper.
 */
export async function startWorker(options: StartWorkerOptions): Promise<JobQueue | undefined> {
  if (options.env.MUTUALS_WORKER === 'off') {
    options.logger.info({}, 'worker is off (MUTUALS_WORKER=off); imports will not run here')
    return undefined
  }

  try {
    const queue = new PgBossQueue({ connectionString: options.env.DATABASE_URL })
    await queue.start()
    await registerJobHandlers(queue, { ...options.context, jobs: queue }, options.logger)

    options.logger.info({}, 'worker started; import.run is handled in this process')
    return queue
  } catch (error) {
    options.logger.warn({ err: error }, 'could not start the job queue; imports will not run')
    return undefined
  }
}

/**
 * Registers every handler on a queue.
 *
 * Separate from {@link startWorker} so a test can drive the real handler through an in-process
 * queue without pg-boss and without a poll interval. If this were inlined above, an API test would
 * either need a live queue or a second copy of the handler — and a second copy is how the tested
 * path and the shipped path drift.
 */
export async function registerJobHandlers(
  queue: JobQueue,
  context: AppContext,
  logger: JobLogger,
): Promise<void> {
  await queue.work<ImportRunPayload>('import.run', async (job) => {
    await handleImport(context, logger, job.data)
  })
}

/**
 * One import, with ADR-061's failure contract.
 *
 * The `catch` writes `status = 'failed'` plus the detail in its own committed transaction and then
 * rethrows. Both halves matter: the row is the only place a user-visible failure can surface — the
 * dead-letter queue was deleted because nothing read it — and rethrowing is what marks the pg-boss
 * job failed, which `retryLimit: 0` then leaves alone rather than replaying a half-applied import.
 */
async function handleImport(
  context: AppContext,
  logger: JobLogger,
  payload: ImportRunPayload,
): Promise<void> {
  try {
    const result = await runImport(context, payload.batchId, payload.resumeFrom ?? 1)
    logger.info({ batch: payload.batchId, ...result }, 'import finished')
  } catch (error) {
    await updateImportBatch(context.db, payload.batchId, {
      status: 'failed',
      errorDetail: {
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      },
    })
    logger.error({ err: error, batch: payload.batchId }, 'import failed')
    throw error
  }
}
