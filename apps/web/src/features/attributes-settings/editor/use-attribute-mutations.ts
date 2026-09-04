/**
 * The two writes the dialog performs.
 *
 * Neither is optimistic, and that is the whole point of §4.2's bet: creating a field is one
 * `INSERT` with no DDL behind it, so the honest thing is to wait the few milliseconds and then show
 * the row the server actually has. Pretending a column exists before it does would be the one place
 * in the product where the table could be lying about the schema.
 *
 * The definition cache is what every other screen reads — the column factory, the filter picker,
 * the create-record dialog (ADR-052) — so invalidating it is what makes a field invented here
 * appear there without a reload.
 */
import {
  AttributeDefinitionSchema,
  type AttributeDefinitionDto,
  type ObjectType,
} from '@mutuals/core'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const PATH = '/attribute-definitions'

export function useCreateAttribute(
  objectType: ObjectType,
): UseMutationResult<AttributeDefinitionDto, Error, Record<string, unknown>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(AttributeDefinitionSchema, PATH, body),
    onSuccess: () => invalidate(queryClient, objectType),
  })
}

export function useUpdateAttribute(
  objectType: ObjectType,
  attributeId: string | undefined,
): UseMutationResult<AttributeDefinitionDto, Error, Record<string, unknown>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (attributeId === undefined) {
        throw new Error('useUpdateAttribute was called without an attribute id')
      }
      return api.patch(AttributeDefinitionSchema, `${PATH}/${attributeId}`, body)
    },
    onSuccess: () => invalidate(queryClient, objectType),
  })
}

/**
 * Rows carry their values as an `attributes` map keyed by slug, so a renamed field, a new option
 * colour or a changed unit all change how an already-fetched row renders. The definitions are the
 * schema and the rows are the data; both have to be refetched or the table renders last week's
 * schema over this week's values.
 */
function invalidate(queryClient: ReturnType<typeof useQueryClient>, objectType: ObjectType): void {
  void queryClient.invalidateQueries({ queryKey: qk.attributeDefinitions(objectType) })
  void queryClient.invalidateQueries({ queryKey: qk.records(objectType) })
}
