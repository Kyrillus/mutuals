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

export function testContext(): AppContext {
  return { db: testDb(), env: testEnv(), now: () => TEST_NOW }
}

export function getTestApp(): Promise<App> {
  const cache = globalThis as Cache
  cache[APP_KEY] ??= buildApp(testContext(), { logger: false })
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

/** `?filter=` carries one URL-encoded JSON array (ADR-032); tests build it the same way a client does. */
export function listUrl(path: string, params: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams(params).toString()
  return search === '' ? path : `${path}?${search}`
}
