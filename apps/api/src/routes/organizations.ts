/**
 * Organizations (§6.3).
 *
 * Deliberately not called "companies": investors work at funds, angels have no company, and a
 * university is neither. The shape is a contact's minus the person-specific derived columns —
 * which is exactly why the list machinery is shared rather than copied.
 */
import {
  CreateOrganizationSchema,
  IdParamSchema,
  ListQueryParamsSchema,
  OrganizationSchema,
  UpdateOrganizationSchema,
  listResponseSchema,
  type ObjectType,
} from '@mutuals/core'
import { applyValues, createOrganization, deleteRecord, renameOrganization } from '@mutuals/db'
import { z } from 'zod'

import { loadSchema, loadSettings } from '../context.ts'
import { ApiError } from '../errors.ts'
import { listRecords } from '../http/list.ts'
import { created201, ok200, ok200WithNotFound } from '../http/schema.ts'
import { serializeOrganization } from '../serialize/records.ts'
import {
  routePlugin,
  MANUAL_PROVENANCE,
  planWrites,
  rawQuery,
  recordExists,
  requireRecord,
} from './shared.ts'

const ORGANIZATION: ObjectType = 'organization'

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

export const organizationRoutes = routePlugin((app, ctx) => {
  app.get(
    '/organizations',
    {
      schema: {
        operationId: 'listOrganizations',
        tags: ['organizations'],
        summary: 'List organizations with the full filter model',
        querystring: ListQueryParamsSchema,
        response: ok200(listResponseSchema(OrganizationSchema)),
      },
    },
    async (request) => {
      const [schema, settings] = await Promise.all([
        loadSchema(ctx, ORGANIZATION),
        loadSettings(ctx),
      ])
      const result = await listRecords(ctx, {
        objectType: ORGANIZATION,
        raw: rawQuery(request),
        schema,
        settings,
      })
      return {
        data: result.records.map((record) => serializeOrganization(record, schema)),
        page: { cursor: result.cursor, hasMore: result.hasMore },
        meta: { total: result.total },
      }
    },
  )

  app.get(
    '/organizations/:id',
    {
      schema: {
        operationId: 'getOrganization',
        tags: ['organizations'],
        summary: 'One organization, with every attribute value',
        params: IdParamSchema,
        response: ok200WithNotFound(OrganizationSchema),
      },
    },
    async (request) => {
      const [record, schema] = await Promise.all([
        requireRecord(ctx, request.params.id, ORGANIZATION),
        loadSchema(ctx, ORGANIZATION),
      ])
      return serializeOrganization(record, schema)
    },
  )

  app.post(
    '/organizations',
    {
      schema: {
        operationId: 'createOrganization',
        tags: ['organizations'],
        summary: 'Create an organization and its attribute values in one transaction',
        body: CreateOrganizationSchema,
        response: created201(OrganizationSchema),
      },
    },
    async (request, reply) => {
      const [schema, settings] = await Promise.all([
        loadSchema(ctx, ORGANIZATION),
        loadSettings(ctx),
      ])
      const changes = await planWrites(ctx, schema, settings, request.body.attributes)

      const id = await createOrganization(ctx.db, {
        name: request.body.name,
        values: changes,
        provenance: MANUAL_PROVENANCE,
      })
      const record = await requireRecord(ctx, id, ORGANIZATION)
      return reply.status(201).send(serializeOrganization(record, schema))
    },
  )

  app.patch(
    '/organizations/:id',
    {
      schema: {
        operationId: 'updateOrganization',
        tags: ['organizations'],
        summary: 'Edit an organization. A rename also refreshes the search index.',
        params: IdParamSchema,
        body: UpdateOrganizationSchema,
        response: ok200WithNotFound(OrganizationSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, ORGANIZATION))) throw notFoundOrganization(id)

      const [schema, settings] = await Promise.all([
        loadSchema(ctx, ORGANIZATION),
        loadSettings(ctx),
      ])
      const changes = await planWrites(ctx, schema, settings, request.body.attributes)
      const name = request.body.name

      await ctx.db.transaction().execute(async (trx) => {
        if (name !== undefined) await renameOrganization(trx, id, name)
        if (changes.length > 0) {
          await applyValues(trx, { recordId: id, changes, provenance: MANUAL_PROVENANCE })
        }
      })

      return serializeOrganization(await requireRecord(ctx, id, ORGANIZATION), schema)
    },
  )

  app.delete(
    '/organizations/:id',
    {
      schema: {
        operationId: 'deleteOrganization',
        tags: ['organizations'],
        summary: 'Delete an organization. Its links to contacts cascade; the contacts do not.',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await recordExists(ctx, id, ORGANIZATION))) throw notFoundOrganization(id)
      await deleteRecord(ctx.db, id)
      return { id, deleted: true as const }
    },
  )
})

function notFoundOrganization(id: string): ApiError {
  return new ApiError({
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: `There is no organization with id ${id}.`,
  })
}
