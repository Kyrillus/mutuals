/**
 * One error shape for the whole API: RFC 9457 `application/problem+json` with a per-field `errors`
 * array (§7, ADR-031).
 *
 * Everything funnels through {@link toProblem}: a `CoreIssue[]` from the domain, a Zod failure from
 * the type provider, a Postgres constraint, a thrown `ApiError`, or something nobody expected. A
 * client therefore branches on `type` and renders `errors[].field`, and never has to recognise
 * four different bodies for the same class of mistake.
 */
import { problemType, type CoreIssue, type Problem, type ProblemError } from '@mutuals/core'
import type { FastifyError, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'

export interface ApiErrorInit {
  readonly status: number
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly errors?: readonly ProblemError[]
}

/** The one exception handlers throw. Everything else that escapes is a bug and answers 500. */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly errors?: readonly ProblemError[]

  constructor(init: ApiErrorInit) {
    super(init.detail)
    this.status = init.status
    this.code = init.code
    this.title = init.title
    this.detail = init.detail
    if (init.errors !== undefined) this.errors = init.errors
  }
}

/** A dotted path a form can highlight: `['attributes','city']` becomes `attributes.city`. */
export function fieldPath(path: readonly (string | number)[]): string {
  return path.map((segment) => String(segment)).join('.')
}

export function errorsFromIssues(issues: readonly CoreIssue[]): ProblemError[] {
  return issues.map((issue) => ({
    field: fieldPath(issue.path),
    code: issue.code,
    message: issue.message,
  }))
}

/** 400 for anything the caller could fix by sending different input. */
export function validationFailed(issues: readonly CoreIssue[]): ApiError {
  return new ApiError({
    status: 400,
    code: 'validation_failed',
    title: 'The request could not be accepted',
    detail:
      issues.length === 1 && issues[0] !== undefined
        ? issues[0].message
        : `${String(issues.length)} fields need attention.`,
    errors: errorsFromIssues(issues),
  })
}

export function notFound(resource: string, id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no ${resource} with id ${id}.`,
  })
}

export function conflict(detail: string): ApiError {
  return new ApiError({ status: 409, code: 'conflict', title: 'Conflict', detail })
}

/**
 * §6.8's upload, handed a file it cannot read.
 *
 * The accepted extensions go in the detail rather than only in the docs: the person who sees this
 * is mid-import with a file in their hand, and "Mutuals reads .csv and .xlsx" is the whole answer.
 */
export function unsupportedMediaType(detail: string, accepted: readonly string[]): ApiError {
  return new ApiError({
    status: 415,
    code: 'unsupported_media_type',
    title: 'Unsupported file type',
    detail: `${detail} Accepted: ${accepted.join(', ')}.`,
  })
}

/** Above the upload limit. §6.8 promises 10k rows, not an arbitrary file. */
export function payloadTooLarge(detail: string): ApiError {
  return new ApiError({
    status: 413,
    code: 'payload_too_large',
    title: 'File too large',
    detail,
  })
}

/** §7's Stage-6 surface: documented, reachable, and honest about not being built yet. */
export function notImplemented(operation: string, stage: string): ApiError {
  return new ApiError({
    status: 501,
    code: 'not_implemented',
    title: 'Not implemented yet',
    detail: `"${operation}" arrives in ${stage}. Its request and response shapes are already in the OpenAPI document so a client can be written against them.`,
  })
}

interface PostgresError {
  readonly code: string
  readonly constraint?: string
  readonly detail?: string
}

function asPostgresError(error: unknown): PostgresError | null {
  if (typeof error !== 'object' || error === null) return null
  const code: unknown = (error as { code?: unknown }).code
  // Every SQLSTATE is five characters; Fastify's own codes are `FST_ERR_…`.
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? (error as unknown as PostgresError)
    : null
}

const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'

/**
 * The section of the request a Zod failure came from, plus the path inside it. An empty
 * `instancePath` means the whole body failed, so the section name is the most useful field there
 * is.
 */
function validationField(context: string | undefined, instancePath: string): string {
  const path = instancePath.replace(/^\//, '').replace(/\//g, '.')
  if (path !== '') return path
  return context ?? 'body'
}

function fromFastifyValidation(error: FastifyError): ApiError | null {
  if (!hasZodFastifySchemaValidationErrors(error)) return null
  const context = (error as { validationContext?: string }).validationContext
  const errors = error.validation.map((entry) => ({
    field: validationField(context, entry.instancePath),
    code: entry.keyword,
    message: entry.message ?? 'Invalid value.',
  }))
  return new ApiError({
    status: 400,
    code: 'validation_failed',
    title: 'The request could not be accepted',
    detail:
      errors.length === 1 && errors[0] !== undefined
        ? `${errors[0].field}: ${errors[0].message}`
        : `${String(errors.length)} fields need attention.`,
    errors,
  })
}

function fromPostgres(error: unknown): ApiError | null {
  const pg = asPostgresError(error)
  if (pg === null) return null
  if (pg.code === UNIQUE_VIOLATION) {
    return conflict(
      `That value is already taken${pg.constraint === undefined ? '' : ` (${pg.constraint})`}.`,
    )
  }
  if (pg.code === FOREIGN_KEY_VIOLATION) {
    return new ApiError({
      status: 400,
      code: 'invalid_input',
      title: 'The request could not be accepted',
      detail: 'One of the records this refers to does not exist.',
    })
  }
  if (pg.code === CHECK_VIOLATION) {
    return new ApiError({
      status: 400,
      code: 'invalid_input',
      title: 'The request could not be accepted',
      detail: `A value was rejected by the database${pg.constraint === undefined ? '' : ` (${pg.constraint})`}.`,
    })
  }
  return null
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  const fastify = error as FastifyError
  const validation = fromFastifyValidation(fastify)
  if (validation !== null) return validation

  const postgres = fromPostgres(error)
  if (postgres !== null) return postgres

  // A Fastify error that already carries a client-side status — an unparseable body, an unknown
  // route, a payload over the limit — keeps it; its message is Fastify's own and safe to show.
  const status = typeof fastify.statusCode === 'number' ? fastify.statusCode : 500
  if (status >= 400 && status < 500) {
    return new ApiError({
      status,
      code: fastify.code ?? 'invalid_input',
      title: status === 404 ? 'Not found' : 'The request could not be accepted',
      detail: fastify.message,
    })
  }

  return new ApiError({
    status: 500,
    code: 'internal_error',
    title: 'Something went wrong',
    // Deliberately not the thrown message: an unexpected error can carry a SQL fragment or a
    // connection string, and the log already has the whole thing.
    detail: 'The server could not complete the request. The details are in the server log.',
  })
}

export function toProblem(error: unknown, request: Pick<FastifyRequest, 'url'>): Problem {
  const api = asApiError(error)
  return {
    type: problemType(api.code),
    title: api.title,
    status: api.status,
    detail: api.detail,
    instance: request.url,
    ...(api.errors === undefined ? {} : { errors: [...api.errors] }),
  }
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'
