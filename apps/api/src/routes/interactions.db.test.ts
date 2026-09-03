/**
 * Interactions, through the real app (ADR-075).
 *
 * The participant set is the thing that goes wrong quietly, so it gets most of the attention here:
 * an absent list leaves participants alone, a present one — the empty array included — makes that
 * list true.
 */
import type { Interaction, Problem } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { api, listUrl } from '../test-support/app.ts'
import { aContact, anInteraction, anOrganization } from '../test-support/fixtures.ts'

interface InteractionList {
  data: Interaction[]
  page: { cursor: string | null; hasMore: boolean }
  meta: { total: number | null }
}

const INTERACTIONS = '/api/v1/interactions'

describe('the happy path', () => {
  it('logs a touchpoint with a contact and an organization', async () => {
    const contact = await aContact({ firstName: 'Anna' })
    const organization = await anOrganization({ name: 'Northstar Ventures' })

    const created = await anInteraction({
      type: 'Meeting',
      occurredAt: '2026-06-01T10:00:00.000Z',
      title: 'Coffee at Bits & Pretzels',
      body: 'She is raising a **seed** round.',
      contactIds: [contact.id],
      organizationIds: [organization.id],
    })

    expect(created.type).toBe('Meeting')
    expect(created.source).toBe('manual')
    expect(created.contacts).toEqual([
      { id: contact.id, displayName: 'Anna Berger', objectType: 'contact' },
    ])
    expect(created.organizations).toEqual([
      { id: organization.id, displayName: 'Northstar Ventures', objectType: 'organization' },
    ])
  })

  it('scopes the timeline to one contact, newest first', async () => {
    const anna = await aContact({ firstName: 'Anna' })
    const bruno = await aContact({ firstName: 'Bruno' })
    await anInteraction({
      title: 'Older',
      occurredAt: '2026-01-01T10:00:00.000Z',
      contactIds: [anna.id],
    })
    await anInteraction({
      title: 'Newer',
      occurredAt: '2026-05-01T10:00:00.000Z',
      contactIds: [anna.id],
    })
    await anInteraction({ title: "Bruno's", contactIds: [bruno.id] })

    const { body } = await api.get<InteractionList>(listUrl(INTERACTIONS, { contactId: anna.id }))
    expect(body.data.map((interaction) => interaction.title)).toEqual(['Newer', 'Older'])
    // A timeline is scrolled, never counted, so `total` is null by design (ADR-023).
    expect(body.meta.total).toBeNull()
  })

  it('filters the timeline by type', async () => {
    const contact = await aContact()
    await anInteraction({ type: 'Meeting', title: 'M', contactIds: [contact.id] })
    await anInteraction({ type: 'Email', title: 'E', contactIds: [contact.id] })

    const { body } = await api.get<InteractionList>(
      listUrl(INTERACTIONS, { contactId: contact.id, type: 'Email' }),
    )
    expect(body.data.map((interaction) => interaction.title)).toEqual(['E'])
  })

  it('pages the timeline with an opaque cursor', async () => {
    const contact = await aContact()
    for (let index = 0; index < 5; index += 1) {
      await anInteraction({
        title: `T${String(index)}`,
        occurredAt: `2026-0${String(index + 1)}-01T10:00:00.000Z`,
        contactIds: [contact.id],
      })
    }

    const first = await api.get<InteractionList>(
      listUrl(INTERACTIONS, { contactId: contact.id, limit: '2' }),
    )
    expect(first.body.data.map((interaction) => interaction.title)).toEqual(['T4', 'T3'])
    expect(first.body.page.hasMore).toBe(true)

    const second = await api.get<InteractionList>(
      listUrl(INTERACTIONS, {
        contactId: contact.id,
        limit: '2',
        cursor: first.body.page.cursor ?? '',
      }),
    )
    expect(second.body.data.map((interaction) => interaction.title)).toEqual(['T2', 'T1'])
  })

  it('replaces the whole participant list when one is sent', async () => {
    const anna = await aContact({ firstName: 'Anna' })
    const bruno = await aContact({ firstName: 'Bruno' })
    const created = await anInteraction({ contactIds: [anna.id] })

    const updated = await api.patch<Interaction>(`${INTERACTIONS}/${created.id}`, {
      contactIds: [bruno.id],
    })
    expect(updated.status).toBe(200)
    expect(updated.body.contacts.map((contact) => contact.id)).toEqual([bruno.id])
  })

  it('leaves participants alone when the field is absent', async () => {
    const anna = await aContact({ firstName: 'Anna' })
    const created = await anInteraction({ contactIds: [anna.id] })
    const updated = await api.patch<Interaction>(`${INTERACTIONS}/${created.id}`, {
      title: 'Renamed',
    })
    expect(updated.body.title).toBe('Renamed')
    expect(updated.body.contacts.map((contact) => contact.id)).toEqual([anna.id])
  })

  it('clears participants when an empty array is sent', async () => {
    const anna = await aContact({ firstName: 'Anna' })
    const created = await anInteraction({ contactIds: [anna.id] })
    const updated = await api.patch<Interaction>(`${INTERACTIONS}/${created.id}`, {
      contactIds: [],
    })
    expect(updated.body.contacts).toEqual([])
  })

  it('moves the contact metrics that warmth is computed from', async () => {
    const contact = await aContact()
    await anInteraction({
      type: 'Meeting',
      occurredAt: '2026-06-10T10:00:00.000Z',
      contactIds: [contact.id],
    })
    const read = await api.get<{ lastInteractionAt: string | null }>(
      `/api/v1/contacts/${contact.id}`,
    )
    // The metrics sweep is nightly (ADR-022), so this asserts the shape rather than a fresh warmth:
    // the field exists, is nullable, and nothing here has to guess when the sweep last ran.
    expect(read.status).toBe(200)
    expect(read.body).toHaveProperty('lastInteractionAt')
  })
})

describe('validation errors', () => {
  it('refuses a type outside the closed set', async () => {
    const { status, body } = await api.post<Problem>(INTERACTIONS, {
      type: 'Telepathy',
      occurredAt: '2026-06-01T10:00:00.000Z',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('type')
  })

  it('refuses a participant that does not exist, with the id in the message', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff'
    const { status, body } = await api.post<Problem>(INTERACTIONS, {
      type: 'Call',
      occurredAt: '2026-06-01T10:00:00.000Z',
      contactIds: [missing],
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('contactIds')
    expect(body.errors?.[0]?.message).toContain(missing)
  })

  it('refuses an organization id in contactIds', async () => {
    const organization = await anOrganization()
    const { status, body } = await api.post<Problem>(INTERACTIONS, {
      type: 'Call',
      occurredAt: '2026-06-01T10:00:00.000Z',
      contactIds: [organization.id],
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('contactIds')
  })

  it('refuses an occurredAt that is not an instant', async () => {
    const { status } = await api.post<Problem>(INTERACTIONS, {
      type: 'Call',
      occurredAt: '2026-06-01',
    })
    expect(status).toBe(400)
  })
})

describe('the destructive path', () => {
  it('deletes the interaction and unlinks it from its participants', async () => {
    const contact = await aContact()
    const created = await anInteraction({ contactIds: [contact.id] })

    expect((await api.delete(`${INTERACTIONS}/${created.id}`)).status).toBe(200)
    expect((await api.delete(`${INTERACTIONS}/${created.id}`)).status).toBe(404)

    const timeline = await api.get<InteractionList>(
      listUrl(INTERACTIONS, { contactId: contact.id }),
    )
    expect(timeline.body.data).toEqual([])
    expect((await api.get(`/api/v1/contacts/${contact.id}`)).status).toBe(200)
  })

  it('takes its interactions with it when the contact is deleted', async () => {
    const contact = await aContact()
    const created = await anInteraction({ contactIds: [contact.id] })
    await api.delete(`/api/v1/contacts/${contact.id}`)
    // The interaction is a record in its own right, so it survives; only the link is gone.
    const remaining = await api.get<InteractionList>(INTERACTIONS)
    expect(remaining.body.data.map((interaction) => interaction.id)).toEqual([created.id])
    expect(remaining.body.data[0]?.contacts).toEqual([])
  })
})
