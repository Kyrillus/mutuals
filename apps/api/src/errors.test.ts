import { issue, problemType } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import {
  ApiError,
  asApiError,
  notFound,
  notImplemented,
  toProblem,
  validationFailed,
} from './errors.ts'

const request = { url: '/api/v1/contacts' }

describe('problem+json', () => {
  it('carries a dereferenceable type, the status, and the request path', () => {
    const problem = toProblem(notFound('contact', 'abc'), request)
    expect(problem).toEqual({
      type: problemType('not_found'),
      title: 'Not found',
      status: 404,
      detail: 'There is no contact with id abc.',
      instance: '/api/v1/contacts',
    })
  })

  it('renders a core issue path as a dotted field a form can highlight', () => {
    const problem = toProblem(
      validationFailed([
        issue('invalid_input', 'Enter an email address.', ['attributes', 'email']),
        issue('malformed_query', 'Not JSON.', ['filter', 2, 'value']),
      ]),
      request,
    )
    expect(problem.status).toBe(400)
    expect(problem.detail).toBe('2 fields need attention.')
    expect(problem.errors).toEqual([
      { field: 'attributes.email', code: 'invalid_input', message: 'Enter an email address.' },
      { field: 'filter.2.value', code: 'malformed_query', message: 'Not JSON.' },
    ])
  })

  it('uses the single message as the detail when there is exactly one', () => {
    const problem = toProblem(
      validationFailed([issue('required', 'Give the contact a name.', ['firstName'])]),
      request,
    )
    expect(problem.detail).toBe('Give the contact a name.')
  })

  it('omits `errors` entirely rather than sending an empty array', () => {
    expect(toProblem(notFound('contact', 'abc'), request).errors).toBeUndefined()
  })

  it('says which stage a 501 belongs to', () => {
    const problem = toProblem(notImplemented('ask', 'Stage 6'), request)
    expect(problem.status).toBe(501)
    expect(problem.detail).toContain('Stage 6')
  })
})

describe('errors nobody threw on purpose', () => {
  it('never leaks the thrown message on a 500', () => {
    const problem = toProblem(
      new Error('connect ECONNREFUSED postgres://mutuals:hunter2@localhost:5432'),
      request,
    )
    expect(problem.status).toBe(500)
    expect(problem.detail).not.toContain('hunter2')
    expect(problem.detail).toBe(
      'The server could not complete the request. The details are in the server log.',
    )
  })

  it('keeps a 4xx that Fastify itself produced', () => {
    const api = asApiError({
      statusCode: 415,
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      message: 'x',
    })
    expect(api.status).toBe(415)
    expect(api.code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE')
  })
})

describe('Postgres errors', () => {
  it('turns a unique violation into 409', () => {
    const api = asApiError({ code: '23505', constraint: 'identifier_uq' })
    expect(api.status).toBe(409)
    expect(api.detail).toContain('identifier_uq')
  })

  it('turns a foreign-key violation into a 400 the caller can act on', () => {
    const api = asApiError({ code: '23503', constraint: 'fact_shape_fk' })
    expect(api.status).toBe(400)
    expect(api.detail).toBe('One of the records this refers to does not exist.')
  })

  it('leaves a Fastify error code alone — five characters is not a SQLSTATE by accident', () => {
    // `FST_ERR_VALIDATION` must not be mistaken for a SQLSTATE, and neither must a short one.
    const api = asApiError({ code: 'FST_ERR_NOT_FOUND', statusCode: 404, message: 'no route' })
    expect(api.status).toBe(404)
  })
})

describe('ApiError', () => {
  it('is its own detail, so a throw site reads as the sentence the user sees', () => {
    const error = new ApiError({
      status: 409,
      code: 'conflict',
      title: 'Conflict',
      detail: '"City" is a system attribute and cannot be deleted.',
    })
    expect(error.message).toBe('"City" is a system attribute and cannot be deleted.')
  })
})
