/**
 * The interaction timeline.
 *
 * The ordering is the contract: `(occurred_at DESC, id DESC)` is `interaction_occurred_idx`, and
 * the keyset cursor is strictly older than the instant it is given, so paging cannot repeat a row.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Uuid } from '@mutuals/core'
import { testDb } from '../test-support/index.ts'
import {
  getInteraction,
  interactionParticipants,
  listInteractions,
  listInteractionsByIds,
} from './interactions.ts'
import { createContact, createInteraction, createOrganization } from '../write/records.ts'

let anna: Uuid
let ben: Uuid
let northstar: Uuid

/** Three interactions, oldest first, so an assertion on order reads the same way as the timeline. */
let coffee: Uuid
let call: Uuid
let intro: Uuid

beforeEach(async () => {
  anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
  ben = await createContact(testDb(), { firstName: 'Ben', lastName: 'Adler' })
  northstar = await createOrganization(testDb(), { name: 'Northstar Ventures' })

  coffee = await createInteraction(testDb(), {
    type: 'Meeting',
    occurredAt: '2026-01-05T09:00:00Z',
    title: 'Coffee at Betahaus',
    contactIds: [anna],
    organizationIds: [northstar],
  })
  call = await createInteraction(testDb(), {
    type: 'Call',
    occurredAt: '2026-02-05T09:00:00Z',
    title: 'Catch-up call',
    contactIds: [anna, ben],
  })
  intro = await createInteraction(testDb(), {
    type: 'Intro',
    occurredAt: '2026-03-05T09:00:00Z',
    title: 'Intro to the fund',
    contactIds: [ben],
    source: 'gmail',
  })
})

describe('listInteractions', () => {
  it('reads newest first', async () => {
    const rows = await listInteractions(testDb())
    expect(rows.map((row) => row.id)).toEqual([intro, call, coffee])
    expect(rows[0]).toMatchObject({
      type: 'Intro',
      title: 'Intro to the fund',
      source: 'gmail',
      occurredAt: '2026-03-05T09:00:00.000Z',
    })
  })

  it('carries the participants of each row', async () => {
    const rows = await listInteractions(testDb())
    const catchUp = rows.find((row) => row.id === call)
    expect([...(catchUp?.contactIds ?? [])].sort()).toEqual([anna, ben].sort())
    expect(rows.find((row) => row.id === coffee)?.organizationIds).toEqual([northstar])
  })

  it('filters to one contact', async () => {
    const rows = await listInteractions(testDb(), { contactId: anna })
    expect(rows.map((row) => row.id)).toEqual([call, coffee])
  })

  it('filters to one organization', async () => {
    const rows = await listInteractions(testDb(), { organizationId: northstar })
    expect(rows.map((row) => row.id)).toEqual([coffee])
  })

  it('filters to a set of types', async () => {
    const rows = await listInteractions(testDb(), { types: ['Call', 'Intro'] })
    expect(rows.map((row) => row.id)).toEqual([intro, call])
  })

  it('pages with a cursor that is strictly older', async () => {
    const first = await listInteractions(testDb(), { limit: 2 })
    expect(first.map((row) => row.id)).toEqual([intro, call])

    const next = await listInteractions(testDb(), {
      limit: 2,
      before: new Date(first[first.length - 1]?.occurredAt ?? ''),
    })
    expect(next.map((row) => row.id)).toEqual([coffee])
  })

  it('returns an empty list rather than throwing when there is nothing', async () => {
    const rows = await listInteractions(testDb(), { types: ['Event'] })
    expect(rows).toEqual([])
  })
})

describe('getInteraction', () => {
  it('reads one, with its participants', async () => {
    const row = await getInteraction(testDb(), coffee)
    expect(row).toMatchObject({ title: 'Coffee at Betahaus', contactIds: [anna] })
  })

  it('returns undefined for an id that is not an interaction', async () => {
    expect(await getInteraction(testDb(), anna)).toBeUndefined()
  })

  it('reads a batch by id', async () => {
    const rows = await listInteractionsByIds(testDb(), [coffee, intro])
    expect(rows.map((row) => row.id).sort()).toEqual([coffee, intro].sort())
    expect(await listInteractionsByIds(testDb(), [])).toEqual([])
  })
})

describe('interactionParticipants', () => {
  it('resolves both sides to labels for the timeline chips', async () => {
    const rows = await interactionParticipants(testDb(), coffee)
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: anna, label: 'Anna Berger', objectType: 'contact' },
        { id: northstar, label: 'Northstar Ventures', objectType: 'organization' },
      ]),
    )
    expect(rows).toHaveLength(2)
  })
})
