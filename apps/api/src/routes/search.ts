/**
 * §4.8's global search, behind §6.10's ⌘K palette.
 *
 * Not an LLM route, and deliberately in its own file so ADR-071's import rule can say so: the
 * palette has to answer on every keystroke, and a keyword search that cost a model call would be
 * both slow and expensive for something Postgres already indexes three ways.
 *
 * §9 reserves `mode` for the semantic variant. It is not a parameter yet — declaring one that only
 * accepts `keyword` tells a client there is a choice when there is not (the same reasoning that
 * keeps `bearerAuth` out of the OpenAPI document).
 */
import { ProblemSchema, SearchQuerySchema, SearchResponseSchema } from '@mutuals/core'
import { MIN_SEARCH_LENGTH, searchRecords } from '@mutuals/db'

import { workspaceId, type AppContext } from '../context.ts'
import { ok200 } from '../http/schema.ts'
import { routePlugin } from './shared.ts'

/** Two screens of results. The palette shows the first handful and scrolls. */
const DEFAULT_SEARCH_LIMIT = 20

export const searchRoutes = routePlugin((app, ctx: AppContext) => {
  app.get(
    '/search',
    {
      schema: {
        operationId: 'search',
        tags: ['agent'],
        summary:
          'Substring search across names, identifiers and interaction text, ranked by what kind ' +
          'of evidence matched (§4.8)',
        querystring: SearchQuerySchema,
        response: { ...ok200(SearchResponseSchema), 400: ProblemSchema },
      },
    },
    async (request) => {
      // A needle under three characters answers empty rather than 400: the palette sends every
      // keystroke, and the first two are not a mistake to be corrected, they are a word being
      // typed.
      const q = request.query.q.trim()
      if (q.length < MIN_SEARCH_LENGTH) return { data: [] }

      const hits = await searchRecords(ctx.db, {
        q,
        limit: request.query.limit ?? DEFAULT_SEARCH_LIMIT,
        workspaceId: await workspaceId(ctx),
      })

      return {
        data: hits.map((hit) => ({
          record: { id: hit.recordId, displayName: hit.displayName, objectType: hit.objectType },
          via: hit.via,
          snippet: hit.snippet,
        })),
      }
    },
  )
})
