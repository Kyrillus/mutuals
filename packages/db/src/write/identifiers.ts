/**
 * Identifier write-through (§4.6): every email, phone, LinkedIn and website value a record carries
 * is mirrored into `identifier` in its canonical form, so duplicate detection is a unique-index
 * probe rather than a similarity search.
 *
 * `project_record` already writes an identifier row per such value, but it writes `text_norm` —
 * the *whole* normalised string. That is right for an email and for an E.164 phone and wrong for
 * the other two: ADR-042 defines LinkedIn identity as `in/<slug>` and website identity as the host
 * with no public-suffix list, and `packages/core`'s normalisers are the one implementation of
 * both. So this runs beside the projector and adds the canonical rows; the table accumulates every
 * handle ever seen either way, and `ON CONFLICT DO NOTHING` makes the overlap free.
 */
import {
  normalizeEmail,
  normalizeLinkedIn,
  normalizeWebsite,
  type IdentifierKind,
  type Uuid,
} from '@mutuals/core'
import { normalizePhone } from '@mutuals/core/phone'
import type { Executor, FactSource } from './types.ts'

interface IdentifierSource {
  workspace_id: string | null
  record_id: string
  type: string
  slug: string
  text_value: string | null
  source: FactSource
}

interface IdentifierRow {
  workspace_id: string | null
  record_id: string
  kind: IdentifierKind
  value: string
  source: FactSource
}

/** Mirrors the projector's `CASE`: the attribute's type decides first, its slug only breaks ties. */
function kindOf(row: IdentifierSource): IdentifierKind | undefined {
  if (row.type === 'email') return 'email'
  if (row.type === 'phone') return 'phone'
  if (row.slug === 'linkedin_url') return 'linkedin_url'
  if (row.slug === 'website') return 'website'
  return undefined
}

function canonical(
  kind: IdentifierKind,
  raw: string,
  phoneRegion: string | undefined,
): string | undefined {
  switch (kind) {
    case 'email': {
      const result = normalizeEmail(raw)
      return result.ok ? result.value.identifier : undefined
    }
    case 'phone': {
      const result = normalizePhone(
        raw,
        phoneRegion === undefined ? {} : { defaultRegion: phoneRegion },
      )
      return result.ok ? result.value.e164 : undefined
    }
    case 'linkedin_url': {
      const result = normalizeLinkedIn(raw)
      return result.ok ? result.value.identifier : undefined
    }
    case 'website': {
      const result = normalizeWebsite(raw)
      return result.ok ? result.value.identifier : undefined
    }
    default:
      // The other five kinds (google_contact_id, telegram, whatsapp, other) have no attribute
      // behind them yet; they are written by their own integrations, not from an attribute value.
      return undefined
  }
}

/**
 * Recomputes the canonical identifiers of one record from its current values and inserts the ones
 * that are missing. Never deletes: §4.6 keeps every handle ever seen, so an address that has been
 * superseded still finds the person who used to use it.
 */
export async function writeIdentifiers(exec: Executor, recordId: Uuid): Promise<number> {
  return writeIdentifiersForRecords(exec, [recordId])
}

/**
 * The same, for many records at once. The importer needs it: one probe per record on a 10k-row
 * LinkedIn export is 10k round trips, which ADR-042 names as the thing not to do.
 */
export async function writeIdentifiersForRecords(
  exec: Executor,
  recordIds: readonly Uuid[],
): Promise<number> {
  if (recordIds.length === 0) return 0

  const sources = await exec
    .selectFrom('attribute_value as v')
    .innerJoin('attribute_definition as d', 'd.id', 'v.attribute_id')
    .innerJoin('fact as f', 'f.id', 'v.fact_id')
    .select(['v.workspace_id', 'v.record_id', 'd.type', 'd.slug', 'v.text_value', 'f.source'])
    .where('v.record_id', 'in', [...new Set(recordIds)])
    .where((eb) =>
      eb.or([
        eb('d.type', 'in', ['email', 'phone']),
        eb('d.slug', 'in', ['linkedin_url', 'website']),
      ]),
    )
    .execute()

  if (sources.length === 0) return 0

  const needsRegion = sources.some((row) => kindOf(row) === 'phone')
  const phoneRegion = needsRegion ? await defaultPhoneRegion(exec) : undefined

  const rows: IdentifierRow[] = []
  for (const source of sources) {
    const kind = kindOf(source)
    if (kind === undefined || source.text_value === null) continue
    const value = canonical(kind, source.text_value, phoneRegion)
    // A value that will not normalise is still a perfectly good attribute value; it just is not an
    // identity, so it writes no row rather than failing the whole edit.
    if (value === undefined) continue
    rows.push({
      workspace_id: source.workspace_id,
      record_id: source.record_id,
      kind,
      value,
      source: source.source,
    })
  }

  if (rows.length === 0) return 0

  const inserted = await exec
    .insertInto('identifier')
    .values(rows)
    .onConflict((conflict) => conflict.doNothing())
    .executeTakeFirst()

  return Number(inserted?.numInsertedOrUpdatedRows ?? 0n)
}

/** ADR-045: `'089 1234567'` cannot be normalised at all without a region, so it comes from the profile. */
async function defaultPhoneRegion(exec: Executor): Promise<string | undefined> {
  const profile = await exec
    .selectFrom('profile')
    .select('phone_region')
    .limit(1)
    .executeTakeFirst()
  return profile?.phone_region
}
