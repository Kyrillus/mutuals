/**
 * §4.5's history, fetched when the popover opens and not before.
 *
 * A contact detail page shows twenty-odd attributes and almost nobody opens the history of any of
 * them, so eager loading would multiply every page view by twenty for the sake of a click that
 * usually does not happen. `enabled` is what makes it lazy.
 */
import { ValueHistorySchema, type ValueHistoryDto } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

export function useValueHistory(
  recordId: string,
  attributeId: string | undefined,
  enabled: boolean,
): UseQueryResult<ValueHistoryDto, Error> {
  return useQuery({
    queryKey: qk.valueHistory(recordId, attributeId ?? ''),
    queryFn: ({ signal }) =>
      api.get(ValueHistorySchema, `/records/${recordId}/history/${attributeId ?? ''}`, { signal }),
    enabled: enabled && attributeId !== undefined,
    // The log is append-only, so what has been fetched cannot become wrong — only incomplete, and
    // only by an edit this same page made, which invalidates the key itself.
    staleTime: 60_000,
  })
}
