/**
 * How the relation value picker finds records, and how a record id in a URL gets its name back.
 *
 * A `relation` filter carries record ids on the wire (ADR-032), so a link shared this morning
 * still resolves this afternoon even if the organization was renamed in between. The cost is that
 * a chip cannot be rendered from the URL alone — the label has to be fetched — which is what this
 * file is for.
 *
 * One entry per object type, each closing over the response schema `@mutuals/core/contracts`
 * already defines, so the label rule for an interaction (a nullable title) stays next to the type
 * that has one instead of becoming a branch in the picker.
 */
import {
  ContactSchema,
  InteractionSchema,
  OrganizationSchema,
  listResponseSchema,
  type ObjectType,
} from '@mutuals/core'
import type { z } from 'zod'

import { api } from '@/lib/api.ts'

export interface RecordOption {
  readonly id: string
  readonly label: string
}

export interface RecordSource {
  /** One record, for a chip rendered from a URL nobody has opened the picker on. */
  one: (id: string, signal?: AbortSignal) => Promise<RecordOption>
  /** The picker's list. An empty term asks for the first page rather than for nothing. */
  search: (term: string, signal?: AbortSignal) => Promise<readonly RecordOption[]>
}

/** Enough to choose from, few enough that the list stays a list. */
export const RECORD_SEARCH_LIMIT = 25

function source<T extends { id: string }>(
  path: string,
  schema: z.ZodType<T>,
  label: (row: T) => string,
): RecordSource {
  const listSchema = listResponseSchema(schema)
  return {
    async one(id, signal) {
      const row = await api.get(schema, `/${path}/${id}`, { signal })
      return { id: row.id, label: label(row) }
    },
    async search(term, signal) {
      const response = await api.get(listSchema, `/${path}`, {
        search: { limit: RECORD_SEARCH_LIMIT, ...(term === '' ? {} : { q: term }) },
        signal,
      })
      return response.data.map((row) => ({ id: row.id, label: label(row) }))
    },
  }
}

export const RECORD_SOURCES: Record<ObjectType, RecordSource> = {
  contact: source('contacts', ContactSchema, (row) => row.displayName),
  organization: source('organizations', OrganizationSchema, (row) => row.displayName),
  // An interaction has no display name of its own; §6.5 shows its title, and an untitled one is
  // identified by nothing better than its type.
  interaction: source('interactions', InteractionSchema, (row) => row.title ?? row.type),
}
