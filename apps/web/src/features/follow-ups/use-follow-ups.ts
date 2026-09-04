/**
 * §6.4's follow-ups: the list behind the quick-filter tabs, and the four writes.
 *
 * Like interactions, and for the same reason, this does not go through `record-api.ts`: a follow-up
 * carries no `attributes` map and no display label, so the shared `DataTable` is the wrong consumer
 * and the wrong abstraction to widen.
 *
 * `state` is never computed here. It is derived server-side from the profile's today (see the
 * contract), so the red due date, the dashboard's attention list and the `open_followups` metric
 * cannot disagree about what "overdue" means at midnight. ADR-091 is the rule this follows.
 */
import {
  FollowUpSchema,
  UpdateFollowUpResponseSchema,
  listResponseSchema,
  type CreateFollowUp,
  type FollowUp,
  type FollowUpState,
  type FollowUpStatus,
} from '@mutuals/core'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { api, type SearchParams } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const listSchema = listResponseSchema(FollowUpSchema)
const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export interface FollowUpQuery {
  readonly status?: FollowUpStatus
  readonly state?: FollowUpState
  readonly contactId?: string
  readonly dueBefore?: string
  readonly limit?: number
}

function searchOf(query: FollowUpQuery): SearchParams {
  return {
    status: query.status,
    state: query.state,
    contactId: query.contactId,
    dueBefore: query.dueBefore,
    limit: query.limit,
  }
}

export function useFollowUps(query: FollowUpQuery): UseQueryResult<readonly FollowUp[], Error> {
  return useQuery({
    queryKey: qk.followUpList(query as Record<string, unknown>),
    queryFn: ({ signal }) =>
      api
        .get(listSchema, '/follow-ups', { search: searchOf(query), signal })
        .then((response) => response.data),
  })
}

/**
 * Everything that touches a follow-up invalidates the same three families: every follow-up list,
 * the contact behind it — `open_followups` and `next_followup_at` are columns on the contact — and
 * the dashboard's counts. Refetching the list alone leaves two other screens lying.
 */
function useFollowUpMutation<TVariables, TResult>(
  run: (variables: TVariables) => Promise<TResult>,
  onDone: (result: TResult, variables: TVariables) => void,
): UseMutationResult<TResult, Error, TVariables> {
  const queryClient = useQueryClient()

  return useMutation<TResult, Error, TVariables>({
    mutationFn: run,
    onSuccess: (result, variables) => {
      void queryClient.invalidateQueries({ queryKey: qk.followUps() })
      void queryClient.invalidateQueries({ queryKey: qk.records('contact') })
      void queryClient.invalidateQueries({ queryKey: qk.stats() })
      onDone(result, variables)
    },
    onError: (error) => {
      toast.error('Could not save the follow-up', { description: error.message })
    },
  })
}

export function useCreateFollowUp(): UseMutationResult<FollowUp, Error, CreateFollowUp> {
  return useFollowUpMutation(
    (body) => api.post(FollowUpSchema, '/follow-ups', body),
    () => {
      toast.success('Follow-up created')
    },
  )
}

export interface FollowUpPatch {
  readonly id: string
  readonly body: Record<string, unknown>
}

/**
 * Marking a recurring follow-up done creates the next occurrence *inside this one operation*, and
 * the response says which. So the toast can name the next date rather than the client having to
 * sequence "complete" then "create", or know the recurrence rules at all (§4.1).
 */
export function useUpdateFollowUp(): UseMutationResult<
  z.output<typeof UpdateFollowUpResponseSchema>,
  Error,
  FollowUpPatch
> {
  return useFollowUpMutation(
    ({ id, body }) => api.patch(UpdateFollowUpResponseSchema, `/follow-ups/${id}`, body),
    (result) => {
      if (result.next !== null) {
        toast.success('Done — the next one is scheduled', {
          description: `${result.next.title} · due ${result.next.dueAt}`,
        })
        return
      }
      toast.success(result.data.status === 'Done' ? 'Marked done' : 'Follow-up updated')
    },
  )
}

export function useDeleteFollowUp(): UseMutationResult<unknown, Error, { id: string }> {
  return useFollowUpMutation(
    ({ id }) => api.delete(DeleteResultSchema, `/follow-ups/${id}`),
    () => {
      toast.success('Follow-up deleted')
    },
  )
}
