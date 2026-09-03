import type { z } from 'zod'

/**
 * Anything that can arrive from a CSV, a form, a URL or an LLM returns `Result`; a programmer
 * error throws (ADR-034). A 10 000-row import has to surface every bad row at once, which an
 * exception cannot do, and V8 deoptimises throw-heavy loops besides.
 */

export const ISSUE_CODES = [
  'required',
  'invalid_input',
  'too_long',
  'out_of_range',
  'not_a_number',
  'bad_date',
  'ambiguous_date',
  'invalid_email',
  'invalid_phone',
  'ambiguous_national_number',
  'invalid_linkedin_url',
  'invalid_website',
  'unknown_option',
  'reserved_slug',
  'duplicate_slug',
  'unknown_field',
  'operator_not_allowed',
  'not_sortable',
  'arity_mismatch',
  'malformed_query',
  'repeated_parameter',
  'too_many_filters',
] as const

export type IssueCode = (typeof ISSUE_CODES)[number]

export interface CoreIssue {
  readonly code: IssueCode
  /** Maps to a form field or an import cell, e.g. `['filter', 2, 'value']`. */
  readonly path: readonly (string | number)[]
  /** English, user-facing, no jargon. */
  readonly message: string
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

export type Result<T, E = readonly CoreIssue[]> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: E }

/** Wraps a computed value as a successful `Result`. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

/** Builds one issue. */
export function issue(
  code: IssueCode,
  message: string,
  path: readonly (string | number)[] = [],
  meta?: Readonly<Record<string, string | number | boolean>>,
): CoreIssue {
  return meta === undefined ? { code, message, path } : { code, message, path, meta }
}

/** A failed `Result` carrying a single issue. */
export function fail(
  code: IssueCode,
  message: string,
  path: readonly (string | number)[] = [],
  meta?: Readonly<Record<string, string | number | boolean>>,
): Result<never> {
  return { ok: false, issues: [issue(code, message, path, meta)] }
}

/** A failed `Result` carrying issues that were collected elsewhere. */
export function failWith(issues: readonly CoreIssue[]): Result<never> {
  return { ok: false, issues }
}

/**
 * Unwraps a `Result` the caller has already established is fine. Throws — so it belongs in tests
 * and in code that has just validated the input, never on a path fed by user input.
 */
export function unwrap<T>(result: Result<T>, context = 'value'): T {
  if (result.ok) return result.value
  const detail = result.issues.map((i) => `${i.code}: ${i.message}`).join('; ')
  throw new Error(`Expected an ok ${context}, got: ${detail}`)
}

/** Exhaustiveness guard. Reaching it is a programmer error, so it throws. */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`)
}

/** Translates a Zod failure into the issue shape the API and the import grid render. */
export function issuesFromZodError(
  error: z.ZodError,
  code: IssueCode = 'invalid_input',
): CoreIssue[] {
  return error.issues.map((i) =>
    issue(
      code,
      i.message,
      i.path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment)),
    ),
  )
}
