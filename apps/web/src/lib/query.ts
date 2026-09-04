/**
 * The server cache, and the query keys everything else is written against.
 *
 * ADR-049 assigns state to exactly four homes, and writing them down here is the whole defence
 * against a fifth appearing:
 *
 *   1. **The URL** owns filters, sort, columns and the current view. That is what makes a view
 *      shareable (§5.2) and what makes a saved view a snapshot loaded into the URL (ADR-048).
 *   2. **The server cache** — this file — owns everything fetched. Nothing that came from the API
 *      is copied into React state; it is read from the cache where it landed.
 *   3. **Component state** owns the rest: an open dialog, focus, which cell is being edited.
 *   4. **Nothing else.** There is no client store. If a piece of state does not fit one of the
 *      three above, the design is wrong before the library choice is.
 */
import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './api.ts'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Long enough that switching between two tables does not refetch, short enough that a value
      // edited in another tab shows up without a reload.
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // A 4xx is the server saying no. Repeating the request cannot change the answer, and the
        // §5.2 error toast should fire immediately rather than three seconds later.
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
})

/**
 * One place that knows how a cache entry is addressed. The list key is a prefix of nothing else, so
 * ADR-049's optimistic patch can reach every page of a list with a single
 * `getQueriesData({ queryKey: qk.records(objectType) })` and still snapshot `qk.record(id)` beside
 * it — the divergence that ADR-049 calls out is a missing key family, not a missing line of code.
 */
export const qk = {
  stats: () => ['stats'] as const,
  profile: () => ['profile'] as const,
  attributeDefinitions: (objectType: string) => ['attribute-definitions', objectType] as const,
  /** Every list page for one object type, whatever the filter. */
  records: (objectType: string) => ['records', objectType] as const,
  /** One page: the serialised list query decides identity, so two URLs never share a cache entry. */
  recordList: (objectType: string, query: Readonly<Record<string, unknown>>) =>
    ['records', objectType, query] as const,
  record: (id: string) => ['record', id] as const,
  /** §6.5's Connections tab: organizations, people and who else works there, in one operation. */
  connections: (id: string) => ['connections', id] as const,
  /** §4.5's history popover — per record *and* per attribute, because it is fetched when opened. */
  valueHistory: (id: string, attributeId: string) => ['value-history', id, attributeId] as const,
  /** Every interaction timeline for one record, whatever the type filter is set to. */
  interactions: (recordId: string) => ['interactions', recordId] as const,
  interactionList: (recordId: string, query: Readonly<Record<string, unknown>>) =>
    ['interactions', recordId, query] as const,
}
