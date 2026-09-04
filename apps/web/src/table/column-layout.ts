/**
 * The `?columns=` parameter, translated into the two state slices TanStack Table owns.
 *
 * One list in the URL — visible slugs, in display order — has to become `columnOrder` (every
 * column, visible or not) and `columnVisibility` (a map). Doing that conversion here, as pure
 * functions, is what lets the Columns picker write the URL through the table's own
 * `onColumnOrderChange`/`onColumnVisibilityChange` (ADR-051) without either side owning a second
 * copy of the truth.
 */
import type { FieldDescriptor } from '@mutuals/core'

/** Not a slug: `packages/core` reserves every slug shape, and a `__` prefix cannot collide. */
export const SELECT_COLUMN_ID = '__select'

export interface ColumnLayout {
  /** `columnOrder`: pinned first, then the visible columns, then the hidden ones. */
  readonly order: readonly string[]
  readonly visibility: Readonly<Record<string, boolean>>
}

/**
 * The visible columns, in order.
 *
 * The label column is forced to the front rather than merely defaulted there: it is the sticky
 * first column and the only link to the record, so a URL that omits it would produce a table of
 * anonymous rows.
 */
export function visibleColumns(
  fields: readonly FieldDescriptor[],
  label: string,
  requested: readonly string[] | null,
): readonly string[] {
  const known = new Set(fields.map((field) => field.slug))
  const wanted =
    requested ?? fields.filter((field) => field.showByDefault).map((field) => field.slug)
  const ordered = wanted.filter((slug) => known.has(slug) && slug !== label)
  return [label, ...new Set(ordered)]
}

export function columnLayout(
  fields: readonly FieldDescriptor[],
  label: string,
  requested: readonly string[] | null,
): ColumnLayout {
  const visible = visibleColumns(fields, label, requested)
  const shown = new Set(visible)
  const hidden = fields.map((field) => field.slug).filter((slug) => !shown.has(slug))

  const visibility: Record<string, boolean> = {}
  for (const slug of hidden) visibility[slug] = false

  return { order: [SELECT_COLUMN_ID, ...visible, ...hidden], visibility }
}

/**
 * The inverse: what `?columns=` should say, given the table's own two slices.
 *
 * `SELECT_COLUMN_ID` is dropped because it is furniture, not a field — putting it in the URL
 * would make it a column a saved view could hide.
 */
export function layoutToColumns(
  order: readonly string[],
  visibility: Readonly<Record<string, boolean>>,
): readonly string[] {
  return order.filter((id) => id !== SELECT_COLUMN_ID && visibility[id] !== false)
}

/**
 * Moves `slug` so that it sits at `targetIndex` of the *visible* list. Used by the Columns
 * picker's drag reorder, which only ever shows visible columns.
 */
export function moveColumn(
  columns: readonly string[],
  slug: string,
  targetIndex: number,
): readonly string[] {
  const from = columns.indexOf(slug)
  if (from === -1) return columns
  const rest = columns.filter((entry) => entry !== slug)
  const clamped = Math.max(0, Math.min(targetIndex, rest.length))
  return [...rest.slice(0, clamped), slug, ...rest.slice(clamped)]
}
