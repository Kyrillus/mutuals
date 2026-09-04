/**
 * The job-queue port (ADR-058).
 *
 * Three methods, because that is the whole surface the product needs and because pg-boss is
 * maintained by one person — §13's R7. Swapping in Graphile Worker means writing one adapter
 * against this interface and changing one line in `main.ts`; nothing that enqueues a job or handles
 * one imports pg-boss.
 *
 * `send` takes an optional executor so an enqueue can join the caller's transaction. That matters
 * for exactly the reason §6.8 needs: the wizard writes `import_batch.status = 'importing'` and
 * enqueues the job, and if those two are not atomic a crash between them leaves a batch that says
 * it is importing with nothing that will ever import it.
 */
import type { Executor } from '../write/types.ts'

/** Every queue the product uses. Named here so a typo is a type error (ADR-060's orphan queues). */
export const JOB_QUEUES = ['import.run'] as const
export type JobQueueName = (typeof JOB_QUEUES)[number]

export interface SendOptions {
  /** Joins the caller's transaction, so the enqueue commits with the state change that caused it. */
  readonly executor?: Executor
  /** Seconds to wait before the job becomes visible. */
  readonly startAfterSeconds?: number
  /**
   * A key that makes the send idempotent while a job with it is still active. Used so a double
   * click on `Import` cannot start two importers for one batch.
   */
  readonly singletonKey?: string
}

export interface JobContext<Data> {
  readonly id: string
  readonly data: Data
}

export type JobHandler<Data> = (job: JobContext<Data>) => Promise<void>

export interface WorkOptions {
  /** How many jobs of this queue may run at once. One, for the importer: it writes a lot. */
  readonly concurrency?: number
}

export interface JobQueue {
  /** Enqueues one job. Returns the job id, or `null` when a singleton key suppressed it. */
  send<Data extends object>(
    queue: JobQueueName,
    data: Data,
    options?: SendOptions,
  ): Promise<string | null>

  /** Registers the handler for a queue. Every queue in {@link JOB_QUEUES} must have exactly one. */
  work<Data extends object>(
    queue: JobQueueName,
    handler: JobHandler<Data>,
    options?: WorkOptions,
  ): Promise<void>

  /** Stops accepting work and waits for what is running. Called on shutdown. */
  stop(): Promise<void>
}

/**
 * The payload of `import.run` (ADR-061): one job per batch, not one per row.
 *
 * `resumeFrom` is what the Resume button sends. The handler restarts at
 * `last_committed_row + 1` and re-evaluates duplicate decisions for the remaining rows only.
 */
export interface ImportRunPayload {
  readonly batchId: string
  readonly resumeFrom?: number
}
