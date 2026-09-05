/**
 * The two halves of §4.8's capture.
 *
 * Both are mutations. The preview is one because it costs money (ADR-070) and must happen when the
 * user presses a button rather than because a component remounted; the commit is one because it
 * writes. Neither retries — `retry: false` is TanStack's default for mutations, and here it is
 * load-bearing twice over: a retried preview bills twice for one sentence, and a retried commit
 * could write the capture twice.
 */
import {
  CommitQuickCaptureResponseSchema,
  QuickCaptureResponseSchema,
  type CommitQuickCapture,
  type CommitQuickCaptureResponse,
  type QuickCaptureResponse,
} from '@mutuals/core'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

export function useQuickCapture(): UseMutationResult<
  QuickCaptureResponse,
  Error,
  { text: string }
> {
  return useMutation({
    mutationFn: (body: { text: string }) =>
      api.post(QuickCaptureResponseSchema, '/quick-capture', body),
  })
}

export function useCommitCapture(): UseMutationResult<
  CommitQuickCaptureResponse,
  Error,
  CommitQuickCapture
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CommitQuickCapture) =>
      api.post(CommitQuickCaptureResponseSchema, '/quick-capture/commit', body),
    onSuccess: () => {
      // A capture can touch a contact, an organization, an interaction and a follow-up at once, so
      // it invalidates all four families rather than trying to patch four caches by hand.
      void queryClient.invalidateQueries({ queryKey: qk.records('contact') })
      void queryClient.invalidateQueries({ queryKey: qk.records('organization') })
      void queryClient.invalidateQueries({ queryKey: qk.followUps() })
      void queryClient.invalidateQueries({ queryKey: qk.stats() })
    },
  })
}
