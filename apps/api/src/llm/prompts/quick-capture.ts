/**
 * §4.8's quick capture: one sentence in, a proposed contact, organization, interaction and
 * follow-up out.
 *
 * The same two properties as the ask prompt, for the same reasons. It emits **slugs and values**
 * and has no way to name an attribute id or to choose an existing record — matching is
 * `matchDuplicates`, deterministic, run afterwards on what the model extracted (§4.8, ADR-067).
 * And it never decides anything: every field it fills is shown to the user before a row exists.
 *
 * One thing it does that the ask prompt does not: it reports a **confidence per field**. A capture
 * is a guess about a sentence someone typed in a hurry, and "Anna Berger, probably a founder" and
 * "Anna Berger, definitely at Northstar" deserve different treatment in the preview. The ask prompt
 * has no equivalent because a filter is either the right filter or it is not.
 */
import { z } from 'zod'

import { PromptFieldSchema, type PromptField } from './ask-filter.ts'
import type { PromptSpec } from './spec.ts'

export const QuickCaptureInputSchema = z.object({
  text: z.string(),
  /** ADR-034: injected. "Follow up in 3 weeks" is meaningless without it. */
  today: z.string(),
  timeZone: z.string(),
  /** The writable fields of each object type, from the resolver. */
  contactFields: z.array(PromptFieldSchema),
  organizationFields: z.array(PromptFieldSchema),
  /** The closed set of interaction types, so the model cannot invent an eighth. */
  interactionTypes: z.array(z.string()),
  problems: z.array(z.string()),
})

export type QuickCaptureInput = z.output<typeof QuickCaptureInputSchema>

const CaptureFieldSchema = z.object({
  slug: z.string(),
  value: z.string(),
  confidence: z.number(),
})

const CaptureRecordSchema = z.object({
  /** The name as the text gives it. Used for matching and, if new, for the record's label. */
  displayName: z.string(),
  fields: z.array(CaptureFieldSchema),
})

export const QuickCaptureOutputSchema = z.object({
  contact: CaptureRecordSchema.nullable(),
  organization: CaptureRecordSchema.nullable(),
  interaction: z
    .object({
      type: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      /** A civil date, or null for today. Never a time — the text almost never carries one. */
      occurredOn: z.string().nullable(),
    })
    .nullable(),
  followUp: z
    .object({
      title: z.string(),
      dueOn: z.string(),
      notes: z.string().nullable(),
    })
    .nullable(),
  /** Anything in the text that did not fit any of the above, in one short sentence. */
  note: z.string().nullable(),
})

export type QuickCaptureOutput = z.output<typeof QuickCaptureOutputSchema>

function renderField(field: PromptField): string {
  const parts = [field.slug, field.label, field.type]
  if (field.options.length > 0) {
    parts.push(`options: ${field.options.map((option) => option.key).join(', ')}`)
  }
  if (field.isMulti) parts.push('repeatable')
  if (field.relationTarget !== null) parts.push(`names a ${field.relationTarget} by name`)
  return `  ${parts.join(' | ')}`
}

const SYSTEM = `You turn one short note about a meeting into structured proposals for a personal
CRM. Everything you return is shown to the person for confirmation before anything is saved, so
propose what the text supports and nothing more.

Rules.

1. Use only the field slugs listed for each object. There are no other fields. Leave out any field
   the text does not mention — an invented value is worse than a missing one, because the person
   confirming will not know it was invented.
2. Every field carries a confidence between 0 and 1: 1.0 for something stated outright, 0.5 for a
   reasonable inference, below 0.3 for a guess. Be honest; a low number is useful and a wrong 1.0
   is not.
3. Values are plain strings. A date is YYYY-MM-DD. A select value is one of the listed option keys.
   A repeatable field may appear more than once, one value each. A field that names another record
   carries that record's NAME, never an id — the name is looked up for you.
4. displayName is the person's or company's name exactly as the text gives it.
5. The interaction is what happened. Its type must be one of the listed types. Its title is a short
   phrase, not a sentence. Its body is the detail worth keeping, or null. occurredOn is the day it
   happened, or null for today.
6. The follow-up is only for an explicit intention to do something later — "follow up in 3 weeks",
   "send the deck on Monday". Resolve the date against today. If the text names no such intention,
   return null rather than inventing one.
7. note carries anything you could not place, in one short sentence, or null. Do not repeat there
   what you already put in a field.
8. If the text names no person and no company, return null for both. An empty capture is a valid
   answer to a sentence that is not about anyone.`

export const quickCapturePrompt: PromptSpec<QuickCaptureInput, QuickCaptureOutput> = {
  id: 'quick-capture.extract',
  version: 1,
  taskKind: 'extraction',
  input: QuickCaptureInputSchema,
  output: QuickCaptureOutputSchema,
  temperature: 0.1,
  maxTokens: 1600,
  sample: {
    // §4.8's own example, verbatim, so the lock hashes the sentence the brief is written around.
    text: "Met Anna Berger from Northstar Ventures at Bits & Pretzels, she's looking for climate-tech seed deals, follow up in 3 weeks",
    today: '2026-06-15',
    timeZone: 'Europe/Berlin',
    interactionTypes: ['Meeting', 'Call', 'Email', 'Message', 'Intro', 'Event', 'Note'],
    problems: [],
    contactFields: [
      {
        slug: 'first_name',
        label: 'First name',
        type: 'text',
        operators: [],
        options: [],
        isMulti: false,
        relationTarget: null,
      },
      {
        slug: 'last_name',
        label: 'Last name',
        type: 'text',
        operators: [],
        options: [],
        isMulti: false,
        relationTarget: null,
      },
      {
        slug: 'organization',
        label: 'Organization',
        type: 'relation',
        operators: [],
        options: [],
        isMulti: true,
        relationTarget: 'organization',
      },
      {
        slug: 'asks',
        label: 'Asks',
        type: 'tags',
        operators: [],
        options: [],
        isMulti: true,
        relationTarget: null,
      },
      {
        slug: 'how_we_met',
        label: 'How we met',
        type: 'long_text',
        operators: [],
        options: [],
        isMulti: false,
        relationTarget: null,
      },
    ],
    organizationFields: [
      {
        slug: 'name',
        label: 'Name',
        type: 'text',
        operators: [],
        options: [],
        isMulti: false,
        relationTarget: null,
      },
      {
        slug: 'industry',
        label: 'Industry',
        type: 'tags',
        operators: [],
        options: [],
        isMulti: true,
        relationTarget: null,
      },
    ],
  },
  render(input) {
    const repair =
      input.problems.length === 0
        ? ''
        : `\n\nYour previous answer was rejected. Fix exactly these and return the whole answer ` +
          `again:\n${input.problems.map((problem) => `- ${problem}`).join('\n')}`

    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Today is ${input.today} in ${input.timeZone}.\n\n` +
          `contact fields (slug | label | type | notes):\n` +
          `${input.contactFields.map(renderField).join('\n')}\n\n` +
          `organization fields (slug | label | type | notes):\n` +
          `${input.organizationFields.map(renderField).join('\n')}\n\n` +
          `interaction types: ${input.interactionTypes.join(', ')}\n\n` +
          `Note: ${input.text}${repair}`,
      },
    ]
  },
}
