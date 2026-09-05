/**
 * The four ways an LLM task fails, and why there are four rather than one.
 *
 * Each maps to a different problem `type` and a different sentence in the UI, because the user's
 * next move differs every time: turn the feature on, wait until tomorrow, try again, or report a
 * provider that is not honouring its own contract (ADR-065, ADR-070). Collapsing them into one
 * "the AI failed" would throw that away — and the one that matters most is the budget, which is
 * not a failure at all but the circuit breaker doing its job.
 */

/** The status written to `llm_call.status`. Mirrors migration 0006's CHECK. */
export type LlmCallStatus =
  'ok' | 'invalid_json' | 'schema_error' | 'http_error' | 'timeout' | 'budget_exceeded' | 'disabled'

export abstract class LlmError extends Error {
  /** The problem `type` slug this becomes at the HTTP boundary. */
  abstract readonly code: string
  abstract readonly status: number
  /** What `llm_call.status` records for the call that produced it. */
  abstract readonly callStatus: LlmCallStatus
}

/** `LLM_MODE=off`, or live mode with no API key. 503: the feature is switched off, not broken. */
export class LlmDisabledError extends LlmError {
  override readonly name = 'LlmDisabledError'
  readonly code = 'llm_disabled'
  readonly status = 503
  readonly callStatus = 'disabled' as const
}

/**
 * The day's cost limit is reached (ADR-070). 429, because it is a rate limit in every sense a
 * client cares about: the same request will work later, and nothing about it was wrong.
 */
export class LlmBudgetError extends LlmError {
  override readonly name = 'LlmBudgetError'
  readonly code = 'llm_budget_exceeded'
  readonly status = 429
  readonly callStatus = 'budget_exceeded' as const
  readonly spentUsd: number
  readonly limitUsd: number

  constructor(detail: string, spentUsd: number, limitUsd: number) {
    super(detail)
    this.spentUsd = spentUsd
    this.limitUsd = limitUsd
  }
}

/**
 * The provider could not be reached, timed out, or answered with an error status. 504, because
 * from the client's side this API is a gateway and the thing behind it did not answer.
 */
export class LlmTransportError extends LlmError {
  override readonly name = 'LlmTransportError'
  readonly code = 'llm_unavailable'
  readonly status = 504
  readonly callStatus: LlmCallStatus
  readonly httpStatus: number | null

  constructor(
    message: string,
    init: { callStatus?: LlmCallStatus; httpStatus?: number | null; cause?: unknown } = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.callStatus = init.callStatus ?? 'http_error'
    this.httpStatus = init.httpStatus ?? null
  }
}

/**
 * The provider answered, and the answer is not the shape it was asked for — twice, because one
 * repair round-trip has already been spent (ADR-066). 502: the upstream response is invalid.
 */
export class LlmSchemaError extends LlmError {
  override readonly name = 'LlmSchemaError'
  readonly code = 'llm_invalid_response'
  readonly status = 502
  readonly callStatus: LlmCallStatus
  /** Zod's own report, so the trace row says exactly which field was wrong. */
  readonly issues: readonly string[]

  constructor(
    message: string,
    issues: readonly string[],
    callStatus: LlmCallStatus = 'schema_error',
  ) {
    super(message)
    this.issues = issues
    this.callStatus = callStatus
  }
}

/** A missing replay fixture. Its message carries the command that records one (ADR-068). */
export class LlmFixtureMissingError extends LlmError {
  override readonly name = 'LlmFixtureMissingError'
  readonly code = 'llm_unavailable'
  readonly status = 504
  readonly callStatus = 'http_error' as const
}
