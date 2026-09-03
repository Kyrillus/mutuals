/**
 * What `pnpm seed --assert-counts` checks, and what CI therefore checks (`verify:db`).
 *
 * The counts are the cheap half. The three properties below them are the half that matters: that
 * the identifier write-through actually ran, that every table's `workspace_id` is populated
 * (ADR-014 promises CI asserts this), and that the planted ask↔offer matches survived the write
 * path — because a seed whose asks match nothing looks identical to one whose asks match, right up
 * until somebody builds the introduction engine on it.
 */
import { sql } from 'kysely'

import type { Executor } from '../write/types.ts'

export interface SeedCounts {
  readonly contacts: number
  readonly organizations: number
  readonly interactions: number
  readonly followUps: number
  readonly facts: number
  readonly attributeValues: number
  readonly recordLinks: number
  readonly identifiers: number
  readonly searchDocuments: number
  readonly contactViews: number
  readonly organizationViews: number
  /** Distinct tags that one contact asks for and a different contact offers (§4.1, §9). */
  readonly askOfferMatches: number
  /** Contacts with a non-zero warmth, so an all-zero metrics sweep cannot pass silently. */
  readonly warmContacts: number
}

export const EXPECTED_COUNTS = {
  contacts: 200,
  organizations: 60,
  interactions: 500,
  followUps: 40,
  contactViews: 4,
  organizationViews: 1,
  /** A floor, not an equality: the decoy tags are random and could accidentally add a match. */
  minAskOfferMatches: 10,
  minWarmContacts: 60,
  minIdentifiers: 350,
} as const

export class SeedAssertionError extends Error {
  override readonly name = 'SeedAssertionError'
  readonly failures: readonly string[]

  constructor(failures: readonly string[]) {
    super(`The seeded database is not what it should be:\n  - ${failures.join('\n  - ')}`)
    this.failures = failures
  }
}

/**
 * The ask↔offer join, in SQL, on the normalised tag key.
 *
 * `attribute_value.value_key` is `left(mutuals_norm(text_value), 512)` for a `tags` element
 * (ADR-018), so joining on it is an exact match on the same identity the `contains any of` filter
 * uses — never a similarity score, which §9 forbids for introduction suggestions.
 */
async function countAskOfferMatches(exec: Executor): Promise<number> {
  const row = await sql<{ n: string }>`
    select count(distinct ask.value_key)::text as n
      from attribute_value ask
      join attribute_definition ad on ad.id = ask.attribute_id and ad.slug = 'asks'
      join attribute_value offer on offer.value_key = ask.value_key
      join attribute_definition od on od.id = offer.attribute_id and od.slug = 'offers'
     where offer.record_id <> ask.record_id
  `.execute(exec)
  return Number(row.rows[0]?.n ?? 0)
}

/** Every table that carries `workspace_id`, counted for NULLs in one pass (ADR-014). */
export async function nullWorkspaceRows(exec: Executor): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }>`
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'workspace_id'
       and t.table_type = 'BASE TABLE'
     order by c.table_name
  `.execute(exec)

  const out: Record<string, number> = {}
  for (const { table_name } of tables.rows) {
    const row = await sql<{ n: string }>`
      select count(*)::text as n from ${sql.table(table_name)} where workspace_id is null
    `.execute(exec)
    const n = Number(row.rows[0]?.n ?? 0)
    if (n > 0) out[table_name] = n
  }
  return out
}

export async function readSeedCounts(exec: Executor): Promise<SeedCounts> {
  const scalar = async (query: ReturnType<typeof sql<{ n: string }>>): Promise<number> =>
    Number((await query.execute(exec)).rows[0]?.n ?? 0)

  return {
    contacts: await scalar(sql<{ n: string }>`select count(*)::text as n from contact`),
    organizations: await scalar(sql<{ n: string }>`select count(*)::text as n from organization`),
    interactions: await scalar(sql<{ n: string }>`select count(*)::text as n from interaction`),
    followUps: await scalar(sql<{ n: string }>`select count(*)::text as n from follow_up`),
    facts: await scalar(sql<{ n: string }>`select count(*)::text as n from fact`),
    attributeValues: await scalar(
      sql<{ n: string }>`select count(*)::text as n from attribute_value`,
    ),
    recordLinks: await scalar(sql<{ n: string }>`select count(*)::text as n from record_link`),
    identifiers: await scalar(sql<{ n: string }>`select count(*)::text as n from identifier`),
    searchDocuments: await scalar(
      sql<{ n: string }>`select count(*)::text as n from search_document`,
    ),
    contactViews: await scalar(
      sql<{ n: string }>`select count(*)::text as n from saved_view where object_type = 'contact'`,
    ),
    organizationViews: await scalar(
      sql<{
        n: string
      }>`select count(*)::text as n from saved_view where object_type = 'organization'`,
    ),
    askOfferMatches: await countAskOfferMatches(exec),
    warmContacts: await scalar(
      sql<{ n: string }>`select count(*)::text as n from contact_metrics where warmth > 0`,
    ),
  }
}

/** Throws {@link SeedAssertionError} listing *every* failure, not only the first. */
export async function assertSeedCounts(exec: Executor): Promise<SeedCounts> {
  const counts = await readSeedCounts(exec)
  const failures: string[] = []

  const exact = (label: string, actual: number, expected: number): void => {
    if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual}`)
  }
  const atLeast = (label: string, actual: number, floor: number): void => {
    if (actual < floor) failures.push(`${label}: expected at least ${floor}, found ${actual}`)
  }

  exact('contacts', counts.contacts, EXPECTED_COUNTS.contacts)
  exact('organizations', counts.organizations, EXPECTED_COUNTS.organizations)
  exact('interactions', counts.interactions, EXPECTED_COUNTS.interactions)
  exact('follow-ups', counts.followUps, EXPECTED_COUNTS.followUps)
  exact('contact views', counts.contactViews, EXPECTED_COUNTS.contactViews)
  exact('organization views', counts.organizationViews, EXPECTED_COUNTS.organizationViews)
  atLeast('identifiers', counts.identifiers, EXPECTED_COUNTS.minIdentifiers)
  atLeast('ask/offer matches', counts.askOfferMatches, EXPECTED_COUNTS.minAskOfferMatches)
  atLeast('contacts with warmth > 0', counts.warmContacts, EXPECTED_COUNTS.minWarmContacts)

  // Every record has exactly one search document, or global search silently misses people.
  const total = counts.contacts + counts.organizations + counts.interactions
  exact('search documents', counts.searchDocuments, total)

  const nulls = await nullWorkspaceRows(exec)
  for (const [table, n] of Object.entries(nulls)) {
    failures.push(`${table}: ${n} row(s) with a NULL workspace_id (ADR-014)`)
  }

  if (failures.length > 0) throw new SeedAssertionError(failures)
  return counts
}
