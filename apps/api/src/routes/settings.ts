/**
 * The dashboard's numbers (§6.1) and the profile (§6.6).
 *
 * Every stat card links to a pre-filtered view, so every number here is an exact count over the
 * same predicate that view will use — "follow-ups due this week" counts what the Follow-ups page
 * will list, not something approximately like it.
 */
import {
  ProfileSchema,
  StatsSchema,
  UpdateProfileSchema,
  addDays,
  type Profile,
} from '@mutuals/core'

import { loadSettings, workspaceId } from '../context.ts'
import { ok200 } from '../http/schema.ts'
import { routePlugin } from './shared.ts'

export const settingsRoutes = routePlugin((app, ctx) => {
  app.get(
    '/stats',
    {
      schema: {
        operationId: 'getStats',
        tags: ['dashboard'],
        summary: "§6.1's key numbers, each an exact count",
        response: ok200(StatsSchema),
      },
    },
    async () => {
      const settings = await loadSettings(ctx)
      const today = settings.today
      const weekEnd = addDays(today, 7)
      const thirtyDaysAgo = addDays(today, -30)

      const [byType, recent, dueThisWeek, overdue] = await Promise.all([
        ctx.db
          .selectFrom('record')
          .select((eb) => ['object_type', eb.fn.countAll<string>().as('total')])
          .groupBy('object_type')
          .execute(),
        // A civil day boundary, not `now() - interval '30 days'`: "added in the last 30 days" is a
        // statement about days in the profile's timezone (ADR-045), and the cutoff is bound.
        ctx.db
          .selectFrom('record')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .where('object_type', '=', 'contact')
          .where('created_at', '>=', new Date(`${thirtyDaysAgo}T00:00:00Z`))
          .executeTakeFirst(),
        ctx.db
          .selectFrom('follow_up')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .where('status', '=', 'Open')
          .where('due_at', '>=', today)
          .where('due_at', '<=', weekEnd)
          .executeTakeFirst(),
        ctx.db
          .selectFrom('follow_up')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .where('status', '=', 'Open')
          .where('due_at', '<', today)
          .executeTakeFirst(),
      ])

      const counted = new Map(byType.map((row) => [row.object_type, Number(row.total)]))
      return {
        totalContacts: counted.get('contact') ?? 0,
        totalOrganizations: counted.get('organization') ?? 0,
        totalInteractions: counted.get('interaction') ?? 0,
        contactsAddedLast30Days: Number(recent?.total ?? 0),
        followUpsDueThisWeek: Number(dueThisWeek?.total ?? 0),
        followUpsOverdue: Number(overdue?.total ?? 0),
        today,
      }
    },
  )

  app.get(
    '/profile',
    {
      schema: {
        operationId: 'getProfile',
        tags: ['dashboard'],
        summary:
          'The single profile. Before the first save this answers the defaults with a null id.',
        response: ok200(ProfileSchema),
      },
    },
    async () => toProfile(await loadSettings(ctx)),
  )

  app.patch(
    '/profile',
    {
      schema: {
        operationId: 'updateProfile',
        tags: ['dashboard'],
        summary: 'Save the profile. The first save creates the row.',
        body: UpdateProfileSchema,
        response: ok200(ProfileSchema),
      },
    },
    async (request) => {
      const body = request.body
      const current = await loadSettings(ctx)

      if (current.profileId === null) {
        await ctx.db
          .insertInto('profile')
          .values({
            workspace_id: await workspaceId(ctx),
            first_name: body.firstName ?? current.firstName,
            last_name: body.lastName ?? current.lastName,
            email: body.email ?? null,
            ...(body.language === undefined ? {} : { language: body.language }),
            phone_region: body.phoneRegion ?? current.phoneRegion,
            time_zone: body.timeZone ?? current.timeZone,
          })
          .execute()
      } else {
        await ctx.db
          .updateTable('profile')
          .set({
            ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
            ...(body.lastName === undefined ? {} : { last_name: body.lastName }),
            ...(body.email === undefined ? {} : { email: body.email ?? null }),
            ...(body.language === undefined ? {} : { language: body.language }),
            ...(body.phoneRegion === undefined ? {} : { phone_region: body.phoneRegion }),
            ...(body.timeZone === undefined ? {} : { time_zone: body.timeZone }),
            updated_at: new Date(),
          })
          .where('id', '=', current.profileId)
          .execute()
      }

      return toProfile(await loadSettings(ctx))
    },
  )
})

function toProfile(settings: Awaited<ReturnType<typeof loadSettings>>): Profile {
  return {
    id: settings.profileId,
    firstName: settings.firstName,
    lastName: settings.lastName,
    email: settings.email,
    language: settings.language,
    phoneRegion: settings.phoneRegion,
    timeZone: settings.timeZone,
    createdAt: settings.createdAt === null ? null : settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt === null ? null : settings.updatedAt.toISOString(),
  }
}
