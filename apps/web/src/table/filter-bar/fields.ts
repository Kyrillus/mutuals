/**
 * Which fields the picker offers, and in what order.
 *
 * `+ Add filter` lists **every** filterable field — system columns, derived columns and custom
 * attributes alike — because that is what `FieldDescriptor` is for (ADR-052): a picker that knew
 * `warmth` was special would be the first hard-coded field in the codebase.
 *
 * With sixty attributes the list has to be groupable and searchable, so it is grouped by §4.2's
 * `group` — the same sections §6.5's detail sidebar uses — and ungrouped fields fall under
 * "Details", which is that sidebar's own default.
 */
import { casefoldForDisplay, type FieldDescriptor } from '@mutuals/core'

/** `system.ts` writes it in a comment: fields without a group fall under Details. */
export const DEFAULT_FIELD_GROUP = 'Details'

export interface FieldGroup {
  readonly name: string
  readonly fields: readonly FieldDescriptor[]
}

export function groupNameOf(field: FieldDescriptor): string {
  return field.group ?? DEFAULT_FIELD_GROUP
}

/**
 * A field with no operators cannot be filtered on. Nothing declares an empty list today; the
 * check is here so that adding a display-only column is not also a way to add a dead menu entry.
 */
export function filterableFields(fields: readonly FieldDescriptor[]): readonly FieldDescriptor[] {
  return fields.filter((field) => field.operators.length > 0)
}

/**
 * Groups in first-appearance order, which is the resolver's order: system columns first, then
 * attributes by `position`. Deterministic, and it puts Name and Email above Import batch without
 * anything here knowing either name.
 */
export function groupFields(fields: readonly FieldDescriptor[]): readonly FieldGroup[] {
  const groups = new Map<string, FieldDescriptor[]>()
  for (const field of fields) {
    const name = groupNameOf(field)
    const bucket = groups.get(name)
    if (bucket === undefined) groups.set(name, [field])
    else bucket.push(field)
  }
  return [...groups].map(([name, members]) => ({ name, fields: members }))
}

/**
 * Substring match on the label, the slug and the group name.
 *
 * `casefoldForDisplay` is the display-only fold `packages/core` documents for exactly this — a
 * client-side match inside a list that has already been fetched. It deliberately does not fold
 * accents, and this is not the filter contract: nothing here is compared against a database
 * column.
 */
export function matchesFieldSearch(field: FieldDescriptor, term: string): boolean {
  const needle = casefoldForDisplay(term)
  if (needle === '') return true
  const haystack = casefoldForDisplay(`${field.label} ${field.slug} ${groupNameOf(field)}`)
  return haystack.includes(needle)
}

/** The picker's list: filterable, grouped, and narrowed to the search term. Empty groups vanish. */
export function pickerGroups(fields: readonly FieldDescriptor[], term = ''): readonly FieldGroup[] {
  const matching = filterableFields(fields).filter((field) => matchesFieldSearch(field, term))
  return groupFields(matching)
}
