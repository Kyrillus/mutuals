/**
 * "How many records hold this option?" — the number §6.7 requires before it asks whether to clear
 * or remap.
 *
 * There is no per-option count on the API, but there does not need to be one: the filter model is
 * the same vocabulary the table uses, so asking for one row of the list the user could have built
 * by hand and reading `meta.total` gives the exact number the confirmation has to state. The
 * operator comes from the type — `is_one_of` for a single select, `contains_any_of` for a multi —
 * so this file names no operator that the registry has not already assigned to the type.
 */
import { ListMetaSchema, PageSchema, type Filter, type ObjectType } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { z } from 'zod'

import { api } from '@/lib/api.ts'

/** Only the count is read, so the rows are not parsed into anything. */
const CountSchema = z.object({
  data: z.array(z.unknown()),
  page: PageSchema,
  meta: ListMetaSchema,
})

const LIST_PATH: Partial<Record<ObjectType, string>> = {
  contact: '/contacts',
  organization: '/organizations',
}

export function optionUsageFilter(slug: string, type: string, optionKey: string): Filter {
  return {
    field: slug,
    op: type === 'multi_select' ? 'contains_any_of' : 'is_one_of',
    values: [optionKey],
  }
}

export interface OptionUsageQuery {
  readonly objectType: ObjectType
  readonly slug: string
  readonly type: string
  readonly optionKey: string
  readonly enabled: boolean
}

/**
 * `null` means "cannot be counted from here" — an option on an interaction attribute, or one that
 * has never been saved and therefore cannot be on a record at all.
 */
export function useOptionUsage(query: OptionUsageQuery): UseQueryResult<number | null, Error> {
  const path = LIST_PATH[query.objectType]
  return useQuery({
    queryKey: ['option-usage', query.objectType, query.slug, query.optionKey],
    enabled: query.enabled && path !== undefined,
    queryFn: async ({ signal }) => {
      if (path === undefined) return null
      const filter = JSON.stringify([optionUsageFilter(query.slug, query.type, query.optionKey)])
      const response = await api.get(CountSchema, path, {
        search: { filter, limit: 1 },
        signal,
      })
      return response.meta.total
    },
    staleTime: 0,
  })
}
