/**
 * The dashboard numbers and the profile, through the real app (ADR-075).
 *
 * The clock is pinned at 2026-06-15, so "due this week" and "added in the last 30 days" are claims
 * a test can check. The profile block covers the case a fresh database is actually in: no row yet.
 */
import type { Problem, Profile } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { api } from '../test-support/app.ts'
import { aContact, aFollowUp, anInteraction, anOrganization } from '../test-support/fixtures.ts'

interface Stats {
  totalContacts: number
  totalOrganizations: number
  totalInteractions: number
  contactsAddedLast30Days: number
  followUpsDueThisWeek: number
  followUpsOverdue: number
  today: string
}

describe('the dashboard numbers', () => {
  it('counts nothing on an empty database', async () => {
    const { status, body } = await api.get<Stats>('/api/v1/stats')
    expect(status).toBe(200)
    expect(body).toEqual({
      totalContacts: 0,
      totalOrganizations: 0,
      totalInteractions: 0,
      contactsAddedLast30Days: 0,
      followUpsDueThisWeek: 0,
      followUpsOverdue: 0,
      today: '2026-06-15',
    })
  })

  it('counts each object type separately, not the shared record table', async () => {
    await aContact({ firstName: 'Anna' })
    await aContact({ firstName: 'Bruno' })
    await anOrganization()
    await anInteraction()

    const { body } = await api.get<Stats>('/api/v1/stats')
    expect(body.totalContacts).toBe(2)
    expect(body.totalOrganizations).toBe(1)
    expect(body.totalInteractions).toBe(1)
  })

  it('splits follow-ups into overdue and due this week, against the profile today', async () => {
    const contact = await aContact()
    await aFollowUp(contact.id, { title: 'Late', dueAt: '2026-06-01' })
    await aFollowUp(contact.id, { title: 'Today', dueAt: '2026-06-15' })
    await aFollowUp(contact.id, { title: 'Friday', dueAt: '2026-06-19' })
    await aFollowUp(contact.id, { title: 'Next month', dueAt: '2026-07-20' })
    const done = await aFollowUp(contact.id, { title: 'Done', dueAt: '2026-06-02' })
    await api.patch(`/api/v1/follow-ups/${done.id}`, { status: 'Done' })

    const { body } = await api.get<Stats>('/api/v1/stats')
    // A completed follow-up is not overdue, however overdue it once was.
    expect(body.followUpsOverdue).toBe(1)
    expect(body.followUpsDueThisWeek).toBe(2)
  })

  it('agrees with the list endpoint it links to', async () => {
    const contact = await aContact()
    await aFollowUp(contact.id, { dueAt: '2026-06-01' })
    await aFollowUp(contact.id, { dueAt: '2026-06-02' })

    const stats = await api.get<Stats>('/api/v1/stats')
    const list = await api.get<{ meta: { total: number } }>('/api/v1/follow-ups?state=overdue')
    // Every stat card links to a pre-filtered view; the two must not be able to disagree.
    expect(stats.body.followUpsOverdue).toBe(list.body.meta.total)
  })

  it('counts a contact created now as added in the last 30 days', async () => {
    await aContact()
    const { body } = await api.get<Stats>('/api/v1/stats')
    expect(body.contactsAddedLast30Days).toBe(1)
  })
})

describe('the profile', () => {
  it('answers the environment defaults with a null id before the first save', async () => {
    const { status, body } = await api.get<Profile>('/api/v1/profile')
    expect(status).toBe(200)
    expect(body.id).toBeNull()
    expect(body.firstName).toBe('')
    expect(body.phoneRegion).toBe('DE')
    expect(body.timeZone).toBe('Europe/Berlin')
    expect(body.createdAt).toBeNull()
  })

  it('creates the row on the first save and updates it after that', async () => {
    const created = await api.patch<Profile>('/api/v1/profile', {
      firstName: 'Simon',
      lastName: 'Mutuals',
      email: 'simon@example.com',
    })
    expect(created.status).toBe(200)
    expect(created.body.id).not.toBeNull()
    expect(created.body.firstName).toBe('Simon')

    const updated = await api.patch<Profile>('/api/v1/profile', { firstName: 'Si' })
    expect(updated.body.id).toBe(created.body.id)
    expect(updated.body.firstName).toBe('Si')
    expect(updated.body.lastName).toBe('Mutuals')
  })

  it('changes the timezone the whole API computes "today" in', async () => {
    // Pinned now is 2026-06-15T09:00Z. In Auckland that is already the 15th too, but at 21:00 —
    // so a zone far enough east of it changes the civil day the dashboard reports.
    await api.patch('/api/v1/profile', { timeZone: 'Pacific/Kiritimati' })
    const { body } = await api.get<Stats>('/api/v1/stats')
    expect(body.today).toBe('2026-06-15')

    await api.patch('/api/v1/profile', { timeZone: 'Pacific/Midway' })
    const west = await api.get<Stats>('/api/v1/stats')
    expect(west.body.today).toBe('2026-06-14')
  })

  it('changes the region a national phone number is normalised against', async () => {
    await api.patch('/api/v1/profile', { phoneRegion: 'US' })
    const contact = await aContact({ attributes: { phone: '(415) 555-0132' } })
    expect(contact.attributes['phone']).toEqual({ type: 'phone', value: '+14155550132' })
  })

  it('refuses a region that is not two letters and a timezone that is not one', async () => {
    const region = await api.patch<Problem>('/api/v1/profile', { phoneRegion: 'Germany' })
    expect(region.status).toBe(400)
    expect(region.body.errors?.[0]?.field).toBe('phoneRegion')

    const empty = await api.patch<Problem>('/api/v1/profile', { firstName: '' })
    expect(empty.status).toBe(400)
    expect(empty.body.errors?.[0]?.field).toBe('firstName')
  })
})
