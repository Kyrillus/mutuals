/**
 * §6.5's Summary card: "an LLM-generated 2–3 sentence summary of who this person is and what they
 * currently need".
 *
 * The input is assembled by code from the record's own fields, its recent interactions and its open
 * follow-ups — the model is given facts and asked to write, not given a record id and asked to look
 * things up. That is the same boundary as everywhere else, and here it also decides the cost: the
 * whole context is one bounded payload rather than a tool-calling loop of unknown length.
 *
 * The output is one string with a hard sentence budget, because §6.5's card is two lines tall and a
 * summary that overflows it is a scrollbar in a highlights row.
 */
import { z } from 'zod'

import type { PromptSpec } from './spec.ts'

/** One field of the record, already rendered for a person. Slugs never reach the model here. */
export const SummaryFactSchema = z.object({
  label: z.string(),
  value: z.string(),
})

export type SummaryFact = z.output<typeof SummaryFactSchema>

export const ContactSummaryInputSchema = z.object({
  displayName: z.string(),
  today: z.string(),
  facts: z.array(SummaryFactSchema),
  /** Newest first, already trimmed. */
  interactions: z.array(
    z.object({ occurredOn: z.string(), type: z.string(), title: z.string(), body: z.string() }),
  ),
  openFollowUps: z.array(z.object({ dueOn: z.string(), title: z.string() })),
  problems: z.array(z.string()),
})

export type ContactSummaryInput = z.output<typeof ContactSummaryInputSchema>

export const ContactSummaryOutputSchema = z.object({
  /** Two or three sentences. Enforced by the prompt and trimmed by code, never by the card's CSS. */
  summary: z.string(),
})

export type ContactSummaryOutput = z.output<typeof ContactSummaryOutputSchema>

const SYSTEM = `You write a two or three sentence summary of one person in someone's personal CRM,
for the top of that person's page.

Rules.

1. Two sentences, three at the most. This is a card, not a page.
2. Say who they are, then what they currently need or are working on. If the notes say nothing about
   what they need, say what the relationship is instead — do not invent a need.
3. Use only what you are given. Never guess an employer, a location or an interest that is not in
   the facts or the notes.
4. Write plainly, in the third person, without their name in every sentence. No bullet points, no
   headings, no preamble like "Here is a summary".
5. If there is almost nothing to go on, say so in one sentence rather than padding.`

function renderFacts(input: ContactSummaryInput): string {
  if (input.facts.length === 0) return '(no fields filled in)'
  return input.facts.map((fact) => `  ${fact.label}: ${fact.value}`).join('\n')
}

function renderInteractions(input: ContactSummaryInput): string {
  if (input.interactions.length === 0) return '(no interactions logged)'
  return input.interactions
    .map(
      (one) =>
        `  ${one.occurredOn} · ${one.type} · ${one.title}${one.body === '' ? '' : `\n    ${one.body}`}`,
    )
    .join('\n')
}

function renderFollowUps(input: ContactSummaryInput): string {
  if (input.openFollowUps.length === 0) return '(none open)'
  return input.openFollowUps.map((one) => `  due ${one.dueOn}: ${one.title}`).join('\n')
}

export const contactSummaryPrompt: PromptSpec<ContactSummaryInput, ContactSummaryOutput> = {
  id: 'contact.summary',
  version: 1,
  taskKind: 'summary',
  input: ContactSummaryInputSchema,
  output: ContactSummaryOutputSchema,
  // Higher than the other two: this one is writing prose, and 0.1 produces the same four sentence
  // shapes for every contact in the workspace.
  temperature: 0.4,
  maxTokens: 300,
  sample: {
    displayName: 'Anna Berger',
    today: '2026-06-15',
    problems: [],
    facts: [
      { label: 'Organization', value: 'Northstar Ventures' },
      { label: 'Job role', value: 'Investor' },
      { label: 'City', value: 'Munich' },
      { label: 'Asks', value: 'climate-tech seed deals' },
    ],
    interactions: [
      {
        occurredOn: '2026-06-01',
        type: 'Meeting',
        title: 'Coffee at Bits & Pretzels',
        body: 'Looking for climate-tech seed deals, writes €250k–500k tickets.',
      },
    ],
    openFollowUps: [{ dueOn: '2026-06-22', title: 'Send the deck' }],
  },
  render(input) {
    const repair =
      input.problems.length === 0
        ? ''
        : `\n\nYour previous answer was rejected: ${input.problems.join('; ')}`

    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Today is ${input.today}.\n\nPerson: ${input.displayName}\n\n` +
          `Fields:\n${renderFacts(input)}\n\n` +
          `Recent interactions (newest first):\n${renderInteractions(input)}\n\n` +
          `Open follow-ups:\n${renderFollowUps(input)}${repair}`,
      },
    ]
  },
}
