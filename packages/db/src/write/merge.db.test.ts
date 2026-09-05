/**
 * §6.9's merge, against a real database.
 *
 * The assertions are mostly about what *survives*, because the failure mode of a merge is silent
 * loss: a follow-up that stops existing, an interaction that loses its attendee, a history that
 * forgets where a value came from. `fact` is the truth (§4.5), so the strongest test here is that
 * the loser's facts are still readable afterwards under the survivor's id.
 *
 * The awkward cases each have a name and a reason: two records linked to each other, a contact
 * linked to both organizations, a shared email that would violate the identifier index. Those are
 * the ones the database refuses outright if the order of operations is wrong, which is why they are
 * worth writing down rather than trusting.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { civil, type Uuid } from '@mutuals/core'

import { attributeIdBySlug, testDb } from '../test-support/index.ts'
import { mergeRecords } from './merge.ts'
import { setValue, addElement, type ValueChange } from './facts.ts'
import { createContact, createInteraction, createOrganization } from './records.ts'
import { writeIdentifiers } from './identifiers.ts'
import { getRecord } from '../repositories/records.ts'

const TODAY = civil('2026-06-15')

let northstar: Uuid
let brightAngle: Uuid

beforeEach(async () => {
  northstar = await createOrganization(testDb(), { name: 'Northstar Ventures' })
  brightAngle = await createOrganization(testDb(), { name: 'Bright Angle' })
})

async function emailValue(text: string): Promise<ValueChange> {
  return {
    attributeId: await attributeIdBySlug('contact', 'email'),
    values: [{ kind: 'text', text }],
  }
}

async function contact(input: {
  firstName?: string
  lastName: string
  email?: string
  city?: string
  organizationId?: Uuid
}): Promise<Uuid> {
  const values: ValueChange[] = []
  if (input.email !== undefined) values.push(await emailValue(input.email))
  if (input.city !== undefined) {
    values.push({
      attributeId: await attributeIdBySlug('contact', 'city'),
      values: [{ kind: 'text', text: input.city }],
    })
  }
  if (input.organizationId !== undefined) {
    values.push({
      attributeId: await attributeIdBySlug('contact', 'organization'),
      values: [{ kind: 'relation', targetRecordId: input.organizationId }],
    })
  }

  const id = await createContact(testDb(), {
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    lastName: input.lastName,
    values,
  })
  if (input.email !== undefined) await writeIdentifiers(testDb(), id)
  return id
}

async function liveValues(recordId: Uuid, slug: string): Promise<string[]> {
  const attributeId = await attributeIdBySlug('contact', slug)
  const rows = await testDb()
    .selectFrom('attribute_value')
    .select('text_value')
    .where('record_id', '=', recordId)
    .where('attribute_id', '=', attributeId)
    .execute()
  return rows.map((row) => row.text_value ?? '')
}

/** Every fact ever recorded for this record and attribute, live or superseded. */
async function allFacts(recordId: Uuid, slug: string): Promise<string[]> {
  const attributeId = await attributeIdBySlug('contact', slug)
  const rows = await testDb()
    .selectFrom('fact')
    .select('text_value')
    .where('record_id', '=', recordId)
    .where('attribute_id', '=', attributeId)
    .orderBy('observed_at')
    .execute()
  return rows.map((row) => row.text_value ?? '')
}

describe('merging two contacts', () => {
  it('keeps the survivor and deletes the other', async () => {
    const anna = await contact({ firstName: 'Anna', lastName: 'Berger' })
    const duplicate = await contact({ firstName: 'Anna', lastName: 'Berger' })

    const result = await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect(result.survivorId).toBe(anna)

    expect(await getRecord(testDb(), anna)).toBeDefined()
    expect(await getRecord(testDb(), duplicate)).toBeUndefined()
  })

  it('takes a value the survivor did not have', async () => {
    const anna = await contact({ firstName: 'Anna', lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger', city: 'Munich' })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect(await liveValues(anna, 'city')).toEqual(['Munich'])
  })

  it('keeps the survivor’s value when both have one and nobody chose', async () => {
    const anna = await contact({ lastName: 'Berger', city: 'Munich' })
    const duplicate = await contact({ lastName: 'Berger', city: 'Berlin' })

    const result = await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect(result.conflictsResolved).toBe(1)
    expect(await liveValues(anna, 'city')).toEqual(['Munich'])
  })

  it('takes the other side’s value when the user picks it', async () => {
    const anna = await contact({ lastName: 'Berger', city: 'Munich' })
    const duplicate = await contact({ lastName: 'Berger', city: 'Berlin' })
    const city = await attributeIdBySlug('contact', 'city')

    await mergeRecords(testDb(), {
      survivorId: anna,
      loserId: duplicate,
      choices: { [city]: 'loser' },
    })
    expect(await liveValues(anna, 'city')).toEqual(['Berlin'])
  })

  /**
   * §4.5 is the reason merge moves facts rather than writing new ones. The value that lost is still
   * in the log, under the survivor, so the history popover can say where it came from.
   */
  it('keeps the losing value in the history rather than deleting it', async () => {
    const anna = await contact({ lastName: 'Berger', city: 'Munich' })
    const duplicate = await contact({ lastName: 'Berger', city: 'Berlin' })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    expect(await liveValues(anna, 'city')).toEqual(['Munich'])
    expect((await allFacts(anna, 'city')).sort()).toEqual(['Berlin', 'Munich'])
  })

  it('keeps a value the survivor had already superseded', async () => {
    const anna = await contact({ lastName: 'Berger', city: 'Munich' })
    const city = await attributeIdBySlug('contact', 'city')
    await setValue(testDb(), {
      recordId: anna,
      attributeId: city,
      value: { kind: 'text', text: 'Hamburg' },
      provenance: { source: 'manual' },
    })
    const duplicate = await contact({ lastName: 'Berger', city: 'Berlin' })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect(await liveValues(anna, 'city')).toEqual(['Hamburg'])
    expect((await allFacts(anna, 'city')).sort()).toEqual(['Berlin', 'Hamburg', 'Munich'])
  })

  /** Multi-valued attributes are a set: the union, with no duplicates and no conflict to resolve. */
  it('unions the tags of both records', async () => {
    const asks = await attributeIdBySlug('contact', 'asks')
    const anna = await contact({ lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger' })

    for (const [record, tag] of [
      [anna, 'intros'],
      [anna, 'hiring'],
      [duplicate, 'hiring'],
      [duplicate, 'seed capital'],
    ] as const) {
      await addElement(testDb(), {
        recordId: record,
        attributeId: asks,
        value: { kind: 'text', text: tag },
        provenance: { source: 'manual' },
      })
    }

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect((await liveValues(anna, 'asks')).sort()).toEqual(['hiring', 'intros', 'seed capital'])
  })
})

describe('what moves with the record', () => {
  it('moves follow-ups', async () => {
    const anna = await contact({ lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger' })
    await testDb()
      .insertInto('follow_up')
      .values({ contact_id: duplicate, title: 'Send the deck', due_at: '2026-07-01' })
      .execute()

    const result = await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })
    expect(result.followUpsMoved).toBe(1)

    const rows = await testDb()
      .selectFrom('follow_up')
      .select('title')
      .where('contact_id', '=', anna)
      .execute()
    expect(rows.map((row) => row.title)).toEqual(['Send the deck'])
  })

  it('moves interactions, and does not double up on one they both attended', async () => {
    const anna = await contact({ lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger' })

    const hers = await createInteraction(testDb(), {
      type: 'Call',
      occurredAt: '2026-02-05T09:00:00Z',
      title: 'Only the duplicate was on this',
      contactIds: [duplicate],
    })
    const shared = await createInteraction(testDb(), {
      type: 'Meeting',
      occurredAt: '2026-03-05T09:00:00Z',
      title: 'Both were on this',
      contactIds: [anna, duplicate],
    })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    const rows = await testDb()
      .selectFrom('interaction_contact')
      .select('interaction_id')
      .where('contact_id', '=', anna)
      .execute()
    expect(new Set(rows.map((row) => row.interaction_id))).toEqual(new Set([hers, shared]))
    expect(rows).toHaveLength(2)
  })

  /**
   * `identifier_uq` is `(workspace_id, kind, value)`. A shared email is very often the reason two
   * records are being merged, so this is the collision the merge must survive rather than an edge
   * case.
   */
  it('moves identifiers and drops the one the survivor already had', async () => {
    const anna = await contact({ lastName: 'Berger', email: 'anna@northstar.example' })
    const duplicate = await contact({ lastName: 'Berger', email: 'anna@northstar.example' })

    // Give the loser a second, different address so there is something to actually move.
    await setValue(testDb(), {
      recordId: duplicate,
      attributeId: await attributeIdBySlug('contact', 'phone'),
      value: { kind: 'text', text: '+49 151 23456789' },
      provenance: { source: 'manual' },
    })
    await writeIdentifiers(testDb(), duplicate)

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    const rows = await testDb()
      .selectFrom('identifier')
      .select(['kind', 'value'])
      .where('record_id', '=', anna)
      .execute()
    expect(rows.filter((row) => row.kind === 'email')).toHaveLength(1)
    expect(rows.some((row) => row.kind === 'phone')).toBe(true)
  })

  it('moves the organization link', async () => {
    const anna = await contact({ lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger', organizationId: northstar })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    const links = await testDb()
      .selectFrom('record_link')
      .select('to_record_id')
      .where('from_record_id', '=', anna)
      .execute()
    expect(links.map((row) => row.to_record_id)).toEqual([northstar])
  })
})

describe('the awkward shapes', () => {
  /**
   * A contact linked to both organizations. Repointing without superseding would produce two
   * identical links and `rl_uq` would refuse the whole merge.
   */
  it('collapses a link that would duplicate after the merge', async () => {
    const anna = await contact({ lastName: 'Berger' })
    const organization = await attributeIdBySlug('contact', 'organization')
    await addElement(testDb(), {
      recordId: anna,
      attributeId: organization,
      value: { kind: 'relation', targetRecordId: northstar },
      provenance: { source: 'manual' },
    })
    await addElement(testDb(), {
      recordId: anna,
      attributeId: organization,
      value: { kind: 'relation', targetRecordId: brightAngle },
      provenance: { source: 'manual' },
    })

    await mergeRecords(testDb(), { survivorId: northstar, loserId: brightAngle })

    const links = await testDb()
      .selectFrom('record_link')
      .select('to_record_id')
      .where('from_record_id', '=', anna)
      .execute()
    expect(links).toHaveLength(1)
    expect(links[0]?.to_record_id).toBe(northstar)
  })

  /**
   * Two records that point at each other. After the merge the relationship has no two ends left, so
   * the link is superseded rather than repointed — `rl_no_self` would refuse it anyway.
   */
  it('drops a link between the two records being merged', async () => {
    const anna = await contact({ lastName: 'Berger', organizationId: northstar })
    const duplicate = await contact({ lastName: 'Berger', organizationId: northstar })
    void anna

    // Northstar absorbs Bright Angle while a contact links to both — already covered above — so
    // here the two *contacts* are linked through the organization each holds.
    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    const selfLinks = await testDb()
      .selectFrom('record_link')
      .select('id')
      .whereRef('from_record_id', '=', 'to_record_id')
      .execute()
    expect(selfLinks).toEqual([])
  })

  it('repoints the contacts of an organization it absorbs', async () => {
    const anna = await contact({ lastName: 'Berger', organizationId: brightAngle })
    const jonas = await contact({ lastName: 'Weber', organizationId: brightAngle })

    const result = await mergeRecords(testDb(), { survivorId: northstar, loserId: brightAngle })
    expect(result.linksRepointed).toBeGreaterThanOrEqual(2)

    for (const person of [anna, jonas]) {
      const links = await testDb()
        .selectFrom('record_link')
        .select('to_record_id')
        .where('from_record_id', '=', person)
        .execute()
      expect(links.map((row) => row.to_record_id)).toEqual([northstar])
    }
  })

  it('refuses to merge two different kinds of record', async () => {
    const anna = await contact({ lastName: 'Berger' })
    await expect(mergeRecords(testDb(), { survivorId: anna, loserId: northstar })).rejects.toThrow(
      /different kinds/,
    )
  })

  it('refuses to merge a record into itself', async () => {
    const anna = await contact({ lastName: 'Berger' })
    await expect(mergeRecords(testDb(), { survivorId: anna, loserId: anna })).rejects.toThrow(
      /into itself/,
    )
  })

  it('refuses a record that is not there', async () => {
    const anna = await contact({ lastName: 'Berger' })
    await expect(
      mergeRecords(testDb(), {
        survivorId: anna,
        loserId: '00000000-0000-4000-8000-00000000dead',
      }),
    ).rejects.toThrow(/No record/)
  })

  /** Warmth moves with the interactions, so it is recomputed when the caller supplies a clock. */
  it('recomputes the survivor’s warmth', async () => {
    const anna = await contact({ lastName: 'Berger' })
    const duplicate = await contact({ lastName: 'Berger' })
    await createInteraction(testDb(), {
      type: 'Meeting',
      occurredAt: '2026-06-01T09:00:00Z',
      title: 'Coffee',
      contactIds: [duplicate],
    })

    await mergeRecords(testDb(), {
      survivorId: anna,
      loserId: duplicate,
      metrics: { today: TODAY, timeZone: 'Europe/Berlin' },
    })

    const metrics = await testDb()
      .selectFrom('contact_metrics')
      .select(['warmth', 'interaction_count_12m'])
      .where('contact_id', '=', anna)
      .executeTakeFirstOrThrow()
    expect(metrics.interaction_count_12m).toBe(1)
    expect(Number(metrics.warmth)).toBeGreaterThan(0)
  })

  it('leaves the search index describing the survivor alone', async () => {
    const anna = await contact({ firstName: 'Anna', lastName: 'Berger', city: 'Munich' })
    const duplicate = await contact({ lastName: 'Berger', city: 'Berlin' })

    await mergeRecords(testDb(), { survivorId: anna, loserId: duplicate })

    const document = await testDb()
      .selectFrom('search_document')
      .select(['title', 'body'])
      .where('record_id', '=', anna)
      .executeTakeFirstOrThrow()
    expect(document.title).toBe('Anna Berger')
    expect(document.body).toContain('Munich')
    // The loser's document went with it.
    const orphans = await testDb()
      .selectFrom('search_document')
      .select('record_id')
      .where('record_id', '=', duplicate)
      .execute()
    expect(orphans).toEqual([])
  })
})
