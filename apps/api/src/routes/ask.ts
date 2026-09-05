/**
 * §4.8's "ask the network" (§6.1's input, at the top of the dashboard).
 *
 * The route is thin on purpose. The model runs in `llm/tasks/ask.ts`, the filter is validated by
 * `packages/core`, and the query is the **same** `listRecords` the contacts table uses — not a
 * private query path. That is the property §4.8 asks for made structural: the answer can show the
 * filter it ran because the filter it ran is the one the user could have built by hand, and
 * clicking "open as a table" lands on a page that produces exactly the same rows.
 *
 * This file is one of the handful ESLint allows to import `../llm/**` by exact path (ADR-071).
 */
import {
  ASK_MATCH_LIMIT,
  AskRequestSchema,
  AskResponseSchema,
  ProblemSchema,
  filterSetSchema,
  type ObjectType,
  type RecordRef,
} from '@mutuals/core'

import { loadSchema, loadSettings, workspaceId } from '../context.ts'
import { llmUnavailable } from '../errors.ts'
import { listRecords } from '../http/list.ts'
import { composeAnswer, proposeQuery, type AskSchemaInput } from '../llm/tasks/ask.ts'
import { routePlugin } from './shared.ts'

const ASKABLE: readonly ObjectType[] = ['contact', 'organization']

export const askRoutes = routePlugin((app, ctx) => {
  app.post(
    '/ask',
    {
      schema: {
        operationId: 'ask',
        tags: ['agent'],
        summary:
          'Ask the network. The answer always ships the filter it ran, so it can be trusted or ' +
          'corrected (§4.8).',
        body: AskRequestSchema,
        response: {
          200: AskResponseSchema,
          400: ProblemSchema,
          429: ProblemSchema,
          500: ProblemSchema,
          502: ProblemSchema,
          503: ProblemSchema,
          504: ProblemSchema,
        },
      },
    },
    async (request) => {
      const llm = ctx.llm
      if (llm === undefined) throw llmUnavailable('AI features are not configured on this server.')

      const settings = await loadSettings(ctx)

      // Both tables unless the caller pinned one. The model choosing costs one extra field list in
      // the prompt and buys "which funds have I met this year", which is not a contact question.
      const wanted = request.body.objectType === undefined ? ASKABLE : [request.body.objectType]
      const schemas: AskSchemaInput[] = await Promise.all(
        wanted.map(async (objectType) => ({
          objectType: objectType as AskSchemaInput['objectType'],
          resolver: (await loadSchema(ctx, objectType)).resolver,
        })),
      )

      const proposed = await proposeQuery(
        ctx.db,
        llm,
        {
          question: request.body.question,
          today: settings.today,
          timeZone: settings.timeZone,
          schemas,
        },
        {
          timeZone: settings.timeZone,
          requestId: request.id,
          workspaceId: await workspaceId(ctx),
        },
      )

      if (proposed.filter === null) {
        return {
          answer: composeAnswer(proposed, 0),
          objectType: proposed.objectType,
          filter: null,
          matches: [],
          total: 0,
        }
      }

      const schema = await loadSchema(ctx, proposed.objectType)
      const result = await listRecords(ctx, {
        objectType: proposed.objectType,
        // Through the ordinary query codec, exactly as a client would send it: a filter that
        // survives this round trip is one the table can render, and one a saved view can hold.
        raw: { filter: JSON.stringify(proposed.filter), limit: String(ASK_MATCH_LIMIT) },
        schema,
        settings,
      })

      const matches: RecordRef[] = result.records.map((record) => ({
        id: record.id,
        displayName: record.displayLabel,
        objectType: record.objectType,
      }))

      return {
        answer: composeAnswer(proposed, result.total),
        objectType: proposed.objectType,
        // Through the contract's own schema, as `views.ts` does: the filter that ships in the
        // answer is the one a client will parse, so it is validated by the same object.
        filter: filterSetSchema.parse(proposed.filter),
        matches,
        total: result.total,
      }
    },
  )
})
