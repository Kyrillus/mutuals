/**
 * Interactions (§4.1, §6.5).
 *
 * The timeline is the reason this resource exists: "last contact three weeks ago" and the warmth
 * score are both functions of these rows, so creating one is the single write that makes a
 * relationship look alive again.
 *
 * Participants are a set the caller states in full. An absent `contactIds` leaves the list alone;
 * an array — the empty one included — makes it true. Anything finer would need add and remove
 * operations for something the UI edits as one picker.
 */
import {
  CreateInteractionSchema,
  IdParamSchema,
  InteractionListQuerySchema,
  InteractionSchema,
  UpdateInteractionSchema,
  listResponseSchema,
  type ObjectType,
  type RecordRef,
} from '@mutuals/core'
import {
  createInteraction,
  deleteRecord,
  recomputeMetrics,
  listInteractions,
  listInteractionsByIds,
  updateInteraction,
  type InteractionSummary,
} from '@mutuals/db'
import { z } from 'zod'

import { loadSettings, type AppContext } from '../context.ts'
import { ApiError, validationFailed } from '../errors.ts'
import { decodeCursor, encodeCursor } from '../http/cursor.ts'
import { created201, ok200, ok200WithNotFound } from '../http/schema.ts'
import { serializeInteraction } from '../serialize/records.ts'
import { recordExists, routePlugin } from './shared.ts'

const INTERACTION: ObjectType = 'interaction'
const DEFAULT_LIMIT = 50

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export const interactionRoutes = routePlugin((app, ctx) => {
  app.get(
    '/interactions',
    {
      schema: {
        operationId: 'listInteractions',
        tags: ['interactions'],
        summary: 'The activity timeline, newest first. Scope it to one contact or organization.',
        querystring: InteractionListQuerySchema,
        response: ok200(listResponseSchema(InteractionSchema)),
      },
    },
    async (request) => {
      const query = request.query
      const limit = query.limit ?? DEFAULT_LIMIT

      let before: Date | undefined
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor)
        if (!decoded.ok || decoded.value.mode !== 'keyset') {
          throw validationFailed([
            {
              code: 'malformed_query',
              path: ['cursor'],
              message: 'That cursor is not valid. Start from the first page.',
            },
          ])
        }
        before = new Date(decoded.value.createdAt)
      }

      const rows = await listInteractions(ctx.db, {
        ...(query.contactId === undefined ? {} : { contactId: query.contactId }),
        ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
        ...(query.type === undefined ? {} : { types: [query.type] }),
        ...(before === undefined ? {} : { before }),
        limit: limit + 1,
      })

      const hasMore = rows.length > limit
      const visible = hasMore ? rows.slice(0, limit) : rows
      const last = visible[visible.length - 1]

      return {
        data: await serializeAll(ctx, visible),
        page: {
          cursor:
            hasMore && last !== undefined
              ? encodeCursor({ mode: 'keyset', createdAt: last.occurredAt, id: last.id })
              : null,
          hasMore,
        },
        // Null, not a number: a timeline is scrolled, never counted, and ADR-023 makes `total`
        // nullable precisely so an endpoint can decline to pay for a count nobody reads.
        meta: { total: null },
      }
    },
  )

  app.post(
    '/interactions',
    {
      schema: {
        operationId: 'createInteraction',
        tags: ['interactions'],
        summary: 'Log a touchpoint with one or more contacts',
        body: CreateInteractionSchema,
        response: created201(InteractionSchema),
      },
    },
    async (request, reply) => {
      const body = request.body
      await assertParticipantsExist(ctx, body.contactIds, body.organizationIds)

      const id = await createInteraction(ctx.db, {
        type: body.type,
        occurredAt: body.occurredAt,
        title: body.title ?? null,
        body: body.body ?? null,
        ...(body.source === undefined ? {} : { source: body.source }),
        contactIds: body.contactIds ?? [],
        organizationIds: body.organizationIds ?? [],
      })

      await refreshMetricsFor(ctx, body.contactIds ?? [], body.organizationIds ?? [])

      const [created] = await serializeAll(ctx, await loadOne(ctx, id))
      if (created === undefined) throw new Error('the interaction vanished after its own insert')
      return reply.status(201).send(created)
    },
  )

  app.patch(
    '/interactions/:id',
    {
      schema: {
        operationId: 'updateInteraction',
        tags: ['interactions'],
        summary: 'Edit a touchpoint. Sending `contactIds` replaces the whole participant list.',
        params: IdParamSchema,
        body: UpdateInteractionSchema,
        response: ok200WithNotFound(InteractionSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, INTERACTION))) throw notFoundInteraction(id)
      const body = request.body
      await assertParticipantsExist(ctx, body.contactIds, body.organizationIds)

      const [before] = await serializeAll(ctx, await loadOne(ctx, id))

      await updateInteraction(ctx.db, id, {
        ...(body.type === undefined ? {} : { type: body.type }),
        ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.contactIds === undefined ? {} : { contactIds: body.contactIds }),
        ...(body.organizationIds === undefined ? {} : { organizationIds: body.organizationIds }),
      })

      const [updated] = await serializeAll(ctx, await loadOne(ctx, id))
      if (updated === undefined) throw notFoundInteraction(id)

      await refreshMetricsFor(
        ctx,
        [
          ...(before?.contacts ?? []).map((ref) => ref.id),
          ...updated.contacts.map((ref) => ref.id),
        ],
        [
          ...(before?.organizations ?? []).map((ref) => ref.id),
          ...updated.organizations.map((ref) => ref.id),
        ],
      )
      return updated
    },
  )

  app.delete(
    '/interactions/:id',
    {
      schema: {
        operationId: 'deleteInteraction',
        tags: ['interactions'],
        summary: 'Delete a touchpoint',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, INTERACTION))) throw notFoundInteraction(id)

      // Read the participants first: after the cascade there is nothing left to ask.
      const [doomed] = await serializeAll(ctx, await loadOne(ctx, id))
      await deleteRecord(ctx.db, id)
      await refreshMetricsFor(
        ctx,
        (doomed?.contacts ?? []).map((ref) => ref.id),
        (doomed?.organizations ?? []).map((ref) => ref.id),
      )
      return { id, deleted: true as const }
    },
  )
})

/**
 * §4.7's derived columns, brought up to date for the people this interaction touches.
 *
 * An interaction is the only thing that moves `last_interaction_at`, `interaction_count_12m` and
 * therefore warmth — so without this the Relationship card of §6.5 reads zero for ever and the
 * numbers only ever change when the seed runs. Scoped to the participants (ADR-092): a workspace-
 * wide recompute on every logged call is the shape of mistake that made deleting a contact take
 * four seconds in Stage 1.
 *
 * The participants of the row *before* an edit matter as much as the ones after: moving an
 * interaction from Anna to Bea has to take the count off Anna too, so both sets are passed in.
 */
async function refreshMetricsFor(
  ctx: AppContext,
  contactIds: readonly string[],
  organizationIds: readonly string[],
): Promise<void> {
  if (contactIds.length === 0 && organizationIds.length === 0) return
  const settings = await loadSettings(ctx)
  await recomputeMetrics(ctx.db, {
    today: settings.today,
    timeZone: settings.timeZone,
    scope: { contactIds: [...new Set(contactIds)], organizationIds: [...new Set(organizationIds)] },
  })
}

function notFoundInteraction(id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no interaction with id ${id}.`,
  })
}

async function loadOne(ctx: AppContext, id: string): Promise<InteractionSummary[]> {
  return listInteractionsByIds(ctx.db, [id])
}

/**
 * Labels and `updated_at` for a page of interactions, in one query over `record`.
 *
 * The timeline renders participant chips before the client has fetched those records, so the
 * label travels with the interaction; `record.display_label` is maintained by the subtype trigger
 * and is the only place it is ever read from.
 */
async function serializeAll(ctx: AppContext, rows: readonly InteractionSummary[]) {
  if (rows.length === 0) return []
  const ids = new Set<string>()
  for (const row of rows) {
    ids.add(row.id)
    for (const id of row.contactIds) ids.add(id)
    for (const id of row.organizationIds) ids.add(id)
  }

  const records = await ctx.db
    .selectFrom('record')
    .select(['id', 'display_label', 'object_type', 'updated_at'])
    .where('id', 'in', [...ids])
    .execute()

  const labels = new Map<string, RecordRef>()
  const updatedAt = new Map<string, string>()
  for (const record of records) {
    labels.set(record.id, {
      id: record.id,
      displayName: record.display_label,
      objectType: record.object_type,
    })
    updatedAt.set(
      record.id,
      record.updated_at instanceof Date
        ? record.updated_at.toISOString()
        : new Date(record.updated_at).toISOString(),
    )
  }

  return rows.map((row) =>
    serializeInteraction(row, labels, updatedAt.get(row.id) ?? row.createdAt),
  )
}

/** A participant that does not exist is a 400 with the id, not a foreign-key error with none. */
async function assertParticipantsExist(
  ctx: AppContext,
  contactIds: readonly string[] | undefined,
  organizationIds: readonly string[] | undefined,
): Promise<void> {
  const wanted = new Map<string, ObjectType>()
  for (const id of contactIds ?? []) wanted.set(id, 'contact')
  for (const id of organizationIds ?? []) wanted.set(id, 'organization')
  if (wanted.size === 0) return

  const rows = await ctx.db
    .selectFrom('record')
    .select(['id', 'object_type'])
    .where('id', 'in', [...wanted.keys()])
    .execute()
  const found = new Map(rows.map((row) => [row.id, row.object_type]))

  const issues = [...wanted]
    .filter(([id, type]) => found.get(id) !== type)
    .map(([id, type]) => ({
      code: 'invalid_input' as const,
      path: [type === 'contact' ? 'contactIds' : 'organizationIds'],
      message: `There is no ${type} with id ${id}.`,
    }))
  if (issues.length > 0) throw validationFailed(issues)
}
