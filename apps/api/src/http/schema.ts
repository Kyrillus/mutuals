/**
 * The response-schema scaffolding every route shares.
 *
 * Declaring the problem responses per route is not ceremony: `@fastify/swagger` reads them, so the
 * OpenAPI document says what a 400 looks like, and the serializer *validates* them, so an error
 * body that does not match RFC 9457 fails in a test rather than in a client.
 */
import { ProblemSchema } from '@mutuals/core'
import type { z } from 'zod'

/** Every route can answer these. 404 is added only where a path parameter can miss. */
export const PROBLEM_RESPONSES = {
  400: ProblemSchema,
  500: ProblemSchema,
} as const

export const PROBLEM_RESPONSES_WITH_404 = {
  400: ProblemSchema,
  404: ProblemSchema,
  500: ProblemSchema,
} as const

export function ok200<T extends z.ZodType>(schema: T): { 200: T } & typeof PROBLEM_RESPONSES {
  return { 200: schema, ...PROBLEM_RESPONSES }
}

export function ok200WithNotFound<T extends z.ZodType>(
  schema: T,
): { 200: T } & typeof PROBLEM_RESPONSES_WITH_404 {
  return { 200: schema, ...PROBLEM_RESPONSES_WITH_404 }
}

export function created201<T extends z.ZodType>(schema: T): { 201: T } & typeof PROBLEM_RESPONSES {
  return { 201: schema, ...PROBLEM_RESPONSES }
}
