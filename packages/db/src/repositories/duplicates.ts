/**
 * The database half of §4.6's duplicate detection — the candidate pool `matchDuplicates` scores.
 *
 * `packages/core` owns the *judgement*: per-kind identifier confidences, noisy-or across distinct
 * kinds, ADR-042's single-strong-identifier gate, and the ordered rule table for the name fallback.
 * It owns none of the searching, because it cannot: finding the candidates is two index probes and
 * a trigram scan. So this file answers exactly one question — "who could this be?" — and never
 * decides.
 *
 * **Batched, deliberately.** ADR-042 names the thing not to do: "the importer batches identifier
 * probes — one probe per identifier per row is 20k+ round trips on a 10k LinkedIn export". Every
 * function here takes an array of probes and returns an array of pools, in the same order.
 *
 * The name query runs only for probes that found no identifier, because §4.6 makes names strictly
 * the fallback — "name + organization similarity is the fallback, never the first check". Skipping
 * it is not an optimisation, it is the rule.
 */
import {
  NAME_CANDIDATE_THRESHOLD,
  emailMatchKey,
  type CandidatePool,
  type DuplicateObjectType,
  type IdentifierHit,
  type IdentifierRef,
  type NameCandidate,
} from '@mutuals/core'
import { sql } from 'kysely'

import type { Executor } from '../write/types.ts'

export interface CandidateProbe {
  readonly objectType: DuplicateObjectType
  /** Raw. Normalised by `mutuals_norm()` in SQL, never in TypeScript (ADR-019). */
  readonly displayName: string
  readonly identifiers: readonly IdentifierRef[]
  readonly emailMatchKeys: readonly string[]
  /** Current organisation links only; a former employer is not evidence of identity. */
  readonly organizationIds: readonly string[]
}

export interface ProbeResult {
  /** `mutuals_norm(displayName)`, as computed by the database. */
  readonly nameKey: string
  readonly pool: CandidatePool
}

export interface ProbeOptions {
  /** Records to leave out — the row's own record when re-probing after a commit. */
  readonly excludeRecordIds?: readonly string[]
}

/**
 * How many trigram candidates one probe may pull back before the pool is truncated.
 *
 * `matchDuplicates` keeps five matches (`MAX_MATCHES`), but it has to *score* them all to know
 * which five, and a common surname in a large workspace can match hundreds. Bounded per probe with
 * the strongest similarities first, so the cap costs the tail rather than the answer.
 */
const NAME_CANDIDATE_LIMIT = 20

export async function probeDuplicates(
  exec: Executor,
  probes: readonly CandidateProbe[],
  options: ProbeOptions = {},
): Promise<readonly ProbeResult[]> {
  if (probes.length === 0) return []

  const excluded = [...new Set(options.excludeRecordIds ?? [])]
  const nameKeys = await normalizeNames(
    exec,
    probes.map((probe) => probe.displayName),
  )
  const identifierHits = await probeIdentifiers(exec, probes, excluded)

  // §4.6: names are consulted only where no identifier landed.
  const needsNames = probes
    .map((probe, index) => ({ probe, index }))
    .filter((entry) => (identifierHits[entry.index] ?? []).length === 0)

  const nameCandidates = await probeNames(exec, needsNames, nameKeys, excluded)

  return probes.map((probe, index) => ({
    nameKey: nameKeys[index] ?? '',
    pool: {
      identifierHits: identifierHits[index] ?? [],
      nameCandidates: nameCandidates.get(index) ?? [],
    } satisfies CandidatePool,
  }))
}

/**
 * `mutuals_norm()` over a list, in one round trip.
 *
 * TypeScript must never produce a value that is compared against a normalised column (ADR-019),
 * and `nameKey` is compared against the record label's normalised column — so the normalisation
 * happens here even though the input never touches a table.
 */
async function normalizeNames(
  exec: Executor,
  names: readonly string[],
): Promise<readonly string[]> {
  if (names.length === 0) return []
  const rows = await sql<{ idx: number; key: string }>`
    select q.idx::int as idx, mutuals_norm(q.name) as key
      from unnest(${sql.val(names)}::text[]) with ordinality as q(name, idx)
     order by q.idx
  `.execute(exec)
  return rows.rows.map((row) => row.key)
}

/**
 * Every identifier of every probe, as **two array parameters** joined against the table.
 *
 * The obvious spelling — one `(kind = … AND value = …)` disjunct per identifier — is what this
 * used to be, and it does not survive the file size §6.8 promises. A 10,000-row LinkedIn export
 * carries ~16,000 identifiers, and:
 *
 *   - Kysely compiles an `OR` tree by recursing once per node, so 16,000 of them raise
 *     `RangeError: Maximum call stack size exceeded` and the upload 500s before Postgres is asked
 *     anything at all;
 *   - the sizes that *do* compile are superlinear — measured at 10,760 records, 200 disjuncts cost
 *     117 ms, 800 cost 686 ms and 1,600 cost 5.7 s — because the plan is one scan of `identifier`
 *     with an N-term filter re-evaluated per row;
 *   - and it is not cancellable. `pg_cancel_backend` and `pg_terminate_backend` both returned true
 *     against a wedged probe and the backend stayed for eleven minutes; only `kill -9` cleared it.
 *
 * A join against `unnest` is two parameters whatever the file size, and the planner probes
 * `identifier_kind_value_idx` once per pair (migration 0012). 16,000 pairs: **110 ms**.
 */
async function probeIdentifiers(
  exec: Executor,
  probes: readonly CandidateProbe[],
  excluded: readonly string[],
): Promise<readonly (readonly IdentifierHit[])[]> {
  const wanted = new Map<string, IdentifierRef>()
  for (const probe of probes) {
    for (const ref of probe.identifiers) wanted.set(`${ref.kind} ${ref.value}`, ref)
  }
  if (wanted.size === 0) return probes.map(() => [])

  const refs = [...wanted.values()]
  const objectTypes = [...new Set(probes.map((probe) => probe.objectType))]

  const result = await sql<{ record_id: string; kind: IdentifierRef['kind']; value: string }>`
    select i.record_id, i.kind, i.value
      from unnest(${sql.val(refs.map((ref) => ref.kind))}::text[],
                  ${sql.val(refs.map((ref) => ref.value))}::text[]) as q(kind, value)
      join identifier i on i.kind = q.kind and i.value = q.value
      join record r on r.id = i.record_id
     where r.object_type = any(${sql.val(objectTypes)}::object_type[])
       and (${sql.val(excluded.length)}::int = 0
            or i.record_id <> all(${sql.val(excluded)}::uuid[]))
  `.execute(exec)

  const rows = result.rows
  const byRef = new Map<string, IdentifierHit[]>()
  for (const row of rows) {
    const key = `${row.kind} ${row.value}`
    const list = byRef.get(key) ?? []
    list.push({ recordId: row.record_id, kind: row.kind, value: row.value })
    byRef.set(key, list)
  }

  return probes.map((probe) =>
    probe.identifiers.flatMap((ref) => byRef.get(`${ref.kind} ${ref.value}`) ?? []),
  )
}

interface NameRow {
  idx: number
  record_id: string
  display_label: string
  label_norm: string
  sim: number
}

/**
 * Trigram name candidates for many probes in one statement.
 *
 * The `%` operator is what uses the trigram index on the record label; the explicit
 * `similarity() >=` is what enforces `NAME_CANDIDATE_THRESHOLD`, which is higher than pg_trgm's
 * session default of 0.3. Both are needed: the operator prunes with the index, the comparison is
 * exact. Setting the GUC instead would make the result depend on session state, which is the kind
 * of thing that passes in a test and differs in production.
 *
 * The threshold here is the *generation* one and is lower than any scoring rule's, deliberately.
 * `name_initial_org_same` matches on `isInitialForm` rather than on similarity, and "J. Weber"
 * scores 0.5385 against "Jonas Weber" — so gating generation at the scoring threshold made that
 * rule dead code no test could catch, because core's tests hand it a pool directly.
 *
 * `%` is left unqualified. Schema-qualifying it as `operator(pg_catalog.%)` is wrong — pg_trgm
 * installs into `public`, not the catalog — and qualifying it as `operator(public.%)` would hard-code
 * where somebody chose to install an extension. The bare operator resolves through `search_path`,
 * which is how every other pg_trgm call in this package already works.
 */
async function probeNames(
  exec: Executor,
  entries: readonly { probe: CandidateProbe; index: number }[],
  nameKeys: readonly string[],
  excluded: readonly string[],
): Promise<Map<number, NameCandidate[]>> {
  const result = new Map<number, NameCandidate[]>()
  const usable = entries.filter((entry) => (nameKeys[entry.index] ?? '') !== '')
  if (usable.length === 0) return result

  const indexes = usable.map((entry) => entry.index)
  const names = usable.map((entry) => nameKeys[entry.index] as string)
  const types = usable.map((entry) => entry.probe.objectType)

  const rows = await sql<NameRow>`
    select q.idx::int as idx, cand.id as record_id, cand.display_label, cand.label_norm,
           similarity(cand.label_norm, q.name) as sim
      from unnest(${sql.val(indexes)}::int[], ${sql.val(names)}::text[], ${sql.val(types)}::text[])
             as q(idx, name, object_type)
      join lateral (
             select r2.id, r2.display_label, r2.label_norm
               from record r2
              where r2.object_type = q.object_type::object_type
                and r2.label_norm % q.name
                and similarity(r2.label_norm, q.name) >= ${NAME_CANDIDATE_THRESHOLD}
                and (${sql.val(excluded.length)}::int = 0
                     or r2.id <> all(${sql.val(excluded)}::uuid[]))
              order by similarity(r2.label_norm, q.name) desc, r2.id
              limit ${NAME_CANDIDATE_LIMIT}
           ) as cand on true
  `.execute(exec)

  if (rows.rows.length === 0) return result

  const candidateIds = [...new Set(rows.rows.map((row) => row.record_id))]
  const [links, emails] = await Promise.all([
    currentOrganizationIds(exec, candidateIds),
    emailKeysOf(exec, candidateIds),
  ])

  for (const row of rows.rows) {
    const list = result.get(row.idx) ?? []
    list.push({
      recordId: row.record_id,
      nameKey: row.label_norm,
      displayName: row.display_label,
      nameSimilarity: row.sim,
      organizationIds: links.get(row.record_id) ?? [],
      emailMatchKeys: emails.get(row.record_id) ?? [],
      // `cityKey` is deliberately never supplied. Filling it would mean asking for "the city
      // attribute" by slug, and a seeded attribute the user may rename or delete is exactly what
      // the one rule forbids naming. ADR-042's `name_exact_city_same` therefore does not fire from
      // this path; closing that needs a declared semantic marker on attribute definitions, which
      // does not exist and is not a Stage 5 decision.
    })
    result.set(row.idx, list)
  }
  return result
}

async function currentOrganizationIds(
  exec: Executor,
  recordIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (recordIds.length === 0) return new Map()
  const rows = await exec
    .selectFrom('record_link')
    .select(['from_record_id', 'to_record_id'])
    .where('from_record_id', 'in', [...recordIds])
    // NULL is current, per the column's own comment. A link that has ended is not evidence.
    .where('valid_to', 'is', null)
    .execute()

  const byRecord = new Map<string, string[]>()
  for (const row of rows) {
    const list = byRecord.get(row.from_record_id) ?? []
    list.push(row.to_record_id)
    byRecord.set(row.from_record_id, list)
  }
  return byRecord
}

/**
 * The candidates' email addresses, folded through `emailMatchKey`.
 *
 * Folded here rather than stored: ADR-042 is explicit that the fold is "a duplicate signal only,
 * never a stored identifier", because writing it into the unique identifier value would
 * permanently prevent someone keeping two deliberately distinct addresses.
 */
async function emailKeysOf(
  exec: Executor,
  recordIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (recordIds.length === 0) return new Map()
  const rows = await exec
    .selectFrom('identifier')
    .select(['record_id', 'value'])
    .where('record_id', 'in', [...recordIds])
    .where('kind', '=', 'email')
    .execute()

  const byRecord = new Map<string, string[]>()
  for (const row of rows) {
    const list = byRecord.get(row.record_id) ?? []
    const key = emailMatchKey(row.value)
    if (!list.includes(key)) list.push(key)
    byRecord.set(row.record_id, list)
  }
  return byRecord
}
