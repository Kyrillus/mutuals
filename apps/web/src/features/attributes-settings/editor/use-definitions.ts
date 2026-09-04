/**
 * The attribute definitions for one object type.
 *
 * A near-copy of the hook `features/records` has, and deliberately so: a `features/*` folder may
 * import `ui`, `table`, `attributes`, `lib`, `hooks` and `@mutuals/core`, never a sibling feature.
 * It costs nothing at runtime — the query key is `qk.attributeDefinitions(objectType)` in both
 * places, so this is the *same* cache entry, deduplicated by TanStack Query, and a field created
 * in this dialog invalidates the entry the contacts table is reading.
 */
import {
  AttributeDefinitionSchema,
  listResponseSchema,
  type AttributeDefinitionDto,
  type ObjectType,
} from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

const schema = listResponseSchema(AttributeDefinitionSchema)

export function useAttributeDefinitions(
  objectType: ObjectType,
): UseQueryResult<readonly AttributeDefinitionDto[], Error> {
  return useQuery({
    queryKey: qk.attributeDefinitions(objectType),
    queryFn: ({ signal }) =>
      api
        .get(schema, '/attribute-definitions', { search: { objectType }, signal })
        .then((response) => response.data),
    staleTime: 5 * 60_000,
  })
}

/** Every group already in use, so the combobox offers them before a near-duplicate is typed. */
export function groupsOf(definitions: readonly AttributeDefinitionDto[]): readonly string[] {
  const groups = new Set<string>()
  for (const definition of definitions) {
    if (definition.group !== null && definition.group !== '') groups.add(definition.group)
  }
  return [...groups].sort((a, b) => a.localeCompare(b))
}

/** The slugs a new attribute may not take, excluding the one being edited. */
export function takenSlugs(
  definitions: readonly AttributeDefinitionDto[],
  exceptId?: string,
): ReadonlySet<string> {
  return new Set(
    definitions
      .filter((definition) => definition.id !== exceptId)
      .map((definition) => definition.slug),
  )
}
