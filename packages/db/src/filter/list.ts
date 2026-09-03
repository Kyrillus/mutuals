/**
 * The list-query builder: filters, the sort and pagination, assembled into the two queries the
 * list endpoint runs (storage-DECISION §5.1).
 *
 * **Q1 is narrow on purpose.** It selects `(id, sort_key)` and nothing else — roughly 40-byte
 * tuples — so the sort cannot spill `work_mem` however wide the table's visible columns are. The
 * ≤50 surviving ids are hydrated by a second query over `av_record_attr_uq`, which is somebody
 * else's file.
 *
 * **Q3 is a separate `count(*)`, never `count(*) OVER ()`** (ADR-023). A window function with no
 * partition has to buffer its whole input before emitting the first row, so `LIMIT 50` would
 * short-circuit nothing and an unfiltered page would materialise every contact.
 *
 * Joins are emitted only when something references them: fewer base relations means the planner
 * keeps reordering exhaustively for more filter chips before `join_collapse_limit` hands over to
 * the genetic optimiser (§5.4).
 */
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely'
import {
  fieldValueKind,
  issue,
  ok,
  type CivilDate,
  type CoreIssue,
  type FieldDescriptor,
  type FieldResolver,
  type ListQuery,
  type MetricTable,
  type ObjectType,
  type Result,
} from '@mutuals/core'

import {
  RECORD_ALIAS,
  TABLE_ALIASES,
  compileFilterSet,
  compileSearch,
  conjoin,
  metricTableOf,
  ref,
  type CompileContext,
} from './compile.ts'
import { resolveSort, type SortPlan } from './sort.ts'

const RECORD_TABLE = 'record'

/** The metrics table each object type owns, and `null` for the one that has none. */
const METRIC_TABLE_BY_OBJECT = {
  contact: 'contact_metrics',
  organization: 'organization_metrics',
  interaction: null,
} as const satisfies Record<ObjectType, MetricTable | null>

/**
 * Where the next page starts. Which variant applies is decided by the sort, not by the caller:
 * the default ordering walks `record_list_idx` and pages by keyset, everything else pays for a
 * sort and pages by offset. Both are wrapped in one opaque cursor at the API boundary (ADR-023),
 * so today's `OFFSET` can become a keyset walk later with no API and no UI change.
 */
export type ListPage =
  | { readonly mode: 'offset'; readonly offset: number }
  | { readonly mode: 'keyset'; readonly createdAt: string; readonly id: string }

export interface ListRequest {
  readonly objectType: ObjectType
  readonly resolver: FieldResolver
  readonly workspaceId: string
  readonly query: ListQuery
  /** Injected (ADR-034); relative filters resolve against this and never against a clock. */
  readonly today: CivilDate
  /** `profile.time_zone` (ADR-045). */
  readonly timeZone: string
  /** Already clamped to the API's bounds by the caller. */
  readonly limit: number
  readonly page?: ListPage | null
  /**
   * Slugs the quick search box covers — §5.2's "visible text columns". Defaults to every
   * text-valued attribute of this object type. A non-text field in the list is skipped rather
   * than refused: the caller passes the visible columns, and most of them are not text.
   */
  readonly searchFields?: readonly string[] | null
}

export interface ListRow {
  readonly id: string
  /** Whatever the sort key's column holds; `count(*)`-style bigints arrive as strings. */
  readonly sort_key: unknown
}

export interface CountRow {
  readonly total: string
}

export interface ListPlan {
  readonly sort: SortPlan
  readonly limit: number
  /** The compiled predicate, exposed so a bulk action can reuse exactly the user's selection. */
  readonly where: Expression<SqlBool>
  /** Q1 — filter, sort, paginate, narrow. */
  readonly rows: RawBuilder<ListRow>
  /** Q3 — the exact "Rows: 2,236" footer over the same predicate, unpaginated. */
  readonly total: RawBuilder<CountRow>
}

function subtypeJoin(objectType: ObjectType): RawBuilder<unknown> {
  const alias = TABLE_ALIASES[objectType]
  return sql`join ${sql.table(objectType)} as ${sql.id(alias)} on ${ref(alias, 'id')} = ${ref(RECORD_ALIAS, 'id')}`
}

/**
 * The metrics row is joined with `LEFT JOIN`, so a contact the nightly sweep has never reached
 * still appears in the list with every metric reading NULL — which is also why a NULL metric
 * matches none of the relative date bounds (ADR-040).
 */
function metricsJoin(objectType: ObjectType, table: MetricTable): RawBuilder<unknown> {
  const alias = TABLE_ALIASES[table]
  return sql`left join ${sql.table(table)} as ${sql.id(alias)} on ${ref(alias, `${objectType}_id`)} = ${ref(RECORD_ALIAS, 'id')}`
}

function fromClause(joins: readonly RawBuilder<unknown>[]): RawBuilder<unknown> {
  const base = sql`from ${sql.table(RECORD_TABLE)} as ${sql.id(RECORD_ALIAS)}`
  return joins.length === 0 ? base : sql`${base} ${sql.join(joins, sql.raw(' '))}`
}

/**
 * The attribute ids the quick search scans. Text kinds only: `text_norm` is the only column the
 * trigram index covers, and "Munich" is not a substring of a number or a date.
 */
function textAttributeId(field: FieldDescriptor): string | null {
  return field.source.kind === 'attribute' && fieldValueKind(field) === 'text'
    ? field.source.def.id
    : null
}

function searchAttributeIds(request: ListRequest): Result<readonly string[]> {
  const { resolver } = request
  const slugs = request.searchFields ?? null
  if (slugs === null) {
    return ok(resolver.list().flatMap((field) => textAttributeId(field) ?? []))
  }

  const issues: CoreIssue[] = []
  const ids: string[] = []
  for (const slug of slugs) {
    const field = resolver.get(slug)
    if (field === undefined) {
      issues.push(
        issue('unknown_field', `There is no field called "${slug}".`, ['columns'], { field: slug }),
      )
      continue
    }
    const id = textAttributeId(field)
    if (id !== null) ids.push(id)
  }
  return issues.length === 0 ? ok(ids) : { ok: false, issues }
}

/** `(r.created_at, r.id) < ($ts, $id)` — one row comparison, straight down `record_list_idx`. */
function keysetPredicate(
  page: Extract<ListPage, { mode: 'keyset' }>,
  sort: SortPlan,
): RawBuilder<SqlBool> {
  const operator = sort.direction === 'desc' ? '<' : '>'
  return sql<SqlBool>`(${ref(RECORD_ALIAS, 'created_at')}, ${ref(RECORD_ALIAS, 'id')}) ${sql.raw(operator)} (${page.createdAt}::timestamptz, ${page.id}::uuid)`
}

/**
 * Compiles a whole list request.
 *
 * Every failure — an unknown slug, an operator a field does not offer, a number that is not a
 * number, a sort on an unsortable column — is collected and returned together, so one bad URL
 * produces one 400 naming everything that is wrong with it rather than three round trips.
 */
export function compileList(request: ListRequest): Result<ListPlan> {
  const ctx: CompileContext = {
    objectType: request.objectType,
    resolver: request.resolver,
    today: request.today,
    timeZone: request.timeZone,
  }

  const issues: CoreIssue[] = []

  const filters = compileFilterSet(request.query.filter, ctx)
  if (!filters.ok) issues.push(...filters.issues)

  const sorted = resolveSort(request.query.sort, ctx)
  if (!sorted.ok) issues.push(...sorted.issues)

  const searchIds = searchAttributeIds(request)
  if (!searchIds.ok) issues.push(...searchIds.issues)

  if (!filters.ok || !sorted.ok || !searchIds.ok) return { ok: false, issues }

  const sort = sorted.value
  const predicates: Expression<SqlBool>[] = [
    sql<SqlBool>`${ref(RECORD_ALIAS, 'workspace_id')} = ${request.workspaceId}::uuid`,
    sql<SqlBool>`${ref(RECORD_ALIAS, 'object_type')} = ${request.objectType}`,
    ...filters.value.map((filter) => filter.expression),
  ]

  const search = request.query.q === null ? null : compileSearch(request.query.q, searchIds.value)
  if (search !== null) predicates.push(search)

  const where = conjoin(predicates)

  const filterMetricTable = filters.value.reduce<MetricTable | null>(
    (found, filter) => found ?? metricTableOf(filter.field),
    null,
  )
  const declaredMetricTable = METRIC_TABLE_BY_OBJECT[request.objectType]
  const countMetricTable = filterMetricTable === null ? null : declaredMetricTable
  const rowsMetricTable =
    filterMetricTable === null && sort.metricTable === null ? null : declaredMetricTable

  const countFrom = fromClause([
    subtypeJoin(request.objectType),
    ...(countMetricTable === null ? [] : [metricsJoin(request.objectType, countMetricTable)]),
  ])
  const rowsFrom = fromClause([
    subtypeJoin(request.objectType),
    ...(rowsMetricTable === null ? [] : [metricsJoin(request.objectType, rowsMetricTable)]),
    ...sort.joins,
  ])

  const page = request.page ?? null
  const rowsWhere =
    page !== null && page.mode === 'keyset' ? conjoin([where, keysetPredicate(page, sort)]) : where
  const window =
    page !== null && page.mode === 'offset'
      ? sql`limit ${request.limit} offset ${page.offset}`
      : sql`limit ${request.limit}`

  return ok({
    sort,
    limit: request.limit,
    where,
    rows: sql<ListRow>`select ${ref(RECORD_ALIAS, 'id')} as "id", ${sort.key} as "sort_key" ${rowsFrom} where ${rowsWhere} order by ${sort.orderBy} ${window}`,
    total: sql<CountRow>`select count(*)::bigint as "total" ${countFrom} where ${where}`,
  })
}
