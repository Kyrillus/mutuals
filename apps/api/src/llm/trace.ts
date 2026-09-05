/**
 * One row per call in `llm_call` (ADR-068, migration 0006).
 *
 * A Postgres table rather than JSONL, because the questions worth asking of a trace are joins —
 * what this contact's summary cost, which prompt version produced the answer the user is
 * complaining about — and because a file does not survive `git clean`.
 *
 * **`prompt_hash` is the prompt *template* hash**, identical to the value in `prompts.lock.json`
 * and constant for a prompt version. Migration 0006's comment says "sha256 of the rendered
 * messages"; that was corrected in ADR-068 and the comment is now corrected too. A per-input hash
 * there would vary per call, subsume `input_hash`, and make the five-part replay key incoherent —
 * every row would be its own key and nothing would ever replay.
 */
import { createHash } from 'node:crypto'
import type { Executor } from '@mutuals/db'

import type { LlmCallStatus } from './errors.ts'
import type { ChatMessage, TaskKind, Usage } from './types.ts'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * A stable serialisation: object keys sorted at every depth, so two structurally equal inputs hash
 * the same however they were built. Without it `{a,b}` and `{b,a}` are different calls and replay
 * misses on an input it has already seen.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
  return `{${entries.join(',')}}`
}

/** The template hash: the rendered *sample*, so it moves when the prompt's wording moves. */
export function promptTemplateHash(messages: readonly ChatMessage[]): string {
  return sha256(canonicalJson(messages))
}

export function inputHash(input: unknown): string {
  return sha256(canonicalJson(input))
}

export interface TraceRow {
  readonly taskKind: TaskKind
  readonly promptId: string
  readonly promptVersion: number
  readonly promptHash: string
  readonly inputHash: string
  readonly provider: string
  readonly baseUrl: string
  readonly modelRequested: string
  readonly modelServed?: string | null
  readonly upstreamProvider?: string | null
  readonly generationId?: string | null
  readonly requestBody?: unknown
  readonly responseBody?: unknown
  readonly status: LlmCallStatus
  readonly httpStatus?: number | null
  readonly attempt?: number
  readonly repairOfId?: string | null
  readonly errorDetail?: unknown
  readonly parsed?: unknown
  readonly usage?: Usage
  readonly latencyMs?: number | null
  readonly recordId?: string | null
  readonly requestId?: string | null
  readonly workspaceId?: string | null
}

/**
 * `pg` serialises a JS array as a Postgres array literal rather than as JSON, so every jsonb value
 * goes through `JSON.stringify` on the way in. This cost an afternoon once already, in `views.ts`.
 */
function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/**
 * Writes one trace row and returns its id, so a repair can point at what it repaired.
 *
 * Failure to trace never fails the task: the row is a record of work that has already been paid
 * for, and losing it is worse than nothing but much better than turning a good answer into a 500.
 * The failure goes to the caller's logger instead.
 */
export async function recordCall(
  exec: Executor,
  row: TraceRow,
  options: { traceBodies: boolean; onError?: (error: unknown) => void },
): Promise<string | null> {
  try {
    const inserted = await exec
      .insertInto('llm_call')
      .values({
        workspace_id: row.workspaceId ?? null,
        task_kind: row.taskKind,
        prompt_id: row.promptId,
        prompt_version: row.promptVersion,
        prompt_hash: row.promptHash,
        input_hash: row.inputHash,
        provider: row.provider,
        base_url: row.baseUrl,
        model_requested: row.modelRequested,
        model_served: row.modelServed ?? null,
        upstream_provider: row.upstreamProvider ?? null,
        generation_id: row.generationId ?? null,
        request_body: options.traceBodies ? jsonb(row.requestBody) : null,
        response_body: options.traceBodies ? jsonb(row.responseBody) : null,
        status: row.status,
        http_status: row.httpStatus ?? null,
        attempt: row.attempt ?? 1,
        repair_of_id: row.repairOfId ?? null,
        error_detail: jsonb(row.errorDetail),
        // The *validated* task output, never the raw text. A row with `parsed` set is a row whose
        // content has been through the production Zod schema.
        parsed: options.traceBodies ? jsonb(row.parsed) : null,
        prompt_tokens: row.usage?.promptTokens ?? null,
        completion_tokens: row.usage?.completionTokens ?? null,
        reasoning_tokens: row.usage?.reasoningTokens ?? null,
        cached_tokens: row.usage?.cachedTokens ?? null,
        cost_usd:
          row.usage?.costUsd === null || row.usage === undefined ? null : String(row.usage.costUsd),
        cost_source: row.usage?.costSource ?? null,
        latency_ms: row.latencyMs ?? null,
        record_id: row.recordId ?? null,
        request_id: row.requestId ?? null,
      })
      .returning('id')
      .executeTakeFirst()
    return inserted?.id ?? null
  } catch (error) {
    options.onError?.(error)
    return null
  }
}
