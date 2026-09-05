/**
 * The daily cost cap (ADR-070; Q7, answered 2026-09-05 at $5.00).
 *
 * A circuit breaker, not a budget. That distinction decides where the check goes: **immediately
 * before every billable HTTP POST**, inside the transport, rather than once at the top of a task.
 * One logical task can bill six generations — three transport attempts plus three on the repair
 * exchange — so a single check per task lets a retry storm run to six times the number in the
 * setting before anything notices. Checking per request is the only placement that means what the
 * setting says.
 *
 * The window is the **profile's civil day** (ADR-045), not UTC and not a rolling 24 hours. Every
 * other "today" in this product is the profile's, and a breaker that resets at 02:00 local time is
 * a support question waiting to happen.
 */
import { llmSpentToday, type Executor } from '@mutuals/db'

import { LlmBudgetError } from './errors.ts'

/**
 * How long a refreshed total is trusted before the table is read again.
 *
 * Not zero. The counter is exact for spend from *this* process, because every response adds to it;
 * the query exists to pick up a second process — `apps/worker`, a CLI, a `pnpm llm:record` run.
 * Five seconds bounds how far behind the breaker can be, for one indexed aggregate per five
 * seconds of continuous LLM traffic rather than one per request.
 */
const REFRESH_AFTER_MS = 5_000

export interface BudgetWindow {
  /** The profile's civil day (ADR-045). The rollover signal, and the SQL window's anchor. */
  readonly today: string
  readonly timeZone: string
  readonly limitUsd: number
  /** ADR-034: injected, never `now()` inside the query. */
  readonly now: Date
}

/**
 * A process-local counter, refreshed from `llm_call_cost_idx`.
 *
 * One per process: `context.ts` builds the client once, so two concurrent requests share the
 * counter rather than each believing it has the whole cap to itself.
 */
export class CostBudget {
  #today = ''
  #spentUsd = 0
  #refreshedAtMs = -1

  /** For the stats route and the tests: what this process believes has been spent today. */
  get spentUsd(): number {
    return this.#spentUsd
  }

  /**
   * Throws {@link LlmBudgetError} when the day's limit is already reached.
   *
   * A limit of 0 disables the breaker, which `.env.example` documents and does not recommend.
   */
  async assertWithinBudget(exec: Executor, window: BudgetWindow): Promise<void> {
    if (window.limitUsd <= 0) return

    const nowMs = window.now.getTime()
    const rolledOver = window.today !== this.#today
    if (rolledOver || nowMs - this.#refreshedAtMs >= REFRESH_AFTER_MS) {
      this.#today = window.today
      this.#spentUsd = await llmSpentToday(exec, window)
      this.#refreshedAtMs = nowMs
    }

    if (this.#spentUsd >= window.limitUsd) {
      throw new LlmBudgetError(
        `The daily limit for AI features is $${window.limitUsd.toFixed(2)} and $${this.#spentUsd.toFixed(2)} has been spent today. It resets at midnight.`,
        this.#spentUsd,
        window.limitUsd,
      )
    }
  }

  /** Adds what a call actually cost. Called for every response that reports one. */
  record(costUsd: number | null): void {
    if (costUsd === null || !Number.isFinite(costUsd)) return
    this.#spentUsd += costUsd
  }

  /** Test seam: a fresh process's view. */
  reset(): void {
    this.#today = ''
    this.#spentUsd = 0
    this.#refreshedAtMs = -1
  }
}
