/**
 * Whether the AI features can run at all, and what they have cost today.
 *
 * Fetched before the user types rather than discovered from a 503 afterwards: a fresh checkout has
 * no API key, the rest of the app works perfectly well without one, and the honest thing is to say
 * so on the input instead of taking a question and then refusing it.
 */
import { LlmStatsSchema, type LlmStats } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

export function useLlmStats(): UseQueryResult<LlmStats, Error> {
  return useQuery({
    queryKey: qk.llmStats(),
    queryFn: ({ signal }) => api.get(LlmStatsSchema, '/stats/llm', { signal }),
  })
}
