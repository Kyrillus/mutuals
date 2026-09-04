/**
 * A filter, as a sentence: `Job role is one of Investor, Angel` (§5.2).
 *
 * Pure, and separate from the chip that renders it, because the same words are needed in three
 * places with three different shapes: the chip itself (option values as coloured chips), its
 * `title`/tooltip (one flat string, so a truncated chip is still readable) and — from Stage 6 —
 * the "How I searched" panel the LLM answer opens.
 *
 * Values are strings on the wire (ADR-032): an option arrives as its stable key, a relation as a
 * record id, a date as `2026-03-01`. Turning those back into something a person recognises is the
 * job of the resolved field plus the two lookups in {@link SentenceContext}, and it is why an
 * option renamed last week reads correctly in a filter saved last month.
 */
import {
  activeOptions,
  fieldValueKind,
  findOptionByKey,
  type AttributeOption,
  type FieldDescriptor,
  type Filter,
} from '@mutuals/core'

import { RELATIVE_PRESET_LABELS, operatorLabel, operatorNote, unitLabel } from './operators.ts'

export interface ValueToken {
  readonly text: string
  /** A design-system colour token when the value is a select option, otherwise null. */
  readonly color: string | null
  /** Options, tags and relations read as chips; text, numbers and dates read as plain words. */
  readonly asChip: boolean
}

export interface FilterSentence {
  readonly fieldLabel: string
  readonly operator: string
  readonly values: readonly ValueToken[]
  /** `, ` between set members, ` and ` between the two ends of a range. */
  readonly separator: string
  /** `ago`, for the two relative operators that read as a distance backwards from today. */
  readonly suffix: string | null
  /** ADR-017's explanation, where the operator has one. */
  readonly note: string | null
  /** The whole sentence, flat. */
  readonly text: string
  /** The slug is in the URL but no longer in the schema — an attribute deleted since the link. */
  readonly unknownField: boolean
}

export interface SentenceContext {
  /**
   * `2026-03-01` as a person reads it. Injected rather than imported: this module stays pure and
   * dependency-free, and the caller already holds the profile's locale (ADR-045) that decides
   * whether that is `1 Mar 2026` or `Mar 1, 2026`.
   */
  readonly formatDate?: (civil: string) => string
  /** Record id → display label, for `relation` values. Missing ids fall back to the raw id. */
  readonly recordLabels?: ReadonlyMap<string, string>
}

const PLAIN: Pick<ValueToken, 'color' | 'asChip'> = { color: null, asChip: false }

function optionToken(field: FieldDescriptor, raw: string): ValueToken | undefined {
  if (field.source.kind !== 'attribute') return undefined
  const options = field.source.def.options ?? []
  if (options.length === 0) return undefined
  const option = findOptionByKey(options, raw)
  // An option that no longer exists still has to render: the filter is what the user saved.
  return { text: option?.label ?? raw, color: option?.color ?? null, asChip: true }
}

function valueToken(
  field: FieldDescriptor | undefined,
  raw: string,
  context: SentenceContext,
): ValueToken {
  if (field === undefined) return { text: raw, ...PLAIN }

  const option = optionToken(field, raw)
  if (option !== undefined) return option

  const kind = fieldValueKind(field)
  if (kind === 'relation') {
    return { text: context.recordLabels?.get(raw) ?? raw, color: null, asChip: true }
  }
  if (kind === 'date') return { text: context.formatDate?.(raw) ?? raw, ...PLAIN }
  // `tags` has no option table, so its values are the strings themselves — still chips, because
  // that is how a tag reads everywhere else in the product.
  if (field.source.kind === 'attribute' && field.source.def.type === 'tags') {
    return { text: raw, color: null, asChip: true }
  }
  return { text: raw, ...PLAIN }
}

/** The options a picker offers for this field, or an empty list for a field that has none. */
export function fieldOptions(field: FieldDescriptor): readonly AttributeOption[] {
  if (field.source.kind !== 'attribute') return []
  return activeOptions(field.source.def.options ?? [])
}

export function describeFilter(
  filter: Filter,
  field: FieldDescriptor | undefined,
  context: SentenceContext,
): FilterSentence {
  const token = (raw: string) => valueToken(field, raw, context)

  let values: readonly ValueToken[] = []
  let separator = ', '
  let suffix: string | null = null

  switch (filter.op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      values = [token(filter.value)]
      break
    case 'between':
      values = [token(filter.from), token(filter.to)]
      separator = ' and '
      break
    case 'in_relative':
      values = [{ text: RELATIVE_PRESET_LABELS[filter.preset], ...PLAIN }]
      break
    case 'older_than':
    case 'newer_than':
      values = [{ text: `${String(filter.n)} ${unitLabel(filter.unit, filter.n)}`, ...PLAIN }]
      suffix = 'ago'
      break
    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      values = filter.values.map(token)
      break
    case 'is_empty':
    case 'is_not_empty':
    case 'is_yes':
    case 'is_no':
      break
  }

  const fieldLabel = field?.label ?? filter.field
  const operator = operatorLabel(filter.op)
  const spoken = values.map((value) => value.text).join(separator)
  const text = [fieldLabel, operator, spoken, suffix]
    .filter((part) => part !== null && part !== '')
    .join(' ')

  return {
    fieldLabel,
    operator,
    values,
    separator,
    suffix,
    note: operatorNote(filter.op) ?? null,
    text,
    unknownField: field === undefined,
  }
}
