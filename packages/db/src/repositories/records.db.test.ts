/**
 * Reading records: hydration, the value-history popover and the reverse side of a relation.
 *
 * Hydration is three round trips for a whole page and it preserves the order the caller asked for,
 * because the ids come from the filter compiler and re-sorting them here would silently undo the
 * `ORDER BY` it just compiled. Both are asserted.
 */
import { describe, expect, it } from 'vitest'
import { civil, decimal, type Uuid } from '@mutuals/core'
import {
  attributeIdBySlug,
  optionIdByKey,
  testDb,
  TEST_WORKSPACE_ID,
} from '../test-support/index.ts'
import { countRecords, getRecord, hydrateRecords, incomingLinks, valueHistory } from './records.ts'
import { createAttributeDefinition } from './attributes.ts'
import { createContact, createInteraction, createOrganization } from '../write/records.ts'
import { addElement, removeElement, setValue } from '../write/facts.ts'

const MANUAL = { source: 'manual' } as const

describe('hydrateRecords', () => {
  it('returns the records in the order the caller asked for', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    const ben = await createContact(testDb(), { firstName: 'Ben', lastName: 'Adler' })

    const rows = await hydrateRecords(testDb(), [ben, anna])
    expect(rows.map((row) => row.displayLabel)).toEqual(['Ben Adler', 'Anna Berger'])
  })

  it('skips an id that is not there rather than returning a hole', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const rows = await hydrateRecords(testDb(), [anna, '00000000-0000-4000-8000-0000000000ff'])
    expect(rows).toHaveLength(1)
  })

  it('carries the contact header and its metrics', async () => {
    const anna = await createContact(testDb(), {
      firstName: 'Anna',
      lastName: 'Berger',
      pinnedImportant: true,
    })
    await testDb()
      .updateTable('contact_metrics')
      .set({
        warmth: 74,
        interaction_count_12m: 3,
        open_followups: 1,
        next_followup_at: '2026-04-01',
        last_interaction_at: new Date('2026-02-01T10:00:00Z'),
      })
      .where('contact_id', '=', anna)
      .execute()

    const record = await getRecord(testDb(), anna)
    expect(record?.contact).toEqual({
      firstName: 'Anna',
      lastName: 'Berger',
      displayName: 'Anna Berger',
      pinnedImportant: true,
      notImportant: false,
      warmth: 74,
      interactionCount12m: 3,
      openFollowups: 1,
      nextFollowupAt: '2026-04-01',
      lastInteractionAt: '2026-02-01T10:00:00.000Z',
    })
  })

  it('carries the organization and interaction headers', async () => {
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const meeting = await createInteraction(testDb(), {
      type: 'Meeting',
      occurredAt: '2026-02-01T10:00:00Z',
      title: 'Coffee',
      body: 'Talked about the fund.',
      source: 'calendar',
    })

    expect((await getRecord(testDb(), org))?.organization).toEqual({
      name: 'Northstar Ventures',
      peopleCount: 0,
      lastInteractionAt: null,
    })
    expect((await getRecord(testDb(), meeting))?.interaction).toEqual({
      type: 'Meeting',
      occurredAt: '2026-02-01T10:00:00.000Z',
      title: 'Coffee',
      body: 'Talked about the fund.',
      source: 'calendar',
    })
  })

  it('hands a numeric back as an exact decimal string and a date as a calendar day', async () => {
    const raised = await createAttributeDefinition(testDb(), {
      objectType: 'organization',
      title: 'Raised',
      slug: 'raised',
      type: 'number',
    })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const birthday = await attributeIdBySlug('contact', 'birthday')
    const anna = await createContact(testDb(), { firstName: 'Anna' })

    await setValue(testDb(), {
      recordId: org,
      attributeId: raised.id,
      value: { kind: 'number', num: decimal('250000.50') },
      provenance: MANUAL,
    })
    await setValue(testDb(), {
      recordId: anna,
      attributeId: birthday,
      value: { kind: 'date', date: civil('1990-03-01') },
      provenance: MANUAL,
    })

    // A float would have made this 250000.5 and a `Date` would have moved the birthday a day west
    // of Greenwich; both are exactly what the client's type parsers exist to prevent.
    expect((await getRecord(testDb(), org))?.values[0]?.num).toBe('250000.50')
    expect((await getRecord(testDb(), anna))?.values[0]?.date).toBe('1990-03-01')
  })

  it('resolves an option to its key and label', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    const founder = await optionIdByKey(jobRole, 'founder')
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    await setValue(testDb(), {
      recordId: anna,
      attributeId: jobRole,
      value: { kind: 'option', optionId: founder, optionKey: 'founder' },
      provenance: MANUAL,
    })

    expect((await getRecord(testDb(), anna))?.values).toEqual([
      expect.objectContaining({
        optionKey: 'founder',
        optionLabel: 'Founder',
        valueKind: 'option',
      }),
    ])
  })

  it('carries the links with their metadata and the label of the other side', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const relation = await attributeIdBySlug('contact', 'organization')

    await addElement(testDb(), {
      recordId: anna,
      attributeId: relation,
      value: {
        kind: 'relation',
        targetRecordId: org,
        link: { title: 'Partner', from: civil('2024-01-01'), isPrimary: true },
      },
      provenance: MANUAL,
    })

    expect((await getRecord(testDb(), anna))?.links).toEqual([
      expect.objectContaining({
        toRecordId: org,
        toLabel: 'Northstar Ventures',
        toObjectType: 'organization',
        title: 'Partner',
        from: '2024-01-01',
        to: null,
        isPrimary: true,
      }),
    ])
  })

  it('returns nothing for no ids at all', async () => {
    expect(await hydrateRecords(testDb(), [])).toEqual([])
    expect(await getRecord(testDb(), '00000000-0000-4000-8000-0000000000ff')).toBeUndefined()
  })
})

describe('valueHistory', () => {
  it('reads the whole chain, tombstone included, newest first', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')

    await addElement(testDb(), {
      recordId: anna,
      attributeId: tags,
      value: { kind: 'text', text: 'Climate' },
      provenance: { source: 'import', validFrom: '2025-06-01' },
    })
    await removeElement(testDb(), {
      recordId: anna,
      attributeId: tags,
      value: { kind: 'text', text: 'Climate' },
      provenance: { source: 'manual', validFrom: '2026-01-01' },
    })

    const history = await valueHistory(testDb(), anna, tags)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ validFrom: '2026-01-01', isCurrent: false })
    expect(history[0]?.removedAt).not.toBeNull()
    expect(history[1]).toMatchObject({
      validFrom: '2025-06-01',
      source: 'import',
      isCurrent: false,
    })
    // The superseded row points at the tombstone that retired it.
    expect(history[1]?.supersededById).toBe(history[0]?.factId)
  })

  it('names the other side of a relation', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const relation = await attributeIdBySlug('contact', 'organization')

    await addElement(testDb(), {
      recordId: anna,
      attributeId: relation,
      value: { kind: 'relation', targetRecordId: org },
      provenance: MANUAL,
    })

    const history = await valueHistory(testDb(), anna, relation)
    expect(history[0]).toMatchObject({ targetRecordId: org, targetLabel: 'Northstar Ventures' })
  })
})

describe('incomingLinks', () => {
  it('is the reverse side of a relation, read off one index and not a second stored row', async () => {
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const relation = await attributeIdBySlug('contact', 'organization')
    const people: Uuid[] = []

    for (const name of ['Anna', 'Ben']) {
      const id = await createContact(testDb(), { firstName: name })
      people.push(id)
      await addElement(testDb(), {
        recordId: id,
        attributeId: relation,
        value: { kind: 'relation', targetRecordId: org },
        provenance: MANUAL,
      })
    }

    const incoming = await incomingLinks(testDb(), org)
    expect(incoming.map((link) => link.toLabel)).toEqual(['Anna', 'Ben'])
    expect(incoming.map((link) => link.toRecordId).sort()).toEqual([...people].sort())
    expect(await incomingLinks(testDb(), people[0] as Uuid)).toEqual([])
  })
})

describe('countRecords', () => {
  it('counts one object type at a time', async () => {
    await createContact(testDb(), { firstName: 'Anna' })
    await createContact(testDb(), { firstName: 'Ben' })
    await createOrganization(testDb(), { name: 'Northstar Ventures' })

    expect(await countRecords(testDb(), 'contact')).toBe(2)
    expect(await countRecords(testDb(), 'organization')).toBe(1)
    expect(await countRecords(testDb(), 'interaction')).toBe(0)
  })
})

describe('the workspace', () => {
  it('is stamped on every record and every derived row', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    await setValue(testDb(), {
      recordId: anna,
      attributeId: city,
      value: { kind: 'text', text: 'Berlin' },
      provenance: MANUAL,
    })

    const value = await testDb()
      .selectFrom('attribute_value')
      .select('workspace_id')
      .where('record_id', '=', anna)
      .executeTakeFirstOrThrow()
    expect(value.workspace_id).toBe(TEST_WORKSPACE_ID)
  })
})
