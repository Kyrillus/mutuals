/**
 * Contacts (§6.2, §6.5).
 *
 * The list endpoint is the interesting one: it carries the whole filter model, so "job role is one
 * of Investor, Angel, sorted by a custom `check_size` attribute, searching for Munich" is one
 * request and one compiled query. Everything else here is ordinary CRUD over the write path in
 * `packages/db`, which is the only thing that ever writes a fact.
 */
import {
  BulkDeleteSchema,
  BulkResultSchema,
  BulkUpdateAttributeSchema,
  ConnectionsSchema,
  ContactSchema,
  CreateContactSchema,
  IdParamSchema,
  ListQueryParamsSchema,
  UpdateContactSchema,
  issue,
  listResponseSchema,
  type ObjectType,
} from '@mutuals/core'
import { applyValues, createContact, deleteRecord, incomingLinks, updateContact } from '@mutuals/db'
import { z } from 'zod'

import { loadSchema, loadSettings, type AppContext } from '../context.ts'
import { ApiError, validationFailed } from '../errors.ts'
import { listRecords } from '../http/list.ts'
import { created201, ok200, ok200WithNotFound } from '../http/schema.ts'
import { serializeContact } from '../serialize/records.ts'
import {
  routePlugin,
  MANUAL_PROVENANCE,
  bulkResult,
  planWrites,
  rawQuery,
  recordExists,
  requireRecord,
  type BulkFailure,
} from './shared.ts'

const CONTACT: ObjectType = 'contact'

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export const contactRoutes = routePlugin((app, ctx) => {
  app.get(
    '/contacts',
    {
      schema: {
        operationId: 'listContacts',
        tags: ['contacts'],
        summary: 'List contacts with the full filter model',
        querystring: ListQueryParamsSchema,
        response: ok200(listResponseSchema(ContactSchema)),
      },
    },
    async (request) => {
      const [schema, settings] = await Promise.all([loadSchema(ctx, CONTACT), loadSettings(ctx)])
      const result = await listRecords(ctx, {
        objectType: CONTACT,
        raw: rawQuery(request),
        schema,
        settings,
      })
      return {
        data: result.records.map((record) => serializeContact(record, schema)),
        page: { cursor: result.cursor, hasMore: result.hasMore },
        meta: { total: result.total },
      }
    },
  )

  app.get(
    '/contacts/:id',
    {
      schema: {
        operationId: 'getContact',
        tags: ['contacts'],
        summary: 'One contact, with every attribute value',
        params: IdParamSchema,
        response: ok200WithNotFound(ContactSchema),
      },
    },
    async (request) => {
      const [record, schema] = await Promise.all([
        requireRecord(ctx, request.params.id, CONTACT),
        loadSchema(ctx, CONTACT),
      ])
      return serializeContact(record, schema)
    },
  )

  app.post(
    '/contacts',
    {
      schema: {
        operationId: 'createContact',
        tags: ['contacts'],
        summary: 'Create a contact and its attribute values in one transaction',
        body: CreateContactSchema,
        response: created201(ContactSchema),
      },
    },
    async (request, reply) => {
      const body = request.body
      const firstName = body.firstName ?? null
      const lastName = body.lastName ?? null
      if ((firstName ?? '') === '' && (lastName ?? '') === '') {
        // A contact known only as "Anna" is a real contact; one with no name at all is a row
        // nobody can find again.
        throw validationFailed([
          issue('required', 'Give the contact a first or a last name.', ['firstName']),
        ])
      }

      const [schema, settings] = await Promise.all([loadSchema(ctx, CONTACT), loadSettings(ctx)])
      const changes = await planWrites(ctx, schema, settings, body.attributes)

      const id = await createContact(ctx.db, {
        firstName,
        lastName,
        ...(body.pinnedImportant === undefined ? {} : { pinnedImportant: body.pinnedImportant }),
        ...(body.notImportant === undefined ? {} : { notImportant: body.notImportant }),
        values: changes,
        provenance: MANUAL_PROVENANCE,
      })

      const record = await requireRecord(ctx, id, CONTACT)
      return reply.status(201).send(serializeContact(record, schema))
    },
  )

  app.patch(
    '/contacts/:id',
    {
      schema: {
        operationId: 'updateContact',
        tags: ['contacts'],
        summary: 'Edit a contact. Last write wins; `updated_at` comes back on every response.',
        params: IdParamSchema,
        body: UpdateContactSchema,
        response: ok200WithNotFound(ContactSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, CONTACT))) throw notFoundContact(id)

      const body = request.body
      const [schema, settings] = await Promise.all([loadSchema(ctx, CONTACT), loadSettings(ctx)])
      const changes = await planWrites(ctx, schema, settings, body.attributes)

      await ctx.db.transaction().execute(async (trx) => {
        await updateContact(trx, id, {
          ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
          ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
          ...(body.pinnedImportant === undefined ? {} : { pinnedImportant: body.pinnedImportant }),
          ...(body.notImportant === undefined ? {} : { notImportant: body.notImportant }),
        })
        if (changes.length > 0) {
          await applyValues(trx, { recordId: id, changes, provenance: MANUAL_PROVENANCE })
        }
      })

      return serializeContact(await requireRecord(ctx, id, CONTACT), schema)
    },
  )

  app.delete(
    '/contacts/:id',
    {
      schema: {
        operationId: 'deleteContact',
        tags: ['contacts'],
        summary: 'Delete a contact. Facts, values, links, identifiers and follow-ups cascade.',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, CONTACT))) throw notFoundContact(id)
      await deleteRecord(ctx.db, id)
      return { id, deleted: true as const }
    },
  )

  app.post(
    '/contacts/bulk-delete',
    {
      schema: {
        operationId: 'bulkDeleteContacts',
        tags: ['contacts'],
        summary: 'Delete many contacts, reporting per item',
        body: BulkDeleteSchema,
        response: ok200(BulkResultSchema),
      },
    },
    async (request) => {
      const succeeded: string[] = []
      const failed: BulkFailure[] = []
      // Deliberately not one transaction: a bulk action bar reports what happened per row, and a
      // single missing id must not roll back forty successful deletes.
      for (const id of request.body.ids) {
        if (!(await recordExists(ctx, id, CONTACT))) {
          failed.push({ id, code: 'not_found', message: `There is no contact with id ${id}.` })
          continue
        }
        await deleteRecord(ctx.db, id)
        succeeded.push(id)
      }
      return bulkResult(request.body.ids.length, succeeded, failed)
    },
  )

  app.post(
    '/contacts/bulk-attribute',
    {
      schema: {
        operationId: 'bulkUpdateContactAttribute',
        tags: ['contacts'],
        summary: 'Set one attribute on many contacts. `value: null` clears it.',
        body: BulkUpdateAttributeSchema,
        response: ok200(BulkResultSchema),
      },
    },
    async (request) => {
      const { ids, slug, value } = request.body
      const [schema, settings] = await Promise.all([loadSchema(ctx, CONTACT), loadSettings(ctx)])
      const changes = await planWrites(ctx, schema, settings, { [slug]: value ?? null })

      const succeeded: string[] = []
      const failed: BulkFailure[] = []
      for (const id of ids) {
        if (!(await recordExists(ctx, id, CONTACT))) {
          failed.push({ id, code: 'not_found', message: `There is no contact with id ${id}.` })
          continue
        }
        await applyValues(ctx.db, { recordId: id, changes, provenance: MANUAL_PROVENANCE })
        succeeded.push(id)
      }
      return bulkResult(ids.length, succeeded, failed)
    },
  )

  app.get(
    '/contacts/:id/connections',
    {
      schema: {
        operationId: 'getContactConnections',
        tags: ['contacts'],
        summary: "§6.5's Connections tab: organizations, people, and who else works there",
        params: IdParamSchema,
        response: ok200WithNotFound(ConnectionsSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      const record = await requireRecord(ctx, id, CONTACT)
      const schema = await loadSchema(ctx, CONTACT)

      const organizations = record.links
        .filter((link) => link.toObjectType === 'organization')
        // Current before past, so the list reads as a CV (§6.5).
        .sort((a, b) => Number(a.to !== null) - Number(b.to !== null))
        .map((link) => ({
          id: link.toRecordId,
          displayName: link.toLabel,
          objectType: link.toObjectType,
          title: link.title,
          from: link.from,
          to: link.to,
          isPrimary: link.isPrimary,
        }))

      const incoming = await incomingLinks(ctx.db, id)
      const people = [
        ...record.links
          .filter((link) => link.toObjectType === 'contact')
          .map((link) => ({
            attributeId: link.attributeId,
            direction: 'outgoing' as const,
            id: link.toRecordId,
            displayName: link.toLabel,
          })),
        ...incoming
          .filter((link) => link.toObjectType === 'contact')
          .map((link) => ({
            attributeId: link.attributeId,
            direction: 'incoming' as const,
            id: link.toRecordId,
            displayName: link.toLabel,
          })),
      ].map((entry) => {
        const definition = schema.byId.get(entry.attributeId)
        return {
          attributeSlug: definition?.slug ?? entry.attributeId,
          attributeTitle: definition?.title ?? 'Related',
          direction: entry.direction,
          id: entry.id,
          displayName: entry.displayName,
        }
      })

      return { organizations, people, alsoAtSameOrganization: await alsoAtSameOrg(ctx, id) }
    },
  )
})

function notFoundContact(id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no contact with id ${id}.`,
  })
}

/**
 * §6.5's "Also at the same organization": other contacts sharing a *current* link to one of this
 * contact's current organizations. Derived and read-only, straight off `rl_same_org_idx`.
 */
async function alsoAtSameOrg(
  ctx: AppContext,
  contactId: string,
): Promise<
  { id: string; displayName: string; organizationId: string; organizationName: string }[]
> {
  const rows = await ctx.db
    .selectFrom('record_link as mine')
    .innerJoin('record_link as theirs', (join) =>
      join
        .onRef('theirs.to_record_id', '=', 'mine.to_record_id')
        .onRef('theirs.attribute_id', '=', 'mine.attribute_id')
        .on('theirs.valid_to', 'is', null),
    )
    .innerJoin('record as person', 'person.id', 'theirs.from_record_id')
    .innerJoin('organization as org', 'org.id', 'mine.to_record_id')
    .select([
      'person.id as id',
      'person.display_label as display_name',
      'org.id as organization_id',
      'org.name as organization_name',
    ])
    .where('mine.from_record_id', '=', contactId)
    .where('mine.valid_to', 'is', null)
    .where('theirs.from_record_id', '!=', contactId)
    .orderBy('org.name')
    .orderBy('person.display_label')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
  }))
}
