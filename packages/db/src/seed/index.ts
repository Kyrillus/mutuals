/**
 * `pnpm seed` — the demo network of §8.1: ~200 contacts, ~60 organizations, ~500 interactions and
 * ~40 follow-ups, written through the real write path so Simon has something to click on and so
 * every later stage has a dataset that behaves like real data.
 *
 * Three steps, in this order and for a reason:
 *
 * 1. `buildSeedPlan` decides the whole network offline, from a seeded faker and an injected
 *    `today`. Same inputs, same network.
 * 2. `applySeedPlan` writes it through `createContact` / `applyValues` / `createInteraction`, so
 *    the fact log, the projector, the identifier write-through and the label trigger all run.
 * 3. `recomputeMetrics` derives warmth and the four relationship columns from what was written —
 *    never from the plan — so a wrong projector shows up as wrong warmth rather than being papered
 *    over by a number the seed made up.
 */
import { sql } from 'kysely'

import type { Executor } from '../write/types.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'
import { applySeedPlan, type SeedIds } from './apply.ts'
import { assertSeedCounts, readSeedCounts, type SeedCounts } from './counts.ts'
import { recomputeMetrics, type MetricsResult } from './metrics.ts'
import { buildSeedPlan, type SeedPlan, type SeedPlanOptions } from './plan.ts'
import { seedDefaultViews } from './views.ts'

export * from './counts.ts'
export * from './data.ts'
export * from './metrics.ts'
export * from './plan.ts'
export * from './views.ts'
export { applySeedPlan, type ApplyOptions, type SeedIds } from './apply.ts'

export interface SeedOptions extends SeedPlanOptions {
  /** Wipe the existing demo data first. Default `true`: `pnpm seed` is idempotent. */
  readonly reset?: boolean
  /** Run the count assertions afterwards and throw if any fails. */
  readonly assertCounts?: boolean
  readonly workspaceId?: string | null
  readonly timeZone?: string
}

export interface SeedResult {
  readonly plan: SeedPlan
  readonly ids: SeedIds
  readonly counts: SeedCounts
  readonly metrics: MetricsResult
  readonly views: number
}

/**
 * Removes everything the seed creates, and nothing else.
 *
 * `record` is the supertype, so one `DELETE` takes the contacts, organizations, interactions,
 * facts, values, links, identifiers, metrics rows, search documents and follow-ups with it
 * (ADR-015/ADR-016). Attribute definitions are deliberately **not** touched: they are the user's
 * schema, and a seed that silently deleted a field somebody created would be a bug, not a reset.
 */
export async function resetSeedData(exec: Executor): Promise<void> {
  await sql`delete from saved_view`.execute(exec)
  await sql`delete from import_batch`.execute(exec)
  await sql`delete from record`.execute(exec)
}

/**
 * There is one profile row and no authentication in Phase 1 (§6.6), but the write path reads
 * `profile.phone_region` to normalise a phone number into an identifier — so a database with no
 * profile silently produces no phone identifiers at all.
 */
async function ensureProfile(exec: Executor, workspaceId: string): Promise<void> {
  const existing = await exec.selectFrom('profile').select('id').limit(1).executeTakeFirst()
  if (existing !== undefined) return
  await exec
    .insertInto('profile')
    .values({
      workspace_id: workspaceId,
      first_name: 'Simon',
      last_name: 'Mutuals',
      email: 'simon@example.com',
      language: 'en',
      phone_region: 'DE',
      time_zone: 'Europe/Berlin',
    })
    .execute()
}

/**
 * Seeds a database. The caller passes a `Kysely` instance; one transaction wraps everything, so a
 * failure halfway through leaves the database exactly as it was.
 */
export async function seedDatabase(exec: Executor, options: SeedOptions): Promise<SeedResult> {
  const plan = buildSeedPlan(options)

  const run = async (trx: Executor): Promise<Omit<SeedResult, 'counts'>> => {
    const workspaceId = await resolveWorkspaceId(trx, options.workspaceId)
    await ensureProfile(trx, workspaceId)
    if (options.reset !== false) await resetSeedData(trx)

    const ids = await applySeedPlan(trx, plan, { workspaceId })
    const views = await seedDefaultViews(trx, workspaceId)
    const metrics = await recomputeMetrics(trx, {
      today: plan.today,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    })
    return { plan, ids, metrics, views }
  }

  const written = exec.isTransaction
    ? await run(exec)
    : await exec.transaction().execute((trx) => run(trx))

  // Assertions run outside the transaction, against committed state: a count that only holds
  // inside the writing transaction is not a count anybody else can rely on.
  const counts = options.assertCounts ? await assertSeedCounts(exec) : await readSeedCounts(exec)
  return { ...written, counts }
}
