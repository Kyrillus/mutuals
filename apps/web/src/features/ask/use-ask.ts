/**
 * §4.8's "ask the network", client side.
 *
 * A mutation rather than a query: asking costs money (ADR-070), so it must happen when the user
 * presses Enter and never because a component remounted or a window regained focus. TanStack's
 * `retry: false` default for mutations matters here for the same reason — a 504 that retried
 * itself would bill twice for one question.
 */
import { AskResponseSchema, type AskRequest, type AskResponse } from '@mutuals/core'
import { useMutation, type UseMutationResult } from '@tanstack/react-query'

import { SLOW_TIMEOUT_MS, api } from '@/lib/api.ts'

export function useAsk(): UseMutationResult<AskResponse, Error, AskRequest> {
  return useMutation({
    // ADR-065 gives the model 45 seconds of its own, so the browser must outwait it.
    mutationFn: (body: AskRequest) =>
      api.post(AskResponseSchema, '/ask', body, { timeoutMs: SLOW_TIMEOUT_MS }),
  })
}
