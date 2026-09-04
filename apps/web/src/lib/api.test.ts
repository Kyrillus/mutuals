import { ProfileSchema, problemType } from '@mutuals/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { api, ApiError, API_BASE } from './api.ts'

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
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    const error = await api.get(ProfileSchema, '/profile').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(502)
    expect(apiError.problem).toBeNull()
    expect(apiError.errors).toHaveLength(0)
  })

  it('refuses a 200 whose body does not match the contract', async () => {
    stubFetch(() => json({ firstName: 'Simon' }))

    await expect(api.get(ProfileSchema, '/profile')).rejects.toThrow()
  })
})
