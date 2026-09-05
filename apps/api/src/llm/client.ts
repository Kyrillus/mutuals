/**
 * The task client: one prompt in, one validated value out (ADR-064, ADR-066, ADR-068).
 *
 * Everything that makes an LLM call safe to run in a product happens here rather than in a route:
 * the model is resolved from the database, the structured output is requested strictly *and*
 * re-validated with the same Zod schema, exactly one repair round-trip is spent on a schema
 * failure, every exchange is traced, and the mode switch decides whether a socket is opened at
 * all. A route calls `run()` and gets a value of the prompt's output type or an `LlmError`.
 *
 * `strict: true` is asked for and never trusted. OpenRouter documents that exact compliance is not
 * guaranteed on every endpoint, so the response is parsed and validated whatever the request said —
 * which also means the repair path is reachable in practice and not theatre.
 */
import { todayIn } from '@mutuals/core'
import type { Executor } from '@mutuals/db'

import type { Env } from '../env.ts'
import { CostBudget } from './budget.ts'
import { LlmDisabledError, LlmSchemaError, LlmError } from './errors.ts'
import { outputJsonSchema, schemaNameOf, type PromptSpec } from './prompts/spec.ts'
import { readFixture } from './replay.ts'
import { modelFor } from './settings.ts'
import { inputHash, promptTemplateHash, recordCall, type TraceRow } from './trace.ts'
import { OpenAiCompatibleProvider } from './transport.ts'
import type { ChatMessage, ChatProvider, ChatResponse, Usage } from './types.ts'

export interface RunOptions {
  readonly signal?: AbortSignal
  /** §6.5's summary is about one contact; the trace row says which. */
  readonly recordId?: string | null
  /** Correlates the trace with the HTTP access log. */
  readonly requestId?: string | null
  readonly workspaceId?: string | null
  /** ADR-045: the profile's zone decides which civil day the cost cap is counting. */
  readonly timeZone: string
}

export interface RunResult<T> {
  readonly value: T
  /** The `llm_call` row, so a caller can show "how I searched" against a real trace. */
  readonly callId: string | null
  readonly model: string
  readonly usage: Usage
  /** True when a schema repair was needed — surfaced in the trace, not in the UI. */
  readonly repaired: boolean
}

export interface LlmClientOptions {
  readonly env: Env
  readonly now: () => Date
  /** Shared across requests so two concurrent calls cannot each spend the whole cap. */
  readonly budget?: CostBudget
  /** Injected by the fixture provider in tests (ADR-072's L2). */
  readonly provider?: ChatProvider
  readonly onTraceError?: (error: unknown) => void
}

/** What a caller needs to know before offering the feature at all. */
export interface LlmAvailability {
  readonly enabled: boolean
  readonly mode: Env['LLM_MODE']
  readonly reason: string | null
}

export class LlmClient {
  readonly #env: Env
  readonly #now: () => Date
  readonly #budget: CostBudget
  readonly #injectedProvider: ChatProvider | undefined
  readonly #onTraceError: ((error: unknown) => void) | undefined

  constructor(options: LlmClientOptions) {
    this.#env = options.env
    this.#now = options.now
    this.#budget = options.budget ?? new CostBudget()
    this.#injectedProvider = options.provider
    this.#onTraceError = options.onTraceError
  }

  get budget(): CostBudget {
    return this.#budget
  }

  /**
   * Whether an LLM task can run, and the sentence to show when it cannot.
   *
   * A missing key is not an error state to discover mid-request: `pnpm dev` on a fresh checkout has
   * no key, the whole rest of the app works, and the dashboard should say so before the user types
   * a question rather than after.
   */
  availability(): LlmAvailability {
    if (this.#env.LLM_MODE === 'off') {
      return { enabled: false, mode: 'off', reason: 'AI features are switched off (LLM_MODE=off).' }
    }
    if (this.#injectedProvider !== undefined || this.#env.LLM_MODE === 'replay') {
      return { enabled: true, mode: this.#env.LLM_MODE, reason: null }
    }
    if (this.#env.OPENROUTER_API_KEY === undefined) {
      return {
        enabled: false,
        mode: this.#env.LLM_MODE,
        reason:
          'AI features need an OpenRouter API key. Put one in OPENROUTER_API_KEY and restart the server.',
      }
    }
    return { enabled: true, mode: this.#env.LLM_MODE, reason: null }
  }

  async run<TInput, TOutput>(
    exec: Executor,
    spec: PromptSpec<TInput, TOutput>,
    input: TInput,
    options: RunOptions,
  ): Promise<RunResult<TOutput>> {
    const availability = this.availability()
    if (!availability.enabled) throw new LlmDisabledError(availability.reason ?? 'Disabled.')

    const model = await modelFor(exec, this.#env, spec.taskKind)
    const messages = spec.render(input)
    const trace = {
      taskKind: spec.taskKind,
      promptId: spec.id,
      promptVersion: spec.version,
      // The prompt *template* hash: constant per version, so the five-part replay key stays
      // coherent. `input_hash` is what varies per call (ADR-068).
      promptHash: promptTemplateHash(spec.render(spec.sample)),
      inputHash: inputHash(input),
      modelRequested: model,
      recordId: options.recordId ?? null,
      requestId: options.requestId ?? null,
      workspaceId: options.workspaceId ?? null,
    } as const

    const first = await this.#exchange(exec, spec, messages, trace, options, 1, null)
    if (first.ok) return this.#result(first, model, false)

    /**
     * ADR-066's one repair, and only one. The failed answer and the validator's complaint go back
     * as two more turns rather than as a re-render, so the repair works for every prompt rather
     * than only for the ones whose input type happens to carry a `problems` field.
     */
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.raw },
      {
        role: 'user',
        content:
          'That did not match the required schema. Fix exactly these problems and return the ' +
          `whole JSON object again:\n${first.issues.map((issue) => `- ${issue}`).join('\n')}`,
      },
    ]

    const second = await this.#exchange(exec, spec, repairMessages, trace, options, 2, first.callId)
    if (second.ok) return this.#result(second, model, true)

    throw new LlmSchemaError(
      'The model did not answer in the required shape, twice. Try again in a moment.',
      second.issues,
    )
  }

  #result<TOutput>(
    exchange: SuccessfulExchange<TOutput>,
    model: string,
    repaired: boolean,
  ): RunResult<TOutput> {
    return {
      value: exchange.value,
      callId: exchange.callId,
      model,
      usage: exchange.usage,
      repaired,
    }
  }

  /** One request/response pair: send, trace, validate, trace the verdict. */
  async #exchange<TInput, TOutput>(
    exec: Executor,
    spec: PromptSpec<TInput, TOutput>,
    messages: readonly ChatMessage[],
    trace: Omit<TraceRow, 'provider' | 'baseUrl' | 'status'>,
    options: RunOptions,
    attempt: number,
    repairOfId: string | null,
  ): Promise<Exchange<TOutput>> {
    const provider = this.#provider(exec, options)
    const request = {
      model: trace.modelRequested,
      messages,
      schemaName: schemaNameOf(spec),
      schema: outputJsonSchema(spec),
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    }

    let response: ChatResponse
    try {
      response =
        this.#env.LLM_MODE === 'replay' && this.#injectedProvider === undefined
          ? await readFixture({
              promptId: spec.id,
              promptVersion: spec.version,
              promptHash: trace.promptHash,
              modelRequested: trace.modelRequested,
              inputHash: trace.inputHash,
            })
          : await provider.complete(request, options.signal)
    } catch (error) {
      // Even a failure is a trace row: a 429 that was never recorded is a cost cap that cannot be
      // explained afterwards, and a timeout that was never recorded looks like nothing happened.
      await this.#trace(exec, {
        ...trace,
        provider: provider.name,
        baseUrl: provider.baseUrl,
        status: error instanceof LlmError ? error.callStatus : 'http_error',
        httpStatus: error instanceof LlmError ? (asHttpStatus(error) ?? null) : null,
        attempt,
        repairOfId,
        requestBody: request,
        errorDetail: { message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }

    this.#budget.record(response.usage.costUsd)

    const parsed = parseJson(response.content)
    const validated = parsed.ok ? spec.output.safeParse(parsed.value) : null

    const base = {
      ...trace,
      provider: provider.name,
      baseUrl: provider.baseUrl,
      attempt,
      repairOfId,
      requestBody: request,
      responseBody: response.responseBody,
      modelServed: response.modelServed,
      upstreamProvider: response.upstreamProvider,
      generationId: response.generationId,
      httpStatus: response.httpStatus,
      usage: response.usage,
      latencyMs: response.latencyMs,
    }

    if (validated?.success === true) {
      const callId = await this.#trace(exec, {
        ...base,
        status: 'ok',
        parsed: validated.data,
      })
      return { ok: true, value: validated.data, callId, usage: response.usage }
    }

    const issues = parsed.ok
      ? (validated?.error.issues ?? []).map(
          (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
        )
      : ['the answer was not JSON at all']

    const callId = await this.#trace(exec, {
      ...base,
      status: parsed.ok ? 'schema_error' : 'invalid_json',
      errorDetail: { issues, content: response.content.slice(0, 4000) },
    })

    return { ok: false, raw: response.content, issues, callId, usage: response.usage }
  }

  #trace(exec: Executor, row: TraceRow): Promise<string | null> {
    return recordCall(exec, row, {
      traceBodies: this.#env.LLM_TRACE_BODIES === 'on',
      ...(this.#onTraceError === undefined ? {} : { onError: this.#onTraceError }),
    })
  }

  /**
   * The provider for this call.
   *
   * Built per call rather than once, because the budget gate closes over the executor and the
   * profile's timezone — and the cap has to be checked against *this* request's day, immediately
   * before each POST, including every retry (ADR-070).
   *
   * An injected provider gets the same gate through {@link budgeted}. Only the built-in transport
   * can enforce "once per HTTP POST", because only it knows how many POSTs one call becomes; a
   * double that skipped the gate entirely would make the cap untestable at the route level, which
   * is exactly where it is worth testing. There is no double-check: the transport branch passes the
   * gate down and the injected branch wraps, never both.
   */
  #provider(exec: Executor, options: RunOptions): ChatProvider {
    const gate = async (): Promise<void> => {
      const now = this.#now()
      await this.#budget.assertWithinBudget(exec, {
        today: todayIn(options.timeZone, now),
        timeZone: options.timeZone,
        limitUsd: this.#env.LLM_DAILY_COST_LIMIT_USD,
        now,
      })
    }

    if (this.#injectedProvider !== undefined) return budgeted(this.#injectedProvider, gate)

    return new OpenAiCompatibleProvider({
      baseUrl: this.#env.LLM_BASE_URL,
      apiKey: this.#env.OPENROUTER_API_KEY ?? '',
      totalTimeoutMs: this.#env.LLM_TOTAL_TIMEOUT_MS,
      attemptTimeoutMs: this.#env.LLM_ATTEMPT_TIMEOUT_MS,
      beforeRequest: gate,
    })
  }
}

/** The cost gate in front of a provider that does not take one itself. */
function budgeted(inner: ChatProvider, gate: () => Promise<void>): ChatProvider {
  return {
    name: inner.name,
    baseUrl: inner.baseUrl,
    complete: async (request, signal) => {
      await gate()
      return inner.complete(request, signal)
    },
  }
}

interface SuccessfulExchange<T> {
  readonly ok: true
  readonly value: T
  readonly callId: string | null
  readonly usage: Usage
}

interface FailedExchange {
  readonly ok: false
  readonly raw: string
  readonly issues: readonly string[]
  readonly callId: string | null
  readonly usage: Usage
}

type Exchange<T> = SuccessfulExchange<T> | FailedExchange

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function asHttpStatus(error: LlmError): number | null {
  const candidate = (error as { httpStatus?: unknown }).httpStatus
  return typeof candidate === 'number' ? candidate : null
}
