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

/**
 * The schema the whole page is built from (§4.2).
 *
 * It is fetched before the rows and cached under its own key, because it changes when a user adds
 * a field and not when a contact is edited — and because the column factory, the filter picker and
 * the create dialog all read the same array rather than three fetches of it.
 */
export function useAttributeDefinitions(
  objectType: ObjectType,
): UseQueryResult<readonly AttributeDefinitionDto[], Error> {
  return useQuery({
    queryKey: qk.attributeDefinitions(objectType),
    queryFn: ({ signal }) =>
      api
        .get(schema, '/attribute-definitions', { search: { objectType }, signal })
        .then((response) => response.data),
    // A field definition is edited in Settings, rarely, and every table on the page depends on it.
    staleTime: 5 * 60_000,
  })
}
