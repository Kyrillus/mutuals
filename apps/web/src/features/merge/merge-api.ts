/**
 * §6.9's three operations, from the browser.
 *
 * The candidate list reuses the ordinary contact and organization list rather than adding a search
 * endpoint: a merge candidate is just a record, and §4.8's global search is Stage 6. Filtering by
 * name through the existing `?q=` keeps this screen from inventing a fourth way to find a record.
 */
import {
  MergePreviewSchema,
  MergeResultSchema,
  listResponseSchema,
  type MergePreview,
  type MergeResultDto,
  type ObjectType,
} from '@mutuals/core'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { api } from '@/lib/api.ts'

const pathFor = (objectType: ObjectType): string =>
  objectType === 'organization' ? 'organizations' : 'contacts'

/** Only the two things the picker shows, so the schema does not couple to either record shape. */
const CandidateSchema = z.object({ id: z.uuid(), displayName: z.string() })
const CandidateListSchema = listResponseSchema(CandidateSchema)

export interface MergeCandidate {
  readonly id: string
  readonly label: string
}

export async function searchMergeCandidates(
  objectType: ObjectType,
  query: string,
  signal?: AbortSignal,
): Promise<readonly MergeCandidate[]> {
  const page = await api.get(CandidateListSchema, `/${pathFor(objectType)}`, {
    search: {
      limit: 20,
      // The list's substring search needs three characters before it uses the trigram index
      // (`MIN_SUBSTRING_LENGTH`), so a shorter query asks for the first page instead of a match.
      ...(query.trim().length >= 3 ? { q: query.trim() } : {}),
    },
    ...(signal === undefined ? {} : { signal }),
  })
  return page.data.map((row) => ({ id: row.id, label: row.displayName }))
}

export function useMergePreview(
  objectType: ObjectType,
  survivorId: string,
  loserId: string | null,
) {
  return useQuery({
    queryKey: ['merge-preview', objectType, survivorId, loserId],
    queryFn: ({ signal }) =>
      api.get<MergePreview>(
        MergePreviewSchema,
        `/${pathFor(objectType)}/${survivorId}/merge-preview`,
        { search: { loserId: loserId as string }, ...(signal === undefined ? {} : { signal }) },
      ),
    enabled: loserId !== null,
    // A preview describes two records as they are right now, and the merge that follows is
    // irreversible — so it is never served from cache after the user has been elsewhere.
    staleTime: 0,
  })
}

export function mergeRecords(
  objectType: ObjectType,
  survivorId: string,
  body: { loserId: string; choices: Readonly<Record<string, 'survivor' | 'loser'>> },
): Promise<MergeResultDto> {
  return api.post(MergeResultSchema, `/${pathFor(objectType)}/${survivorId}/merge`, body)
}
