/**
 * §4.8's quick capture — the second half of Stage 6.
 *
 * Still a documented 501. The shape is the contract: free text in, an editable preview of a
 * contact, an organization, an interaction and a follow-up out, and **nothing saved before the
 * user confirms**. Matching against existing people goes through the same `matchDuplicates` the
 * importer uses, whose thresholds ADR-099 moved in Stage 5 — quick capture inherits them, which is
 * intended.
 *
 * Its own file because ADR-071's rule lists routes by exact path, and this is one of the paths that
 * will be allowed to import the LLM module the day it is built.
 */
import { ProblemSchema, QuickCaptureRequestSchema, QuickCaptureResponseSchema } from '@mutuals/core'

import { notImplemented } from '../errors.ts'
import { routePlugin } from './shared.ts'

export const quickCaptureRoutes = routePlugin((app) => {
  app.post(
    '/quick-capture',
    {
      schema: {
        operationId: 'quickCapture',
        tags: ['agent'],
        summary:
          'Turn one sentence into a proposed contact, organization, interaction and follow-up. ' +
          'A preview: nothing is saved before the user confirms (Stage 6).',
        body: QuickCaptureRequestSchema,
        response: {
          200: QuickCaptureResponseSchema,
          400: ProblemSchema,
          500: ProblemSchema,
          501: ProblemSchema,
        },
      },
    },
    () => {
      throw notImplemented('quickCapture', 'Stage 6, second half')
    },
  )
})
