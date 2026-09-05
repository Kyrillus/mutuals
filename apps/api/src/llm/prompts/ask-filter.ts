/**
 * §4.8's "ask the network": one question, one structured filter over the user's own fields.
 *
 * Two properties of this prompt are load-bearing and neither is a matter of wording.
 *
 * **It emits slugs, never ids.** The output type has no attribute-id field and no record-id field,
 * so an id cannot be smuggled through it. Everything the model says is a name the user could have
 * typed, and `tasks/ask.ts` decides what — if anything — that name refers to (§4.8, ADR-067).
 *
 * **It never states a count.** The model returns a noun phrase for what it searched for; the
 * sentence the user reads is composed in code around the real number of rows the filter returned.
 * A model asked to write "I found 12 contacts" before the query has run will sometimes write 12
 * when the answer is 340, and there is no way to tell from the outside which it did (ADR-103).
 *
 * The filter shape here is deliberately **flat and nullable** rather than the discriminated union
 * `packages/core` exports. A strict structured output takes an object with every property required,
 * and a nine-variant union of operator shapes is exactly the construct that is refused or degraded
 * across providers. Flat in, `parseFilterSet` out — so the model's output is *proposed* and core's
 * validator is what decides it is a filter.
 */
import { z } from 'zod'

import type { PromptSpec } from './spec.ts'

export const ASK_OBJECT_TYPES = ['contact', 'organization'] as const

/** One field, as the model is told about it. Slugs and option keys; no ids anywhere. */
export const PromptFieldSchema = z.object({
  slug: z.string(),
  label: z.string(),
  /** The attribute type (`single_select`, `date`, …) or a system column's value kind. */
  type: z.string(),
  operators: z.array(z.string()),
  /** `[{key, label}]` for the two select types, `[]` for everything else. */
  options: z.array(z.object({ key: z.string(), label: z.string() })),
  isMulti: z.boolean(),
  /** The object type a `relation` field points at, so the model knows what a name would name. */
  relationTarget: z.string().nullable(),
})

export type PromptField = z.output<typeof PromptFieldSchema>

export const AskFilterInputSchema = z.object({
  question: z.string(),
  /** ADR-034: today is injected. A relative window resolved against the server's clock is a bug. */
  today: z.string(),
  timeZone: z.string(),
  tables: z.array(
    z.object({
      objectType: z.enum(ASK_OBJECT_TYPES),
      fields: z.array(PromptFieldSchema),
    }),
  ),
  /**
   * The validator's complaints about the previous attempt, on the one repair round-trip ADR-066
   * allows. Empty on the first call.
   */
  problems: z.array(z.string()),
})

export type AskFilterInput = z.output<typeof AskFilterInputSchema>

/**
 * One proposed filter. Every payload field is present and nullable because `strict: true` requires
 * every property in `required` — `.optional()` would be dropped from the schema and the provider
 * would refuse it (ADR-066).
 */
export const ProposedFilterSchema = z.object({
  field: z.string(),
  op: z.string(),
  /** For the one-operand operators. */
  value: z.string().nullable(),
  /** For the set operators. */
  values: z.array(z.string()).nullable(),
  /** For `between`. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** For `in_relative`. */
  preset: z.string().nullable(),
  /** For `older_than` / `newer_than`. */
  n: z.number().nullable(),
  unit: z.string().nullable(),
})

export type ProposedFilter = z.output<typeof ProposedFilterSchema>

export const AskFilterOutputSchema = z.object({
  /** False when the question is not about the network at all, or cannot be expressed. */
  understood: z.boolean(),
  objectType: z.enum(ASK_OBJECT_TYPES),
  filters: z.array(ProposedFilterSchema),
  /**
   * What was searched for, as a noun phrase: `investors in Munich`, `organizations in Berlin`.
   * Lower case, no leading article, no count, no full stop — code writes the sentence around it.
   */
  subject: z.string(),
  /** Present when `understood` is false: one plain sentence saying why. */
  declineReason: z.string().nullable(),
})

export type AskFilterOutput = z.output<typeof AskFilterOutputSchema>

function renderField(field: PromptField): string {
  const parts = [field.slug, field.label, field.type, field.operators.join(' ')]
  if (field.options.length > 0) {
    parts.push(`options: ${field.options.map((o) => `${o.key}=${o.label}`).join(', ')}`)
  }
  if (field.isMulti) parts.push('multi-valued')
  if (field.relationTarget !== null) parts.push(`points at a ${field.relationTarget}`)
  return `  ${parts.join(' | ')}`
}

const SYSTEM = `You turn one question about a personal CRM into a structured filter over that
person's own fields. You never see the data, only the field definitions, and you never answer the
question yourself — a query is run for you and the answer is written around its result.

Rules, in order of importance.

1. Use only the field slugs listed for the table you choose. There are no other fields.
2. Use only an operator that is listed for that field.
3. Return the operator's payload in the matching property and leave every other one null:
   contains, equals, eq, neq, lt, gt, before, after -> value
   between                                          -> from and to
   is_one_of, is_not_one_of, contains_any_of,
   contains_all_of, has_any_of                      -> values
   in_relative                                      -> preset
   older_than, newer_than                           -> n and unit
   is_empty, is_not_empty, is_yes, is_no            -> nothing
4. Value formats. A date is YYYY-MM-DD. A number is a plain decimal string. A single_select or
   multi_select value is the option KEY from the list, never its label. A tags value is the tag
   itself. A relation value is the NAME of the record ("Northstar Ventures"); it is looked up for
   you, so never invent an id.
5. Filters combine with AND only. Fewer filters is better than more: a filter the question did not
   ask for silently hides rows.
6. Relative time. "in the last 30 days" is in_relative with preset last_30_days; "this year" is
   preset this_year. "not in six months" on a date field is older_than n=6 unit=month; "in the last
   three weeks" is newer_than n=21 unit=day. Units are day, month, year.
7. Choose the table the question is about. A question about people is contact; a question about
   companies, funds or universities is organization.
8. If the question is not about this network, or cannot be expressed with these fields, set
   understood to false, return no filters, and say why in declineReason in one plain sentence.
9. subject is a lower-case noun phrase naming what you searched for, with no count and no full
   stop: "investors in Munich", "contacts with no email". Never claim a number.

An empty filter list with understood true means every row of that table, which is a valid answer to
"who do I know" and a wrong answer to anything narrower.`

export const askFilterPrompt: PromptSpec<AskFilterInput, AskFilterOutput> = {
  id: 'ask.filter',
  version: 1,
  taskKind: 'question',
  input: AskFilterInputSchema,
  output: AskFilterOutputSchema,
  // Low but not zero: the job is close to deterministic, and 0 makes some providers degenerate.
  temperature: 0.1,
  maxTokens: 1200,
  sample: {
    question: 'Which investors in Munich have I not spoken to in six months?',
    today: '2026-06-15',
    timeZone: 'Europe/Berlin',
    problems: [],
    tables: [
      {
        objectType: 'contact',
        fields: [
          {
            slug: 'display_name',
            label: 'Name',
            type: 'text',
            operators: ['contains', 'equals', 'is_empty', 'is_not_empty'],
            options: [],
            isMulti: false,
            relationTarget: null,
          },
          {
            slug: 'city',
            label: 'City',
            type: 'short_text',
            operators: ['contains', 'equals', 'is_empty', 'is_not_empty'],
            options: [],
            isMulti: false,
            relationTarget: null,
          },
          {
            slug: 'job_role',
            label: 'Job role',
            type: 'single_select',
            operators: ['is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
            options: [
              { key: 'investor', label: 'Investor' },
              { key: 'founder', label: 'Founder' },
            ],
            isMulti: false,
            relationTarget: null,
          },
          {
            slug: 'last_interaction_at',
            label: 'Last interaction',
            type: 'date',
            operators: ['before', 'after', 'between', 'in_relative', 'older_than', 'newer_than'],
            options: [],
            isMulti: false,
            relationTarget: null,
          },
        ],
      },
    ],
  },
  render(input) {
    const tables = input.tables
      .map(
        (table) =>
          `${table.objectType} fields (slug | label | type | operators | notes):\n` +
          table.fields.map(renderField).join('\n'),
      )
      .join('\n\n')

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
          `Today is ${input.today} in ${input.timeZone}.\n\n${tables}\n\n` +
          `Question: ${input.question}${repair}`,
      },
    ]
  },
}
