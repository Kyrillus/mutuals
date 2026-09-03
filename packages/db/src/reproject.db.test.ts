/**
 * The projection-equivalence gate (ADR-025), and the repair path it justifies.
 *
 * `attribute_value`, `record_link` and `search_document` are allowed to exist only because a full
 * rebuild from `fact` reproduces them exactly. That is the entire safety argument for keeping a
 * derived copy, so it is checked as a per-record digest map rather than one `md5()` over the
 * database: when it trips, Vitest names the records that diverged instead of printing two hashes.
 *
 * The digest test is deliberately the last one in this file, and the state it runs against is
 * built the way the product builds it — through the write path, with edits, removals and re-adds —
 * because a rebuild of a database that only ever had one value written to it proves nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { civil, type Uuid } from '@mutuals/core'
import { attributeIdBySlug, optionIdByKey, testDb } from './test-support/index.ts'
import { projectionDigest, reprojectAll, reprojectRecords, verifyProjection } from './reproject.ts'
import { createContact, createInteraction, createOrganization } from './write/records.ts'
import { addElement, removeElement, setValue, setValues } from './write/facts.ts'

const MANUAL = { source: 'manual' } as const

interface Fixture {
  readonly anna: Uuid
  readonly ben: Uuid
  readonly northstar: Uuid
}

/**
 * Everything the projector owns, in one dataset: single and multi-valued attributes, an option, a
 * relation with link metadata, a superseded value, a tombstone, a re-add, and an interaction whose
 * body feeds `search_document`.
 */
async function seed(): Promise<Fixture> {
  const db = testDb()
  const city = await attributeIdBySlug('contact', 'city')
  const email = await attributeIdBySlug('contact', 'email')
  const notes = await attributeIdBySlug('contact', 'notes')
  const tags = await attributeIdBySlug('contact', 'areas_of_interest')
  const jobRole = await attributeIdBySlug('contact', 'job_role')
  const relation = await attributeIdBySlug('contact', 'organization')
  const industry = await attributeIdBySlug('organization', 'industry')

  const northstar = await createOrganization(db, { name: 'Northstar Ventures' })
  await setValues(db, {
    recordId: northstar,
    attributeId: industry,
    values: [
      { kind: 'text', text: 'Venture Capital' },
      { kind: 'text', text: 'Climate' },
    ],
    provenance: MANUAL,
  })

  const anna = await createContact(db, { firstName: 'Anna', lastName: 'Berger' })
  const ben = await createContact(db, { firstName: 'Ben', lastName: 'Adler' })

  // An edit, so the digest runs over a record with a supersession chain behind it.
  await setValue(db, {
    recordId: anna,
    attributeId: city,
    value: { kind: 'text', text: 'Berlin' },
    provenance: MANUAL,
  })
  await setValue(db, {
    recordId: anna,
    attributeId: city,
    value: { kind: 'text', text: 'Munich' },
    provenance: MANUAL,
  })
  await setValue(db, {
    recordId: anna,
    attributeId: email,
    value: { kind: 'text', text: 'old@example.com' },
    provenance: { source: 'import', sourceRef: 'batch-1' },
  })
  await setValue(db, {
    recordId: anna,
    attributeId: email,
    value: { kind: 'text', text: 'anna@example.com' },
    provenance: MANUAL,
  })
  await setValue(db, {
    recordId: anna,
    attributeId: notes,
    value: { kind: 'text', text: 'Met at the Betahaus climate breakfast.' },
    provenance: MANUAL,
  })
  await setValue(db, {
    recordId: anna,
    attributeId: jobRole,
    value: {
      kind: 'option',
      optionId: await optionIdByKey(jobRole, 'founder'),
      optionKey: 'founder',
    },
    provenance: MANUAL,
  })
  await addElement(db, {
    recordId: anna,
    attributeId: tags,
    value: { kind: 'text', text: 'Climate' },
    provenance: MANUAL,
  })
  await addElement(db, {
    recordId: anna,
    attributeId: tags,
    value: { kind: 'text', text: 'Biotech' },
    provenance: MANUAL,
  })
  // Removed and added again, so a tombstone and its successor are both in the log.
  await removeElement(db, {
    recordId: anna,
    attributeId: tags,
    value: { kind: 'text', text: 'Biotech' },
    provenance: MANUAL,
  })
  await addElement(db, {
    recordId: anna,
    attributeId: tags,
    value: { kind: 'text', text: 'Biotech' },
    provenance: MANUAL,
  })

  await addElement(db, {
    recordId: anna,
    attributeId: relation,
    value: {
      kind: 'relation',
      targetRecordId: northstar,
      link: { title: 'Partner', from: civil('2024-01-01'), to: null, isPrimary: true },
    },
    provenance: MANUAL,
  })
  await addElement(db, {
    recordId: ben,
    attributeId: relation,
    value: { kind: 'relation', targetRecordId: northstar, link: { title: 'Analyst' } },
    provenance: MANUAL,
  })

  await createInteraction(db, {
    type: 'Meeting',
    occurredAt: '2026-02-01T10:00:00Z',
    title: 'Coffee at Betahaus',
    body: 'Talked about the fund and the climate thesis.',
    contactIds: [anna, ben],
    organizationIds: [northstar],
  })

  return { anna, ben, northstar }
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await seed()
})

describe('reprojectRecords', () => {
  it('rebuilds one record and repairs a projection somebody broke by hand', async () => {
    const before = await projectionDigest(testDb())

    // The scenario the repair path exists for: a `psql` session that edited the derived table.
    await sql`delete from attribute_value where record_id = ${fixture.anna}`.execute(testDb())
    await sql`update record_link set title = 'wrong' where from_record_id = ${fixture.anna}`.execute(
      testDb(),
    )
    const damaged = await projectionDigest(testDb())
    expect(damaged[fixture.anna]).not.toBe(before[fixture.anna])

    const result = await reprojectRecords(testDb(), [fixture.anna])
    expect(result.records).toBe(1)
    expect(await projectionDigest(testDb())).toEqual(before)
  })

  it('does nothing at all for an empty list', async () => {
    const before = await projectionDigest(testDb())
    expect(await reprojectRecords(testDb(), [])).toEqual({ records: 0, identifiers: 0 })
    expect(await projectionDigest(testDb())).toEqual(before)
  })
})

describe('reprojectAll', () => {
  it('rebuilds every derived row from fact alone', async () => {
    const before = await projectionDigest(testDb())
    await sql`delete from attribute_value`.execute(testDb())
    await sql`delete from record_link`.execute(testDb())
    await sql`delete from search_document`.execute(testDb())

    const result = await reprojectAll(testDb())

    expect(result.records).toBe(4)
    expect(await projectionDigest(testDb())).toEqual(before)
  })

  it('tops identifiers up rather than truncating them (§4.6)', async () => {
    const before = await testDb()
      .selectFrom('identifier')
      .select('value')
      .where('record_id', '=', fixture.anna)
      .execute()
    // `old@example.com` was superseded; the identifier survives, because a handle we have ever
    // seen still has to find the person who used to use it.
    expect(before.map((row) => row.value)).toContain('old@example.com')

    await reprojectAll(testDb())

    const after = await testDb()
      .selectFrom('identifier')
      .select('value')
      .where('record_id', '=', fixture.anna)
      .execute()
    expect(after.map((row) => row.value).sort()).toEqual(before.map((row) => row.value).sort())
  })
})

/**
 * Last, on purpose. Everything above has already mutated this worker's database, so what is being
 * compared is accumulated state against a rebuild of it — which is the only comparison that can
 * actually catch drift.
 */
describe('the projection equivalence gate', () => {
  it('rebuilds byte-identical', async () => {
    const report = await verifyProjection(testDb())

    expect(report.diverged).toEqual([])
    expect(report.after).toEqual(report.before)
    expect(report.ok).toBe(true)
    expect(Object.keys(report.after)).toHaveLength(4)
  })
})
