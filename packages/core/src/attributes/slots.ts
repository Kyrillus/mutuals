/**
 * The only file in the repository, outside `packages/db`'s schema and migrations, that contains a
 * physical value-column name.
 *
 * "Attribute definitions drive everything — never hard-code a column" is a rule that a comment
 * cannot enforce, so `slots.test.ts` greps the whole of `packages/core/src` for these strings and
 * fails on any hit outside this file. Every SQL fragment the filter compiler emits takes its
 * column name from {@link SLOT_COLUMNS}, keyed by the attribute's `value_kind`, which is why
 * adding a thirteenth attribute type that reuses an existing kind touches no SQL at all.
 */
import type { ValueKind } from './kinds.ts'

/**
 * `fact` and `attribute_value` carry an identical set of typed slots, so projection is a
 * column-for-column copy. `norm` and `sort` exist only on `attribute_value`: they are derived, and
 * ADR-020 keeps derived columns out of the append-only log so `db:reproject` can rebuild them.
 */
export const SLOT_COLUMNS = {
  text: { value: 'text_value', norm: 'text_norm', sort: 'text_sort' },
  number: { value: 'num_value', sort: 'num_value' },
  date: { value: 'date_value', sort: 'date_value' },
  bool: { value: 'bool_value', sort: 'bool_value' },
  option: { value: 'option_id' },
  // Relations are projected into `record_link`, never into `attribute_value`, because the link
  // carries its own attributes (§4.3). This name only ever appears on `fact`.
  relation: { value: 'target_record_id' },
} as const satisfies Record<
  ValueKind,
  { readonly value: string; readonly norm?: string; readonly sort?: string }
>

/**
 * The identity of one value inside one attribute on one record: `''` for every single-valued
 * attribute, the normalised element for a multi-valued one (ADR-018). It belongs to no single
 * `value_kind`, so it is not part of {@link SLOT_COLUMNS}.
 */
export const VALUE_KEY_COLUMN = 'value_key'

export type SlotColumn =
  (typeof SLOT_COLUMNS)[ValueKind]['value'] | 'text_norm' | 'text_sort' | typeof VALUE_KEY_COLUMN

/** The frozen allowlist the compiler's "no user input ever becomes an identifier" test asserts. */
export const ALL_SLOT_COLUMNS: readonly SlotColumn[] = Object.freeze([
  'text_value',
  'text_norm',
  'text_sort',
  'num_value',
  'date_value',
  'bool_value',
  'option_id',
  'target_record_id',
  VALUE_KEY_COLUMN,
])

/** The column holding the value itself for a given kind. */
export function valueColumn(kind: ValueKind): SlotColumn {
  return SLOT_COLUMNS[kind].value
}

/**
 * The column an `ORDER BY` reads for a given kind, or `undefined` where the kind has no orderable
 * slot — `option` sorts by the option's position and `relation` does not sort at all.
 */
export function sortColumn(kind: ValueKind): SlotColumn | undefined {
  const slot = SLOT_COLUMNS[kind]
  return 'sort' in slot ? slot.sort : undefined
}

/** The trigram-indexed column `contains` and `equals` match against, for text kinds only. */
export function normColumn(kind: ValueKind): SlotColumn | undefined {
  const slot = SLOT_COLUMNS[kind]
  return 'norm' in slot ? slot.norm : undefined
}

export function isSlotColumn(value: string): value is SlotColumn {
  return (ALL_SLOT_COLUMNS as readonly string[]).includes(value)
}
