/**
 * The URL is the working copy (ADR-048), and this file is the only place that says so.
 *
 * `packages/core` owns the wire codec — `parseListQuery` reads raw query parameters into a
 * `ListQuery`, `serializeListQuery` writes the canonical ones back. The same pair serves Fastify
 * and, from Stage 6, the LLM. Nothing here re-implements any of it; what it adds is the one thing
 * core cannot know: TanStack Router does not hand a validator raw strings.
 *
 * Its default `parseSearch` is `parseSearchWith(JSON.parse)` over a `decode()` that already turns
 * `"50"` into `50` and `"true"` into `true`, so by the time `validateSearch` runs, `?filter=[…]`
 * is an array, `?limit=50` is a number and `?sort=display_name:asc` is still a string.
 * {@link toRawQuery} puts every one of them back into the exact text the wire codec parses, so
 * there is one parser and one canonicalisation rather than a second, subtly different one here.
 *
 * The reverse direction matters just as much: what {@link toListSearch} returns *is* the URL.
 * `filter` stays a structured array because the router's `stringifySearch` JSON-stringifies
 * objects — which is precisely ADR-032's `?filter=<JSON>` — while `sort`, `columns`, `q` and
 * `view` stay the canonical strings `serializeListQuery` produced, because the router emits a
 * string that does not look like JSON verbatim. The result is a browser URL that is byte-for-byte
 * the API's query string, which is what makes a filtered view a shareable link (§5.2).
 */
import {
  EMPTY_LIST_QUERY,
  canonicalListQuery,
  parseListQuery,
  serializeListQuery,
  type CoreIssue,
  type FilterSet,
  type ListQuery,
  type RawQuery,
  type SortRequest,
} from '@mutuals/core'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

/**
 * The search parameters of every list route, as the router holds them in memory.
 *
 * Deliberately not `ListQuery`: this is the *wire* shape, one property per query parameter, so
 * what the router stringifies is what the API would have parsed. `cursor` is absent by design
 * (ADR-032) — it belongs to the API contract and to `getNextPageParam`, and putting it in the URL
 * would make every shared link carry a stale page position.
 */
export type ListSearch = {
  readonly filter?: FilterSet
  readonly sort?: string
  readonly columns?: string
  readonly q?: string
  readonly view?: string
  readonly limit?: number
}

/** A hand-edited URL that the wire codec refuses, with every problem it found. */
export class ListSearchError extends Error {
  readonly issues: readonly CoreIssue[]

  constructor(issues: readonly CoreIssue[]) {
    super(issues.map((problem) => problem.message).join(' '))
    this.name = 'ListSearchError'
    this.issues = issues
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * The router's parsed search object, back in the raw form the wire codec parses.
 *
 * The one ambiguity is an array: `?filter=a&filter=b` decodes to `['a', 'b']` and so does the
 * JSON array `?filter=["a","b"]`. A repeated parameter always yields two or more entries, so two
 * or more strings are handed through as an array and the codec refuses them by name ("filter was
 * given more than once"), which is the message that describes the mistake a person actually made.
 * Everything else — objects, arrays of objects, numbers, booleans — becomes its JSON text.
 */
export function toRawQuery(search: Readonly<Record<string, unknown>>): RawQuery {
  const raw: Record<string, string | readonly string[]> = {}
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') raw[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') raw[key] = String(value)
    else if (isStringArray(value) && value.length > 1) raw[key] = value
    else raw[key] = JSON.stringify(value)
  }
  return raw
}

/** The canonical search object for a query — what the URL should read. */
export function toListSearch(query: ListQuery): ListSearch {
  const canonical = canonicalListQuery(query)
  const params = serializeListQuery(canonical)
  return {
    // An array rather than `params.filter`'s JSON text: the router stringifies an object with
    // `JSON.stringify` and re-quotes a string that already looks like JSON, so handing it the
    // text would produce `?filter="[{…}]"` — valid, unreadable, and not what the API parses.
    ...(canonical.filter.length > 0 ? { filter: canonical.filter } : {}),
    ...(params['sort'] === undefined ? {} : { sort: params['sort'] }),
    ...(params['columns'] === undefined ? {} : { columns: params['columns'] }),
    ...(params['q'] === undefined ? {} : { q: params['q'] }),
    ...(params['view'] === undefined ? {} : { view: params['view'] }),
    ...(canonical.limit === null ? {} : { limit: canonical.limit }),
  }
}

/**
 * A list route's `validateSearch`.
 *
 * It throws on a URL the codec refuses rather than silently dropping the offending parameter:
 * a truncated `?filter=` that quietly returns every contact is a plausible, wrong answer, and
 * §5.2's whole promise is that the URL says what you are looking at. TanStack turns the throw
 * into a `SearchParamError` on the match, so the route's error boundary renders and the sidebar
 * still navigates away from it.
 */
export function validateListSearch(input: Record<string, unknown>): ListSearch {
  const parsed = parseListQuery(toRawQuery(input))
  if (!parsed.ok) throw new ListSearchError(parsed.issues)
  return toListSearch(parsed.value)
}

/**
 * The querystring itself, split into raw parameters — the very bytes Fastify's parser is handed.
 *
 * Reading the address bar rather than the router's parsed object takes JSON.parse out of the read
 * path entirely, so a repeated `?q=one&q=two` is still two values here and is refused by name
 * instead of arriving as an array that has to be told apart from a JSON one.
 */
export function rawFromSearchString(searchStr: string): RawQuery {
  const params = new URLSearchParams(searchStr)
  const raw: Record<string, string | readonly string[]> = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    raw[key] = all.length > 1 ? all : (all[0] ?? '')
  }
  return raw
}

/** Reads the router's search object back into a `ListQuery`. */
export function readListQuery(search: Readonly<Record<string, unknown>>): ListQuery {
  return listQueryOf(toRawQuery(search))
}

function listQueryOf(raw: RawQuery): ListQuery {
  const parsed = parseListQuery(raw)
  // Unreachable through the router, which validated the same bytes on the way in. Falling back
  // rather than throwing keeps a render from failing on a URL that is already an error state.
  return parsed.ok ? canonicalListQuery(parsed.value) : EMPTY_LIST_QUERY
}

export interface ListQueryUpdateOptions {
  /** Typing in the search box replaces; adding a chip pushes, so Back undoes one filter. */
  readonly replace?: boolean
}

export interface ListQueryState {
  /** The working copy, canonical, as the table and the filter bar read it. */
  readonly query: ListQuery
  /** The same thing as query-string parameters, for the API request. */
  readonly params: Record<string, string>
  update: (patch: Partial<ListQuery>, options?: ListQueryUpdateOptions) => void
  setFilters: (filter: FilterSet, options?: ListQueryUpdateOptions) => void
  setSort: (sort: SortRequest | null) => void
  setColumns: (columns: readonly string[] | null) => void
  setSearchText: (q: string | null) => void
  setView: (view: string | null) => void
}

/**
 * The list route's state, read from and written to the URL.
 *
 * There is no store and no copy in React state (ADR-049): the URL is read on every render and
 * every setter is a navigation, so the Back button, a pasted link and a bookmark all behave the
 * same way as clicking.
 */
export function useListQuery(): ListQueryState {
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const navigate = useNavigate()

  const query = useMemo(() => listQueryOf(rawFromSearchString(searchStr)), [searchStr])

  const update = useCallback(
    (patch: Partial<ListQuery>, options?: ListQueryUpdateOptions) => {
      // `view` is named explicitly so that clearing it wins over `retainSearchParams(['view'])`,
      // which only re-adds a key the next search does not mention at all. The object is built
      // outside the call because a fresh literal there is excess-property-checked against every
      // route's search type at once, and a route that has not declared one yet has none.
      const next: ListSearch = { view: undefined, ...toListSearch({ ...query, ...patch }) }
      void navigate({ to: '.', search: () => next, replace: options?.replace ?? false })
    },
    [navigate, query],
  )

  const setFilters = useCallback(
    (filter: FilterSet, options?: ListQueryUpdateOptions) => {
      update({ filter }, options)
    },
    [update],
  )

  const setSort = useCallback(
    (sort: SortRequest | null) => {
      update({ sort })
    },
    [update],
  )

  const setColumns = useCallback(
    (columns: readonly string[] | null) => {
      update({ columns })
    },
    [update],
  )

  const setSearchText = useCallback(
    (q: string | null) => {
      update({ q: q === null || q.trim() === '' ? null : q }, { replace: true })
    },
    [update],
  )

  const setView = useCallback(
    (view: string | null) => {
      update({ view })
    },
    [update],
  )

  const params = useMemo(() => serializeListQuery(query), [query])

  return { query, params, update, setFilters, setSort, setColumns, setSearchText, setView }
}
