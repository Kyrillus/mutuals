/**
 * §5.2's inline edit: optimistic, rolled back on failure, with an error toast that offers Retry.
 *
 * ADR-049's corrected protocol, point by point:
 *
 *  1. **Both cache families are snapshotted.** The list pages *and* `qk.record(id)`. Patching two
 *     and restoring one is how the table and the detail sidebar end up disagreeing about a value
 *     that was never written.
 *  2. **`scope` is not used.** `MutationScope` is static per `useMutation` instance, so one shared
 *     hook cannot serialise per cell with it. Instead a module-level map keyed by
 *     `${recordId}:${slug}` holds a rising sequence number, and `onSuccess` is a **no-op when a
 *     newer write for the same cell is in flight** — otherwise two fast edits can commit out of
 *     order and the older response overwrites the newer value.
 *  4. **The snapshot belongs to the cell, not to the write.** Found in Stage 7 by killing the
 *     server mid-edit: two writes for one cell meant the second snapshotted the *first one's
 *     optimistic value*, so the rollback restored the value that had just failed to save and the
 *     cell kept a number the database had never seen. The first write to touch an idle cell takes
 *     the snapshot; every later one shares it, and it is thrown away when the last of them settles.
 *     A failure while a newer write is still in flight does not roll back at all — that write will
 *     either commit its own value or roll back to the same original.
 *  3. **Retry calls `.mutate` on the mutation object**, reached through a ref, because the object
 *     does not exist yet while its own options are being constructed.
 */
import type { AttributeDefinitionDto, FieldDescriptor } from '@mutuals/core'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import type { RecordRow } from '@/table/record-row.ts'

import { optimisticValue } from './optimistic-value.ts'
import {
  cellKey,
  patchRecord,
  patchRowInPages,
  withAttribute,
  type RecordListData,
} from './record-cache.ts'
import { recordEndpoint, type RecordObjectType } from './record-api.ts'

/** Rising per cell. Module-level because it must outlive the component the cell scrolled out of. */
const inFlight = new Map<string, number>()
let sequence = 0

/** The cell's value before *any* of its in-flight writes touched it. See point 4 above. */
const snapshots = new Map<string, EditSnapshot>()

export interface EditVariables {
  readonly row: RecordRow
  readonly field: FieldDescriptor
  readonly definition: AttributeDefinitionDto
  /** The write value the control produced. `null` clears the attribute (ADR-017, ADR-031). */
  readonly write: unknown
}

interface EditSnapshot {
  readonly lists: [readonly unknown[], RecordListData | undefined][]
  readonly detail: RecordRow | undefined
}

interface EditContext {
  readonly key: string
  readonly seq: number
  readonly snapshot: EditSnapshot
}

export interface RecordEditor {
  commit(
    row: RecordRow,
    field: FieldDescriptor,
    definition: AttributeDefinitionDto,
    write: unknown,
  ): void
  readonly pendingCells: ReadonlySet<string>
}

export function useRecordEdit(objectType: RecordObjectType): RecordEditor {
  const endpoint = recordEndpoint(objectType)
  const queryClient = useQueryClient()
  const [pendingCells, setPendingCells] = useState<ReadonlySet<string>>(new Set())
  const mutationRef = useRef<UseMutationResult<
    RecordRow,
    Error,
    EditVariables,
    EditContext
  > | null>(null)

  const markPending = useCallback((key: string, pending: boolean) => {
    setPendingCells((current) => {
      const next = new Set(current)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const mutation = useMutation<RecordRow, Error, EditVariables, EditContext>({
    mutationFn: ({ row, field, write }) =>
      api.patch(endpoint.one, `${endpoint.path}/${row.id}`, {
        attributes: { [field.slug]: write },
      }),

    onMutate: async ({ row, field, definition, write }) => {
      const key = cellKey(row.id, field.slug)
      // Read before the write below claims the cell: whether this is the first write decides
      // whether what the cache holds now is the original value or an earlier optimistic one.
      const isFirstForCell = !inFlight.has(key)
      sequence += 1
      const seq = sequence
      inFlight.set(key, seq)
      markPending(key, true)

      // An in-flight refetch would land after the patch and undo it.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: qk.records(objectType) }),
        queryClient.cancelQueries({ queryKey: qk.record(row.id) }),
      ])

      if (isFirstForCell) {
        snapshots.set(key, {
          lists: queryClient.getQueriesData<RecordListData>({ queryKey: qk.records(objectType) }),
          detail: queryClient.getQueryData<RecordRow>(qk.record(row.id)),
        })
      }

      applyPatch(queryClient, objectType, row.id, (current) =>
        withAttribute(current, field.slug, optimisticValue(definition, write)),
      )

      return { key, seq, snapshot: snapshots.get(key) ?? { lists: [], detail: undefined } }
    },

    onError: (error, variables, context) => {
      // A newer write for the same cell is still in flight; it owns what the cell shows next, and
      // rolling back under it would put the original value on screen and then take it away again.
      if (context !== undefined && inFlight.get(context.key) === context.seq) {
        restore(queryClient, context.snapshot, variables.row.id)
      }
      toast.error(`Could not save ${variables.field.label}`, {
        description: describe(error),
        action: {
          label: 'Retry',
          onClick: () => {
            mutationRef.current?.mutate(variables)
          },
        },
      })
    },

    onSuccess: (record, _variables, context) => {
      // A newer write for the same cell is already in flight: writing this response back would
      // put the older value on screen and leave it there.
      if (inFlight.get(context.key) !== context.seq) return
      applyPatch(queryClient, objectType, record.id, () => record)
    },

    onSettled: (_record, _error, _variables, context) => {
      if (context === undefined) return
      // Only the last write for a cell releases it. An older one settling out of order must not
      // stop the pulse or drop the snapshot the newer one still needs to roll back to.
      if (inFlight.get(context.key) !== context.seq) return
      inFlight.delete(context.key)
      snapshots.delete(context.key)
      markPending(context.key, false)
    },
  })

  useEffect(() => {
    mutationRef.current = mutation
  })

  const commit = useCallback(
    (
      row: RecordRow,
      field: FieldDescriptor,
      definition: AttributeDefinitionDto,
      write: unknown,
    ) => {
      mutation.mutate({ row, field, definition, write })
    },
    [mutation],
  )

  return { commit, pendingCells }
}

function applyPatch(
  queryClient: ReturnType<typeof useQueryClient>,
  objectType: string,
  id: string,
  patch: (row: RecordRow) => RecordRow,
): void {
  queryClient.setQueriesData<RecordListData>({ queryKey: qk.records(objectType) }, (data) =>
    patchRowInPages(data, id, patch),
  )
  queryClient.setQueryData<RecordRow>(qk.record(id), (record) => patchRecord(record, id, patch))
}

function restore(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshot: EditSnapshot,
  id: string,
): void {
  for (const [key, data] of snapshot.lists) queryClient.setQueryData(key, data)
  queryClient.setQueryData(qk.record(id), snapshot.detail)
}

function describe(error: Error): string {
  if (!(error instanceof ApiError)) return error.message
  const field = error.errors[0]
  return field?.message ?? error.message
}
