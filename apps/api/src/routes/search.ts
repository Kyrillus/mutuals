/**
 * ⌘K palette search (§4.8, §6.10) — the second half of Stage 6.
 *
 * Registered now and answering a documented 501, as it has since Stage 1. It is not an LLM route:
 * §4.8's global search is a substring search across labels, identifiers and interaction titles, and
 * §9 reserves `mode` for the semantic version. It lives in its own file rather than beside `ask`
 * because ADR-071's import rule names routes by exact path, and a file that may reach the model
 * should not also hold one that must not.
 */
import { ProblemSchema, SearchQuerySchema, SearchResponseSchema } from '@mutuals/core'

import { notImplemented } from '../errors.ts'
import { routePlugin } from './shared.ts'

export const searchRoutes = routePlugin((app) => {
  app.get(
    '/search',
    {
      schema: {
        operationId: 'search',
        tags: ['agent'],
        summary: '⌘K palette search across labels, identifiers and full text (Stage 6)',
        querystring: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          400: ProblemSchema,
          500: ProblemSchema,
          501: ProblemSchema,
        },
      },
    },
    () => {
      throw notImplemented('search', 'Stage 6, second half')
    },
  )
})
