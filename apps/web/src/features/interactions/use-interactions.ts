/**
 * §6.5's Activities: the timeline for one record, and the three writes that maintain it.
 *
 * Deliberately not routed through `record-api.ts`. That table is for object types the shared
 * `DataTable` renders — an interaction has no `attributes` map and no display label, and the file
 * says so. This is the adapter of its own it was waiting for.
 */
import {
  InteractionSchema,
  listResponseSchema,
  type CreateInteraction,
  type Interaction,
} from '@mutuals/core'
import { z } from 'zod'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'

import { api, type SearchParams } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const listSchema = listResponseSchema(InteractionSchema)

/** What every DELETE in this API answers. Declared per caller, as `attribute-api.ts` does. */
const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export interface TimelineQuery {
  readonly contactId?: string
  readonly organizationId?: string
  readonly type?: string
  readonly limit?: number
}

/** The query as the URL wants it: `undefined` entries are dropped by `buildUrl`. */
function searchOf(query: TimelineQuery): SearchParams {
  return {
    contactId: query.contactId,
    organizationId: query.organizationId,
    type: query.type,
    limit: query.limit,
  }
}

export function useInteractions(
  recordId: string,
  query: TimelineQuery,
): UseQueryResult<readonly Interaction[], Error> {
  return useQuery({
    queryKey: qk.interactionList(recordId, query as Record<string, unknown>),
    queryFn: ({ signal }) =>
      api
        .get(listSchema, '/interactions', { search: searchOf(query), signal })
        .then((response) => response.data),
  })
}

/**
 * Every write invalidates the record as well as the timeline: an interaction moves
 * `last_interaction_at`, `interaction_count_12m` and therefore warmth (§4.7), and those are
 * columns on the contact. Refetching the timeline alone would leave the Relationship card lying.
 */
function useTimelineMutation<TVariables>(
  recordId: string,
  run: (variables: TVariables) => Promise<unknown>,
  message: (variables: TVariables) => string,
): UseMutationResult<unknown, Error, TVariables> {
  const queryClient = useQueryClient()

  return useMutation<unknown, Error, TVariables>({
    mutationFn: run,
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: qk.interactions(recordId) })
      void queryClient.invalidateQueries({ queryKey: qk.record(recordId) })
      void queryClient.invalidateQueries({ queryKey: qk.records('contact') })
      toast.success(message(variables))
    },
    onError: (error) => {
      toast.error('Could not save the activity', { description: error.message })
    },
  })
}

export function useCreateInteraction(
  recordId: string,
): UseMutationResult<unknown, Error, CreateInteraction> {
  return useTimelineMutation(
    recordId,
    (body) => api.post(InteractionSchema, '/interactions', body),
    () => 'Activity logged',
  )
}

export function useUpdateInteraction(
  recordId: string,
): UseMutationResult<unknown, Error, { id: string; body: Record<string, unknown> }> {
  return useTimelineMutation(
    recordId,
    ({ id, body }) => api.patch(InteractionSchema, `/interactions/${id}`, body),
    () => 'Activity updated',
  )
}

export function useDeleteInteraction(
  recordId: string,
): UseMutationResult<unknown, Error, { id: string }> {
  return useTimelineMutation(
    recordId,
    ({ id }) => api.delete(DeleteResultSchema, `/interactions/${id}`),
    () => 'Activity deleted',
  )
}
