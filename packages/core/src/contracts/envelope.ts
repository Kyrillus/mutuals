/**
 * The wire contract (ADR-031): a **bare object** for one resource, `{ data, page, meta }` for a
 * list, and a uniform 200 with an explicit `failed` array for a bulk write.
 *
 * There is deliberately no envelope around a single resource. One shape per cardinality means a
 * client that fetched a contact holds a contact, not a box containing one.
 */
import { z } from 'zod'

import { UuidSchema } from './primitives.ts'

export const PageSchema = z.object({
  /**
   * Opaque (ADR-023). Today it encodes either a keyset position or an offset; that it can change
   * to a pure keyset walk without an API change is the whole reason it is opaque.
   */
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
})

export const ListMetaSchema = z.object({
  /** Exact, and nullable so an estimate can arrive later without a wire change (ADR-023). */
  total: z.int().nullable(),
})

export function listResponseSchema<T extends z.ZodType>(
  item: T,
): z.ZodObject<{ data: z.ZodArray<T>; page: typeof PageSchema; meta: typeof ListMetaSchema }> {
  return z.object({ data: z.array(item), page: PageSchema, meta: ListMetaSchema })
}

/**
 * A bulk write answers 200 with per-item results, never 207: a multi-status body forces every
 * client to parse a shape it otherwise never sees, and the bulk action bar renders this directly.
 */
export const BulkResultSchema = z.object({
  data: z.object({
    succeeded: z.array(UuidSchema),
    failed: z.array(z.object({ id: UuidSchema, code: z.string(), message: z.string() })),
  }),
  meta: z.object({ attempted: z.int(), succeeded: z.int(), failed: z.int() }),
})

export type BulkResult = z.output<typeof BulkResultSchema>
