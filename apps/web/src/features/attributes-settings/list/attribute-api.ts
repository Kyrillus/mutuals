/**
 * The calls this page makes, and the cache they share with the rest of the app.
 *
 * The list is read under `qk.attributeDefinitions(objectType)` — the very key the Contacts table
 * reads its schema from — so a field created or deleted here reaches that table by invalidating
 * one entry rather than by anyone remembering to refetch. Deleting a definition also deletes its
 * values, so the record lists go with it.
 */
import { DeleteAttributePreviewSchema, type ObjectType } from '@mutuals/core'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const PATH = '/attribute-definitions'

const deleteSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

/**
 * The list itself is read through the editor's hook rather than a third copy of it: `editor/` and
 * `list/` are two folders of one feature, so this is not the sibling-feature import the boundary
 * forbids. Both read `qk.attributeDefinitions(objectType)`, so §6.6's card count and §6.7's table
 * are one cache entry read twice — the only arrangement in which they cannot disagree.
 */
export { useAttributeDefinitions } from '../editor/use-definitions.ts'

export type DeletePreview = z.output<typeof DeleteAttributePreviewSchema>

/**
 * §5.4's numbers, fetched before the button that needs them is offered.
 *
 * One query for the whole selection rather than one per row: the dialog is a single sentence
 * about a single decision, and it should appear in one state change rather than flickering as
 * four requests land. The key carries the ids so re-opening the dialog on the same rows is
 * instant and re-opening it on different ones is not stale.
 *
 * `enabled` rather than an empty id list while the dialog is shut, because the key must not change
 * on the way out: a closing dialog animates for a moment longer than it is `open`, and a key that
 * changed underneath it would repaint the sentence as it fades.
 */
export function useDeletePreviews(
  ids: readonly string[],
  enabled: boolean,
): UseQueryResult<DeletePreview[], Error> {
  const key = [...ids].sort()
  return useQuery({
    queryKey: ['attribute-delete-preview', key],
    enabled: enabled && key.length > 0,
    // The counts are the whole point of the dialog: they must be current, not the ones from the
    // last time these rows were looked at.
    staleTime: 0,
    queryFn: ({ signal }) =>
      Promise.all(
        key.map((id) =>
          api.get(DeleteAttributePreviewSchema, `${PATH}/${id}/delete-preview`, { signal }),
        ),
      ),
  })
}

export function useDeleteAttributes(
  objectType: ObjectType,
): UseMutationResult<readonly string[], Error, readonly string[]> {
  const queryClient = useQueryClient()

  return useMutation<readonly string[], Error, readonly string[]>({
    // Sequential, not `Promise.all`: each delete cascades over facts, values and links, and a
    // handful of them arriving at once buys nothing a user can perceive.
    mutationFn: async (ids) => {
      const deleted: string[] = []
      for (const id of ids) {
        await api.delete(deleteSchema, `${PATH}/${id}`)
        deleted.push(id)
      }
      return deleted
    },
    // On `onSettled` rather than `onSuccess`: the loop is not a transaction, so a failure on the
    // third id leaves the first two deleted and the caches have to learn about them anyway.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.attributeDefinitions(objectType) })
      // The field is gone from every record that had it, and from the columns of every table
      // built out of these definitions.
      void queryClient.invalidateQueries({ queryKey: qk.records(objectType) })
    },
    onSuccess: (deleted) => {
      toast.success(
        deleted.length === 1 ? 'Attribute deleted' : `${String(deleted.length)} attributes deleted`,
      )
    },
    // Deliberately not "nothing was deleted": the loop is sequential, so a failure on the third id
    // leaves two gone. `onSettled` has already refetched the list, and what it shows is the truth.
    onError: (error) => {
      toast.error('Could not delete', { description: error.message })
    },
  })
}
