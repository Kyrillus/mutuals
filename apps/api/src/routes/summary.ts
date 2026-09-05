/**
 * §6.5's Summary card: read the cached one, or generate a new one.
 *
 * Two operations rather than one, because the two cost very different things. `GET` is a single
 * indexed read and runs on every visit to a contact's page; `POST` spends money and runs when
 * somebody presses a button. Folding the summary into `getContact` would have put an LLM-shaped
 * feature behind every read of every contact, including the list — which is how a $5.00 daily cap
 * gets spent by scrolling.
 *
 * The cache is `record_summary`, one row per contact, replaced on regenerate. §6.5 asks for the
 * timestamp to be shown, and it is the timestamp that makes the card honest: a summary written
 * before three meetings happened is not wrong, it is stale, and only the date says which.
 */
import {
  ContactSummarySchema,
  IdParamSchema,
  ProblemSchema,
  type ContactSummary,
} from '@mutuals/core'
import { listInteractions } from '@mutuals/db'

import { loadSchema, loadSettings, workspaceId, type AppContext } from '../context.ts'
import { llmUnavailable } from '../errors.ts'
import { ok200WithNotFound } from '../http/schema.ts'
import { generateSummary, SUMMARY_INTERACTIONS } from '../llm/tasks/summary.ts'
import { serializeAttributes } from '../serialize/attributes.ts'
import { requireRecord, routePlugin } from './shared.ts'

const LLM_ERRORS = {
  404: ProblemSchema,
  429: ProblemSchema,
  500: ProblemSchema,
  502: ProblemSchema,
  503: ProblemSchema,
  504: ProblemSchema,
} as const

export const summaryRoutes = routePlugin((app, ctx: AppContext) => {
  app.get(
    '/contacts/:id/summary',
    {
      schema: {
        operationId: 'getContactSummary',
        tags: ['contacts'],
        summary: "§6.5's cached summary, or nulls when none has been generated yet",
        params: IdParamSchema,
        response: ok200WithNotFound(ContactSummarySchema),
      },
    },
    async (request): Promise<ContactSummary> => {
      await requireRecord(ctx, request.params.id, 'contact')
      return readSummary(ctx, request.params.id)
    },
  )

  app.post(
    '/contacts/:id/summary',
    {
      schema: {
        operationId: 'generateContactSummary',
        tags: ['contacts'],
        summary:
          'Write a fresh summary of this contact from their fields, recent interactions and open ' +
          'follow-ups. Replaces the cached one (§6.5).',
        params: IdParamSchema,
        response: { 200: ContactSummarySchema, ...LLM_ERRORS },
      },
    },
    async (request): Promise<ContactSummary> => {
      const llm = ctx.llm
      if (llm === undefined) throw llmUnavailable('AI features are not configured on this server.')

      const recordId = request.params.id
      const [record, schema, settings] = await Promise.all([
        requireRecord(ctx, recordId, 'contact'),
        loadSchema(ctx, 'contact'),
        loadSettings(ctx),
      ])

      const [interactions, followUps] = await Promise.all([
        listInteractions(ctx.db, { contactId: recordId, limit: SUMMARY_INTERACTIONS }),
        ctx.db
          .selectFrom('follow_up')
          .select(['title', 'due_at'])
          .where('contact_id', '=', recordId)
          .where('status', '=', 'Open')
          .orderBy('due_at')
          .limit(10)
          .execute(),
      ])

      const generated = await generateSummary(
        ctx.db,
        llm,
        {
          displayName: record.displayLabel,
          today: settings.today,
          attributes: serializeAttributes(record, schema),
          interactions,
          openFollowUps: followUps.map((row) => ({ title: row.title, dueAt: row.due_at })),
        },
        // The label the *user* gave the field, so the model reads "Standort: München" in a workspace
        // where the field was renamed. Falls back to the slug, which is better than nothing and is
        // unreachable while the map comes from the same schema the attributes did.
        (slug) => schema.bySlug.get(slug)?.title ?? slug,
        {
          timeZone: settings.timeZone,
          recordId,
          requestId: request.id,
          workspaceId: await workspaceId(ctx),
        },
      )

      await ctx.db
        .insertInto('record_summary')
        .values({
          record_id: recordId,
          workspace_id: await workspaceId(ctx),
          summary: generated.summary,
          model: generated.model,
          prompt_version: generated.promptVersion,
          llm_call_id: generated.callId,
          generated_at: ctx.now(),
        })
        .onConflict((conflict) =>
          conflict.column('record_id').doUpdateSet({
            summary: generated.summary,
            model: generated.model,
            prompt_version: generated.promptVersion,
            llm_call_id: generated.callId,
            generated_at: ctx.now(),
          }),
        )
        .execute()

      return readSummary(ctx, recordId)
    },
  )
})

async function readSummary(ctx: AppContext, recordId: string): Promise<ContactSummary> {
  const row = await ctx.db
    .selectFrom('record_summary')
    .select(['summary', 'model', 'generated_at'])
    .where('record_id', '=', recordId)
    .executeTakeFirst()

  if (row === undefined) return { summary: null, generatedAt: null, model: null }
  return {
    summary: row.summary,
    model: row.model,
    generatedAt:
      row.generated_at instanceof Date
        ? row.generated_at.toISOString()
        : new Date(row.generated_at).toISOString(),
  }
}
