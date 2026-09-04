/**
 * §6.6's saved views on the client.
 *
 * ADR-048 decides everything structural here: the URL is the working copy, a view is a named
 * snapshot loaded into it, and "dirty" is deep equality over the canonical `(filters, sort,
 * columns)` triple. `viewSnapshotsEqual` in `packages/core` is that comparison, and it is the same
 * canonicalisation `serializeListQuery` applies — so the menu, the breadcrumb and the management
 * screen cannot disagree about whether something has changed.
 */
import {
  SavedViewSchema,
  listResponseSchema,
  type CreateSavedView,
  type ObjectType,
  type SavedView,
} from '@mutuals/core'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { z } from 'zod'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const listSchema = listResponseSchema(SavedViewSchema)
const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export function useViews(objectType: ObjectType): UseQueryResult<readonly SavedView[], Error> {
  return useQuery({
    queryKey: qk.views(objectType),
    queryFn: ({ signal }) =>
      api
        .get(listSchema, '/views', { search: { objectType }, signal })
        .then((response) => response.data),
    // A view changes when somebody saves one, which invalidates this key. Nothing else moves it.
    staleTime: 5 * 60_000,
  })
}

function useViewMutation<TVariables, TResult>(
  objectType: ObjectType,
  run: (variables: TVariables) => Promise<TResult>,
  message: (result: TResult, variables: TVariables) => string,
): UseMutationResult<TResult, Error, TVariables> {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useMutation<TResult, Error, TVariables>({
    mutationFn: run,
    onSuccess: (result, variables) => {
      void queryClient.invalidateQueries({ queryKey: qk.views(objectType) })
      // The breadcrumb's name comes from a route loader, and the router caches loader data per
      // navigation — so renaming a view without this leaves the old name in the crumb until the
      // next navigation. Invalidating the router is what makes the rename visible where §5.2 puts it.
      void router.invalidate()
      toast.success(message(result, variables))
    },
    onError: (error) => {
      toast.error('Could not save the view', { description: error.message })
    },
  })
}

export function useCreateView(
  objectType: ObjectType,
): UseMutationResult<SavedView, Error, CreateSavedView> {
  return useViewMutation(
    objectType,
    (body) => api.post(SavedViewSchema, '/views', body),
    (view) => `"${view.name}" saved`,
  )
}

export interface ViewPatch {
  readonly id: string
  readonly body: Record<string, unknown>
}

export function useUpdateView(
  objectType: ObjectType,
): UseMutationResult<SavedView, Error, ViewPatch> {
  return useViewMutation(
    objectType,
    ({ id, body }) => api.patch(SavedViewSchema, `/views/${id}`, body),
    (view) => `"${view.name}" updated`,
  )
}

export function useDeleteView(
  objectType: ObjectType,
): UseMutationResult<unknown, Error, { id: string; name: string }> {
  return useViewMutation(
    objectType,
    ({ id }) => api.delete(DeleteResultSchema, `/views/${id}`),
    (_result, variables) => `"${variables.name}" deleted`,
  )
}
