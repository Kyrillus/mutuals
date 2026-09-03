/**
 * What a handler is given: the database, the validated environment, and a clock.
 *
 * The clock is a parameter rather than a call to `new Date()` inside a handler for the same reason
 * `packages/core` forbids ambient time (ADR-034) — an integration test that asserts "due this week"
 * must be able to say which week — but the rule is one level weaker here: `apps/api` may read the
 * wall clock, it just does it in exactly one place.
 */
import {
  makeFieldResolver,
  todayIn,
  type AttributeDefinition,
  type CivilDate,
  type FieldResolver,
  type ObjectType,
  type TypeContext,
} from '@mutuals/core'
import { normalizePhone } from '@mutuals/core/phone'
import { listAttributeDefinitions, resolveWorkspaceId, type Executor } from '@mutuals/db'

import type { Env } from './env.ts'

export interface AppContext {
  readonly db: Executor
  readonly env: Env
  readonly now: () => Date
}

/**
 * The profile's two ambient settings (ADR-045), resolved for one request.
 *
 * No profile row exists until the user saves one, so the environment defaults stand in. That is
 * also why this is read per request rather than cached: the cache would need invalidating from
 * `updateProfile`, from the seed script and from every test's `TRUNCATE`, and one indexed
 * single-row read is cheaper than getting that wrong.
 */
export interface RequestSettings {
  readonly profileId: string | null
  readonly firstName: string
  readonly lastName: string
  readonly email: string | null
  readonly language: string
  readonly phoneRegion: string
  readonly timeZone: string
  readonly createdAt: Date | null
  readonly updatedAt: Date | null
  /** The civil day the profile's timezone is on right now. */
  readonly today: CivilDate
}

export async function loadSettings(ctx: AppContext): Promise<RequestSettings> {
  const row = await ctx.db
    .selectFrom('profile')
    .select([
      'id',
      'first_name',
      'last_name',
      'email',
      'language',
      'phone_region',
      'time_zone',
      'created_at',
      'updated_at',
    ])
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst()

  const timeZone = row?.time_zone ?? ctx.env.DEFAULT_TIME_ZONE
  return {
    profileId: row?.id ?? null,
    firstName: row?.first_name ?? '',
    lastName: row?.last_name ?? '',
    email: row?.email ?? null,
    language: row?.language ?? 'en',
    phoneRegion: row?.phone_region ?? ctx.env.DEFAULT_PHONE_REGION,
    timeZone,
    createdAt: row === undefined ? null : toDate(row.created_at),
    updatedAt: row === undefined ? null : toDate(row.updated_at),
    today: todayIn(timeZone, ctx.now()),
  }
}

function toDate(value: Date | string): Date {
  return typeof value === 'string' ? new Date(value) : value
}

export async function workspaceId(ctx: AppContext): Promise<string> {
  return resolveWorkspaceId(ctx.db)
}

export interface Schema {
  readonly definitions: readonly AttributeDefinition[]
  readonly resolver: FieldResolver
  readonly bySlug: ReadonlyMap<string, AttributeDefinition>
  readonly byId: ReadonlyMap<string, AttributeDefinition>
}

/**
 * The attribute definitions of one object type, plus the resolver that puts them in one namespace
 * with the system and derived columns.
 *
 * Read on every request that touches attributes. That is the price of "attribute definitions drive
 * everything": the alternative is a process-level cache that has to be invalidated by every
 * `createAttributeDefinition`, including one issued by a different process — psql, the MCP server,
 * a second API instance — which is exactly the class of staleness this design exists to avoid.
 */
export async function loadSchema(ctx: AppContext, objectType: ObjectType): Promise<Schema> {
  const definitions = await listAttributeDefinitions(ctx.db, objectType)
  return {
    definitions,
    resolver: makeFieldResolver(objectType, definitions),
    bySlug: new Map(definitions.map((definition) => [definition.slug, definition])),
    byId: new Map(definitions.map((definition) => [definition.id, definition])),
  }
}

/**
 * The context an attribute type validates and normalises against.
 *
 * `normalizePhone` is injected here and nowhere else: `packages/core` leaves it undefined so the
 * browser bundle never pulls libphonenumber-js's metadata (ADR-035), and the API — which does have
 * to write E.164 into the identifier table — supplies it from the `./phone` subpath.
 */
export function typeContext(
  definition: AttributeDefinition,
  settings: Pick<RequestSettings, 'phoneRegion'>,
): TypeContext {
  return {
    options: definition.options ?? [],
    phoneRegion: settings.phoneRegion,
    normalizePhone: (raw, region) => {
      const result = normalizePhone(raw, region === undefined ? {} : { defaultRegion: region })
      return result.ok ? result.value.e164 : undefined
    },
  }
}
