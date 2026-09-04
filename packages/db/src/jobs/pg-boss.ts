/**
 * The pg-boss adapter for {@link JobQueue} (ADR-058, ADR-059).
 *
 * The only file in the repository that imports pg-boss. Everything else speaks the three-method
 * port, which is the mitigation §13's R7 names: pg-boss is maintained by one person, and
 * `DROP SCHEMA pgboss CASCADE` is a complete uninstall.
 *
 * **Its own pool, polling only** (ADR-059). Two reasons, and neither is style. The application's
 * pool carries the raised planner GUCs of ADR-013, which a background job has no business
 * inheriting — a job that scans a whole batch wants different plans from a request that reads one
 * contact. And pg-boss's own documentation states its LISTEN/NOTIFY listener does not work through
 * PgBouncer in transaction or statement pooling mode, which is exactly how a Supabase connection
 * string is pooled. Polling costs one small query per interval and works everywhere; the listener
 * saves that and breaks in the one deployment the brief names.
 */
import { PgBoss, fromKysely, type Job, type JobSpyInterface } from 'pg-boss'

import {
  JOB_QUEUES,
  type JobHandler,
  type JobQueue,
  type JobQueueName,
  type SendOptions,
  type WorkOptions,
} from './queue.ts'

/** Its own schema, so the uninstall really is one `DROP SCHEMA`. */
export const PGBOSS_SCHEMA = 'pgboss'

export interface PgBossOptions {
  readonly connectionString: string
  /**
   * Small on purpose. The importer runs one job at a time and the maintenance queries are tiny, so
   * two connections is enough — and every connection here is one the API cannot have.
   */
  readonly maxConnections?: number
  /** Per *worker* in pg-boss 12, not per instance, so it is carried to `work()` rather than used here. */
  readonly pollingIntervalSeconds?: number
  readonly schema?: string
  /**
   * Turns on pg-boss's job spy, which {@link PgBossQueue.spy} needs (ADR-063).
   *
   * Tests only. It maps to pg-boss's own `__test__enableSpies`, and the double-underscore name is
   * the library telling you so: the spy keeps every job it sees in memory, which for a long-running
   * import worker is a leak rather than a feature. `main.ts` never sets it.
   */
  readonly enableJobSpies?: boolean
}

export class PgBossQueue implements JobQueue {
  readonly #boss: PgBoss
  readonly #pollingIntervalSeconds: number
  #started = false

  constructor(options: PgBossOptions) {
    this.#pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? PGBOSS_SCHEMA,
      max: options.maxConnections ?? 2,
      // Its own name in `pg_stat_activity`, so a connection that will not close is attributable.
      application_name: 'mutuals-worker',
      // ADR-059, stated rather than left to the default: the listener holds a session-pinned
      // connection and pg-boss's own documentation says it will not work through PgBouncer in
      // transaction pooling mode, which is how a Supabase connection string is pooled. Polling
      // stays on as the correctness floor either way, so this only ever costs latency.
      useListenNotify: false,
      // pg-boss owns its schema and migrates it itself. Ours are explicit and never run on boot
      // (CLAUDE.md); this one is a vendor's internal schema and is not ours to version.
      migrate: true,
      supervise: true,
      ...(options.enableJobSpies === true ? { __test__enableSpies: true } : {}),
    })

    // pg-boss emits on its own error channel; an unhandled 'error' event would take the process
    // down, and a queue that cannot reach the database must not kill an API that still can.
    this.#boss.on('error', (error: unknown) => {
      console.error('[jobs] pg-boss error', error)
    })
  }

  /**
   * Starts the queue and declares every queue in {@link JOB_QUEUES}.
   *
   * pg-boss 12 requires a queue to exist before anything sends to it, and declaring them from the
   * one authoritative list is what stops a typo becoming a queue nobody works — ADR-060's orphaned
   * queue, which is how the deleted `import.failed` dead-letter went wrong.
   */
  async start(): Promise<void> {
    if (this.#started) return
    await this.#boss.start()
    for (const queue of JOB_QUEUES) {
      await this.#boss.createQueue(queue, {
        /**
         * `stately` is what makes `singletonKey` actually deduplicate.
         *
         * A key on its own suppresses nothing in pg-boss 12 — the queue's policy decides, and the
         * default `standard` policy has no notion of a key at all. Found by asserting that a second
         * send returns `null` and getting a job id. `stately` allows at most one job per key in
         * `created` *and* at most one in `active`, which is exactly the double-click guarantee §6.8
         * needs: the key is the batch id, so two different files still import concurrently.
         */
        policy: 'stately',
        // ADR-061: no automatic retry. A half-applied import must be resumed deliberately, from
        // `last_committed_row + 1`, not replayed from the top by a supervisor.
        retryLimit: 0,
        expireInSeconds: 900,
        // ADR-061. On the *queue* in pg-boss 12, not on the worker — the worker's own option is
        // `heartbeatRefreshSeconds`, which is how often it touches a job it already holds. The
        // handler advances `last_committed_row` every chunk, so a job that is genuinely working
        // never looks stalled and one that has died is reclaimed within the minute.
        heartbeatSeconds: 60,
        // Kept long enough that a completed import is still inspectable the next morning.
        retentionSeconds: 7 * 24 * 60 * 60,
      })
    }
    this.#started = true
  }

  async send<Data extends object>(
    queue: JobQueueName,
    data: Data,
    options: SendOptions = {},
  ): Promise<string | null> {
    return this.#boss.send(queue, data, {
      ...(options.startAfterSeconds === undefined ? {} : { startAfter: options.startAfterSeconds }),
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      ...(options.executor === undefined ? {} : { db: fromKysely(options.executor) }),
    })
  }

  async work<Data extends object>(
    queue: JobQueueName,
    handler: JobHandler<Data>,
    options: WorkOptions = {},
  ): Promise<void> {
    await this.#boss.work<Data>(
      queue,
      {
        batchSize: options.concurrency ?? 1,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
      },
      async (jobs: Job<Data>[]) => {
        for (const job of jobs) await handler({ id: job.id, data: job.data })
      },
    )
  }

  /**
   * pg-boss's own job spy, for tests (ADR-063).
   *
   * A queue test that sleeps is slow when it passes and flaky when it does not, and it cannot
   * express "wait until this job reaches `completed`" at all — only "wait 200ms and hope". The spy
   * resolves on the state transition. Exposed on the adapter rather than on the port because it is
   * pg-boss's mechanism, and a second adapter would bring its own.
   */
  spy<Data extends object>(queue: JobQueueName): JobSpyInterface<Data> {
    return this.#boss.getSpy<Data>(queue)
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    this.#started = false
    // `graceful` lets a running import finish its chunk and record where it got to, which is what
    // makes a restart resumable rather than a guess. `close` returns the pool's connections, which
    // matters in tests: a suite that leaves two connections open per case exhausts the server.
    await this.#boss.stop({ graceful: true, close: true })
  }
}
