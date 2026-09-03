/**
 * The closed filter-operator vocabulary.
 *
 * It lives next to the attribute registry rather than in `filters/` because §4.2's table defines
 * the operator set *per attribute type*, and the registry is where that table is transcribed. The
 * filter model, its Zod schemas and `OPERATORS_BY_TYPE` build on this list; nothing here knows
 * about SQL, URLs or arity.
 */
export const OPERATORS = [
  // text
  'contains',
  'equals',
  // universal
  'is_empty',
  'is_not_empty',
  // numeric
  'eq',
  'neq',
  'lt',
  'gt',
  'between',
  // temporal
  'before',
  'after',
  'in_relative',
  'older_than',
  'newer_than',
  // boolean
  'is_yes',
  'is_no',
  // options
  'is_one_of',
  'is_not_one_of',
  'contains_any_of',
  'contains_all_of',
  // relations
  'has_any_of',
] as const

export type OperatorId = (typeof OPERATORS)[number]

export function isOperatorId(value: string): value is OperatorId {
  return (OPERATORS as readonly string[]).includes(value)
}
