import { OPERATORS, isOperatorId, type OperatorId } from '../attributes/operators.ts'

/**
 * What a filter operator carries and which fields offer it.
 *
 * The operator *vocabulary* is `attributes/operators.ts`, next to the registry that transcribes
 * §4.2's table; this file adds the two things the filter layer needs on top of it — the payload
 * shape (hence the arity) and the per-field operator sets, including the derived columns of §5.2
 * that no attribute type declares.
 *
 * `apps/web` imports this to build the filter picker and `packages/db`'s compiler switches on it.
 * Neither keeps its own copy: a duplicated operator table plus a test asserting the two agree is a
 * table too many.
 */

export { OPERATORS, isOperatorId, type OperatorId }

export const OPERATOR_SHAPES = ['none', 'value', 'range', 'values', 'duration', 'preset'] as const

/**
 * The payload an operator carries:
 * - `none`     — nothing at all (`is_empty`, `is_yes`)
 * - `value`    — one string (`contains`, `lt`, `before`)
 * - `range`    — `from` and `to` (`between`)
 * - `values`   — a set of strings (`is_one_of`, `has_any_of`)
 * - `duration` — `n` plus a unit (`older_than`, `newer_than`)
 * - `preset`   — a named relative window (`in_relative`)
 */
export type OperatorShape = (typeof OPERATOR_SHAPES)[number]

export const OPERATOR_SHAPE_BY_ID = {
  contains: 'value',
  equals: 'value',
  is_empty: 'none',
  is_not_empty: 'none',
  eq: 'value',
  neq: 'value',
  lt: 'value',
  gt: 'value',
  between: 'range',
  before: 'value',
  after: 'value',
  in_relative: 'preset',
  older_than: 'duration',
  newer_than: 'duration',
  is_yes: 'none',
  is_no: 'none',
  is_one_of: 'values',
  is_not_one_of: 'values',
  contains_any_of: 'values',
  contains_all_of: 'values',
  has_any_of: 'values',
} as const satisfies Record<OperatorId, OperatorShape>

/**
 * How many operands the operator takes; `-1` is variadic (a set of at least one value). Arity is
 * enforced by the type system too — an `is_empty` filter has no `value` property to forget — but
 * the filter picker builds its editors from data, not from types.
 */
export const ARITY_BY_SHAPE = {
  none: 0,
  value: 1,
  preset: 1,
  range: 2,
  duration: 2,
  values: -1,
} as const satisfies Record<OperatorShape, number>

export function operatorShape(op: OperatorId): OperatorShape {
  return OPERATOR_SHAPE_BY_ID[op]
}

export function operatorArity(op: OperatorId): number {
  return ARITY_BY_SHAPE[OPERATOR_SHAPE_BY_ID[op]]
}

/**
 * The twelve attribute types of §4.2. `AttributeType` proper is derived from the registry; this
 * is the same twelve names, and `OPERATORS_BY_TYPE` below is keyed by it.
 */
export const ATTRIBUTE_TYPE_NAMES = [
  'short_text',
  'long_text',
  'number',
  'date',
  'yes_no',
  'single_select',
  'multi_select',
  'tags',
  'url',
  'email',
  'phone',
  'relation',
] as const

export type AttributeTypeName = (typeof ATTRIBUTE_TYPE_NAMES)[number]

/**
 * §4.2's operator column, plus `is_not_empty` — the brief names only "is empty", but its
 * complement costs one negation in the compiler, it is what a picker offers next to it, and the
 * derived date columns need it to express "has ever been contacted".
 *
 * `is_empty` means "no live value row exists", identically for all twelve types (ADR-017).
 *
 * Each registry type definition declares the same list in its own `operators` field, because that
 * is what the create-attribute dialog reads. The registry's own test asserts the two agree.
 */
export const OPERATORS_BY_TYPE = {
  short_text: ['contains', 'equals', 'is_empty', 'is_not_empty'],
  long_text: ['contains', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'lt', 'gt', 'between', 'is_empty', 'is_not_empty'],
  date: [
    'before',
    'after',
    'between',
    'in_relative',
    'older_than',
    'newer_than',
    'is_empty',
    'is_not_empty',
  ],
  yes_no: ['is_yes', 'is_no', 'is_empty', 'is_not_empty'],
  single_select: ['is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
  multi_select: ['contains_any_of', 'contains_all_of', 'is_empty', 'is_not_empty'],
  tags: ['contains_any_of', 'is_empty', 'is_not_empty'],
  url: ['contains', 'is_empty', 'is_not_empty'],
  email: ['contains', 'is_empty', 'is_not_empty'],
  phone: ['contains', 'is_empty', 'is_not_empty'],
  relation: ['has_any_of', 'is_empty', 'is_not_empty'],
} as const satisfies Record<AttributeTypeName, readonly OperatorId[]>

/**
 * §5.2's read-only numeric derived columns: `warmth`, `interaction_count_12m`, `open_followups`,
 * `people_count`. The metrics row always has a value, so they deliberately offer no "is empty".
 */
export const NUMERIC_METRIC_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'gt',
  'between',
] as const satisfies readonly OperatorId[]

/**
 * §5.2's derived date columns: `last_interaction_at`, `next_followup_at`. `older_than` is what
 * makes "Last interaction is more than 90 days ago" — and the seeded view "No interaction in
 * 90 days" — expressible at all.
 */
export const DATE_METRIC_OPERATORS = [
  'before',
  'after',
  'between',
  'in_relative',
  'older_than',
  'newer_than',
  'is_empty',
  'is_not_empty',
] as const satisfies readonly OperatorId[]

/** Whether an attribute of this type offers this operator. */
export function isOperatorAllowed(type: AttributeTypeName, op: OperatorId): boolean {
  const allowed: readonly OperatorId[] = OPERATORS_BY_TYPE[type]
  return allowed.includes(op)
}
