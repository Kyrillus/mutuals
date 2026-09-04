/**
 * §6.6's saved views (ADR-048).
 *
 * The four names were reserved in `PLANNED_OPERATIONS` from Stage 1 and move to `OPERATIONS` here,
 * which is what `operations.test.ts` is for: a route added under a second, invented name fails the
 * build rather than quietly doubling the surface.
 */
import {
  filterSetSchema,
  CreateSavedViewSchema,
  IdParamSchema,
  SavedViewListQuerySchema,
  SavedViewSchema,
  UpdateSavedViewSchema,
  listResponseSchema,
} from '@mutuals/core'
import {
  createView,
  deleteView,
  getView,
  listViews,
  updateView,
  type SavedViewRow,
} from '@mutuals/db'
import { z } from 'zod'

import { notFound } from '../errors.ts'
import { created201, ok200, ok200WithNotFound } from '../http/schema.ts'
import { routePlugin } from './shared.ts'

const DeleteResultSchema = z.object({ id: z.uuid(), deleted: z.literal(true) })

/**
 * `saved_view.filters` is jsonb, so what comes back is whatever was written — possibly by an older
 * build with a filter shape this one no longer accepts. Parsing it here rather than casting turns
 * that into a clear failure at the boundary instead of a serialiser error three frames later, and
 * it is also what reconciles `packages/db`'s `readonly` arrays with the schema's mutable ones.
 */
function serialize(view: SavedViewRow) {
  return {
    ...view,
    columns: [...view.columns],
    filters: filterSetSchema.parse(view.filters),
  }
}

export const viewRoutes = routePlugin((app, ctx) => {
  app.get(
    '/views',
    {
      schema: {
        operationId: 'listViews',
        tags: ['views'],
        summary: "§6.6's saved views, in display order",
        querystring: SavedViewListQuerySchema,
        response: ok200(listResponseSchema(SavedViewSchema)),
      },
    },
    async (request) => {
      const views = await listViews(ctx.db, request.query.objectType)
      return {
        data: views.map(serialize),
        page: { hasMore: false, cursor: null },
        meta: { total: views.length },
      }
    },
  )

  app.post(
    '/views',
    {
      schema: {
        operationId: 'createView',
        tags: ['views'],
        summary: 'Save the current columns, filters and sort under a name',
        body: CreateSavedViewSchema,
        response: created201(SavedViewSchema),
      },
    },
    async (request, reply) => {
      const body = request.body
      const id = await createView(ctx.db, {
        objectType: body.objectType,
        name: body.name,
        columns: body.columns,
        filters: body.filters,
        sort: body.sort ?? null,
        ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
      })
      const created = await getView(ctx.db, id)
      if (created === undefined) throw new Error('the view vanished after its own insert')
      return reply.status(201).send(serialize(created))
    },
  )

  app.patch(
    '/views/:id',
    {
      schema: {
        operationId: 'updateView',
        tags: ['views'],
        summary: 'Rename a view, or overwrite its snapshot with the current one',
        params: IdParamSchema,
        body: UpdateSavedViewSchema,
        response: ok200WithNotFound(SavedViewSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if ((await getView(ctx.db, id)) === undefined) throw notFound('view', id)

      const body = request.body
      await updateView(ctx.db, id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.columns === undefined ? {} : { columns: body.columns }),
        ...(body.filters === undefined ? {} : { filters: body.filters }),
        ...(body.sort === undefined ? {} : { sort: body.sort ?? null }),
        ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
        ...(body.position === undefined ? {} : { position: body.position }),
      })

      const updated = await getView(ctx.db, id)
      if (updated === undefined) throw notFound('view', id)
      return serialize(updated)
    },
  )

  app.delete(
    '/views/:id',
    {
      schema: {
        operationId: 'deleteView',
        tags: ['views'],
        summary: 'Delete a saved view. The records it showed are untouched.',
        params: IdParamSchema,
        response: ok200WithNotFound(DeleteResultSchema),
      },
    },
    async (request) => {
      const id = request.params.id
      if (!(await deleteView(ctx.db, id))) throw notFound('view', id)
      return { id, deleted: true as const }
    },
  )
})
