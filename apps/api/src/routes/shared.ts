/**
 * What every route file needs and none of them should own a second copy of.
 */
import type { BulkResult, ObjectType, RawQuery } from '@mutuals/core'
import { getRecord, type HydratedRecord, type ValueChange } from '@mutuals/db'
import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import type { AppContext, RequestSettings, Schema } from '../context.ts'
import { notFound, validationFailed } from '../errors.ts'
import { assertRelationTargets, planAttributeWrites } from '../write/attributes.ts'

export interface RoutesOptions {
  readonly ctx: AppContext
}

/** Every fact this API writes says it came from a person using the app (§4.5). */
export const MANUAL_PROVENANCE = { source: 'manual' } as const

/** The Fastify instance a route file is handed: the root one, with the Zod type provider on it. */
type RouteInstance = Parameters<FastifyPluginAsyncZod<RoutesOptions>>[0]

/**
 * Adapts a synchronous route registrar to Fastify's asynchronous plugin contract.
 *
 * Registering routes awaits nothing, and writing `async` for a function with no `await` in it is
 * the kind of thing that stops meaning anything after the third file. This also unwraps `ctx` once
 * instead of in every route file.
 */
export function routePlugin(
  register: (app: RouteInstance, ctx: AppContext) => void,
): FastifyPluginAsyncZod<RoutesOptions> {
  return (app, options) => {
    register(app, options.ctx)
    return Promise.resolve()
  }
}

/**
 * Loads one record and proves it is the type the route claims.
 *
 * The check is not paranoia: `record` is a supertype with one id space (ADR-015), so
 * `GET /contacts/<an organization id>` is a well-formed request for a row that exists. It answers
 * 404, not a contact-shaped rendering of an organization.
 */
export async function requireRecord(
  ctx: AppContext,
  id: string,
  objectType: ObjectType,
): Promise<HydratedRecord> {
  const record = await getRecord(ctx.db, id)
  if (record === undefined || record.objectType !== objectType) throw notFound(objectType, id)
  return record
}

export async function recordExists(
  ctx: AppContext,
  id: string,
  objectType: ObjectType,
): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('record')
    .select('object_type')
    .where('id', '=', id)
    .executeTakeFirst()
  return row?.object_type === objectType
}

/**
 * The querystring as the list codec wants it.
 *
 * Fastify's own parser has already produced an object of strings; `parseListQuery` is what turns
 * that into a `ListQuery`. It runs in the handler rather than as Fastify's `querystringParser`
 * because that hook is server-wide and would then also run for `/follow-ups`, whose query string
 * is a different shape entirely.
 */
export function rawQuery(request: FastifyRequest): RawQuery {
  return request.query as RawQuery
}

/**
 * The two-step validation every write of user-defined fields goes through: shape and type first
 * (pure), then the one query that proves a relation points at a record of the right kind.
 *
 * Both failures come back as one 400 listing every field, because a create dialog with four bad
 * values should light up four inputs, not one per round trip.
 */
export async function planWrites(
  ctx: AppContext,
  schema: Schema,
  settings: Pick<RequestSettings, 'phoneRegion'>,
  attributes: Readonly<Record<string, unknown>> | undefined,
): Promise<ValueChange[]> {
  const planned = planAttributeWrites(attributes, schema, settings)
  if (!planned.ok) throw validationFailed(planned.issues)
  const targets = await assertRelationTargets(ctx, schema, planned.value)
  if (!targets.ok) throw validationFailed(targets.issues)
  return planned.value
}

export interface BulkFailure {
  readonly id: string
  readonly code: string
  readonly message: string
}

export function bulkResult(
  attempted: number,
  succeeded: readonly string[],
  failed: readonly BulkFailure[],
): BulkResult {
  return {
    data: { succeeded: [...succeeded], failed: [...failed] },
    meta: { attempted, succeeded: succeeded.length, failed: failed.length },
  }
}
