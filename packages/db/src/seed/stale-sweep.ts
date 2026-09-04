/**
 * The "recompute warmth if it is stale" half of Q6, which Simon answered on 2026-09-04:
 * recompute at startup when stale, **provided it is cheap** (ADR-093).
 *
 * It is cheap, and this is why. Warmth changes on its own only where `computeWarmth` would return
 * something different tomorrow, and its only time-dependent input is the decay on interactions
 * inside the window. A contact at 0 with nothing in the window is at a fixed point: 0 today, 0 for
 * ever. So the set that has to be touched is "warmth is not already at rest, **or** there is an
 * interaction still in the window".
 *
 * Measured here at 10,000 contacts × 60 attributes: **156 movable contacts of 10,200**, swept in
 * **27 ms**; 0 ms when the workspace is already fresh; 396 ms to recompute all 10,200 for
 * comparison.
 *
 * **This is not the shortcut ADR-022 warns about.** That warning is about a contact who goes quiet
 * keeping last year's warmth for ever — and such a contact has `warmth > 0`, so this predicate
 * keeps recomputing them every day until they decay to 0, which is the correct resting value. What
 * is skipped is only contacts already at that resting value.
 *
 * The window is `WARMTH_WINDOW_DAYS + 1`, not `WARMTH_WINDOW_DAYS`. On the day a contact's last
 * interaction falls out of the window their score becomes 0, and a boundary that excluded them
 * that morning would freeze them at yesterday's number instead.
 */
import { sql } from 'kysely'
import { WARMTH_WINDOW_DAYS, addDays, type CivilDate } from '@mutuals/core'

import type { Executor } from '../write/types.ts'
import { recomputeMetrics, type MetricsResult } from './metrics.ts'

export interface StaleSweepOptions {
  readonly today: CivilDate
  readonly timeZone?: string
  /** How stale is stale. Simon's answer to Q6 picked a day; the ADR explains why that is invisible. */
  readonly maxAgeHours?: number
}

export interface StaleSweepResult {
  readonly ran: boolean
  readonly contacts: number
  readonly milliseconds: number
}

/** The contacts whose warmth can still move on its own, which is a small fraction of any workspace. */
async function movableContacts(
  exec: Executor,
  today: CivilDate,
  timeZone: string,
): Promise<string[]> {
  const windowStart = addDays(today, -(WARMTH_WINDOW_DAYS + 1))

  const rows = await sql<{ id: string }>`
    select c.id
      from contact c
      join contact_metrics m on m.contact_id = c.id
     where m.warmth > 0
        or exists (
             select 1
               from interaction_contact ic
               join interaction i on i.id = ic.interaction_id
              where ic.contact_id = c.id
                and i.occurred_at >= (${windowStart}::date::timestamp at time zone ${timeZone})
           )
  `.execute(exec)

  return rows.rows.map((row) => row.id)
}

/**
 * Runs the sweep if the workspace has not been swept recently. Returns `ran: false` and touches
 * nothing when it is fresh, which is the common case — the app is opened many times a day.
 */
export async function sweepIfStale(
  exec: Executor,
  options: StaleSweepOptions,
): Promise<StaleSweepResult> {
  const maxAgeHours = options.maxAgeHours ?? 20
  const startedAt = Date.now()

  const row = await sql<{ stale: boolean }>`
    select coalesce(metrics_swept_at < now() - make_interval(hours => ${maxAgeHours}), true) as stale
      from workspace
     limit 1
  `.execute(exec)

  if (row.rows[0]?.stale !== true) {
    return { ran: false, contacts: 0, milliseconds: Date.now() - startedAt }
  }

  const timeZone = options.timeZone ?? 'Europe/Berlin'
  const contactIds = await movableContacts(exec, options.today, timeZone)

  // Scoped, but still a sweep: the whole point is that the contacts left out provably cannot have
  // changed, so stamping the workspace is honest and stops the next startup repeating this.
  const result: MetricsResult = await recomputeMetrics(exec, {
    today: options.today,
    timeZone,
    scope: { contactIds },
  })
  await sql`update workspace set metrics_swept_at = now()`.execute(exec)

  return { ran: true, contacts: result.contacts, milliseconds: Date.now() - startedAt }
}
