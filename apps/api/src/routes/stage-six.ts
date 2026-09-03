/**
 * Search, ask and quick capture (§4.8) — Stage 6.
 *
 * They are registered now, and they answer a documented 501. That is deliberate: §7 makes the API
 * the contract every client is written against, so the shape of "ask the network" belongs in the
 * OpenAPI document before the engine is fitted. A client can be written, a fixture can be
 * recorded, and an MCP adapter can declare the tool — and the day the LLM module lands, nothing
 * about the surface changes.
 *
 * The 501 is a real problem+json with a `type` a client can branch on, not a stub that returns an
 * empty list and lets someone believe the network has nobody in it.
 */
import {
  AskRequestSchema,
  AskResponseSchema,
  QuickCaptureRequestSchema,
  QuickCaptureResponseSchema,
  ProblemSchema,
  SearchQuerySchema,
  SearchResponseSchema,
} from '@mutuals/core'

import { notImplemented } from '../errors.ts'
import { routePlugin } from './shared.ts'

const NOT_IMPLEMENTED = { 501: ProblemSchema, 400: ProblemSchema, 500: ProblemSchema } as const

export const stageSixRoutes = routePlugin((app) => {
  app.get(
    '/search',
    {
      schema: {
        operationId: 'search',
        tags: ['agent'],
        summary: '⌘K palette search across labels, identifiers and full text (Stage 6)',
        querystring: SearchQuerySchema,
        response: { 200: SearchResponseSchema, ...NOT_IMPLEMENTED },
      },
    },
    () => {
      throw notImplemented('search', 'Stage 6')
    },
  )

  app.post(
    '/ask',
    {
      schema: {
        operationId: 'ask',
        tags: ['agent'],
        summary:
          'Ask the network. The answer always ships the filter it ran, so it can be trusted or ' +
          'corrected (Stage 6).',
        body: AskRequestSchema,
        response: { 200: AskResponseSchema, ...NOT_IMPLEMENTED },
      },
    },
    () => {
      throw notImplemented('ask', 'Stage 6')
    },
  )

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
        response: { 200: QuickCaptureResponseSchema, ...NOT_IMPLEMENTED },
      },
    },
    () => {
      throw notImplemented('quickCapture', 'Stage 6')
    },
  )
})
