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

/** Query-string values as the caller thinks of them; `undefined` and `null` are dropped. */
export type SearchParams = Record<string, string | number | boolean | null | undefined>

export type RequestOptions = {
  search?: SearchParams
  /** TanStack Query hands one to every `queryFn`; passing it on makes navigation cancel work. */
  signal?: AbortSignal
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
  const response = await fetch(buildUrl(path, options.search), {
    ...init,
    signal: options.signal,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })

  // A proxy or a crash can answer with HTML, so the body is read as text and parsed defensively —
  // the error path must never throw a SyntaxError over the real failure.
  const text = await response.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const problem = ProblemSchema.safeParse(body)
    throw new ApiError(
      response.status,
      problem.success ? problem.data.detail : `${String(response.status)} ${response.statusText}`,
      problem.success ? problem.data : null,
    )
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
