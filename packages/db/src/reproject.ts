/**
 * `pnpm db:reproject` — rebuild every derived value from `fact` alone, and the per-record digest
 * map that proves it (ADR-025).
 *
 * This is the entire safety argument for keeping a derived copy at all: `attribute_value`,
 * `record_link` and `search_document` are allowed to exist only because a full rebuild reproduces
 * them exactly. So the rebuild deliberately calls `project_record` — the same function the write
 * path and the `AFTER STATEMENT` backstop call — rather than a second, set-based copy of it. A
 * hand-written twin would make the gate compare one implementation against another instead of
 * comparing accumulated state against a rebuild, which is the thing that can actually drift.
 *
 * `identifier` is the exception: §4.6 accumulates every handle ever seen, including handles whose
 * fact has long since been superseded, so it is topped up rather than truncated. That still makes
 * the digest meaningful — after a rebuild it must contain exactly what it contained before, since
 * every current value already wrote its row.
 */
import { sql } from 'kysely'
import type { Uuid } from '@mutuals/core'
import { writeIdentifiersForRecords } from './write/identifiers.ts'
import type { Executor } from './write/types.ts'

/** `record_id` → a digest of everything derived from that record's facts. */
export type DigestMap = Record<string, string>

export interface ReprojectResult {
  readonly records: number
  readonly identifiers: number
}

export interface EquivalenceReport {
  readonly ok: boolean
  readonly before: DigestMap
  readonly after: DigestMap
  /** The records whose digest moved, which is what a failing gate should name. */
  readonly diverged: readonly string[]
}

/** Records are re-identified in batches so a 10k rebuild is a handful of round trips, not 10k. */
const IDENTIFIER_BATCH = 500

async function inTransaction<T>(exec: Executor, fn: (trx: Executor) => Promise<T>): Promise<T> {
  if (exec.isTransaction) return fn(exec)
  return exec.transaction().execute((trx) => fn(trx))
}

/** Rebuilds every derived table in the database from `fact`. */
export async function reprojectAll(exec: Executor): Promise<ReprojectResult> {
  return inTransaction(exec, async (trx) => {
    await sql`delete from attribute_value`.execute(trx)
    await sql`delete from record_link`.execute(trx)
    await sql`delete from search_document`.execute(trx)

    // One statement, one invocation of the projector per record. The projector is idempotent and
    // scoped by record, so ordering does not matter.
    const projected = await sql<{ id: string }>`
      select r.id from record r, lateral project_record(r.id, null)
    `.execute(trx)

    const ids = projected.rows.map((row) => row.id)
    const identifiers = await topUpIdentifiers(trx, ids)
    return { records: ids.length, identifiers }
  })
}

/** The same, for one record or a page of them — the repair path after a manual `psql` session. */
export async function reprojectRecords(
  exec: Executor,
  recordIds: readonly Uuid[],
): Promise<ReprojectResult> {
  if (recordIds.length === 0) return { records: 0, identifiers: 0 }
  const ids = [...new Set(recordIds)]

  return inTransaction(exec, async (trx) => {
    await trx.deleteFrom('attribute_value').where('record_id', 'in', ids).execute()
    await trx.deleteFrom('record_link').where('from_record_id', 'in', ids).execute()
    await trx.deleteFrom('search_document').where('record_id', 'in', ids).execute()
    for (const id of ids) {
      await sql`select project_record(${id}, null)`.execute(trx)
    }
    const identifiers = await topUpIdentifiers(trx, ids)
    return { records: ids.length, identifiers }
  })
}

async function topUpIdentifiers(trx: Executor, ids: readonly string[]): Promise<number> {
  let identifiers = 0
  for (let start = 0; start < ids.length; start += IDENTIFIER_BATCH) {
    identifiers += await writeIdentifiersForRecords(trx, ids.slice(start, start + IDENTIFIER_BATCH))
  }
  return identifiers
}

/**
 * A digest per record over everything the projector owns.
 *
 * Surrogate keys and `updated_at` are excluded on purpose: `attribute_value.id` and
 * `record_link.id` default to `gen_random_uuid()` and every rebuild mints new ones, so including
 * them would make the gate fail on every run while telling you nothing. `fact_id` *is* included —
 * it is the per-value provenance pointer, and reproducing it is exactly what has to be true.
 */
export async function projectionDigest(exec: Executor): Promise<DigestMap> {
  const rows = await sql<{ record_id: string; digest: string }>`
    select r.id::text as record_id,
           md5(
             coalesce((
               select string_agg(
                        concat_ws(':', v.attribute_id::text, v.value_key, v.position::text,
                                  v.value_kind::text,
                                  coalesce(v.text_value, ''), coalesce(v.text_norm, ''),
                                  coalesce(v.text_sort, ''), coalesce(v.num_value::text, ''),
                                  coalesce(to_char(v.date_value, 'YYYY-MM-DD'), ''),
                                  coalesce(v.bool_value::text, ''),
                                  coalesce(v.option_id::text, ''), v.fact_id::text),
                        E'\n' order by v.attribute_id, v.value_key)
                 from attribute_value v where v.record_id = r.id), '')
             || '|' ||
             coalesce((
               select string_agg(
                        concat_ws(':', l.attribute_id::text, l.to_record_id::text,
                                  coalesce(l.title, ''),
                                  coalesce(to_char(l.valid_from, 'YYYY-MM-DD'), ''),
                                  coalesce(to_char(l.valid_to, 'YYYY-MM-DD'), ''),
                                  l.is_primary::text, l.position::text, l.fact_id::text),
                        E'\n' order by l.attribute_id, l.to_record_id)
                 from record_link l where l.from_record_id = r.id), '')
             || '|' ||
             coalesce((
               select sd.title || E'\n' || sd.body
                 from search_document sd where sd.record_id = r.id), '')
             || '|' ||
             coalesce((
               select string_agg(i.kind || ':' || i.value, E'\n' order by i.kind, i.value)
                 from identifier i where i.record_id = r.id), '')
           ) as digest
      from record r
     order by r.id
  `.execute(exec)

  return Object.fromEntries(rows.rows.map((row) => [row.record_id, row.digest]))
}

/**
 * The gate itself: digest, rebuild, digest again. Run it as the last test in the integration
 * project, after that worker's mutations have accumulated, so it checks state that was built the
 * way the product builds it.
 */
export async function verifyProjection(exec: Executor): Promise<EquivalenceReport> {
  const before = await projectionDigest(exec)
  await reprojectAll(exec)
  const after = await projectionDigest(exec)

  const diverged = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((id) => before[id] !== after[id])
    .sort()

  return { ok: diverged.length === 0, before, after, diverged }
}
