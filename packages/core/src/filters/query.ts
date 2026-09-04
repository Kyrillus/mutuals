import { z } from 'zod'
import { fail, failWith, ok, type CoreIssue, type Result } from '../result.ts'
import {
  MAX_FIELD_REF_LENGTH,
  canonicalFilterSet,
  parseFilterSet,
  type FilterSet,
} from './model.ts'

/**
 * The one wire codec for a list request.
 *
 * The same definition serves three callers: Fastify registers {@link parseListQuery} as the
 * route's querystring parser, TanStack Router calls it from `validateSearch`, and the Stage-6 LLM
 * emits a `ListQuery` that goes down the identical path. One definition with an explicit wire
 * boundary — not "the same schema at both ends", which would be false: the router hands the client
 * a parsed array while Fastify hands the handler a string.
 *
 * Shape (ADR-032): the filter set travels as **one** URL-encoded JSON array in `?filter=`;
 * `sort`, `columns`, `q`, `view`, `limit` and `cursor` are plain scalars. One JSON value has one
 * escaping layer, where repeated `field:op:value` parameters need two — and Fastify's default
 * querystring parser decodes `+` as a space, so an unescaped `+` in a phone fragment would
 * silently become a space.
 *
 * {@link serializeListQuery} is **canonical**: filters sorted, set payloads deduplicated and
 * sorted, keys in a fixed order. Saved-view dirtiness is deep equality over exactly this output
 * (ADR-048), so there is one canonicalisation and not two that can disagree.
 */

export const SORT_DIRECTIONS = ['asc', 'desc'] as const

export type SortDirection = (typeof SORT_DIRECTIONS)[number]

export interface SortRequest {
  readonly field: string
  readonly direction: SortDirection
}

export interface ListQuery {
  readonly filter: FilterSet
  readonly sort: SortRequest | null
  /** Visible columns in display order; `null` means "whatever the view or the default says". */
  readonly columns: readonly string[] | null
  /** The table's quick substring search. */
  readonly q: string | null
  /** The saved view this URL was opened from, if any. */
  readonly view: string | null
  readonly limit: number | null
  /**
   * Opaque. Not part of a shareable URL — it belongs to the API contract and to
   * `getNextPageParam`; putting it in the browser's query key would discard every loaded page on
   * each fetch.
   */
  readonly cursor: string | null
}

export type RawQuery = Readonly<Record<string, string | readonly string[] | undefined>>

export const MIN_LIMIT = 1
export const MAX_LIMIT = 200
export const MAX_COLUMNS = 100
export const MAX_QUERY_TEXT_LENGTH = 256
export const MAX_CURSOR_LENGTH = 512

export const EMPTY_LIST_QUERY: ListQuery = {
  filter: [],
  sort: null,
  columns: null,
  q: null,
  view: null,
  limit: null,
  cursor: null,
}

function scalar(raw: RawQuery, key: string): Result<string | null> {
  const value = raw[key]
  if (value === undefined) return ok(null)
  if (Array.isArray(value)) {
    // Silently taking the last one would drop half a user's filters and return a plausible,
    // wrong set of people. Refuse instead.
    return fail('repeated_parameter', `"${key}" was given more than once.`, [key])
  }
  const text = value as string
  return ok(text.trim() === '' ? null : text)
}

/** `field:direction`, e.g. `check_size:desc`. */
/**
 * A sort as a saved view *stores* it, which is not how a URL carries it.
 *
 * `?sort=` is the string `field:direction` (ADR-032) because a query parameter is a string;
 * `saved_view.sort` is jsonb because a column is not. Two spellings of one idea, and this is the
 * one that crosses the wire as an object — `parseSort` and `serializeSort` remain the only bridge
 * between them.
 */
export const sortRequestSchema = z.object({
  field: z.string().min(1).max(120),
  direction: z.enum(SORT_DIRECTIONS),
})

export function parseSort(raw: string): Result<SortRequest> {
  const separator = raw.lastIndexOf(':')
  if (separator <= 0 || separator === raw.length - 1) {
    return fail(
      'malformed_query',
      `Sort must look like "field:asc" or "field:desc", got "${raw}".`,
      ['sort'],
    )
  }
  const field = raw.slice(0, separator)
  const direction = raw.slice(separator + 1)
  if (field.length > MAX_FIELD_REF_LENGTH) {
    return fail('malformed_query', 'That sort field name is too long.', ['sort'])
  }
  if (direction !== 'asc' && direction !== 'desc') {
    return fail('malformed_query', `Sort direction must be "asc" or "desc", got "${direction}".`, [
      'sort',
    ])
  }
  return ok({ field, direction })
}

export function serializeSort(sort: SortRequest): string {
  return `${sort.field}:${sort.direction}`
}

function parseColumns(raw: string): Result<readonly string[]> {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) {
    return fail('malformed_query', 'Name at least one column, or leave "columns" out.', ['columns'])
  }
  if (parts.length > MAX_COLUMNS) {
    return fail('malformed_query', `Name at most ${MAX_COLUMNS} columns.`, ['columns'])
  }
  const tooLong = parts.find((part) => part.length > MAX_FIELD_REF_LENGTH)
  if (tooLong !== undefined) {
    return fail('malformed_query', `"${tooLong}" is not a column name.`, ['columns'])
  }
  // Duplicates are a rendering bug waiting to happen; the first position wins.
  return ok([...new Set(parts)])
}

function parseLimit(raw: string): Result<number> {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    return fail(
      'out_of_range',
      `Limit must be a whole number between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
      ['limit'],
    )
  }
  return ok(value)
}

function parseFilterParam(raw: string): Result<FilterSet> {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return fail('malformed_query', 'The filter parameter is not valid JSON.', ['filter'])
  }
  if (!Array.isArray(decoded)) {
    return fail('malformed_query', 'The filter parameter must be a JSON array of conditions.', [
      'filter',
    ])
  }
  const parsed = parseFilterSet(decoded)
  if (!parsed.ok) {
    return failWith(parsed.issues.map((i) => ({ ...i, path: ['filter', ...i.path] })))
  }
  return parsed
}

/**
 * Parses a raw querystring object. Collects every problem it finds rather than stopping at the
 * first, so a hand-edited URL reports all of its mistakes at once.
 */
export function parseListQuery(raw: RawQuery): Result<ListQuery> {
  const issues: CoreIssue[] = []

  let filter: FilterSet = []
  let sort: SortRequest | null = null
  let columns: readonly string[] | null = null
  let q: string | null = null
  let view: string | null = null
  let limit: number | null = null
  let cursor: string | null = null

  const filterRaw = scalar(raw, 'filter')
  if (!filterRaw.ok) issues.push(...filterRaw.issues)
  else if (filterRaw.value !== null) {
    const parsed = parseFilterParam(filterRaw.value)
    if (parsed.ok) filter = parsed.value
    else issues.push(...parsed.issues)
  }

  const sortRaw = scalar(raw, 'sort')
  if (!sortRaw.ok) issues.push(...sortRaw.issues)
  else if (sortRaw.value !== null) {
    const parsed = parseSort(sortRaw.value)
    if (parsed.ok) sort = parsed.value
    else issues.push(...parsed.issues)
  }

  const columnsRaw = scalar(raw, 'columns')
  if (!columnsRaw.ok) issues.push(...columnsRaw.issues)
  else if (columnsRaw.value !== null) {
    const parsed = parseColumns(columnsRaw.value)
    if (parsed.ok) columns = parsed.value
    else issues.push(...parsed.issues)
  }

  const qRaw = scalar(raw, 'q')
  if (!qRaw.ok) issues.push(...qRaw.issues)
  else if (qRaw.value !== null) {
    if (qRaw.value.length > MAX_QUERY_TEXT_LENGTH) {
      issues.push({
        code: 'too_long',
        message: `Search for at most ${MAX_QUERY_TEXT_LENGTH} characters.`,
        path: ['q'],
      })
    } else {
      q = qRaw.value
    }
  }

  const viewRaw = scalar(raw, 'view')
  if (!viewRaw.ok) issues.push(...viewRaw.issues)
  else view = viewRaw.value

  const limitRaw = scalar(raw, 'limit')
  if (!limitRaw.ok) issues.push(...limitRaw.issues)
  else if (limitRaw.value !== null) {
    const parsed = parseLimit(limitRaw.value)
    if (parsed.ok) limit = parsed.value
    else issues.push(...parsed.issues)
  }

  const cursorRaw = scalar(raw, 'cursor')
  if (!cursorRaw.ok) issues.push(...cursorRaw.issues)
  else if (cursorRaw.value !== null) {
    if (cursorRaw.value.length > MAX_CURSOR_LENGTH) {
      issues.push({
        code: 'malformed_query',
        message: 'That cursor is not valid.',
        path: ['cursor'],
      })
    } else {
      cursor = cursorRaw.value
    }
  }

  if (issues.length > 0) return failWith(issues)
  return ok({ filter, sort, columns, q, view, limit, cursor })
}

/** The canonical form: what dirtiness comparison and cache keys are computed over. */
export function canonicalListQuery(query: ListQuery): ListQuery {
  return {
    filter: canonicalFilterSet(query.filter),
    sort: query.sort === null ? null : { field: query.sort.field, direction: query.sort.direction },
    // Column order is display order, so it is meaning, not noise: never sorted.
    columns: query.columns === null ? null : [...new Set(query.columns)],
    q: query.q,
    view: query.view,
    limit: query.limit,
    cursor: query.cursor,
  }
}

/**
 * Canonical querystring parameters. Absent keys are omitted rather than emitted empty, so an
 * untouched list page has a bare URL and two equivalent queries serialise byte-identically.
 */
export function serializeListQuery(query: ListQuery): Record<string, string> {
  const canonical = canonicalListQuery(query)
  const out: Record<string, string> = {}
  if (canonical.filter.length > 0) out['filter'] = JSON.stringify(canonical.filter)
  if (canonical.q !== null) out['q'] = canonical.q
  if (canonical.sort !== null) out['sort'] = serializeSort(canonical.sort)
  if (canonical.columns !== null) out['columns'] = canonical.columns.join(',')
  if (canonical.view !== null) out['view'] = canonical.view
  if (canonical.limit !== null) out['limit'] = String(canonical.limit)
  if (canonical.cursor !== null) out['cursor'] = canonical.cursor
  return out
}

/** The same parameters as a percent-encoded querystring, without a leading `?`. */
export function stringifyListQuery(query: ListQuery): string {
  return new URLSearchParams(serializeListQuery(query)).toString()
}

/** A stable string identity for a query — the memoisation key for the exact row count. */
export function listQuerySignature(query: ListQuery): string {
  return JSON.stringify(serializeListQuery(query))
}

/** The part of a list query a saved view stores (ADR-048). */
export type ViewSnapshot = Pick<ListQuery, 'filter' | 'sort' | 'columns'>

export function canonicalViewSnapshot(snapshot: ViewSnapshot): ViewSnapshot {
  const canonical = canonicalListQuery({ ...EMPTY_LIST_QUERY, ...snapshot })
  return { filter: canonical.filter, sort: canonical.sort, columns: canonical.columns }
}

/**
 * Whether the URL's working copy still matches the view's stored snapshot. The `⋮` menu's
 * "Save changes to view" and "Revert changes" are enabled by the negation of this.
 */
export function viewSnapshotsEqual(a: ViewSnapshot, b: ViewSnapshot): boolean {
  return JSON.stringify(canonicalViewSnapshot(a)) === JSON.stringify(canonicalViewSnapshot(b))
}
