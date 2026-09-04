/**
 * One record, for the detail pages of §6.3 and §6.5.
 *
 * Typed per object type rather than through `record-api.ts`'s `RecordEndpoint`. That table
 * deliberately widens both schemas to `RecordRow` so the shared table can consume either, and a
 * detail page needs the opposite: `warmth` and `interactionCount12m` exist on a contact and not on
 * an organization, and the page should not have to assert that.
 *
 * The cache key is still `qk.record(id)`, the one the table's inline edit patches optimistically
 * (ADR-049) — so editing a cell and then opening the record shows the new value without a refetch.
 */
import {
  ConnectionsSchema,
  ContactSchema,
  OrganizationSchema,
  type Connections,
  type Contact,
  type Organization,
} from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

export function useContact(id: string): UseQueryResult<Contact, Error> {
  return useQuery({
    queryKey: qk.record(id),
    queryFn: ({ signal }) => api.get(ContactSchema, `/contacts/${id}`, { signal }),
  })
}

export function useOrganization(id: string): UseQueryResult<Organization, Error> {
  return useQuery({
    queryKey: qk.record(id),
    queryFn: ({ signal }) => api.get(OrganizationSchema, `/organizations/${id}`, { signal }),
  })
}

export function useConnections(id: string): UseQueryResult<Connections, Error> {
  return useQuery({
    queryKey: qk.connections(id),
    queryFn: ({ signal }) => api.get(ConnectionsSchema, `/contacts/${id}/connections`, { signal }),
  })
}
