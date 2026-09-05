/**
 * §6.5's Summary card: gather the facts, ask for two sentences, cache the answer.
 *
 * The gathering is the part worth reading. The model is handed **rendered** facts — "Organization:
 * Northstar Ventures", not a slug and a slot — so it never sees an id, never sees an attribute
 * type, and cannot ask for anything it was not given. That keeps the whole context one bounded
 * payload rather than a tool-calling loop, which is what makes the cost of this feature knowable
 * in advance (ADR-070).
 *
 * Rendering is a switch over `AttributeValue`, the discriminated union `serializeAttributes`
 * already produces, so a thirteenth attribute type is a compile error here rather than a fact that
 * silently renders as `[object Object]`.
 */
import { assertNever, type AttributeValue, type Attributes } from '@mutuals/core'
import type { Executor, InteractionSummary } from '@mutuals/db'

import type { LlmClient, RunOptions } from '../client.ts'
import { contactSummaryPrompt, type SummaryFact } from '../prompts/contact-summary.ts'

/**
 * How much history the summary is written from.
 *
 * Six interactions and 600 characters each is roughly a page — enough for "what they currently
 * need" to be about the present rather than about 2024, and small enough that the prompt stays
 * around 1,500 tokens whatever the contact's history looks like. A summary of *everything* would
 * cost more for every long-standing relationship, which is exactly the wrong way round.
 */
export const SUMMARY_INTERACTIONS = 6
export const SUMMARY_BODY_CHARS = 600

export interface SummarySource {
  readonly displayName: string
  readonly today: string
  readonly attributes: Attributes
  readonly interactions: readonly InteractionSummary[]
  readonly openFollowUps: readonly { readonly title: string; readonly dueAt: string }[]
}

export interface GeneratedSummary {
  readonly summary: string
  readonly model: string
  readonly promptVersion: number
  readonly callId: string | null
}

/** One attribute, as a sentence fragment a person would recognise. `null` for nothing to say. */
export function renderFact(label: string, value: AttributeValue): SummaryFact | null {
  const text = renderValue(value)
  return text === '' ? null : { label, value: text }
}

function renderValue(value: AttributeValue): string {
  switch (value.type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
      return value.value.trim()
    case 'number':
      return value.unit === undefined ? value.value : `${value.value} ${value.unit}`
    case 'date':
      return value.value
    case 'yes_no':
      return value.value ? 'yes' : 'no'
    case 'single_select':
      return value.value.label
    case 'multi_select':
      return value.value.map((option) => option.label).join(', ')
    case 'tags':
      return value.value.join(', ')
    case 'relation':
      return value.value.map((relation) => relation.label).join(', ')
    default:
      return assertNever(value, 'attribute value')
  }
}

export function summaryFacts(
  attributes: Attributes,
  labelOf: (slug: string) => string,
): readonly SummaryFact[] {
  const facts: SummaryFact[] = []
  for (const [slug, value] of Object.entries(attributes)) {
    if (value === undefined) continue
    const fact = renderFact(labelOf(slug), value)
    if (fact !== null) facts.push(fact)
  }
  return facts
}

export async function generateSummary(
  exec: Executor,
  llm: LlmClient,
  source: SummarySource,
  labelOf: (slug: string) => string,
  options: RunOptions,
): Promise<GeneratedSummary> {
  const run = await llm.run(
    exec,
    contactSummaryPrompt,
    {
      displayName: source.displayName,
      today: source.today,
      problems: [],
      facts: [...summaryFacts(source.attributes, labelOf)],
      interactions: source.interactions.slice(0, SUMMARY_INTERACTIONS).map((one) => ({
        // The day, not the instant: "what they currently need" is a question about weeks, and a
        // timestamp invites the model to write one into the prose.
        occurredOn: one.occurredAt.slice(0, 10),
        type: one.type,
        title: one.title ?? '',
        body: (one.body ?? '').slice(0, SUMMARY_BODY_CHARS),
      })),
      openFollowUps: source.openFollowUps.map((one) => ({ dueOn: one.dueAt, title: one.title })),
    },
    options,
  )

  return {
    // Trimmed here rather than by the card's CSS: an overflowing summary is a scrollbar in a
    // highlights row, and a truncated one at least ends in a full stop.
    summary: run.value.summary.trim(),
    model: run.model,
    promptVersion: contactSummaryPrompt.version,
    callId: run.callId,
  }
}
