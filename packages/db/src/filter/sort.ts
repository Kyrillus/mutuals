/**
 * Typed sorting (storage-DECISION §6).
 *
 * Every sort key is a native Postgres value in a real column, so ordering is correct by
 * construction rather than by encoding discipline: `9` sorts before `10`, `1988-03-12` before
 * `1990-01-01`, and a `single_select` sorts by the option's own `position` rather than
 * alphabetically. The types §4.2 marks "—" are refused with `not_sortable`, never silently
 * demoted to insertion order.
 *
 * The sort join is a plain `LEFT JOIN`, not a `LATERAL`: every sortable attribute type is
 * single-valued, so `value_key = ''` and `av_record_attr_uq` already guarantee at most one row.
 * That leaves the planner more freedom than a lateral with `LIMIT 1` and produces the same answer.
 */
import { sql, type RawBuilder } from 'kysely'
import {
  issue,
  ok,
  sortSpecFor,
  valueColumn,
  VALUE_KEY_COLUMN,
  type FieldDescriptor,
  type MetricTable,
  type Result,
  type SortDirection,
  type SortRequest,
} from '@mutuals/core'

import { RECORD_ALIAS, columnRef, ref, systemColumn, type CompileContext } from './compile.ts'

/** The `attribute_value` row a custom-attribute sort reads its key from. */
export const SORT_VALUE_ALIAS = 'sv'
/** The `attribute_option` row a `single_select` sort reads its `position` from. */
export const SORT_OPTION_ALIAS = 'so'

const VALUE_TABLE = 'attribute_value'
const OPTION_TABLE = 'attribute_option'

/**
 * §6.6: the default ordering walks `record_list_idx (object_type, created_at DESC, id DESC)`, so
 * it can page by keyset at constant cost. Every other ordering reads its key from a join and pays
 * for a sort, so it pages by `LIMIT/OFFSET` behind the same opaque cursor (ADR-023).
 */
export type PaginationMode = 'keyset' | 'offset'

export interface SortPlan {
  /** `null` for the default `created_at DESC` ordering, which no request has to name. */
  readonly field: FieldDescriptor | null
  /** What the user asked for. The emitted key direction may be inverted; the tiebreaker is not. */
  readonly direction: SortDirection
  /** `LEFT JOIN` fragments this ordering needs, in the order they must appear. */
  readonly joins: readonly RawBuilder<unknown>[]
  /** The expression the ordering is on, also selected as `sort_key` by the narrow first query. */
  readonly key: RawBuilder<unknown>
  /** The complete `ORDER BY` list, tiebreaker included. */
  readonly orderBy: RawBuilder<unknown>
  readonly mode: PaginationMode
  /** Set when the key lives on a metrics table, so the caller knows to join it. */
  readonly metricTable: MetricTable | null
}

const DIRECTIONS = { asc: 'asc', desc: 'desc' } as const

function flip(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}

/**
 * `NULLS LAST` in both directions, so "empty" always sinks to the bottom and the plan shape does
 * not change between ascending and descending (§6). It is emitted only where the key can actually
 * be NULL: on `record.created_at` it would buy nothing and would stop the ordering matching
 * `record_list_idx`, which is the one index this design pages through.
 */
function orderTerm(
  key: RawBuilder<unknown>,
  direction: SortDirection,
  nullable: boolean,
): RawBuilder<unknown> {
  return nullable
    ? sql`${key} ${sql.raw(DIRECTIONS[direction])} nulls last`
    : sql`${key} ${sql.raw(DIRECTIONS[direction])}`
}

function tiebreaker(direction: SortDirection): RawBuilder<unknown> {
  return sql`${ref(RECORD_ALIAS, 'id')} ${sql.raw(DIRECTIONS[direction])}`
}

function plan(
  field: FieldDescriptor | null,
  direction: SortDirection,
  key: RawBuilder<unknown>,
  options: {
    readonly keyDirection?: SortDirection
    readonly nullable: boolean
    readonly joins?: readonly RawBuilder<unknown>[]
    readonly mode?: PaginationMode
    readonly metricTable?: MetricTable | null
  },
): SortPlan {
  const keyDirection = options.keyDirection ?? direction
  return {
    field,
    direction,
    joins: options.joins ?? [],
    key,
    orderBy: sql`${orderTerm(key, keyDirection, options.nullable)}, ${tiebreaker(direction)}`,
    mode: options.mode ?? 'offset',
    metricTable: options.metricTable ?? null,
  }
}

/** The ordering a list falls back to when no `sort` was asked for. */
export function defaultSort(): SortPlan {
  return plan(null, 'desc', ref(RECORD_ALIAS, 'created_at'), { nullable: false, mode: 'keyset' })
}

function valueJoin(attributeId: string): RawBuilder<unknown> {
  return sql`left join ${sql.table(VALUE_TABLE)} as ${sql.id(SORT_VALUE_ALIAS)} on ${ref(SORT_VALUE_ALIAS, 'record_id')} = ${ref(RECORD_ALIAS, 'id')} and ${ref(SORT_VALUE_ALIAS, 'attribute_id')} = ${attributeId} and ${ref(SORT_VALUE_ALIAS, VALUE_KEY_COLUMN)} = ''`
}

function optionJoin(): RawBuilder<unknown> {
  return sql`left join ${sql.table(OPTION_TABLE)} as ${sql.id(SORT_OPTION_ALIAS)} on ${ref(SORT_OPTION_ALIAS, 'id')} = ${ref(SORT_VALUE_ALIAS, valueColumn('option'))}`
}

function notSortable(field: FieldDescriptor): Result<never> {
  return {
    ok: false,
    issues: [
      issue('not_sortable', `"${field.label}" cannot be sorted.`, ['sort'], { field: field.slug }),
    ],
  }
}

function sortAttribute(field: FieldDescriptor, direction: SortDirection): Result<SortPlan> {
  if (field.source.kind !== 'attribute') throw new Error('Not an attribute field')
  const definition = field.source.def
  const spec = sortSpecFor(definition.type)
  if (spec === null || !field.sortable) return notSortable(field)

  if (spec.via === 'option-position') {
    return ok(
      plan(field, direction, ref(SORT_OPTION_ALIAS, 'position'), {
        nullable: true,
        joins: [valueJoin(definition.id), optionJoin()],
      }),
    )
  }

  // `yes_no` inverts: §4.2 asks for "yes first" ascending, and true sorts after false.
  return ok(
    plan(field, direction, ref(SORT_VALUE_ALIAS, spec.column), {
      keyDirection: spec.invert === true ? flip(direction) : direction,
      nullable: true,
      joins: [valueJoin(definition.id)],
    }),
  )
}

function sortColumnField(field: FieldDescriptor, direction: SortDirection): Result<SortPlan> {
  if (field.source.kind === 'attribute') throw new Error('Not a column field')
  if (!field.sortable) return notSortable(field)

  const declared = systemColumn(field)
  const column = columnRef(field)
  const metricTable = field.source.kind === 'metric' ? field.source.table : null

  // Text is ordered the way `contact_name_sort_idx` and `organization_name_sort_idx` store it:
  // case-folded and byte-ordered, so the ordering is deterministic and immune to a glibc
  // collation change on the machine somebody else runs this on.
  const key =
    declared.type === 'text'
      ? sql`lower(${column}) collate "C"`
      : declared.type === 'enum_text'
        ? sql`lower((${column})::text) collate "C"`
        : column

  const isCreatedAt =
    field.source.kind === 'column' &&
    field.source.table === 'record' &&
    field.source.column === 'created_at'

  return ok(
    plan(field, direction, key, {
      nullable: declared.nullable,
      // Explicitly asking for the default ordering is the default ordering: it walks the same
      // index and pages the same way.
      mode: isCreatedAt ? 'keyset' : 'offset',
      metricTable,
    }),
  )
}

/**
 * Resolves a sort request into the joins, the key and the `ORDER BY` a list query needs.
 *
 * An unknown slug and an unsortable field are both refused here, before any SQL exists — §6.5's
 * "explicit refusal, not a silent fallback to insertion order".
 */
export function resolveSort(sort: SortRequest | null, ctx: CompileContext): Result<SortPlan> {
  if (sort === null) return ok(defaultSort())

  const field = ctx.resolver.get(sort.field)
  if (field === undefined) {
    return {
      ok: false,
      issues: [
        issue('unknown_field', `There is no field called "${sort.field}".`, ['sort'], {
          field: sort.field,
        }),
      ],
    }
  }

  return field.source.kind === 'attribute'
    ? sortAttribute(field, sort.direction)
    : sortColumnField(field, sort.direction)
}
