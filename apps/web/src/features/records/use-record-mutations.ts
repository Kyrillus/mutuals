/**
 * The two writes the table itself performs: create one record, delete many.
 *
 * Neither is optimistic. A create has no id until the server answers and a delete is §5.4's
 * confirmed, destructive action — pretending either has already happened buys a frame of
 * smoothness and costs the user their trust in the row count.
 */
import { BulkResultSchema, type BulkResult } from '@mutuals/core'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { toast } from 'sonner'

import { ApiError, api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import type { RecordRow } from '@/table/record-row.ts'

import { recordEndpoint, type RecordObjectType } from './record-api.ts'

export function useCreateRecord(
  objectType: RecordObjectType,
): UseMutationResult<RecordRow, Error, unknown> {
  const endpoint = recordEndpoint(objectType)
  const queryClient = useQueryClient()

  return useMutation<RecordRow, Error, unknown>({
    mutationFn: (body) => api.post(endpoint.one, endpoint.path, body),
    onSuccess: (record) => {
      queryClient.setQueryData(qk.record(record.id), record)
      // The new row's position depends on the active sort, which only the server knows.
      void queryClient.invalidateQueries({ queryKey: qk.records(objectType) })
      toast.success(`${record.displayName} added`)
    },
  })
}

export function useDeleteRecords(
  objectType: RecordObjectType,
): UseMutationResult<BulkResult, Error, readonly string[]> {
  const endpoint = recordEndpoint(objectType)
  const queryClient = useQueryClient()

  return useMutation<BulkResult, Error, readonly string[]>({
    mutationFn: (ids) => api.post(BulkResultSchema, `${endpoint.path}/bulk-delete`, { ids }),
    onSuccess: (result) => {
      for (const id of result.data.succeeded) queryClient.removeQueries({ queryKey: qk.record(id) })
      void queryClient.invalidateQueries({ queryKey: qk.records(objectType) })

      const { succeeded, failed } = result.meta
      if (failed === 0) {
        toast.success(`Deleted ${String(succeeded)} ${endpoint.noun}${succeeded === 1 ? '' : 's'}`)
        return
      }
      toast.warning(`Deleted ${String(succeeded)}, ${String(failed)} could not be deleted`, {
        description: result.data.failed[0]?.message,
      })
    },
    onError: (error) => {
      toast.error(`Nothing was deleted`, {
        description: error instanceof ApiError ? error.message : error.message,
      })
    },
  })
}
