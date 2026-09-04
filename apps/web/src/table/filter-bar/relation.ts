/**
 * The two things a relation filter needs that no other field does: which object type its ids
 * point at, and what those ids are called.
 */
import { typeDef, type FieldDescriptor, type Filter, type ObjectType } from '@mutuals/core'
import { useQueries } from '@tanstack/react-query'

import { RECORD_SOURCES } from './record-source.ts'

/**
 * `relation` is the one type whose behaviour comes out of its config (ADR-036), so the target is
 * read through the registry's own schema rather than by reaching into `config` with a string.
 */
export function relationTarget(field: FieldDescriptor): ObjectType | undefined {
  if (field.source.kind !== 'attribute' || field.source.def.type !== 'relation') return undefined
  const parsed = typeDef('relation').configSchema.safeParse(field.source.def.config)
  return parsed.success ? parsed.data.targetObjectType : undefined
}

export interface RecordRef {
  readonly id: string
  readonly objectType: ObjectType
}

/** Every record id mentioned by a filter set, with the object type it belongs to. */
export function relationRefs(
  filters: readonly Filter[],
  fieldFor: (slug: string) => FieldDescriptor | undefined,
): readonly RecordRef[] {
  const refs = new Map<string, RecordRef>()
  for (const filter of filters) {
    if (!('values' in filter)) continue
    const field = fieldFor(filter.field)
    const objectType = field === undefined ? undefined : relationTarget(field)
    if (objectType === undefined) continue
    for (const id of filter.values) refs.set(id, { id, objectType })
  }
  return [...refs.values()]
}

/**
 * Record id → display label, for chips rendered from a URL.
 *
 * One query per id rather than one bulk request: the API has no filter on record id (nothing else
 * needs one), the ids are few — a chip with twenty organizations in it is not a chip anyone
 * builds — and each one lands in the cache under its own key, so opening the picker afterwards
 * costs nothing. A failed lookup is not retried and not surfaced: the chip falls back to the id,
 * which is still an honest description of what is being filtered on.
 */
export function useRecordLabels(refs: readonly RecordRef[]): ReadonlyMap<string, string> {
  const results = useQueries({
    queries: refs.map((ref) => ({
      queryKey: ['record-label', ref.objectType, ref.id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        RECORD_SOURCES[ref.objectType].one(ref.id, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })

  const labels = new Map<string, string>()
  for (const result of results) {
    if (result.data !== undefined) labels.set(result.data.id, result.data.label)
  }
  return labels
}
