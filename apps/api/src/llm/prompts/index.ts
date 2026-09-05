/**
 * Every prompt, by id (ADR-067).
 *
 * The registry is what `pnpm llm:relock` walks and what the golden-schema test iterates, so a
 * prompt that is not listed here has neither a lock entry nor a snapshot — which is the failure
 * this array exists to make impossible.
 */
import { askFilterPrompt } from './ask-filter.ts'
import { registered, type RegisteredPrompt } from './spec.ts'

export const PROMPTS: readonly RegisteredPrompt[] = [registered(askFilterPrompt)]

/**
 * The prompts Stage 6's second half adds: quick capture (§4.8) and the contact summary (§6.5).
 *
 * Written down for the same reason `PLANNED_OPERATIONS` is: the complete surface stays reviewable
 * while half of it does not exist yet, and `prompts.test.ts` asserts the two lists are disjoint so
 * a prompt cannot quietly be registered under a second id.
 */
export const PLANNED_PROMPTS = ['quick-capture.extract', 'contact.summary'] as const

export function promptById(id: string): RegisteredPrompt | undefined {
  return PROMPTS.find((prompt) => prompt.id === id)
}

export * from './spec.ts'
export * from './ask-filter.ts'
