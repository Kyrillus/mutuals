/**
 * Find-or-create for organizations, which the import needs and nothing else in the product does.
 *
 * §6.8's LinkedIn preset maps a `Company` column to the organization link, so a row naming
 * "Northstar Ventures" has to resolve to a record — one that probably does not exist on a first
 * import and definitely does by the second. Without this, thirty rows at one company create thirty
 * organizations.
 *
 * **Matching is exact on the normalised label, never fuzzy.** That is a deliberate asymmetry with
 * how *contacts* are matched, where §4.6 has a whole fallback rule table. Two reasons. A company
 * name is the thing being imported rather than a person being recognised, so a wrong merge silently
 * relabels every contact linked to it and there is no identifier to overrule the guess. And
 * organization names are adversarial for trigrams in a way people's names are not: "Meyer, Schulz &
 * Partner" against "Meyer Schulz", or "Kiln Robotics GmbH" against "Kiln Robotics" — the pairs a
 * fuzzy rule would join are exactly the ones a human would want kept apart until asked. §6.9 leaves
 * `mergeOrganizations` to Session B, which is where an inexact match belongs: a decision, not a
 * side effect of an import.
 */
import type { ObjectType, Uuid } from '@mutuals/core'
import { sql } from 'kysely'

import { createOrganization } from './records.ts'
import type { Executor, Provenance } from './types.ts'

export interface ResolveOrganizationsInput {
  /** Names as the file spells them. Blank and duplicate entries are handled here. */
  readonly names: readonly string[]
  readonly workspaceId?: string | null
  readonly importBatchId?: string | null
  readonly provenance?: Provenance
}

export interface ResolvedOrganizations {
  /** Keyed by `mutuals_norm(name)`, so a caller looks up by the same key it passed. */
  readonly byKey: ReadonlyMap<string, Uuid>
  /** `mutuals_norm` of each input name, in the order they were given. */
  readonly keys: readonly string[]
  readonly created: readonly Uuid[]
}

/**
 * Resolves many organization names in a fixed number of round trips.
 *
 * Batched for the same reason ADR-042 batches identifier probes: a 10k-row export naming 4k
 * companies is 4k round trips done one at a time, and it is the same work done once.
 *
 * Creation happens inside one transaction so a failure half way leaves no organizations behind for
 * an import that never ran.
 */
export async function resolveOrganizations(
  exec: Executor,
  input: ResolveOrganizationsInput,
): Promise<ResolvedOrganizations> {
  const keys = await normalizeLabels(exec, input.names)
  const wanted = [...new Set(keys.filter((key) => key !== ''))]
  if (wanted.length === 0) return { byKey: new Map(), keys, created: [] }

  const byKey = new Map<string, Uuid>(await lookup(exec, wanted))
  const missing = wanted.filter((key) => !byKey.has(key))
  if (missing.length === 0) return { byKey, keys, created: [] }

  // The display name to create under is the first spelling the file used for that key, so
  // "northstar ventures" becomes "Northstar Ventures" rather than the normalised form.
  const displayFor = new Map<string, string>()
  keys.forEach((key, index) => {
    if (key !== '' && !displayFor.has(key)) displayFor.set(key, (input.names[index] ?? '').trim())
  })

  const created: Uuid[] = []
  await inTransaction(exec, async (trx) => {
    for (const key of missing) {
      const id = await createOrganization(trx, {
        name: displayFor.get(key) ?? key,
        createdVia: 'import',
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.importBatchId === undefined ? {} : { importBatchId: input.importBatchId }),
        ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      })
      byKey.set(key, id)
      created.push(id)
    }

    /**
     * Re-read after creating, because a concurrent import could have created the same company in
     * the gap between the lookup and the insert. There is no unique constraint on an organization's
     * name and there should not be — two genuinely different funds may share one — so this cannot
     * be an `ON CONFLICT`. Losing the race means two records, which §6.9's merge exists to fix, and
     * re-reading keeps *this* batch internally consistent, which is what matters for its links.
     */
    for (const [key, id] of await lookup(trx, missing)) {
      const mine = created.includes(id)
      if (!mine) byKey.set(key, id)
    }
  })

  return { byKey, keys, created }
}

/** One organization, for a caller that has exactly one name. */
export async function resolveOrganization(
  exec: Executor,
  name: string,
  options: Omit<ResolveOrganizationsInput, 'names'> = {},
): Promise<Uuid | undefined> {
  const resolved = await resolveOrganizations(exec, { ...options, names: [name] })
  const key = resolved.keys[0]
  return key === undefined || key === '' ? undefined : resolved.byKey.get(key)
}

/**
 * `mutuals_norm()` over a list of names.
 *
 * In SQL because the result is compared against the record label's normalised column, and ADR-019
 * allows exactly one implementation of that.
 */
async function normalizeLabels(
  exec: Executor,
  names: readonly string[],
): Promise<readonly string[]> {
  if (names.length === 0) return []
  const rows = await sql<{ key: string }>`
    select mutuals_norm(q.name) as key
      from unnest(${sql.val([...names])}::text[]) with ordinality as q(name, idx)
     order by q.idx
  `.execute(exec)
  return rows.rows.map((row) => row.key)
}

async function lookup(exec: Executor, keys: readonly string[]): Promise<readonly [string, Uuid][]> {
  const rows = await exec
    .selectFrom('record')
    .select(['id', 'label_norm'])
    .where('object_type', '=', 'organization' satisfies ObjectType)
    .where('label_norm', 'in', [...keys])
    // Oldest wins, so a repeated import keeps pointing at the same record rather than drifting to
    // whichever duplicate was created most recently.
    .orderBy('created_at')
    .orderBy('id')
    .execute()

  const pairs = new Map<string, Uuid>()
  for (const row of rows) if (!pairs.has(row.label_norm)) pairs.set(row.label_norm, row.id)
  return [...pairs]
}

async function inTransaction<T>(exec: Executor, fn: (trx: Executor) => Promise<T>): Promise<T> {
  if (exec.isTransaction) return fn(exec)
  return exec.transaction().execute((trx) => fn(trx))
}
