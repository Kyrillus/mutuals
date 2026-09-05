/**
 * RFC 9457 `application/problem+json`, with the per-field `errors` array §7 requires (ADR-031).
 *
 * `type` is a URI that points at an anchor in the repository's `docs/ERRORS.md`. RFC 9457 says the
 * URI need not dereference, and `about:blank` — its default — would throw away the one machine
 * -readable thing a client can branch on, so a real anchor is cheap and honest.
 */
import { z } from 'zod'

import { ISSUE_CODES } from '../result.ts'

export const ERROR_TYPE_BASE = 'https://github.com/Kyrillus/mutuals/blob/main/docs/ERRORS.md'

/**
 * The problem `type` slugs. `ISSUE_CODES` covers everything `packages/core` can report about user
 * input; these are the transport-level ones a handler raises itself.
 */
export const PROBLEM_CODES = [
  'validation_failed',
  'not_found',
  'conflict',
  'unsupported_media_type',
  'payload_too_large',
  'not_implemented',
  'internal_error',
  // -- The LLM layer (§4.8, ADR-065, ADR-070). Four, because a client has four different things
  // to do about them: tell the user the feature is switched off, tell them the day's budget is
  // spent, offer a retry, or report a provider that is not honouring its own contract.
  'llm_disabled',
  'llm_budget_exceeded',
  'llm_unavailable',
  'llm_invalid_response',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]

export function problemType(code: string): string {
  return `${ERROR_TYPE_BASE}#${code}`
}

/**
 * One field-level failure. `field` is a dotted path into the request body or query string
 * (`attributes.city`, `filter.0.value`) so a form can highlight exactly one input.
 */
export const ProblemErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
})

export type ProblemError = z.output<typeof ProblemErrorSchema>

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  /** The request path that produced it. */
  instance: z.string(),
  /** Present on a validation failure; absent otherwise, never an empty array. */
  errors: z.array(ProblemErrorSchema).optional(),
})

export type Problem = z.output<typeof ProblemSchema>

/** Every code a `Problem.errors[].code` can carry: a core issue code, or a transport one. */
export const ALL_ERROR_CODES: readonly string[] = Object.freeze([...ISSUE_CODES, ...PROBLEM_CODES])
