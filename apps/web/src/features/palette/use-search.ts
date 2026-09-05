/**
 * §4.8's global search, one query per keystroke, debounced.
 *
 * A query rather than a mutation — unlike `ask`, this costs a database round trip and no money, so
 * caching it is the right thing and TanStack's `staleTime` makes retyping a needle free. The
 * debounce is here rather than in the palette because the *query key* is what has to be stable:
 * debouncing the input value alone would still create a cache entry per keystroke.
 */
import { SearchResponseSchema, type SearchResponse } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

/** `gin_trgm_ops` needs three characters; the server answers empty below that and so do we. */
export const MIN_SEARCH_LENGTH = 3

/** Long enough that a fast typist sends one query, short enough to feel immediate. */
const DEBOUNCE_MS = 150

export function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value)
    }, ms)
    return () => {
      clearTimeout(timer)
    }
  }, [value, ms])
  return settled
}

export function useSearch(q: string): UseQueryResult<SearchResponse, Error> {
  const needle = q.trim()
  return useQuery({
    queryKey: qk.search(needle),
    queryFn: ({ signal }) =>
      api.get(SearchResponseSchema, '/search', { search: { q: needle }, signal }),
    enabled: needle.length >= MIN_SEARCH_LENGTH,
    // The workspace does not change under the palette while it is open.
    staleTime: 30_000,
  })
}
