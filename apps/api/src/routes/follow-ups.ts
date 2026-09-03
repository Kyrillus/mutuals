/**
 * Follow-ups (§4.1, §6.4).
 *
 * Two things here are more than CRUD.
 *
 * **"Overdue" has one definition.** It is `followUpState()` in `packages/core`, evaluated against
 * the profile's today (ADR-045), and the list filter compiles from the same civil date — so the red
 * due date in the table, the dashboard's attention list and the `state` field cannot disagree about
 * what happens at midnight.
 *
 * **Marking a recurring follow-up done creates the next occurrence**, inside this one operation and
 * inside one transaction. The response carries it as `next`, so the client never sequences
 * "complete" and "create next" and never has to know the recurrence rules.
 */
import {
  BulkResultSchema,
  BulkUpdateFollowUpsSchema,
  CreateFollowUpSchema,
  FollowUpListQuerySchema,
  FollowUpSchema,
  IdParamSchema,
  UpdateFollowUpResponseSchema,
  UpdateFollowUpSchema,
  civil,
  followUpState,
  listResponseSchema,
  nextOccurrence,
  type CivilDate,
  type FollowUp,
  type FollowUpStatus,
  type Recurrence,
} from '@mutuals/core'
import type { JsonValue } from '@mutuals/db'
import { z } from 'zod'

import { loadSettings, workspaceId, type AppContext } from '../context.ts'
import { ApiError, validationFailed } from '../errors.ts'
import { decodeCursor, encodeCursor } from '../http/cursor.ts'
import { created201, ok200, ok200WithNotFound } from '../http/schema.ts'
import { bulkResult, routePlugin, type BulkFailure } from './shared.ts'

const DEFAULT_LIMIT = 50

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

interface FollowUpRow {
  id: string
  contact_id: string
  title: string
  due_at: string
  status: string
  recurrence: JsonValue
  origin: string
  notes: string | null
  completed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  contact_label: string
}

export const followUpRoutes = routePlugin((app, ctx) => {
  app.get(
    '/follow-ups',
    {
      schema: {
        operationId: 'listFollowUps',
        tags: ['follow-ups'],
        summary: "§6.4's table and its Open / Overdue / Done tabs, soonest first",
        querystring: FollowUpListQuerySchema,
        response: ok200(listResponseSchema(FollowUpSchema)),
      },
    },
    async (request) => {
      const query = request.query
      const settings = await loadSettings(ctx)
      const limit = query.limit ?? DEFAULT_LIMIT

      let offset = 0
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor)
        if (!decoded.ok || decoded.value.mode !== 'offset') {
          throw validationFailed([
            {
              code: 'malformed_query',
              path: ['cursor'],
              message: 'That cursor is not valid. Start from the first page.',
            },
          ])
        }
        offset = decoded.value.offset
      }

      const [rows, total] = await Promise.all([
        selectFollowUps(ctx, query, settings.today)
          .limit(limit + 1)
          .offset(offset)
          .execute(),
        countFollowUps(ctx, query, settings.today),
      ])

      const hasMore = rows.length > limit
      const visible = hasMore ? rows.slice(0, limit) : rows
      return {
        data: visible.map((row) => toFollowUp(row, settings.today)),
        page: {
          cursor: hasMore ? encodeCursor({ mode: 'offset', offset: offset + limit }) : null,
          hasMore,
        },
        meta: { total },
      }
    },
  )

  app.post(
    '/follow-ups',
    {
      schema: {
        operationId: 'createFollowUp',
        tags: ['follow-ups'],
        summary: 'Create a follow-up, optionally repeating',
        body: CreateFollowUpSchema,
        response: created201(FollowUpSchema),
      },
    },
    async (request, reply) => {
      const body = request.body
      await assertContactExists(ctx, body.contactId)
      const settings = await loadSettings(ctx)

      const inserted = await ctx.db
        .insertInto('follow_up')
        .values({
          workspace_id: await workspaceId(ctx),
          contact_id: body.contactId,
          title: body.title,
          due_at: body.dueAt,
          ...(body.status === undefined ? {} : { status: body.status }),
          recurrence: storedRecurrence(body.recurrence ?? null, civil(body.dueAt)),
          notes: body.notes ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const row = await loadFollowUp(ctx, inserted.id)
      if (row === undefined) throw new Error('the follow-up vanished after its own insert')
      return reply.status(201).send(toFollowUp(row, settings.today))
    },
  )

  app.patch(
    '/follow-ups/:id',
    {
      schema: {
        operationId: 'updateFollowUp',
        tags: ['follow-ups'],
        summary: 'Edit a follow-up. Marking a recurring one done returns its successor as `next`.',
        params: IdParamSchema,
        body: UpdateFollowUpSchema,
        response: ok200WithNotFound(UpdateFollowUpResponseSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const settings = await loadSettings(ctx)
      const existing = await loadFollowUp(ctx, id)
      if (existing === undefined) throw notFoundFollowUp(id)

      const body = request.body
      if (body.contactId !== undefined) await assertContactExists(ctx, body.contactId)

      const becomingDone = body.status === 'Done' && existing.status !== 'Done'
      const dueAt = body.dueAt ?? existing.due_at
      const rule =
        body.recurrence === undefined ? readRecurrence(existing.recurrence) : body.recurrence
      const anchor = anchorOf(existing.recurrence) ?? civil(existing.due_at)

      let nextId: string | null = null
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('follow_up')
          .set({
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.contactId === undefined ? {} : { contact_id: body.contactId }),
            ...(body.dueAt === undefined ? {} : { due_at: body.dueAt }),
            ...(body.status === undefined ? {} : { status: body.status }),
            ...(body.notes === undefined ? {} : { notes: body.notes ?? null }),
            ...(body.recurrence === undefined
              ? {}
              : { recurrence: storedRecurrence(body.recurrence ?? null, anchor) }),
            ...(body.status === undefined
              ? {}
              : { completed_at: body.status === 'Done' ? new Date() : null }),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute()

        if (!becomingDone || rule === null) return

        const next = nextOccurrence(
          { rule, anchor },
          { dueAt: civil(dueAt), today: settings.today },
        )
        if (!next.ok) throw validationFailed(next.issues)

        const created = await trx
          .insertInto('follow_up')
          .values({
            workspace_id: await workspaceId(ctx),
            contact_id: body.contactId ?? existing.contact_id,
            title: body.title ?? existing.title,
            due_at: next.value,
            status: 'Open',
            recurrence: storedRecurrence(rule, anchor),
            origin: existing.origin === 'system' ? 'system' : 'manual',
            notes: body.notes === undefined ? existing.notes : (body.notes ?? null),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        nextId = created.id
      })

      const updated = await loadFollowUp(ctx, id)
      if (updated === undefined) throw notFoundFollowUp(id)
      const successor = nextId === null ? undefined : await loadFollowUp(ctx, nextId)

      return {
        data: toFollowUp(updated, settings.today),
        next: successor === undefined ? null : toFollowUp(successor, settings.today),
      }
    },
  )

  app.delete(
    '/follow-ups/:id',
    {
      schema: {
        operationId: 'deleteFollowUp',
        tags: ['follow-ups'],
        summary: 'Delete a follow-up',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const result = await ctx.db.deleteFrom('follow_up').where('id', '=', id).executeTakeFirst()
      if (Number(result.numDeletedRows) === 0) throw notFoundFollowUp(id)
      return { id, deleted: true as const }
    },
  )

  app.post(
    '/follow-ups/bulk',
    {
      schema: {
        operationId: 'bulkUpdateFollowUps',
        tags: ['follow-ups'],
        summary: "§6.4's bulk actions: mark done, or move the due date",
        body: BulkUpdateFollowUpsSchema,
        response: ok200(BulkResultSchema),
      },
    },
    async (request) => {
      const { ids, status, dueAt } = request.body
      if (status === undefined && dueAt === undefined) {
        throw validationFailed([
          {
            code: 'required',
            path: ['status'],
            message: 'Say what to change: a status, a due date, or both.',
          },
        ])
      }

      const succeeded: string[] = []
      const failed: BulkFailure[] = []
      for (const id of ids) {
        const result = await ctx.db
          .updateTable('follow_up')
          .set({
            ...(status === undefined ? {} : { status }),
            ...(dueAt === undefined ? {} : { due_at: dueAt }),
            ...(status === undefined
              ? {}
              : { completed_at: status === 'Done' ? new Date() : null }),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .executeTakeFirst()
        if (Number(result.numUpdatedRows) === 0) {
          failed.push({ id, code: 'not_found', message: `There is no follow-up with id ${id}.` })
        } else {
          succeeded.push(id)
        }
      }
      // Deliberately no successor here: §6.4's bulk "mark done" over forty rows would otherwise
      // create forty new follow-ups the user never asked for and cannot see in the same view.
      return bulkResult(ids.length, succeeded, failed)
    },
  )
})

type FollowUpQuery = z.output<typeof FollowUpListQuerySchema>

const FOLLOW_UP_COLUMNS = [
  'f.id',
  'f.contact_id',
  'f.title',
  'f.due_at',
  'f.status',
  'f.recurrence',
  'f.origin',
  'f.notes',
  'f.completed_at',
  'f.created_at',
  'f.updated_at',
  'r.display_label as contact_label',
] as const

/**
 * The filtered set, before anything is selected from it, so the page and the exact count are
 * provably the same predicate rather than two hand-written ones that could drift.
 *
 * The tabs of §6.4 are *states*, not statuses: "Overdue" is an open follow-up whose day has passed
 * in the profile's timezone — which is why `today` arrives as a bound parameter and `current_date`
 * never appears (ADR-040).
 */
function filtered(ctx: AppContext, filters: FollowUpQuery, today: CivilDate) {
  let query = ctx.db.selectFrom('follow_up as f').innerJoin('record as r', 'r.id', 'f.contact_id')

  if (filters.status !== undefined) query = query.where('f.status', '=', filters.status)
  if (filters.contactId !== undefined) query = query.where('f.contact_id', '=', filters.contactId)
  if (filters.dueBefore !== undefined) query = query.where('f.due_at', '<', filters.dueBefore)

  switch (filters.state) {
    case 'overdue':
      query = query.where('f.status', '=', 'Open').where('f.due_at', '<', today)
      break
    case 'due_today':
      query = query.where('f.status', '=', 'Open').where('f.due_at', '=', today)
      break
    case 'upcoming':
      query = query.where('f.status', '=', 'Open').where('f.due_at', '>', today)
      break
    case 'done':
      query = query.where('f.status', '=', 'Done')
      break
    case 'snoozed':
      query = query.where('f.status', '=', 'Snoozed')
      break
    case undefined:
      break
  }
  return query
}

function selectFollowUps(ctx: AppContext, filters: FollowUpQuery, today: CivilDate) {
  return filtered(ctx, filters, today)
    .select([...FOLLOW_UP_COLUMNS])
    .orderBy('f.due_at')
    .orderBy('f.id')
}

async function countFollowUps(
  ctx: AppContext,
  filters: FollowUpQuery,
  today: CivilDate,
): Promise<number> {
  const row = await filtered(ctx, filters, today)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

async function loadFollowUp(ctx: AppContext, id: string): Promise<FollowUpRow | undefined> {
  const row = await ctx.db
    .selectFrom('follow_up as f')
    .innerJoin('record as r', 'r.id', 'f.contact_id')
    .select([...FOLLOW_UP_COLUMNS])
    .where('f.id', '=', id)
    .executeTakeFirst()
  return row
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
}

function toFollowUp(row: FollowUpRow, today: CivilDate): FollowUp {
  const status = row.status as FollowUpStatus
  const dueAt = civil(row.due_at.slice(0, 10))
  return {
    id: row.id,
    title: row.title,
    contact: { id: row.contact_id, displayName: row.contact_label, objectType: 'contact' },
    dueAt,
    status,
    state: followUpState({ status, dueAt }, today),
    recurrence: readRecurrence(row.recurrence),
    origin: row.origin === 'system' ? 'system' : 'manual',
    notes: row.notes,
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/**
 * The series anchor, stored beside the rule.
 *
 * ADR-043 anchors a recurring series on its **first** due date and copies that anchor into every
 * successor: 31 Jan monthly gives 31 Jan → 28 Feb → 31 Mar, where clamping from the previous date
 * would demote the whole series to the 28th after one February. `follow_up` has no anchor column,
 * so it rides in the `recurrence` jsonb next to the rule.
 *
 * {@link readRecurrence} strips it again, so the anchor is storage and never wire: the API returns,
 * and accepts, the bare five-variant union of ADR-043. A row written without an anchor — by the
 * seed, or by hand — reads back with its own due date as the anchor, which is correct for a series
 * that has not yet rolled over.
 */
function storedRecurrence(rule: Recurrence | null, anchor: CivilDate): JsonValue {
  return rule === null ? null : { ...rule, anchor }
}

function readRecurrence(stored: JsonValue): Recurrence | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const { anchor: _anchor, ...rule } = stored as Record<string, JsonValue>
  // The rule is validated on the way in by `recurrenceSchema`; re-validating strictly here would
  // turn a hand-edited row into a 500 rather than a follow-up that simply does not repeat.
  if (typeof rule['kind'] !== 'string') return null
  return rule as unknown as Recurrence
}

function anchorOf(stored: JsonValue): CivilDate | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const anchor = (stored as Record<string, JsonValue>)['anchor']
  return typeof anchor === 'string' ? civil(anchor) : null
}

async function assertContactExists(ctx: AppContext, contactId: string): Promise<void> {
  const row = await ctx.db
    .selectFrom('contact')
    .select('id')
    .where('id', '=', contactId)
    .executeTakeFirst()
  if (row === undefined) {
    throw validationFailed([
      {
        code: 'invalid_input',
        path: ['contactId'],
        message: `There is no contact with id ${contactId}.`,
      },
    ])
  }
}

function notFoundFollowUp(id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no follow-up with id ${id}.`,
  })
}
