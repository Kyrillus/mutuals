/**
 * The derived columns of §4.1 and §4.7, recomputed from the data that is actually in the database.
 *
 * The nightly sweep that owns this in production belongs to a later stage; this is the same three
 * steps it will perform, written where the seed needs them: one aggregate query, `computeWarmth()`
 * in TypeScript — the **only** implementation (ADR-022), so no SQL twin exists to drift from it —
 * and one batched write-back. `pnpm db:check` calls it too, which is what makes a filter on
 * `warmth` or `last_interaction_at` measurable at 10k rows.
 *
 * `today` is injected. Nothing here reads the wall clock (ADR-081).
 */
import { sql } from 'kysely'
import {
  civil,
  computeWarmth,
  WARMTH_WINDOW_DAYS,
  addDays,
  type CivilDate,
  type WarmthInteraction,
} from '@mutuals/core'

import type { Executor } from '../write/types.ts'

export interface MetricsOptions {
  readonly today: CivilDate
  /** `profile.time_zone`; the civil day an interaction falls on is only defined in a zone. */
  readonly timeZone?: string
}

export interface MetricsResult {
  readonly contacts: number
  readonly organizations: number
  /** The warmth distribution, so a seed run can show at a glance that it is not uniform. */
  readonly warmthBuckets: Readonly<Record<string, number>>
}

interface TouchRow {
  contact_id: string
  type: string
  day: string
}

interface ContactRow {
  id: string
  pinned_important: boolean
  not_important: boolean
}

const WRITE_CHUNK = 500

/**
 * Recomputes `contact_metrics` and `organization_metrics` for the whole workspace.
 *
 * Every contact is written, not only the ones with a recent interaction: a contact who goes quiet
 * would otherwise keep last year's warmth for ever, which ADR-022 names explicitly.
 */
export async function recomputeMetrics(
  exec: Executor,
  options: MetricsOptions,
): Promise<MetricsResult> {
  const timeZone = options.timeZone ?? (await profileTimeZone(exec)) ?? 'Europe/Berlin'
  const windowStart = addDays(options.today, -WARMTH_WINDOW_DAYS)

  const contacts = await exec
    .selectFrom('contact')
    .select(['id', 'pinned_important', 'not_important'])
    .execute()

  // Only the warmth window is fetched. `last_interaction_at` and the 12-month count are set-based
  // aggregates and stay in SQL, because they are counts rather than a decay curve.
  const touches = await sql<TouchRow>`
    select ic.contact_id,
           i.type,
           to_char((i.occurred_at at time zone ${timeZone})::date, 'YYYY-MM-DD') as day
      from interaction_contact ic
      join interaction i on i.id = ic.interaction_id
     where i.occurred_at >= (${windowStart}::date::timestamp at time zone ${timeZone})
  `.execute(exec)

  const byContact = new Map<string, WarmthInteraction[]>()
  for (const row of touches.rows) {
    const list = byContact.get(row.contact_id) ?? []
    list.push({ type: row.type, occurredOn: civil(row.day) })
    byContact.set(row.contact_id, list)
  }

  const warmthBuckets: Record<string, number> = {
    '0-9': 0,
    '10-24': 0,
    '25-49': 0,
    '50-74': 0,
    '75-100': 0,
  }
  const warmth = contacts.map((contact: ContactRow) => {
    const result = computeWarmth(
      byContact.get(contact.id) ?? [],
      { pinnedImportant: contact.pinned_important, notImportant: contact.not_important },
      options.today,
    )
    warmthBuckets[bucketOf(result.warmth)] = (warmthBuckets[bucketOf(result.warmth)] ?? 0) + 1
    return { id: contact.id, warmth: result.warmth }
  })

  await writeWarmth(exec, warmth)
  await writeContactAggregates(exec, options.today, timeZone)
  await writeOrganizationAggregates(exec)
  await sql`update workspace set metrics_swept_at = now()`.execute(exec)

  const organizations = await exec
    .selectFrom('organization')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirst()

  return {
    contacts: contacts.length,
    organizations: Number(organizations?.n ?? 0),
    warmthBuckets,
  }
}

function bucketOf(warmth: number): string {
  if (warmth < 10) return '0-9'
  if (warmth < 25) return '10-24'
  if (warmth < 50) return '25-49'
  if (warmth < 75) return '50-74'
  return '75-100'
}

async function writeWarmth(
  exec: Executor,
  rows: readonly { id: string; warmth: number }[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
    const chunk = rows.slice(start, start + WRITE_CHUNK)
    await sql`
      update contact_metrics m
         set warmth = v.warmth::smallint, computed_at = now()
        from (values ${sql.join(
          chunk.map((row) => sql`(${row.id}::uuid, ${row.warmth})`),
        )}) as v(id, warmth)
       where m.contact_id = v.id
    `.execute(exec)
  }
}

/**
 * `last_interaction_at`, `interaction_count_12m`, `open_followups` and `next_followup_at` in one
 * statement each. They are counts over indexed columns, so keeping them in SQL costs nothing and
 * saves pulling every interaction of every contact into Node.
 */
async function writeContactAggregates(
  exec: Executor,
  today: CivilDate,
  timeZone: string,
): Promise<void> {
  const windowStart = addDays(today, -365)

  await sql`
    update contact_metrics m
       set last_interaction_at = agg.last_at,
           interaction_count_12m = agg.count_12m,
           computed_at = now()
      from (
        select c.id as contact_id,
               max(i.occurred_at) as last_at,
               count(i.id) filter (
                 where i.occurred_at >= (${windowStart}::date::timestamp at time zone ${timeZone})
               )::int as count_12m
          from contact c
          left join interaction_contact ic on ic.contact_id = c.id
          left join interaction i on i.id = ic.interaction_id
         group by c.id
      ) as agg
     where m.contact_id = agg.contact_id
  `.execute(exec)

  await sql`
    update contact_metrics m
       set open_followups = agg.open_count,
           next_followup_at = agg.next_due,
           computed_at = now()
      from (
        select c.id as contact_id,
               count(f.id) filter (where f.status = 'Open')::int as open_count,
               min(f.due_at) filter (where f.status = 'Open') as next_due
          from contact c
          left join follow_up f on f.contact_id = c.id
         group by c.id
      ) as agg
     where m.contact_id = agg.contact_id
  `.execute(exec)
}

/**
 * `people_count` counts distinct contacts linked to the organization by any relation attribute,
 * past positions included — §6.3's "People" column is the organization's whole roster, and the
 * Connections tab is where current and past are told apart.
 */
async function writeOrganizationAggregates(exec: Executor): Promise<void> {
  await sql`
    update organization_metrics m
       set people_count = agg.people,
           last_interaction_at = agg.last_at,
           computed_at = now()
      from (
        select o.id as organization_id,
               (select count(distinct l.from_record_id)::int
                  from record_link l where l.to_record_id = o.id) as people,
               (select max(i.occurred_at)
                  from interaction_organization io
                  join interaction i on i.id = io.interaction_id
                 where io.organization_id = o.id) as last_at
          from organization o
      ) as agg
     where m.organization_id = agg.organization_id
  `.execute(exec)
}

async function profileTimeZone(exec: Executor): Promise<string | undefined> {
  const row = await exec.selectFrom('profile').select('time_zone').limit(1).executeTakeFirst()
  return row?.time_zone
}
