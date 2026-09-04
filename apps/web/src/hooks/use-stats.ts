import { StatsSchema } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

/** `@mutuals/core` exports the schema but not this alias, so it is derived rather than restated. */
export type Stats = z.output<typeof StatsSchema>

/**
 * §6.1's numbers. `today` comes back with them because the API computes the counts against the
 * profile's timezone (ADR-045) — the browser's own date can be a day off, which would make "due
 * this week" disagree with the number printed beside it.
 */
export function useStats(): UseQueryResult<Stats, Error> {
  return useQuery({
    queryKey: qk.stats(),
    queryFn: ({ signal }) => api.get(StatsSchema, '/stats', { signal }),
  })
}
