/**
 * The list endpoint, once, for every record type.
 *
 * §5.2's table is one component; this is its server half. Contacts and organizations differ only in
 * which object type they pass and how a row is serialised, so the filter model, the sort, the
 * search box, the pagination and the exact row count are compiled and executed here — which is
 * also what makes "dynamic filter and sort on a custom attribute" one thing to test rather than
 * two things that could drift.
 *
 * Two queries run, never one (ADR-023, storage-DECISION §5.1). Q1 is narrow — `(id, sort_key)` —
 * so the sort cannot spill `work_mem` however wide the visible columns are, and the surviving ids
 * are hydrated separately. Q3 is a plain `count(*)` over the same predicate: `count(*) OVER ()`
 * would have to buffer the whole filtered set before emitting a row, so `LIMIT 50` would
 * short-circuit nothing.
 */
import { DEFAULT_PAGE_SIZE, parseListQuery, type ObjectType, type RawQuery } from '@mutuals/core'
import { compileList, hydrateRecords, type HydratedRecord, type ListPage } from '@mutuals/db'

import { workspaceId, type AppContext, type RequestSettings, type Schema } from '../context.ts'
import { validationFailed } from '../errors.ts'
import { decodeCursor, encodeCursor } from './cursor.ts'

export interface ListResult {
  readonly records: readonly HydratedRecord[]
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly total: number
}

interface ListInput {
  readonly objectType: ObjectType
  readonly raw: RawQuery
  readonly schema: Schema
  readonly settings: Pick<RequestSettings, 'timeZone' | 'today'>
}

interface SortKeyRow {
  readonly id: string
  readonly sort_key: unknown
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new Error('the keyset cursor needs a timestamp sort key')
}

export async function listRecords(ctx: AppContext, input: ListInput): Promise<ListResult> {
  const query = parseListQuery(input.raw)
  if (!query.ok) throw validationFailed(query.issues)

  const limit = query.value.limit ?? DEFAULT_PAGE_SIZE

  let page: ListPage | null = null
  if (query.value.cursor !== null) {
    const decoded = decodeCursor(query.value.cursor)
    if (!decoded.ok) throw validationFailed(decoded.issues)
    page = decoded.value
  }

  // One row more than asked for. `hasMore` is then a fact about this query rather than a guess
  // from comparing the page size against a count that a concurrent write may have moved.
  const plan = compileList({
    objectType: input.objectType,
    resolver: input.schema.resolver,
    workspaceId: await workspaceId(ctx),
    query: query.value,
    today: input.settings.today,
    timeZone: input.settings.timeZone,
    limit: limit + 1,
    page,
    searchFields: query.value.columns,
  })
  if (!plan.ok) throw validationFailed(plan.issues)

  if (page !== null && page.mode !== plan.value.sort.mode) {
    throw validationFailed([
      {
        code: 'malformed_query',
        path: ['cursor'],
        message: 'That cursor belongs to a different sort order. Start from the first page.',
      },
    ])
  }

  const [rows, totals] = await Promise.all([
    plan.value.rows.execute(ctx.db),
    plan.value.total.execute(ctx.db),
  ])

  const fetched = rows.rows as readonly SortKeyRow[]
  const hasMore = fetched.length > limit
  const visible = hasMore ? fetched.slice(0, limit) : fetched
  const total = Number(totals.rows[0]?.total ?? 0)

  const records = await hydrateRecords(
    ctx.db,
    visible.map((row) => row.id),
  )

  return {
    records,
    hasMore,
    total,
    cursor: hasMore ? encodeCursor(nextPage(plan.value.sort.mode, page, limit, visible)) : null,
  }
}

function nextPage(
  mode: 'keyset' | 'offset',
  current: ListPage | null,
  limit: number,
  visible: readonly SortKeyRow[],
): ListPage {
  if (mode === 'keyset') {
    const last = visible[visible.length - 1]
    if (last === undefined) throw new Error('hasMore with no rows')
    return { mode: 'keyset', createdAt: isoOf(last.sort_key), id: last.id }
  }
  const offset = current !== null && current.mode === 'offset' ? current.offset : 0
  return { mode: 'offset', offset: offset + limit }
}
