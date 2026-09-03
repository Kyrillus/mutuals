import { z } from 'zod'
import { assertNever, failWith, issuesFromZodError, ok, type Result } from '../result.ts'
import { OPERATOR_SHAPE_BY_ID, type OperatorId } from './operators.ts'
import {
  RELATIVE_PRESETS,
  RELATIVE_UNITS,
  type RelativePreset,
  type RelativeUnit,
} from './relative.ts'

/**
 * The filter model: one variant per operator *shape*, discriminated on `op`.
 *
 * Two properties make this the shape it is.
 *
 * **Arity lives in the type system.** `{ op: 'is_empty' }` has no `value` property at all, so an
 * `is_empty` carrying a value is unconstructable and a `between` missing its `to` will not
 * compile. Zod gives the same guarantee at the API boundary with a readable message.
 *
 * **The payload is always strings** (or, for the relative operators, a small number and a closed
 * unit). A date is `'2026-03-01'`, a number is `'600000'`, a select is an option *key*, a relation
 * is a record id. So the wire codec is lossless with no per-type escaping, and *interpreting* the
 * payload is the resolved field's job — which is also why the union is not discriminated on the
 * field's type: that would duplicate what the resolver already knows and add a way to disagree.
 *
 * Filters combine with **AND only** (brief §5.2, ADR-032). The wire form is a bare JSON array;
 * an `any` group, if it is ever wanted, arrives as a wrapper object, which is a wire change and
 * therefore a decision to take out loud rather than a shape to reserve now.
 */

/** Past this the planner leaves `join_collapse_limit` behind and starts guessing (GEQO). */
export const MAX_FILTERS = 20
export const MAX_FILTER_VALUES = 200
export const MAX_FILTER_VALUE_LENGTH = 1024
export const MAX_FIELD_REF_LENGTH = 64

export type Filter =
  | { readonly field: string; readonly op: 'contains' | 'equals'; readonly value: string }
  | { readonly field: string; readonly op: 'is_empty' | 'is_not_empty' }
  | { readonly field: string; readonly op: 'eq' | 'neq' | 'lt' | 'gt'; readonly value: string }
  | { readonly field: string; readonly op: 'between'; readonly from: string; readonly to: string }
  | { readonly field: string; readonly op: 'before' | 'after'; readonly value: string }
  | { readonly field: string; readonly op: 'in_relative'; readonly preset: RelativePreset }
  | {
      readonly field: string
      readonly op: 'older_than' | 'newer_than'
      readonly n: number
      readonly unit: RelativeUnit
    }
  | { readonly field: string; readonly op: 'is_yes' | 'is_no' }
  | {
      readonly field: string
      readonly op:
        'is_one_of' | 'is_not_one_of' | 'contains_any_of' | 'contains_all_of' | 'has_any_of'
      readonly values: readonly string[]
    }

/** AND-only, and a bare array on the wire. */
export type FilterSet = readonly Filter[]

/**
 * A field reference is validated for *shape* only. Resolving it — and rejecting an unknown slug
 * with `unknown_field` before a single character of SQL is built — belongs to the field resolver,
 * so the codec does not carry a second copy of the slug rules.
 */
const fieldSchema = z.string().min(1).max(MAX_FIELD_REF_LENGTH)

const valueSchema = z.string().max(MAX_FILTER_VALUE_LENGTH)

const valuesSchema = z.array(valueSchema).min(1).max(MAX_FILTER_VALUES)

const relativeNSchema = z.int().min(0)

export const filterSchema = z.discriminatedUnion('op', [
  z.strictObject({
    field: fieldSchema,
    op: z.literal(['contains', 'equals']),
    value: valueSchema,
  }),
  z.strictObject({ field: fieldSchema, op: z.literal(['is_empty', 'is_not_empty']) }),
  z.strictObject({
    field: fieldSchema,
    op: z.literal(['eq', 'neq', 'lt', 'gt']),
    value: valueSchema,
  }),
  z.strictObject({
    field: fieldSchema,
    op: z.literal('between'),
    from: valueSchema,
    to: valueSchema,
  }),
  z.strictObject({ field: fieldSchema, op: z.literal(['before', 'after']), value: valueSchema }),
  z.strictObject({
    field: fieldSchema,
    op: z.literal('in_relative'),
    preset: z.literal(RELATIVE_PRESETS),
  }),
  z.strictObject({
    field: fieldSchema,
    op: z.literal(['older_than', 'newer_than']),
    n: relativeNSchema,
    unit: z.literal(RELATIVE_UNITS),
  }),
  z.strictObject({ field: fieldSchema, op: z.literal(['is_yes', 'is_no']) }),
  z.strictObject({
    field: fieldSchema,
    op: z.literal([
      'is_one_of',
      'is_not_one_of',
      'contains_any_of',
      'contains_all_of',
      'has_any_of',
    ]),
    values: valuesSchema,
  }),
])

export const filterSetSchema = z.array(filterSchema).max(MAX_FILTERS)

/** Parses one filter from untrusted JSON. */
export function parseFilter(input: unknown): Result<Filter> {
  const parsed = filterSchema.safeParse(input)
  if (!parsed.success) return failWith(issuesFromZodError(parsed.error))
  return ok(parsed.data)
}

/** Parses a whole filter set from untrusted JSON. */
export function parseFilterSet(input: unknown): Result<FilterSet> {
  if (Array.isArray(input) && input.length > MAX_FILTERS) {
    return failWith([
      {
        code: 'too_many_filters',
        message: `Use at most ${MAX_FILTERS} filters at a time.`,
        path: ['filter'],
      },
    ])
  }
  const parsed = filterSetSchema.safeParse(input)
  if (!parsed.success) return failWith(issuesFromZodError(parsed.error))
  return ok(parsed.data)
}

function canonicalValues(values: readonly string[]): readonly string[] {
  // The multi-value operators are set operators, so the order the user clicked the options in is
  // not part of the meaning — and if it were kept, reordering two chips would make a saved view
  // look dirty.
  return [...new Set(values)].sort()
}

/**
 * One filter in canonical form: a fixed key order and set payloads deduplicated and sorted, so
 * `JSON.stringify` of two equivalent filters produces the same bytes.
 */
export function canonicalFilter(filter: Filter): Filter {
  const { field, op } = filter
  switch (op) {
    case 'contains':
    case 'equals':
    case 'eq':
    case 'neq':
    case 'lt':
    case 'gt':
    case 'before':
    case 'after':
      return { field, op, value: filter.value }
    case 'is_empty':
    case 'is_not_empty':
    case 'is_yes':
    case 'is_no':
      return { field, op }
    case 'between':
      return { field, op, from: filter.from, to: filter.to }
    case 'in_relative':
      return { field, op, preset: filter.preset }
    case 'older_than':
    case 'newer_than':
      return { field, op, n: filter.n, unit: filter.unit }
    case 'is_one_of':
    case 'is_not_one_of':
    case 'contains_any_of':
    case 'contains_all_of':
    case 'has_any_of':
      return { field, op, values: canonicalValues(filter.values) }
    default:
      return assertNever(filter, 'filter operator')
  }
}

/**
 * A whole filter set in canonical form: every filter canonicalised, then the set ordered by its
 * own serialisation. AND is commutative, so ordering costs nothing semantically and buys a stable
 * comparison — which is what makes "this view has unsaved changes" a deep equality check rather
 * than a heuristic.
 */
export function canonicalFilterSet(filters: FilterSet): FilterSet {
  return filters
    .map(canonicalFilter)
    .map((filter) => ({ filter, key: JSON.stringify(filter) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.filter)
}

/** The operator's payload shape, for a UI that builds its editors from data. */
export function shapeOf(filter: Filter): (typeof OPERATOR_SHAPE_BY_ID)[OperatorId] {
  return OPERATOR_SHAPE_BY_ID[filter.op]
}
