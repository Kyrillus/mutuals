/**
 * `embed()`, typed, with one fixture test and nothing else (ADR-069).
 *
 * §9 asks that the provider interface expose `embed()` now so semantic search can be swapped in
 * later. That is the whole Phase-1 requirement, and it is worth being exact about what is *not*
 * here: the first-use dimension probe (which spends money), the never-mix-models guard,
 * `pnpm llm:reembed` and the three-step fallback ladder all belong in Stage 8, beside the
 * `embeddings.backfill` job, where a vector is about to be written and those checks have something
 * to protect. Building them now means maintaining five guards over a code path nothing calls.
 *
 * **The base URL defaults to OpenAI direct, not OpenRouter.** ADR-069 chose OpenRouter's
 * `/embeddings` on the strength of a live check in Stage 1 that listed 37 embedding models. Re-run
 * on 2026-09-05, `GET https://openrouter.ai/api/v1/models` returns 431 models and **not one** with
 * an embedding output modality; `?category=embedding` returns an empty list. Nothing in Phase 1
 * calls this, so nothing breaks — but the default now points at the fallback ADR-069 itself named
 * as "provably config-only" (same wire format, native 1536 dimensions), and the claim that needed
 * re-checking is recorded rather than repeated. See ADR-104.
 */
import { LlmTransportError } from './errors.ts'
import { readUsage } from './transport.ts'
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from './types.ts'

/** `search_document.embedding` is `vector(1536)`; the two have to agree or nothing indexes. */
export const EMBEDDING_DIMENSIONS = 1536

export interface EmbeddingTransportOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface EmbeddingBody {
  readonly model?: unknown
  readonly data?: readonly { readonly embedding?: unknown; readonly index?: unknown }[]
  readonly usage?: Readonly<Record<string, unknown>>
}

/**
 * An OpenAI-compatible `/embeddings` client.
 *
 * No retry loop and no budget hook, deliberately: nothing calls this in Phase 1, and a retry
 * policy written against a code path with no caller is a policy nobody has ever seen run. Stage 8
 * gets both, together with the backfill job that will actually exercise them.
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-compatible'
  readonly baseUrl: string
  readonly dimensions = EMBEDDING_DIMENSIONS
  readonly #options: EmbeddingTransportOptions
  readonly #fetch: typeof globalThis.fetch

  constructor(options: EmbeddingTransportOptions) {
    this.#options = options
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse> {
    const timeout = AbortSignal.timeout(this.#options.timeoutMs)
    const response = await this.#fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({ model: request.model, input: [...request.input] }),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new LlmTransportError(`The embedding provider answered ${String(response.status)}.`, {
        httpStatus: response.status,
      })
    }

    const body = JSON.parse(text) as EmbeddingBody
    const vectors = (body.data ?? []).map((item) => {
      const embedding = item.embedding
      if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number')) {
        throw new LlmTransportError('The embedding provider answered without a vector.')
      }
      return embedding
    })

    if (vectors.length !== request.input.length) {
      throw new LlmTransportError(
        `Asked for ${String(request.input.length)} embeddings and got ${String(vectors.length)}.`,
      )
    }

    return {
      vectors,
      usage: readUsage(body),
      modelServed: typeof body.model === 'string' ? body.model : null,
    }
  }
}
