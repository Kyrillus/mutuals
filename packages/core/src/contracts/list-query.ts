/**
 * The list endpoint's query string, as OpenAPI sees it (ADR-032).
 *
 * Every parameter is a **string** here, deliberately. The filter set travels as one URL-encoded
 * JSON array in `?filter=`, and `parseListQuery` in `filters/query.ts` is the one codec that turns
 * the raw parameters into a `ListQuery`. Declaring `filter` as `z.array(...)` would be the
 * previously claimed "same schema at both ends", which is false: TanStack Router hands the client
 * a parsed array while Fastify hands the handler a string, and one schema cannot accept both.
 *
 * So this schema documents and bounds the wire, and the codec does the parsing — one definition
 * with an explicit boundary rather than two that can disagree.
 */
import { z } from 'zod'

import { MAX_CURSOR_LENGTH, MAX_LIMIT, MAX_QUERY_TEXT_LENGTH, MIN_LIMIT } from '../filters/query.ts'
import { MAX_FILTER_VALUE_LENGTH, MAX_FILTERS } from '../filters/model.ts'

/** Generous, but finite: 20 chips at 1 kB each plus the JSON scaffolding. */
const MAX_FILTER_PARAM_LENGTH = MAX_FILTERS * (MAX_FILTER_VALUE_LENGTH + 128)

export const DEFAULT_PAGE_SIZE = 50

export const ListQueryParamsSchema = z.object({
  filter: z
    .string()
    .max(MAX_FILTER_PARAM_LENGTH)
    .optional()
    .describe(
      'URL-encoded JSON array of filter conditions, ANDed together. ' +
        'Example: [{"field":"city","op":"contains","value":"Munich"}]',
    ),
  sort: z
    .string()
    .max(80)
    .optional()
    .describe('field:direction, e.g. "display_name:asc". Unsortable fields are refused with 400.'),
  columns: z
    .string()
    .max(4096)
    .optional()
    .describe('Comma-separated slugs, in display order. Also scopes the ?q= substring search.'),
  q: z
    .string()
    .max(MAX_QUERY_TEXT_LENGTH)
    .optional()
    .describe('Substring search over the record label and the text columns named by "columns".'),
  view: z.string().max(64).optional().describe('The saved view this URL was opened from.'),
  limit: z
    .string()
    .max(8)
    .optional()
    .describe(
      `Page size, ${String(MIN_LIMIT)}–${String(MAX_LIMIT)}. Defaults to ${String(DEFAULT_PAGE_SIZE)}.`,
    ),
  cursor: z
    .string()
    .max(MAX_CURSOR_LENGTH)
    .optional()
    .describe('Opaque. Take it from page.cursor of the previous response; never build one.'),
})

export type ListQueryParams = z.output<typeof ListQueryParamsSchema>
