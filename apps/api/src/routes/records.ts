/**
 * The operations that belong to a *record*, whatever kind of record it is (ADR-090).
 *
 * §4.5's history popover is identical on a contact, on an organization and on anything added
 * later — "what did this field used to say, and who said so" has one answer shape. So it is one
 * route on the supertype rather than one per object type, which is what `record` being a supertype
 * with a shared id space (ADR-015) is for. The alternative was `getContactValueHistory` and
 * `getOrganizationValueHistory` differing only in the word in the middle.
 */
import { HistoryParamSchema, ValueHistorySchema } from '@mutuals/core'
import { getRecord, valueHistory } from '@mutuals/db'

import { loadSchema } from '../context.ts'
import { notFound } from '../errors.ts'
import { ok200WithNotFound } from '../http/schema.ts'
import { serializeHistoryValue } from '../serialize/attributes.ts'
import { routePlugin } from './shared.ts'

export const recordRoutes = routePlugin((app, ctx) => {
  app.get(
    '/records/:id/history/:attributeId',
    {
      schema: {
        operationId: 'getValueHistory',
        tags: ['records'],
        summary: "§4.5's value history: every fact ever written for one field on one record",
        params: HistoryParamSchema,
        response: ok200WithNotFound(ValueHistorySchema),
      },
    },
    async (request) => {
      const { id, attributeId } = request.params

      const record = await getRecord(ctx.db, id)
      if (record === undefined) throw notFound('record', id)

      // Named by object type, because an id that is valid for a *different* kind of record is the
      // mistake a caller actually makes, and a bare "no such attribute definition" hides it.
      const schema = await loadSchema(ctx, record.objectType)
      const definition = schema.byId.get(attributeId)
      if (definition === undefined) {
        throw notFound(`attribute definition on a ${record.objectType}`, attributeId)
      }

      return {
        attributeSlug: definition.slug,
        attributeTitle: definition.title,
        entries: (await valueHistory(ctx.db, id, attributeId)).map((entry) => ({
          factId: entry.factId,
          value: serializeHistoryValue(definition, entry),
          validFrom: entry.validFrom,
          observedAt: entry.observedAt,
          source: entry.source,
          sourceRef: entry.sourceRef,
          confidence: entry.confidence,
          isCurrent: entry.isCurrent,
          isRemoval: entry.removedAt !== null,
          removedAt: entry.removedAt,
        })),
      }
    },
  )
})
