/**
 * Reading `llm_call` — the cost probe the circuit breaker checks, and the spend report `/stats/llm`
 * answers with (ADR-068, ADR-070).
 *
 * These are *reads of a table*, so they live with the other repositories rather than inside
 * `apps/api/src/llm/`. The distinction matters because ADR-071's ESLint rule bans that directory
 * from business logic: the trace table is ordinary data and anything may read it, while the client
 * that spends money is what must stay out of the domain. Putting the queries here is what lets the
 * settings route report yesterday's spend without being granted an exemption it does not need.
 *
 * Both derive their day boundary in SQL from an **injected** instant. Postgres carries the tz
 * database, so `date_trunc('day', … at time zone …)` is the one implementation that gets a
 * DST-shortened day right, and `now()` never reaches the query (ADR-034, ADR-045).
 */
import { sql } from 'kysely'

import type { LlmTaskKind } from '../schema.ts'
import type { Executor } from '../write/types.ts'

export interface DayWindow {
  readonly now: Date
  readonly timeZone: string
}

/**
 * What has been spent since the start of the profile's civil day.
 *
 * `numeric` arrives from node-pg as a string — the only way `0.00012345` survives the round trip —
 * so the sum is cast to text in SQL and converted exactly once, here.
 */
export async function llmSpentToday(exec: Executor, window: DayWindow): Promise<number> {
  const rows = await sql<{ total: string }>`
    select coalesce(sum(cost_usd), 0)::text as total
      from llm_call
     where cost_usd is not null
       and created_at >= date_trunc('day', ${window.now} at time zone ${window.timeZone})
                           at time zone ${window.timeZone}
  `.execute(exec)
  return Number(rows.rows[0]?.total ?? 0)
}

/** One row of the spend report: a day, a task kind and a prompt version. */
export interface LlmSpendRow {
  readonly day: string
  readonly taskKind: LlmTaskKind
  readonly promptId: string
  readonly promptVersion: number
  readonly calls: number
  readonly costUsd: number
  readonly promptTokens: number
  readonly completionTokens: number
  /**
   * Calls whose provider reported no cost at all.
   *
   * Without this a total of $0.00 is ambiguous — free, or unreported? — and ADR-070 chose to record
   * `NULL, 'unreported'` rather than estimate from a price table. The count is how that honesty
   * stays readable instead of looking like a bug.
   */
  readonly unreportedCalls: number
}

export async function llmSpend(
  exec: Executor,
  options: { since: Date; timeZone: string },
): Promise<readonly LlmSpendRow[]> {
  const rows = await sql<{
    day: string
    task_kind: LlmTaskKind
    prompt_id: string
    prompt_version: number
    calls: string
    cost_usd: string
    prompt_tokens: string
    completion_tokens: string
    unreported_calls: string
  }>`
    select to_char((created_at at time zone ${options.timeZone})::date, 'YYYY-MM-DD') as day,
           task_kind,
           prompt_id,
           prompt_version,
           count(*)::text                                          as calls,
           coalesce(sum(cost_usd), 0)::text                        as cost_usd,
           coalesce(sum(prompt_tokens), 0)::text                   as prompt_tokens,
           coalesce(sum(completion_tokens), 0)::text               as completion_tokens,
           count(*) filter (where cost_source = 'unreported')::text as unreported_calls
      from llm_call
     where created_at >= ${options.since}
     group by 1, 2, 3, 4
     order by 1 desc, 2, 3, 4
  `.execute(exec)

  return rows.rows.map((row) => ({
    day: row.day,
    taskKind: row.task_kind,
    promptId: row.prompt_id,
    promptVersion: row.prompt_version,
    calls: Number(row.calls),
    costUsd: Number(row.cost_usd),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    unreportedCalls: Number(row.unreported_calls),
  }))
}
