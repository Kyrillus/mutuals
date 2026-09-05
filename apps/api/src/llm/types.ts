/**
 * The provider ports (ADR-064, ADR-069).
 *
 * Two of them, not one. A chat completion and an embedding differ in every dimension that matters
 * — request shape, response shape, pricing, and which vendor is even good at it — and §3.1 already
 * anticipates embeddings coming from a second provider. One interface with an unused half is how
 * that ends up being discovered at the worst moment.
 *
 * Nothing here mentions OpenRouter. `transport.ts` is the one file that does.
 */

/** `llm_call.task_kind`. Mirrors migration 0006's CHECK. */
export const TASK_KINDS = ['extraction', 'question', 'summary', 'embedding'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/**
 * What the transport is asked for. `schema` is a JSON Schema object, already walked and hardened
 * by `json-schema.ts` — the transport never sees a Zod type, which is what keeps it a transport.
 */
export interface ChatRequest {
  readonly model: string
  readonly messages: readonly ChatMessage[]
  readonly schemaName: string
  readonly schema: Readonly<Record<string, unknown>>
  readonly temperature?: number
  readonly maxTokens?: number
}

/**
 * What the provider reports it cost.
 *
 * `costUsd` is `null` with source `unreported` when the provider says nothing — an honest gap,
 * rather than an estimate from a price table nobody refreshes (ADR-070).
 */
export interface Usage {
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly reasoningTokens: number | null
  readonly cachedTokens: number | null
  readonly costUsd: number | null
  readonly costSource: 'reported' | 'unreported' | 'free'
}

export interface ChatResponse {
  /** The assistant message's content, verbatim. Parsing it is the client's job, not the transport's. */
  readonly content: string
  readonly usage: Usage
  /** `response.model`: a gateway may serve a variant of what was asked for. */
  readonly modelServed: string | null
  readonly upstreamProvider: string | null
  readonly generationId: string | null
  readonly httpStatus: number
  readonly latencyMs: number
  /** The bytes, for the trace. Written to `llm_call` only when `LLM_TRACE_BODIES=on`. */
  readonly requestBody: unknown
  readonly responseBody: unknown
}

export interface ChatProvider {
  readonly name: string
  readonly baseUrl: string
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
}

// -- Embeddings (ADR-069) ------------------------------------------------------------------------

export interface EmbeddingRequest {
  readonly model: string
  readonly input: readonly string[]
}

export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[]
  readonly usage: Usage
  readonly modelServed: string | null
}

/**
 * Phase 1 ships this typed and one fixture test, and nothing else (ADR-069). The dimension probe,
 * the never-mix-models guard and the fallback ladder arrive in Stage 8, where a vector is about to
 * be written and those checks have something to protect.
 */
export interface EmbeddingProvider {
  readonly name: string
  readonly baseUrl: string
  readonly dimensions: number
  embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse>
}
