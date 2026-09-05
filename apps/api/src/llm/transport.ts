/**
 * ~200 lines of `fetch` against an OpenAI-compatible chat-completions endpoint (ADR-065).
 *
 * Not the `openai` SDK, and not the Vercel AI SDK, for one reason each. Two fields this module
 * depends on are typed by neither: `usage.cost`, which is the whole of ADR-070's cost record, and
 * `provider.require_parameters`, which is what restricts routing to endpoints that actually honour
 * `response_format`. Reaching both through an escape hatch is more code than the request itself,
 * and byte-exact replay (ADR-068) then becomes an interception problem rather than a function that
 * returns the bytes.
 *
 * **The timeout is the part to read twice.** The obvious implementation composes
 * `AbortSignal.timeout(t)` per attempt *inside* the retry loop and rethrows only on an HTTP error
 * or the caller's abort — so a timeout satisfies neither branch and a hung provider is retried
 * three times. With a 60-second timeout that is a three-minute "Ask the network". Here the total
 * deadline is created **once, before the loop**, and a deadline that has passed terminates rather
 * than retries.
 */
import { LlmTransportError } from './errors.ts'
import type { ChatProvider, ChatRequest, ChatResponse, Usage } from './types.ts'

/** 409 is deliberately absent: it has no meaning for a chat-completions API (ADR-065). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5_000

export interface TransportOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly totalTimeoutMs: number
  readonly attemptTimeoutMs: number
  /**
   * Run immediately before every billable POST, including each retry and the repair exchange
   * (ADR-070). Throwing here is how the budget stops a retry storm; checking once per task let one
   * user action bill up to six generations.
   */
  readonly beforeRequest?: () => Promise<void> | void
  /** Called with what the provider reported, so a process-local counter can stay current. */
  readonly onUsage?: (usage: Usage) => void
  /** Injected so a test can assert the backoff without waiting for it. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

interface ChoiceMessage {
  readonly content?: unknown
}

interface ProviderResponse {
  readonly id?: unknown
  readonly model?: unknown
  readonly provider?: unknown
  readonly choices?: readonly { readonly message?: ChoiceMessage }[]
  readonly usage?: Readonly<Record<string, unknown>>
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function nested(usage: Readonly<Record<string, unknown>> | undefined, ...path: string[]): unknown {
  let node: unknown = usage
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/**
 * What the provider says it cost.
 *
 * `cost` absent is recorded as `unreported` with a null amount rather than estimated from a cached
 * price table — an estimate that nobody refreshes reads as a fact and is not one (ADR-070). A
 * reported cost of exactly zero is `free`, which is a different thing again and worth telling
 * apart when the daily spend is inspected.
 */
export function readUsage(body: ProviderResponse): Usage {
  const usage = body.usage
  const rawCost = usage?.cost
  const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : null

  return {
    promptTokens: integerOrNull(usage?.prompt_tokens),
    completionTokens: integerOrNull(usage?.completion_tokens),
    reasoningTokens: integerOrNull(nested(usage, 'completion_tokens_details', 'reasoning_tokens')),
    cachedTokens: integerOrNull(nested(usage, 'prompt_tokens_details', 'cached_tokens')),
    costUsd: cost,
    costSource: cost === null ? 'unreported' : cost === 0 ? 'free' : 'reported',
  }
}

/** The body, exactly as it goes on the wire. Exported because ADR-072's L3 asserts on it. */
export function chatRequestBody(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    response_format: {
      type: 'json_schema',
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
    /**
     * ADR-066: restrict routing to endpoints that honour `response_format`. OpenRouter states
     * plainly that exact compliance is not guaranteed on every endpoint, which is also why the
     * response is re-validated whatever this says.
     */
    provider: { require_parameters: true },
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    /**
     * `usage: { include: true }` and `stream_options` are deliberately **not** sent. OpenRouter's
     * documentation records both as deprecated no-ops — full usage comes back regardless — and a
     * no-op parameter in a request body is a claim about the provider that nobody re-checks.
     * ADR-072's contract test asserts this absence, because the natural thing to write is to send
     * it "to be safe".
     */
  }
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly name = 'openrouter'
  readonly baseUrl: string
  readonly #options: TransportOptions
  readonly #fetch: typeof globalThis.fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #now: () => number

  constructor(options: TransportOptions) {
    this.#options = options
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? Date.now
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = chatRequestBody(request)
    // Created once, before the loop. This is the whole correction ADR-065 records.
    const deadline = AbortSignal.timeout(this.#options.totalTimeoutMs)
    const overall = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
    const startedAt = this.#now()
    // Read through a function, not a property: an inline `signal?.aborted` check narrows for the
    // rest of the block, and the second read — inside the catch, after an await — is the one that
    // matters. A caller's abort and a deadline are different failures and must not be conflated.
    const cancelled = (): boolean => signal?.aborted === true

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (deadline.aborted) throw this.#deadlineError(startedAt)
      if (cancelled()) throw new LlmTransportError('The request was cancelled.')

      await this.#options.beforeRequest?.()

      const attemptSignal = AbortSignal.any([
        overall,
        AbortSignal.timeout(this.#options.attemptTimeoutMs),
      ])

      const attemptStartedAt = this.#now()
      let response: Response
      try {
        response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#options.apiKey}`,
            // OpenRouter attributes traffic from these; neither carries user data.
            'http-referer': 'https://github.com/Kyrillus/mutuals',
            'x-title': 'Mutuals',
          },
          body: JSON.stringify(body),
          signal: attemptSignal,
        })
      } catch (error) {
        if (cancelled()) throw new LlmTransportError('The request was cancelled.')
        if (deadline.aborted) throw this.#deadlineError(startedAt)
        // One attempt stalled while the overall deadline still has room: that is what the second
        // timeout is for, and it is retryable.
        if (attempt === MAX_ATTEMPTS) {
          throw new LlmTransportError(
            `The model provider did not answer after ${String(MAX_ATTEMPTS)} attempts.`,
            { callStatus: 'timeout', cause: error },
          )
        }
        await this.#backoff(attempt, null)
        continue
      }

      const text = await response.text()

      if (!response.ok) {
        const retryable = RETRYABLE_STATUSES.has(response.status)
        if (!retryable || attempt === MAX_ATTEMPTS) {
          throw new LlmTransportError(providerMessage(response.status, text), {
            httpStatus: response.status,
            callStatus: 'http_error',
          })
        }
        if (deadline.aborted) throw this.#deadlineError(startedAt)
        await this.#backoff(attempt, response.headers.get('retry-after'))
        continue
      }

      return this.#parse(response, text, body, this.#now() - attemptStartedAt)
    }

    // No `throw lastErr` here. Every path above either returns or throws, and an unreachable throw
    // is a place a future reader looks for behaviour that does not exist (ADR-065).
    throw new LlmTransportError('The model provider did not answer.', { callStatus: 'timeout' })
  }

  #deadlineError(startedAt: number): LlmTransportError {
    const elapsed = Math.round((this.#now() - startedAt) / 1000)
    return new LlmTransportError(
      `The model provider did not answer within ${String(Math.round(this.#options.totalTimeoutMs / 1000))} seconds (gave up after ${String(elapsed)}s).`,
      { callStatus: 'timeout' },
    )
  }

  #parse(response: Response, text: string, requestBody: unknown, latencyMs: number): ChatResponse {
    let parsed: ProviderResponse
    try {
      parsed = JSON.parse(text) as ProviderResponse
    } catch (error) {
      throw new LlmTransportError('The model provider answered with something that is not JSON.', {
        httpStatus: response.status,
        cause: error,
      })
    }

    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new LlmTransportError('The model provider answered with no message content.', {
        httpStatus: response.status,
      })
    }

    const usage = readUsage(parsed)
    this.#options.onUsage?.(usage)

    return {
      content,
      usage,
      modelServed: typeof parsed.model === 'string' ? parsed.model : null,
      upstreamProvider: typeof parsed.provider === 'string' ? parsed.provider : null,
      generationId: typeof parsed.id === 'string' ? parsed.id : null,
      httpStatus: response.status,
      latencyMs,
      requestBody,
      responseBody: parsed,
    }
  }

  /**
   * Full jitter, because equal backoff across concurrent callers reconverges on the same instant —
   * and a `Retry-After` when the provider sent one, because it knows something we do not.
   */
  async #backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const advertised = retryAfter === null ? Number.NaN : Number(retryAfter) * 1000
    const ceiling = Number.isFinite(advertised)
      ? Math.min(advertised, MAX_BACKOFF_MS)
      : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    await this.#sleep(Math.round(this.#random() * ceiling))
  }
}

function providerMessage(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return `The model provider answered ${String(status)}.`
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message !== '') {
      return `The model provider answered ${String(status)}: ${message}`
    }
  } catch {
    // Not JSON. The status alone is more use than a page of HTML.
  }
  return `The model provider answered ${String(status)}.`
}
