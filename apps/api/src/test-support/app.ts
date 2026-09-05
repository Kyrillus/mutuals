/**
 * One real Fastify app per worker, over that worker's own cloned database (ADR-073, ADR-075).
 *
 * `inject()` rather than a socket: it exercises routing, the Zod type provider, serialisation, the
 * hooks and the error handler — which is what §8.1 means by "the API" — without a port. The service
 * layer is deliberately not called directly, because the query-string filter model is the fragile
 * surface and calling past it would test the wrong thing.
 *
 * Building the app is a per-process singleton on `globalThis`, not a `beforeAll`: `setupFiles` run
 * once per test *file*, so a naive `beforeAll` would boot Fastify thirty times instead of four.
 */
import { testDb } from '@mutuals/db/test-support'
import type { JobHandler, JobQueue, JobQueueName } from '@mutuals/db'

import { buildApp, type App } from '../app.ts'
import type { AppContext } from '../context.ts'
import { parseEnv, type Env } from '../env.ts'

/** Pinned so "due this week", "overdue" and "added in the last 30 days" mean one thing. */
export const TEST_NOW = new Date('2026-06-15T09:00:00.000Z')

const APP_KEY = Symbol.for('mutuals.test.api.app')

interface Cache {
  [APP_KEY]?: Promise<App>
}

export function testEnv(): Env {
  return parseEnv({
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? 'postgres://mutuals:mutuals@localhost:5432/mutuals_test',
    NODE_ENV: 'test',
    DEFAULT_PHONE_REGION: 'DE',
    DEFAULT_TIME_ZONE: 'Europe/Berlin',
  })
}

/**
 * A job queue that runs the handler immediately, in the caller's process.
 *
 * pg-boss's own behaviour is tested in `packages/db/src/jobs/pg-boss.db.test.ts` — the transactional
 * enqueue, the singleton key, `retryLimit: 0`. What an API test needs is the *other* half: that
 * `commitImportBatch` enqueues the right payload and that the handler does the right thing with it.
 * Running inline gives both without a poll interval, and without the test having to know that a
 * queue exists.
 *
 * The difference from production that matters: here the handler's failure propagates to the caller,
 * where pg-boss would swallow it into a failed job. `register.ts` writes `status = 'failed'` before
 * rethrowing either way, so the row a test asserts on is the same row a user would see.
 */
export class InlineJobQueue implements JobQueue {
  readonly #handlers = new Map<string, JobHandler<never>>()
  readonly #pending: { queue: string; data: object }[] = []
  /** Every payload that was sent, so a test can assert on what was enqueued. */
  readonly sent: { queue: string; data: unknown }[] = []

  /**
   * Records the job. It runs in {@link drain}, **after** the enqueueing transaction commits.
   *
   * Running it here instead is what the first version did, and it deadlocked: `commitImportBatch`
   * enqueues inside a transaction that has just written `import_batch.status = 'importing'`, and the
   * handler's own transaction — a different connection — then blocks on that row until the pool
   * gives up. Real pg-boss cannot have this problem because a worker only ever sees a committed job,
   * so a double that runs inline is not merely eager, it models the wrong thing.
   */
  send<Data extends object>(queue: JobQueueName, data: Data): Promise<string | null> {
    this.sent.push({ queue, data })
    if (!this.#handlers.has(queue)) return Promise.resolve(null)
    this.#pending.push({ queue, data })
    return Promise.resolve(`inline-${String(this.sent.length)}`)
  }

  /** Runs everything enqueued since the last drain. Called by the HTTP helper after each request. */
  async drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const job = this.#pending.shift()
      if (job === undefined) break
      const handler = this.#handlers.get(job.queue)
      if (handler === undefined) continue
      await (handler as JobHandler<object>)({
        id: `inline-${String(this.sent.length)}`,
        data: job.data,
      })
    }
  }

  work<Data extends object>(queue: JobQueueName, handler: JobHandler<Data>): Promise<void> {
    this.#handlers.set(queue, handler)
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }
}

const QUEUE_KEY = Symbol.for('mutuals.test.api.jobs')

interface QueueCache {
  [QUEUE_KEY]?: InlineJobQueue
}

/** The one queue this process's test app uses, so a test can read what was enqueued. */
export function testJobs(): InlineJobQueue {
  const cache = globalThis as QueueCache
  cache[QUEUE_KEY] ??= new InlineJobQueue()
  return cache[QUEUE_KEY]
}

export function testContext(): AppContext {
  return { db: testDb(), env: testEnv(), now: () => TEST_NOW, jobs: testJobs() }
}

export function getTestApp(): Promise<App> {
  const cache = globalThis as Cache
  cache[APP_KEY] ??= buildApp(testContext(), { logger: false }).then(async (app) => {
    // The same registration `main.ts` performs, so the handler under test is the one that ships.
    const { registerJobHandlers } = await import('../jobs/register.ts')
    await registerJobHandlers(testJobs(), testContext(), {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    })
    return app
  })
  return cache[APP_KEY]
}

export interface Response<T = unknown> {
  readonly status: number
  readonly body: T
  readonly contentType: string
}

async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<Response<T>> {
  const app = await getTestApp()
  const result = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
  // Jobs the request enqueued run here, once its transaction has committed — the moment a real
  // worker would first be able to see them.
  await testJobs().drain()
  return {
    status: result.statusCode,
    contentType: result.headers['content-type']?.toString() ?? '',
    body: result.body === '' ? (undefined as T) : (JSON.parse(result.body) as T),
  }
}

export const api = {
  get: <T = unknown>(url: string) => send<T>('GET', url),
  post: <T = unknown>(url: string, payload?: unknown) => send<T>('POST', url, payload ?? {}),
  patch: <T = unknown>(url: string, payload?: unknown) => send<T>('PATCH', url, payload ?? {}),
  delete: <T = unknown>(url: string) => send<T>('DELETE', url),
}

/**
 * A `multipart/form-data` upload, built by hand.
 *
 * §6.8's upload is the one route that is not JSON, and `inject` takes a raw body — so the body is
 * assembled here rather than pulled in as a dependency. It is twenty lines and it exercises the
 * real parser, which is the point: a test that posted JSON would not touch `@fastify/multipart` at
 * all and would pass with the plugin unregistered.
 */
export async function upload<T = unknown>(
  url: string,
  file: { name: string; content: Buffer },
  fields: Readonly<Record<string, string>> = {},
): Promise<Response<T>> {
  const boundary = '----mutualstest0123456789'
  const parts: Buffer[] = []

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  )

  const app = await getTestApp()
  const result = await app.inject({
    method: 'POST',
    url,
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  })
  await testJobs().drain()
  return {
    status: result.statusCode,
    contentType: result.headers['content-type']?.toString() ?? '',
    body: result.body === '' ? (undefined as T) : (JSON.parse(result.body) as T),
  }
}

/** `?filter=` carries one URL-encoded JSON array (ADR-032); tests build it the same way a client does. */
export function listUrl(path: string, params: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams(params).toString()
  return search === '' ? path : `${path}?${search}`
}
