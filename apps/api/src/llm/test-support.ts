/**
 * ADR-072's layer 2: a `ChatProvider` that answers from a script, and never opens a socket.
 *
 * The interesting cases cannot be produced reliably against a live model — repair succeeds, repair
 * fails with two rows linked by `repair_of_id`, schema-valid but domain-invalid slug rejected by
 * core, budget exceeded, `LLM_MODE=off`. Every one of them is one line here. That is the whole
 * argument for the port existing.
 *
 * This lives in `src/` rather than in a `test-support/` folder because the fixture provider *is*
 * an implementation of the module's own port, and a second copy in every test file is how the
 * double drifts from the interface it doubles (ADR-100's queue double is the cautionary tale).
 */
import { LlmTransportError } from './errors.ts'
import type { ChatProvider, ChatRequest, ChatResponse, Usage } from './types.ts'

export const FREE_USAGE: Usage = {
  promptTokens: 120,
  completionTokens: 40,
  reasoningTokens: null,
  cachedTokens: null,
  costUsd: 0.000_12,
  costSource: 'reported',
}

/** One scripted turn. `content` is the assistant message *verbatim*, so a malformed one is testable. */
export type ScriptedTurn =
  | { readonly kind: 'content'; readonly content: string; readonly usage?: Usage }
  | { readonly kind: 'error'; readonly error: Error }

export function answers(value: unknown, usage: Usage = FREE_USAGE): ScriptedTurn {
  return { kind: 'content', content: JSON.stringify(value), usage }
}

export function answersRaw(content: string, usage: Usage = FREE_USAGE): ScriptedTurn {
  return { kind: 'content', content, usage }
}

export function failsWith(error: Error): ScriptedTurn {
  return { kind: 'error', error }
}

/**
 * Plays a script, one turn per `complete()`, and records what it was asked.
 *
 * Running out of turns throws rather than repeating the last one: a test that makes three calls
 * when it scripted two is a test whose expectations have quietly drifted, and repeating would hide
 * exactly the repair-loop bug this class exists to catch.
 */
export class ScriptedProvider implements ChatProvider {
  readonly name = 'scripted'
  readonly baseUrl = 'https://scripted.invalid/api/v1'
  readonly requests: ChatRequest[] = []
  #turns: ScriptedTurn[]

  constructor(turns: readonly ScriptedTurn[] = []) {
    this.#turns = [...turns]
  }

  /** Queue what the next call should answer. The integration app holds one of these per process. */
  script(...turns: readonly ScriptedTurn[]): this {
    this.#turns.push(...turns)
    return this
  }

  /** Between tests: no leftover turns, no leftover requests. */
  reset(): void {
    this.#turns = []
    this.requests.length = 0
  }

  complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request)
    const turn = this.#turns.shift()
    if (turn === undefined) {
      throw new Error(
        `ScriptedProvider ran out of turns on call ${String(this.requests.length)}. ` +
          'Script every call the test expects, so an extra one fails loudly.',
      )
    }
    if (turn.kind === 'error') return Promise.reject(turn.error)

    return Promise.resolve({
      content: turn.content,
      usage: turn.usage ?? FREE_USAGE,
      modelServed: request.model,
      upstreamProvider: 'scripted',
      generationId: `gen-${String(this.requests.length)}`,
      httpStatus: 200,
      latencyMs: 3,
      requestBody: { model: request.model, schemaName: request.schemaName },
      responseBody: { choices: [{ message: { content: turn.content } }] },
    })
  }
}

/** A provider that is always down, for the 504 path. */
export class DownProvider implements ChatProvider {
  readonly name = 'down'
  readonly baseUrl = 'https://down.invalid/api/v1'

  complete(): Promise<ChatResponse> {
    return Promise.reject(
      new LlmTransportError('The model provider did not answer.', { callStatus: 'timeout' }),
    )
  }
}
