/**
 * The typed fetch wrapper (ADR-030). There is no generated client: `@mutuals/core/contracts` owns
 * every request and response schema, `apps/api` implements them, and this file parses responses
 * through the very same objects. A response that does not match is a bug in this repository, so
 * `schema.parse` is allowed to throw rather than being softened into a cast.
 *
 * `VITE_API_URL` is empty in development, where Vite proxies `/api` to Fastify, and empty in
 * production, where Fastify serves the built SPA from the same origin (ADR-011). It exists for the
 * one case neither covers: pointing the dev server at a remote API.
 */
import { ProblemSchema, type Problem, type ProblemError } from '@mutuals/core'
import type { z } from 'zod'

const configured: unknown = import.meta.env.VITE_API_URL

export const API_BASE = `${typeof configured === 'string' ? configured : ''}/api/v1`

/**
 * A failed request, carrying the RFC 9457 body the API answered with. `errors` is the per-field
 * array §7 requires: a form reads it to mark the input that was refused, rather than showing one
 * sentence over a dozen fields.
 */
export class ApiError extends Error {
  readonly status: number
  readonly problem: Problem | null
  readonly errors: readonly ProblemError[]

  constructor(status: number, message: string, problem: Problem | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
    this.errors = problem?.errors ?? []
  }

  /** The message for one field path (`firstName`, `attributes.city`), or undefined. */
  fieldError(field: string): string | undefined {
    return this.errors.find((error) => error.field === field)?.message
  }
}

/**
 * The request never reached an HTTP status: the API is not running, the machine is offline, or the
 * connection dropped mid-flight.
 *
 * It exists because `fetch` rejects with a bare `TypeError` whose message is whatever the engine
 * feels like saying — "Failed to fetch" in Chrome, "Load failed" in Safari, "NetworkError when
 * attempting to fetch resource" in Firefox. That string ends up in a toast and in the table's
 * error row, where it tells the reader nothing they can act on.
 */
export class NetworkError extends Error {
  /** The gateway's status, when the failure arrived as one rather than as a dropped socket. */
  readonly status: number | null

  constructor(cause: unknown, status: number | null = null) {
    super('Could not reach the server. It may be offline, or the connection dropped.')
    this.name = 'NetworkError'
    this.cause = cause
    this.status = status
  }
}

/** The request was still running when its deadline passed. Distinct from an abort by the caller. */
export class TimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`The server did not answer within ${String(Math.round(timeoutMs / 1000))} seconds.`)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Every request gets a deadline, because a socket that is open and silent is the one failure the
 * UI cannot see: no error, no data, a spinner that never resolves and an optimistic edit that
 * never rolls back.
 */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The deadline for the operations that are slow *by contract* rather than by accident: the three
 * routes that call a model — ADR-065 gives the model itself 45 seconds — and the import commit,
 * which writes up to 10,000 rows in one transaction.
 */
export const SLOW_TIMEOUT_MS = 120_000

/** Query-string values as the caller thinks of them; `undefined` and `null` are dropped. */
export type SearchParams = Record<string, string | number | boolean | null | undefined>

export type RequestOptions = {
  search?: SearchParams
  /** TanStack Query hands one to every `queryFn`; passing it on makes navigation cancel work. */
  signal?: AbortSignal
  /** Overrides `DEFAULT_TIMEOUT_MS` for one call. `SLOW_TIMEOUT_MS` is the other sanctioned value. */
  timeoutMs?: number
}

function buildUrl(path: string, search: SearchParams | undefined): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value))
  }
  const query = params.toString()
  return `${API_BASE}${path}${query === '' ? '' : `?${query}`}`
}

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

  let status: number
  let statusText: string
  let ok: boolean
  let text: string
  try {
    const response = await fetch(buildUrl(path, options.search), {
      ...init,
      signal,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
    status = response.status
    statusText = response.statusText
    ok = response.ok
    // A proxy or a crash can answer with HTML, so the body is read as text and parsed defensively —
    // the error path must never throw a SyntaxError over the real failure. Reading it is inside the
    // try because a stalled body aborts here, not at the call above.
    text = await response.text()
  } catch (cause) {
    // The caller's own cancellation is not a failure. React Query aborts on unmount and whenever a
    // key changes, and it recognises that rejection by identity — translating it would turn every
    // navigation into an error toast.
    if (options.signal?.aborted === true) throw cause
    if (deadline.aborted) throw new TimeoutError(timeoutMs)
    throw new NetworkError(cause)
  }

  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!ok) {
    const problem = ProblemSchema.safeParse(body)
    if (problem.success) throw new ApiError(status, problem.data.detail, problem.data)

    /*
     * A gateway status with no RFC 9457 body did not come from this API — every failure it
     * produces carries one (§7), including its own 503. It came from whatever sits in front:
     * Vite's `/api` proxy in development and in `vite preview`, which answers **502 Bad Gateway**
     * when Fastify is not listening. Measured, not assumed: with the API killed, `/contacts` used
     * to read "The field definitions could not be loaded: 502 Bad Gateway".
     *
     * So it is the same failure as a dropped socket, and it gets the same sentence.
     */
    if (status === 502 || status === 503 || status === 504) {
      throw new NetworkError(new Error(`${String(status)} ${statusText}`), status)
    }

    throw new ApiError(status, `${String(status)} ${statusText}`, null)
  }

  return schema.parse(body)
}

export const api = {
  get<T>(schema: z.ZodType<T>, path: string, options: RequestOptions = {}): Promise<T> {
    return request(schema, path, { method: 'GET' }, options)
  },
  post<T>(
    schema: z.ZodType<T>,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return request(schema, path, { method: 'POST', body: JSON.stringify(body) }, options)
  },
  patch<T>(
    schema: z.ZodType<T>,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return request(schema, path, { method: 'PATCH', body: JSON.stringify(body) }, options)
  },
  delete<T>(schema: z.ZodType<T>, path: string, options: RequestOptions = {}): Promise<T> {
    return request(schema, path, { method: 'DELETE' }, options)
  },
}
