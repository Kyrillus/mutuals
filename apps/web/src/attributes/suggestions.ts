/**
 * "Existing values are suggested" (§4.2), without a new endpoint.
 *
 * `tags` has no option table — that is what makes it different from a select — so there is nowhere
 * to look up the values a workspace already uses. The API has no facet endpoint either, and adding
 * one for an autocomplete would be a query per keystroke against a table that is already fully in
 * the client's hands: every list page the table has fetched is sitting in the server cache
 * (ADR-049), and each row carries its whole `attributes` map.
 *
 * So the suggestions are read from the cache. They are as good as what has been loaded, which is
 * the first page on open and everything scrolled past after that — and they cost one pass over
 * memory at the moment a popover opens, not a request.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { z } from 'zod'

import { qk } from '@/lib/query.ts'

import type { AttributeSpec } from './value.ts'

/** Deliberately loose: this reads a cache, and a cache entry that has changed shape is not a bug
 *  worth throwing over — it is a reason to suggest nothing. */
const CachedPageSchema = z.object({
  data: z.array(z.object({ attributes: z.record(z.string(), z.unknown()) })),
})

const TagsValueSchema = z.object({ type: z.literal('tags'), value: z.array(z.string()) })

/**
 * Every distinct value of one `tags` attribute across the pages already fetched for its object
 * type, in descending frequency — the value used by forty contacts is the one being typed.
 */
export function useTagSuggestions(definition: AttributeSpec, active: boolean): readonly string[] {
  const client = useQueryClient()

  // `active` is the dependency that matters: the list is recomputed when a popover opens and not
  // on every keystroke, and the cache is not reactive so nothing else would trigger it anyway.
  return useMemo(() => {
    if (!active || definition.type !== 'tags') return []
    const counts = new Map<string, { label: string; count: number }>()
    for (const [, page] of client.getQueriesData({ queryKey: qk.records(definition.objectType) })) {
      const parsed = CachedPageSchema.safeParse(page)
      if (!parsed.success) continue
      for (const record of parsed.data.data) {
        const value = TagsValueSchema.safeParse(record.attributes[definition.slug])
        if (!value.success) continue
        for (const tag of value.data.value) {
          const key = tag.toLocaleLowerCase()
          const seen = counts.get(key)
          if (seen === undefined) counts.set(key, { label: tag, count: 1 })
          else seen.count += 1
        }
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .map((entry) => entry.label)
  }, [client, definition.objectType, definition.slug, definition.type, active])
}
