/**
 * A prompt is a versioned TypeScript module (ADR-067).
 *
 * The typed `render` signature is the whole argument for TypeScript over markdown-with-frontmatter:
 * a template that interpolates a field nobody passes produces `undefined` in the middle of a
 * sentence and no error anywhere. Here it does not compile.
 *
 * The strongest property falls out of the output type rather than out of a review checklist. The
 * ask prompt returns attribute **slugs**; it has no way to name an attribute id, and no way to
 * choose a record. §4.8's "the LLM extracts, code decides" is therefore a compile-time fact.
 */
import type { z } from 'zod'

import { toStrictJsonSchema, type JsonSchemaNode } from '../json-schema.ts'
import type { ChatMessage, TaskKind } from '../types.ts'

export interface PromptSpec<TInput, TOutput> {
  /** Stable across versions; `llm_call.prompt_id`. */
  readonly id: string
  /** Bumped whenever the rendered text changes; `llm_call.prompt_version`. */
  readonly version: number
  readonly taskKind: TaskKind
  readonly input: z.ZodType<TInput>
  readonly output: z.ZodType<TOutput>
  render(input: TInput): readonly ChatMessage[]
  /**
   * A real input, beside the prompt rather than in a fixtures folder.
   *
   * `prompts.lock.json` hashes what `render(sample)` produces, so the lock is over something
   * type-checked and refactorable — a sample in JSON would drift from the input type in silence,
   * which is the failure the lock exists to catch.
   */
  readonly sample: TInput
  readonly temperature?: number
  readonly maxTokens?: number
}

/**
 * A prompt with its type parameters erased, for the registry and the tooling that walks it.
 *
 * Not `PromptSpec<any, any>`. `render` makes `PromptSpec` contravariant in its input, so no
 * concrete spec is assignable to a `PromptSpec<unknown, unknown>` and the usual escape is `any` —
 * which switches type checking off for every consumer of the registry, including the two CLI
 * tools. Erasing to exactly what those consumers need (an id, a version, the output schema, and
 * the *rendered sample*) keeps them checked, and `renderSample` closes over the typed `render` so
 * the sample can never be passed to the wrong prompt.
 */
export interface RegisteredPrompt {
  readonly id: string
  readonly version: number
  readonly taskKind: TaskKind
  readonly output: z.ZodType
  readonly temperature?: number
  readonly maxTokens?: number
  renderSample(): readonly ChatMessage[]
}

export function registered<TInput, TOutput>(spec: PromptSpec<TInput, TOutput>): RegisteredPrompt {
  return {
    id: spec.id,
    version: spec.version,
    taskKind: spec.taskKind,
    output: spec.output,
    ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    renderSample: () => spec.render(spec.sample),
  }
}

/** The name a provider sees for the response schema. Stable, and safe as an identifier. */
export function schemaNameOf(spec: Pick<RegisteredPrompt, 'id' | 'version'>): string {
  return `${spec.id.replace(/[^a-zA-Z0-9_]/g, '_')}_v${String(spec.version)}`
}

export function outputJsonSchema(
  spec: Pick<RegisteredPrompt, 'id' | 'version' | 'output'>,
): JsonSchemaNode {
  return toStrictJsonSchema(spec.output, schemaNameOf(spec))
}
