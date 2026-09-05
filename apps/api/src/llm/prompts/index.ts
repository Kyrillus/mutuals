/**
 * Every prompt, by id (ADR-067).
 *
 * The registry is what `pnpm llm:relock` walks and what the golden-schema test iterates, so a
 * prompt that is not listed here has neither a lock entry nor a snapshot — which is the failure
 * this array exists to make impossible.
 */
import { askFilterPrompt } from './ask-filter.ts'
import { contactSummaryPrompt } from './contact-summary.ts'
import { quickCapturePrompt } from './quick-capture.ts'
import { registered, type RegisteredPrompt } from './spec.ts'

export const PROMPTS: readonly RegisteredPrompt[] = [
  registered(askFilterPrompt),
  registered(quickCapturePrompt),
  registered(contactSummaryPrompt),
]

/**
 * Prompts a later stage will add.
 *
 * **Empty as of Stage 6.** All three of §4.8's and §6.5's are registered. The array stays for the
 * same reason `PLANNED_OPERATIONS` does: `prompts.test.ts` asserts the two lists are disjoint, and
 * that guard is what keeps a planned name from quietly becoming a second registered id.
 */
export const PLANNED_PROMPTS = [] as const

export function promptById(id: string): RegisteredPrompt | undefined {
  return PROMPTS.find((prompt) => prompt.id === id)
}

export * from './spec.ts'
export * from './ask-filter.ts'
export * from './contact-summary.ts'
export * from './quick-capture.ts'
