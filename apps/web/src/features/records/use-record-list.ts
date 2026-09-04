/**
 * One list page at a time, forever (ADR-053).
 *
 * The cursor is opaque (ADR-023), so pages can only be walked, never indexed — which is exactly
 * what `useInfiniteQuery` does. The cursor is deliberately not part of the query key: putting it
 * there would give every page its own cache entry and throw away everything already loaded on each
 * fetch.
 */
import type { ListQuery } from '@mutuals/core'
import {
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from '@tanstack/react-query'
import { useMemo } from 'react'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import { requestParams } from '@/table/list-request.ts'
import type { RecordRow } from '@/table/record-row.ts'

import { recordEndpoint, type RecordListPage, type RecordObjectType } from './record-api.ts'

/** Two screens of a 40px row at a time: enough that scrolling never catches up with the fetch. */
export const PAGE_SIZE = 100

export interface RecordList {
  readonly rows: RecordRow[]
  readonly total: number | null
  readonly query: UseInfiniteQueryResult<InfiniteData<RecordListPage, unknown>, Error>
}

export function useRecordList(objectType: RecordObjectType, listQuery: ListQuery): RecordList {
  const endpoint = recordEndpoint(objectType)
  const params = useMemo(() => requestParams(listQuery), [listQuery])

  const query = useInfiniteQuery({
    queryKey: qk.recordList(objectType, params),
    queryFn: ({ pageParam, signal }) =>
      api.get(endpoint.list, endpoint.path, {
        search: { ...params, limit: PAGE_SIZE, cursor: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.page.hasMore ? last.page.cursor : undefined),
  })

  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data?.pages],
  )

  return { rows, total: query.data?.pages[0]?.meta.total ?? null, query }
}
