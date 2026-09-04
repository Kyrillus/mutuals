/**
 * What each operator is called, what it carries, and the three that need explaining.
 *
 * The *vocabulary* is `@mutuals/core` — `OPERATORS_BY_TYPE` says which operators a field offers
 * and `OPERATOR_SHAPE_BY_ID` says what each one carries. Nothing here re-states either. What it
 * adds is the two things a picker needs on top: English for each operator, and a valid empty
 * filter to start editing from.
 */
import {
  MAX_RELATIVE_N,
  RELATIVE_PRESETS,
  assertNever,
  canonicalFilter,
  fieldValueKind,
  operatorShape,
  shapeOf,
  type FieldDescriptor,
  type Filter,
  type OperatorId,
  type RelativePreset,
  type RelativeUnit,
  type ValueKind,
} from '@mutuals/core'

/**
 * Read as `<field> <operator> <value>`, so each one has to work as the middle of a sentence:
 * "Job role is one of Investor, Angel", "Last interaction is more than 90 days ago".
 *
 * The pairs that mean different things must also *read* differently in the dropdown, which is why
 * `is_yes` is "is yes" rather than "is" with a value of yes — an operator list containing "is"
 * twice is a list nobody can use.
 */
export const OPERATOR_LABELS = {
  contains: 'contains',
  equals: 'is',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  eq: 'is',
  neq: 'is not',
  lt: 'is less than',
  gt: 'is more than',
  between: 'is between',
  before: 'is before',
  after: 'is after',
  in_relative: 'is within',
  older_than: 'is more than',
  newer_than: 'is less than',
  is_yes: 'is yes',
  is_no: 'is no',
  is_one_of: 'is one of',
  is_not_one_of: 'is not one of',
  contains_any_of: 'has any of',
  contains_all_of: 'has all of',
  has_any_of: 'is any of',
} as const satisfies Record<OperatorId, string>

export function operatorLabel(op: OperatorId): string {
  return OPERATOR_LABELS[op]
}

/**
 * ADR-017 settled three operator semantics that Notion and Airtable disagree about, and a user
 * who guesses wrong gets a plausible, wrong set of people. Each one is shown verbatim in the
 * chip's tooltip, which is the whole reason this table exists.
 */
const OPERATOR_NOTES: Partial<Record<OperatorId, string>> = {
  is_empty:
    'Matches records where no value exists. An empty text and a missing value are the same thing here.',
  is_not_empty: 'Matches records that have a value of any kind.',
  neq: 'Matches records that have a number and where it differs. Records with no value are not matched — use “is empty” for those.',
  is_not_one_of:
    'Records with no value are matched too, because “is not one of” reads as the opposite of “is one of”.',
}

export function operatorNote(op: OperatorId): string | undefined {
  return OPERATOR_NOTES[op]
}

export const RELATIVE_PRESET_LABELS = {
  last_30_days: 'the last 30 days',
  this_year: 'this year',
} as const satisfies Record<RelativePreset, string>

export const RELATIVE_UNIT_LABELS = {
  day: ['day', 'days'],
  month: ['month', 'months'],
  year: ['year', 'years'],
} as const satisfies Record<RelativeUnit, readonly [string, string]>

export function unitLabel(unit: RelativeUnit, n: number): string {
  return RELATIVE_UNIT_LABELS[unit][n === 1 ? 0 : 1]
}

/** The starting point for a new chip: valid to *construct*, not necessarily {@link isComplete}. */
export function emptyFilter(field: string, op: OperatorId): Filter {
  switch (op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      return { field, op, value: '' }
    case 'is_empty':
    case 'is_not_empty':
    case 'is_yes':
    case 'is_no':
      return { field, op }
    case 'between':
      return { field, op, from: '', to: '' }
    case 'in_relative':
      return { field, op, preset: RELATIVE_PRESETS[0] }
    case 'older_than':
    case 'newer_than':
      return { field, op, n: 30, unit: 'day' }
    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return { field, op, values: [] }
    default:
      return assertNever(op, 'filter operator')
  }
}

/**
 * Switching operator keeps the payload whenever the two shapes agree, so changing "is one of" to
 * "is not one of" does not make the user pick the same four options again. When they disagree the
 * payload is dropped: there is no honest way to turn two dates into a set of option keys.
 */
export function withOperator(filter: Filter, op: OperatorId): Filter {
  if (filter.op === op) return filter
  const next = emptyFilter(filter.field, op)
  if (shapeOf(filter) !== operatorShape(op)) return next

  switch (next.op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      return 'value' in filter ? { ...next, value: filter.value } : next
    case 'between':
      return 'from' in filter ? { ...next, from: filter.from, to: filter.to } : next
    case 'in_relative':
      return 'preset' in filter ? { ...next, preset: filter.preset } : next
    case 'older_than':
    case 'newer_than':
      return 'n' in filter ? { ...next, n: filter.n, unit: filter.unit } : next
    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return 'values' in filter ? { ...next, values: filter.values } : next
    default:
      return next
  }
}

/**
 * A payload survives a change of field only for these kinds.
 *
 * Every filter value is a string on the wire (ADR-032), so the type system cannot stop `"Munich"`
 * from becoming a date filter's value — the API would answer 400 and the chip would look fine.
 * `option` and `relation` are excluded for the same reason in a different disguise: an option key
 * belongs to one attribute's option list, and a record id to one object type.
 */
const PORTABLE_KINDS: readonly ValueKind[] = ['text', 'number', 'date']

/**
 * Replaces the field, keeping the operator when the new field offers it — and the payload when it
 * still means anything there, so retyping "Munich" is not the price of correcting City to Country.
 */
export function withField(
  filter: Filter,
  field: FieldDescriptor,
  previous: FieldDescriptor | undefined,
): Filter {
  const op = field.operators.includes(filter.op) ? filter.op : (field.operators[0] ?? filter.op)
  const kind = fieldValueKind(field)
  const portable =
    previous !== undefined && PORTABLE_KINDS.includes(kind) && fieldValueKind(previous) === kind
  return portable ? withOperator({ ...filter, field: field.slug }, op) : emptyFilter(field.slug, op)
}

/**
 * Whether a filter is worth sending.
 *
 * Nothing incomplete ever reaches the URL: `?filter=` is validated by the same Zod schema the API
 * uses, so a half-typed `between` would not survive the next page load. The draft lives in the
 * editor's own state until this returns true (ADR-049's third state home).
 */
export function isComplete(filter: Filter): boolean {
  switch (filter.op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      return filter.value.trim() !== ''
    case 'between':
      return filter.from.trim() !== '' && filter.to.trim() !== ''
    case 'older_than':
    case 'newer_than':
      return Number.isInteger(filter.n) && filter.n >= 0 && filter.n <= MAX_RELATIVE_N
    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return filter.values.length > 0
    case 'is_empty':
    case 'is_not_empty':
    case 'is_yes':
    case 'is_no':
    case 'in_relative':
      return true
    default:
      return assertNever(filter, 'filter operator')
  }
}

/**
 * A filter's identity, so the open editor keeps pointing at its own chip.
 *
 * The URL is canonical (ADR-032), which means the set is re-sorted on every commit and a chip's
 * position is not stable across an edit. Its canonical serialisation is.
 */
export function filterKey(filter: Filter): string {
  return JSON.stringify(canonicalFilter(filter))
}

/** Two identical AND conditions are one condition; keeping both would also duplicate a React key. */
export function dedupeFilters(filters: readonly Filter[]): readonly Filter[] {
  const seen = new Set<string>()
  return filters.filter((filter) => {
    const key = filterKey(filter)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
