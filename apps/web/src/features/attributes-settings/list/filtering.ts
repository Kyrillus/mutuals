/**
 * §6.7's "Filter and search", evaluated in the browser.
 *
 * Every other table in the product filters in Postgres, because every other table is unbounded.
 * This one is not: `listAttributeDefinitions` answers with the whole set in a single page — tens
 * of rows, by construction — and asking the API to grow a filter compiler for a list that never
 * paginates would buy a round trip and nothing else.
 *
 * What it does *not* do is invent a second filter language. The `Filter` union, the operators and
 * their payloads are `packages/core`'s, the same ones the URL carries and the SQL compiler reads;
 * this file is one more interpreter of them, and it is written against the **value**, not against
 * the field, so it stays correct for a hand-edited `?filter=` that pairs an operator with a column
 * that never offers it.
 *
 * Two deliberate differences from the SQL, both because there is no SQL here to agree with:
 * `equals` and `contains` fold case with `casefoldForDisplay` rather than `mutuals_norm()`, and
 * dates are compared as the calendar days the rows already carry.
 */
import {
  assertNever,
  boundContains,
  casefoldForDisplay,
  compareCivil,
  compareDecimal,
  isCivilDate,
  parseDecimal,
  resolveRelativeDate,
  type AttributeValue,
  type CivilDate,
  type FieldDescriptor,
  type Filter,
  type ListQuery,
} from '@mutuals/core'

// Relative, not `@/`: the unit project resolves no alias, and this module is one the tests
// reach directly.
import type { RecordRow } from '../../../table/record-row.ts'
import { attributeText } from '../../../table/value-text.ts'

function valueOf(row: RecordRow, slug: string): AttributeValue | undefined {
  return row.attributes[slug]
}

function fold(input: string): string {
  return casefoldForDisplay(input)
}

/** The civil day a value denotes, or `null` for a value that is not a day at all. */
function civilOf(value: AttributeValue | undefined): CivilDate | null {
  if (value?.type !== 'date') return null
  return isCivilDate(value.value) ? value.value : null
}

function compareNumberValue(value: AttributeValue | undefined, raw: string): number | null {
  if (value?.type !== 'number') return null
  const bound = parseDecimal(raw)
  if (!bound.ok) return null
  return compareDecimal(value.value, bound.value)
}

/** The option keys, tag texts or record ids a set operator tests membership against. */
function membersOf(value: AttributeValue | undefined): readonly string[] | null {
  if (value === undefined) return null
  switch (value.type) {
    case 'single_select':
      return [value.value.key]
    case 'multi_select':
      return value.value.map((option) => option.key)
    case 'tags':
      return value.value
    case 'relation':
      return value.value.map((record) => record.id)
    default:
      return null
  }
}

/**
 * Whether one row satisfies one filter.
 *
 * A filter whose payload the value cannot answer — `is_yes` on a date, `between` on a select —
 * matches nothing rather than throwing: it is reachable by editing the URL, which makes it user
 * input, and a table that renders nothing is a readable answer to a nonsensical question.
 */
export function matchesFilter(row: RecordRow, filter: Filter, today: CivilDate): boolean {
  const value = valueOf(row, filter.field)

  switch (filter.op) {
    case 'is_empty':
      return value === undefined
    case 'is_not_empty':
      return value !== undefined

    case 'contains':
      return value !== undefined && fold(attributeText(value)).includes(fold(filter.value))
    case 'equals':
      return value !== undefined && fold(attributeText(value)) === fold(filter.value)

    case 'eq':
    case 'neq': {
      const order = compareNumberValue(value, filter.value)
      if (order === null) return false
      return filter.op === 'eq' ? order === 0 : order !== 0
    }
    case 'lt':
    case 'gt': {
      const order = compareNumberValue(value, filter.value)
      if (order === null) return false
      return filter.op === 'lt' ? order < 0 : order > 0
    }

    // The only operator two value kinds share: a number between two numbers, a day between two
    // days. Branching on the value rather than on the field is what keeps both correct.
    case 'between': {
      const day = civilOf(value)
      if (day !== null) {
        if (!isCivilDate(filter.from) || !isCivilDate(filter.to)) return false
        return compareCivil(day, filter.from) >= 0 && compareCivil(day, filter.to) <= 0
      }
      const lower = compareNumberValue(value, filter.from)
      const upper = compareNumberValue(value, filter.to)
      return lower !== null && upper !== null && lower >= 0 && upper <= 0
    }

    case 'before':
    case 'after': {
      const day = civilOf(value)
      if (day === null || !isCivilDate(filter.value)) return false
      const order = compareCivil(day, filter.value)
      return filter.op === 'before' ? order < 0 : order > 0
    }

    case 'in_relative':
    case 'older_than':
    case 'newer_than': {
      const day = civilOf(value)
      if (day === null) return false
      const bound = resolveRelativeDate(filter, today)
      return bound.ok && boundContains(bound.value, day)
    }

    case 'is_yes':
    case 'is_no': {
      if (value?.type !== 'yes_no') return false
      return filter.op === 'is_yes' ? value.value : !value.value
    }

    case 'is_one_of':
    case 'is_not_one_of':
    case 'has_any_of':
    case 'contains_any_of': {
      const members = membersOf(value)
      if (members === null) return filter.op === 'is_not_one_of'
      const hit = members.some((member) => filter.values.includes(member))
      return filter.op === 'is_not_one_of' ? !hit : hit
    }
    case 'contains_all_of': {
      const members = membersOf(value)
      if (members === null) return false
      return filter.values.every((wanted) => members.includes(wanted))
    }

    default:
      return assertNever(filter, 'filter operator')
  }
}

/**
 * §5.2's quick search, over everything the row says.
 *
 * Every value in the row, not a chosen subset: on this page "select" should find the select
 * attributes and "linkedin" should find the field whose slug says so, and naming which columns
 * take part would be the hard-coded column CLAUDE.md forbids.
 */
export function matchesSearch(row: RecordRow, term: string): boolean {
  const needle = fold(term.trim())
  if (needle === '') return true
  return Object.values(row.attributes).some(
    (value) => value !== undefined && fold(attributeText(value)).includes(needle),
  )
}

/**
 * Ordering one column.
 *
 * Selects sort by the option's position — the registry's order for the `Type` column — which is
 * what `single_select`'s `sort: { via: 'option-position' }` says in `packages/core`. Dates are
 * compared as days, so two attributes created the same afternoon tie; ties fall through to the
 * row label, which is stable, visible and the order a person would have picked anyway.
 */
function compareValues(
  a: AttributeValue,
  b: AttributeValue,
  optionOrder: ReadonlyMap<string, number>,
): number {
  if (a.type === 'number' && b.type === 'number') return compareDecimal(a.value, b.value)
  if (a.type === 'date' && b.type === 'date') {
    return isCivilDate(a.value) && isCivilDate(b.value) ? compareCivil(a.value, b.value) : 0
  }
  if (a.type === 'single_select' && b.type === 'single_select') {
    const left = optionOrder.get(a.value.key) ?? Number.MAX_SAFE_INTEGER
    const right = optionOrder.get(b.value.key) ?? Number.MAX_SAFE_INTEGER
    return left - right
  }
  return attributeText(a).localeCompare(attributeText(b), undefined, { sensitivity: 'base' })
}

function optionOrderOf(field: FieldDescriptor | undefined): ReadonlyMap<string, number> {
  if (field?.source.kind !== 'attribute') return new Map()
  return new Map((field.source.def.options ?? []).map((option) => [option.key, option.position]))
}

/**
 * The rows the DataTable is handed: filtered, searched and ordered.
 *
 * The same contract the record table has — the table never filters and never sorts, it renders
 * the array it is given — so the only thing that changes between the two pages is who did the
 * work, Postgres or this function.
 */
export function applyListQuery(
  rows: readonly RecordRow[],
  fields: readonly FieldDescriptor[],
  query: ListQuery,
  today: CivilDate,
): RecordRow[] {
  const matching = rows.filter(
    (row) =>
      query.filter.every((filter) => matchesFilter(row, filter, today)) &&
      (query.q === null || matchesSearch(row, query.q)),
  )

  const sort = query.sort
  if (sort === null) return matching

  const field = fields.find((entry) => entry.slug === sort.field)
  if (field === undefined || !field.sortable) return matching

  const order = optionOrderOf(field)
  const sign = sort.direction === 'desc' ? -1 : 1

  return [...matching].sort((a, b) => {
    const left = a.attributes[sort.field]
    const right = b.attributes[sort.field]

    // Absent sorts last in **both** directions — outside the sign, deliberately. An empty cell is
    // the absence of an answer, not a small one, and reversing the sort to see the largest values
    // should not parade the rows that have none past the user first.
    if (left === undefined || right === undefined) {
      if (left !== undefined) return -1
      if (right !== undefined) return 1
      return byLabel(a, b)
    }

    const primary = compareValues(left, right, order) * sign
    return primary === 0 ? byLabel(a, b) : primary
  })
}

function byLabel(a: RecordRow, b: RecordRow): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
}
