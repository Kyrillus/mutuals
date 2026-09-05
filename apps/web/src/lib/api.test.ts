import { ProfileSchema, problemType } from '@mutuals/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { api, ApiError, API_BASE, NetworkError, TimeoutError } from './api.ts'

type FetchArgs = { url: string; init: RequestInit | undefined }

/**
 * The wrapper's entire job is what happens either side of `fetch`, so `fetch` is the seam. Nothing
 * here starts a server: these are assertions about URL building, error translation and parsing.
 */
function stubFetch(respond: () => Response): { calls: FetchArgs[] } {
  const calls: FetchArgs[] = []
  // A factory, not a value: a Response body can only be read once, and two calls in one test would
  // otherwise fail on the second with an error that says nothing about the wrapper.
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(respond())
  })
  return { calls }
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })
}

const PROFILE = {
  id: '9f1f1e34-5f0a-4a1e-9d94-3a0a3f9f5f11',
  firstName: 'Simon',
  lastName: 'Mutuals',
  email: 'simon@example.com',
  language: 'en',
  phoneRegion: 'DE',
  timeZone: 'Europe/Berlin',
  createdAt: '2026-09-03T20:42:35.024Z',
  updatedAt: '2026-09-03T20:42:35.024Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api', () => {
  it('parses a successful response through the contract schema', async () => {
    stubFetch(() => json(PROFILE))

    const profile = await api.get(ProfileSchema, '/profile')

    expect(profile.firstName).toBe('Simon')
  })

  it('requests the versioned path and drops empty query parameters', async () => {
    const { calls } = stubFetch(() => json(PROFILE))

    await api.get(ProfileSchema, '/profile', {
      search: { limit: 50, cursor: undefined, view: null, q: 'anna' },
    })

    expect(calls[0]?.url).toBe(`${API_BASE}/profile?limit=50&q=anna`)
  })

  it('sends a JSON content type only when there is a body', async () => {
    const { calls } = stubFetch(() => json(PROFILE))

    await api.get(ProfileSchema, '/profile')
    await api.patch(ProfileSchema, '/profile', { firstName: 'Simon' })

    const headers = (index: number) => new Headers(calls[index]?.init?.headers)
    expect(headers(0).get('content-type')).toBeNull()
    expect(headers(1).get('content-type')).toBe('application/json')
  })

  it('turns problem+json into an ApiError carrying the per-field errors', async () => {
    stubFetch(() =>
      json(
        {
          type: problemType('validation_failed'),
          title: 'The request could not be accepted',
          status: 400,
          detail: 'Give the contact a first or a last name.',
          instance: '/api/v1/contacts',
          errors: [
            {
              field: 'firstName',
              code: 'required',
              message: 'Give the contact a first or a last name.',
            },
          ],
        },
        400,
        'application/problem+json',
      ),
    )

    const error = await api.post(z.unknown(), '/contacts', {}).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(400)
    expect(apiError.message).toBe('Give the contact a first or a last name.')
    expect(apiError.fieldError('firstName')).toBe('Give the contact a first or a last name.')
    expect(apiError.fieldError('lastName')).toBeUndefined()
  })

  it('survives a failure whose body is not JSON at all', async () => {
    stubFetch(() => new Response('<html>500 Internal Server Error</html>', { status: 500 }))

    const error = await api.get(ProfileSchema, '/profile').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(500)
    expect(apiError.problem).toBeNull()
    expect(apiError.errors).toHaveLength(0)
  })

  it('refuses a 200 whose body does not match the contract', async () => {
    stubFetch(() => json({ firstName: 'Simon' }))

    await expect(api.get(ProfileSchema, '/profile')).rejects.toThrow()
  })
})

/**
 * The three ways a request fails without ever producing a status. They are separated here because
 * the UI has to tell them apart: an unreachable server is a sentence about the server, a deadline
 * is a sentence about waiting, and a cancelled request is not a failure at all.
 */
describe('a request that never reaches a status', () => {
  it('translates a rejected fetch into a sentence about the server', async () => {
    // What Chrome throws with nothing listening on the port.
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))

    const error = await api.get(ProfileSchema, '/profile').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(NetworkError)
    expect((error as NetworkError).message).toMatch(/could not reach the server/i)
    // The engine's own words are kept for the console, and kept out of the user's way.
    expect((error as NetworkError).cause).toBeInstanceOf(TypeError)
  })

  it('reads a bare 502 as the proxy saying the API is not there', async () => {
    // Exactly what `vite preview` answers with Fastify stopped — measured, then written down.
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    const error = await api.get(ProfileSchema, '/profile').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(NetworkError)
    expect((error as NetworkError).status).toBe(502)
    expect((error as NetworkError).message).toMatch(/could not reach the server/i)
  })

  it('still trusts a 503 that carries a problem document, because ours do', async () => {
    // §4.8 answers 503 `llm_disabled` when there is no API key, and that is the API talking.
    stubFetch(() =>
      json(
        {
          type: problemType('llm_disabled'),
          title: 'The AI features are switched off',
          status: 503,
          detail: 'Set OPENROUTER_API_KEY to switch them on.',
          instance: '/api/v1/ask',
        },
        503,
        'application/problem+json',
      ),
    )

    const error = await api.post(z.unknown(), '/ask', {}).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('Set OPENROUTER_API_KEY to switch them on.')
  })

  it('gives up on a socket that is open and silent', async () => {
    // Never resolves, and never rejects on its own: the deadline is the only thing that ends it.
    vi.stubGlobal(
      'fetch',
      (_input: string | URL, init?: RequestInit) =>
        new Promise((_resolve, reject: (reason: Error) => void) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason
            reject(reason instanceof Error ? reason : new Error('aborted'))
          })
        }),
    )

    const error = await api
      .get(ProfileSchema, '/profile', { timeoutMs: 20 })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as TimeoutError).timeoutMs).toBe(20)
  })

  it("passes the caller's own cancellation through untranslated", async () => {
    // React Query recognises its own abort by identity; wrapping it would turn every navigation
    // away from a loading page into an error toast.
    vi.stubGlobal(
      'fetch',
      (_input: string | URL, init?: RequestInit) =>
        new Promise((_resolve, reject: (reason: Error) => void) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason
            reject(reason instanceof Error ? reason : new Error('aborted'))
          })
        }),
    )

    const controller = new AbortController()
    const pending = api
      .get(ProfileSchema, '/profile', { signal: controller.signal })
      .catch((thrown: unknown) => thrown)
    controller.abort(new DOMException('The user navigated away', 'AbortError'))

    const error = await pending
    expect(error).not.toBeInstanceOf(NetworkError)
    expect(error).not.toBeInstanceOf(TimeoutError)
    expect((error as Error).name).toBe('AbortError')
  })
})
