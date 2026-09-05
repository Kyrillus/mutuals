/**
 * §6.9's merge, as the last three operations ADR-031 reserved.
 *
 * `PLANNED_OPERATIONS` is empty after this file, which is the point of having kept it: the complete
 * surface ADR-031 enumerated in Stage 1 is now registered, and nothing was invented along the way
 * except the one addition ADR-098 records.
 *
 * The preview is where the work is. Merging itself is one call into `packages/db`, because the
 * ordering that makes it correct belongs next to the constraints that enforce it (see `merge.ts`
 * there); this file's job is to render two records side by side in terms of *fields*, which means
 * reading the attribute definitions rather than knowing any field's name.
 */
import {
  MergePreviewQuerySchema,
  MergePreviewSchema,
  MergeRecordsSchema,
  MergeResultSchema,
  type MergeField,
  type ObjectType,
} from '@mutuals/core'
import { mergeRecords, type HydratedRecord, type RecordValue } from '@mutuals/db'
import { z } from 'zod'

import { loadSchema, loadSettings } from '../context.ts'
import { conflict } from '../errors.ts'
import { ok200WithNotFound } from '../http/schema.ts'
import { requireRecord, routePlugin } from './shared.ts'

const ParamsSchema = z.object({ id: z.uuid() })

export const mergeRoutes = routePlugin((app, ctx) => {
  app.get(
    '/contacts/:id/merge-preview',
    {
      schema: {
        operationId: 'previewMergeContacts',
        tags: ['contacts'],
        summary: 'Two contacts side by side, and what merging them would move',
        params: ParamsSchema,
        querystring: MergePreviewQuerySchema,
        response: ok200WithNotFound(MergePreviewSchema),
      },
    },
    async (request) => buildPreview(ctx, 'contact', request.params.id, request.query.loserId),
  )

  app.post(
    '/contacts/:id/merge',
    {
      schema: {
        operationId: 'mergeContacts',
        tags: ['contacts'],
        summary: 'Absorb another contact into this one. Cannot be undone.',
        params: ParamsSchema,
        body: MergeRecordsSchema,
        response: ok200WithNotFound(MergeResultSchema),
      },
    },
    async (request) => runMerge(ctx, 'contact', request.params.id, request.body),
  )

  /**
   * §6.9 calls organization merge "lower priority; can be Stage 6". It ships now because Session A
   * created the need: the importer matches company names *exactly* and never fuzzily, on purpose
   * (`organizations.ts`), so "Kiln Robotics" and "Kiln Robotics GmbH" are two records by design —
   * and the place that was always meant to resolve that is this operation. Deferring it would have
   * left the importer's asymmetry with no remedy.
   */
  app.post(
    '/organizations/:id/merge',
    {
      schema: {
        operationId: 'mergeOrganizations',
        tags: ['organizations'],
        summary: 'Absorb another organization into this one. Cannot be undone.',
        params: ParamsSchema,
        body: MergeRecordsSchema,
        response: ok200WithNotFound(MergeResultSchema),
      },
    },
    async (request) => runMerge(ctx, 'organization', request.params.id, request.body),
  )

  async function runMerge(
    context: typeof ctx,
    objectType: ObjectType,
    survivorId: string,
    body: z.output<typeof MergeRecordsSchema>,
  ) {
    if (survivorId === body.loserId) {
      throw conflict('A contact cannot be merged into itself.')
    }
    await requireRecord(context, survivorId, objectType)
    await requireRecord(context, body.loserId, objectType)

    const settings = await loadSettings(context)
    const result = await mergeRecords(context.db, {
      survivorId,
      loserId: body.loserId,
      choices: body.choices,
      provenance: { source: 'manual' },
      metrics: { today: settings.today, timeZone: settings.timeZone },
    })

    return {
      survivorId: result.survivorId,
      factsMoved: result.factsMoved,
      followUpsMoved: result.followUpsMoved,
      interactionsMoved: result.interactionsMoved,
      linksRepointed: result.linksRepointed,
      conflictsResolved: result.conflictsResolved,
    }
  }
})

/**
 * The side-by-side.
 *
 * Built from the resolver rather than from a list of fields, so an attribute created in Settings
 * five minutes ago has a row here. Read-only and derived columns are left out: warmth and
 * `created_at` are not things a person chooses between.
 */
async function buildPreview(
  ctx: Parameters<typeof loadSchema>[0],
  objectType: ObjectType,
  survivorId: string,
  loserId: string,
) {
  if (survivorId === loserId) throw conflict('A record cannot be merged into itself.')

  const survivor = await requireRecord(ctx, survivorId, objectType)
  const loser = await requireRecord(ctx, loserId, objectType)
  const schema = await loadSchema(ctx, objectType)

  const fields: MergeField[] = []
  for (const field of schema.resolver.list()) {
    if (field.readOnly) continue
    if (field.source.kind !== 'attribute') {
      const left = systemValue(survivor, field.slug)
      const right = systemValue(loser, field.slug)
      if (left === null && right === null) continue
      fields.push({
        attributeId: null,
        slug: field.slug,
        label: field.label,
        survivor: left,
        loser: right,
        conflicting: left !== null && right !== null && left !== right,
        isMulti: false,
      })
      continue
    }

    const definition = field.source.def
    const left = renderValues(survivor, definition.id)
    const right = renderValues(loser, definition.id)
    if (left === null && right === null) continue

    fields.push({
      attributeId: definition.id,
      slug: field.slug,
      label: field.label,
      survivor: left,
      loser: right,
      // A set is not a conflict: the merge is the union, and asking which of two tag lists to keep
      // would throw away the half the user did not click.
      conflicting: !field.isMulti && left !== null && right !== null && left !== right,
      isMulti: field.isMulti,
    })
  }

  const moves = await countMoves(ctx, objectType, loserId, survivorId)

  return {
    objectType,
    survivor: { id: survivor.id, label: survivor.displayLabel },
    loser: { id: loser.id, label: loser.displayLabel },
    fields,
    moves,
    conflictCount: fields.filter((field) => field.conflicting).length,
  }
}

/** The writable columns on the subtype: the two name parts, or an organization's name. */
function systemValue(record: HydratedRecord, slug: string): string | null {
  const value =
    slug === 'first_name'
      ? record.contact?.firstName
      : slug === 'last_name'
        ? record.contact?.lastName
        : slug === 'name'
          ? record.organization?.name
          : undefined
  return value === undefined || value === null || value === '' ? null : value
}

/**
 * One attribute's values as one string.
 *
 * Rendering rather than returning structure, because §6.9's screen is a comparison a person makes
 * with their eyes: two rows of text they can read side by side. The structured value is not needed —
 * the merge takes a *choice*, not a value, so the server never has to be told what the value was.
 */
function renderValues(record: HydratedRecord, attributeId: string): string | null {
  const links = record.links.filter((link) => link.attributeId === attributeId)
  if (links.length > 0) {
    return links
      .map((link) => (link.title === null ? link.toLabel : `${link.toLabel} (${link.title})`))
      .join(', ')
  }

  const values = record.values
    .filter((value) => value.attributeId === attributeId)
    .sort((a, b) => a.position - b.position)
  if (values.length === 0) return null

  const rendered = values.map((value) => renderOne(value)).filter((text) => text !== '')
  return rendered.length === 0 ? null : rendered.join(', ')
}

function renderOne(value: RecordValue): string {
  if (value.optionLabel !== null) return value.optionLabel
  if (value.text !== null) return value.text
  if (value.num !== null) return value.num
  if (value.date !== null) return value.date
  if (value.bool !== null) return value.bool ? 'Yes' : 'No'
  return ''
}

/**
 * What §6.9 promises moves, counted before anything does.
 *
 * The confirmation dialog needs real numbers rather than "interactions and follow-ups will be
 * moved": the merge cannot be undone, and "3 interactions, 1 follow-up" is what tells someone they
 * are looking at the right pair of records.
 */
async function countMoves(
  ctx: Parameters<typeof loadSchema>[0],
  objectType: ObjectType,
  loserId: string,
  survivorId: string,
) {
  // Branched rather than built from a table name, because `apps/api` deliberately does not depend
  // on kysely — it reaches the database through `@mutuals/db`'s repositories and the query builder
  // it is handed, and a raw `sql` tag here would be the first crack in that.
  const interactions =
    objectType === 'contact'
      ? await ctx.db
          .selectFrom('interaction_contact')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('contact_id', '=', loserId)
          .executeTakeFirst()
      : await ctx.db
          .selectFrom('interaction_organization')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('organization_id', '=', loserId)
          .executeTakeFirst()

  const followUps =
    objectType === 'contact'
      ? await ctx.db
          .selectFrom('follow_up')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('contact_id', '=', loserId)
          .executeTakeFirst()
      : { count: '0' }

  const incoming = await ctx.db
    .selectFrom('record_link')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('to_record_id', '=', loserId)
    .where('from_record_id', '!=', survivorId)
    .executeTakeFirst()

  return {
    interactions: Number(interactions?.count ?? '0'),
    followUps: Number(followUps?.count ?? '0'),
    incomingLinks: Number(incoming?.count ?? '0'),
  }
}
