/**
 * Follow-ups, through the real app (ADR-075).
 *
 * The clock is pinned at 2026-06-15 (`TEST_NOW`), so "overdue", "due today" and "due this week"
 * are statements a test can make rather than guesses about when it happens to run.
 *
 * The recurrence block is the one §12 names by hand: a follow-up that repeats every quarter, marked
 * done, produces exactly one successor, anchored on the series and not on the completion date.
 */
import type { FollowUp, Problem } from '@mutuals/core'
import { testDb } from '@mutuals/db/test-support'
import { describe, expect, it } from 'vitest'

import { api, listUrl } from '../test-support/app.ts'
import { aContact, aFollowUp } from '../test-support/fixtures.ts'

interface FollowUpList {
  data: FollowUp[]
  page: { cursor: string | null; hasMore: boolean }
  meta: { total: number | null }
}

interface UpdateResult {
  data: FollowUp
  next: FollowUp | null
}

const FOLLOW_UPS = '/api/v1/follow-ups'

describe('the happy path', () => {
  it('creates one against a contact and returns the chip the table renders', async () => {
    const contact = await aContact({ firstName: 'Anna' })
    const created = await aFollowUp(contact.id, {
      title: 'Send the deck',
      dueAt: '2026-06-20',
      notes: 'She asked for the seed deck.',
    })

    expect(created.title).toBe('Send the deck')
    expect(created.status).toBe('Open')
    expect(created.origin).toBe('manual')
    expect(created.recurrence).toBeNull()
    expect(created.completedAt).toBeNull()
    expect(created.contact).toEqual({
      id: contact.id,
      displayName: 'Anna Berger',
      objectType: 'contact',
    })
  })

  it('derives the state from the pinned today, not from the stored status alone', async () => {
    const contact = await aContact()
    const overdue = await aFollowUp(contact.id, { dueAt: '2026-06-01' })
    const today = await aFollowUp(contact.id, { dueAt: '2026-06-15' })
    const upcoming = await aFollowUp(contact.id, { dueAt: '2026-07-01' })

    expect(overdue.state).toBe('overdue')
    expect(today.state).toBe('due_today')
    expect(upcoming.state).toBe('upcoming')
  })

  it('filters by the tabs of §6.4', async () => {
    const contact = await aContact()
    await aFollowUp(contact.id, { title: 'Late', dueAt: '2026-06-01' })
    await aFollowUp(contact.id, { title: 'Soon', dueAt: '2026-07-01' })
    const done = await aFollowUp(contact.id, { title: 'Finished', dueAt: '2026-06-02' })
    await api.patch(`${FOLLOW_UPS}/${done.id}`, { status: 'Done' })

    const overdue = await api.get<FollowUpList>(listUrl(FOLLOW_UPS, { state: 'overdue' }))
    expect(overdue.body.data.map((followUp) => followUp.title)).toEqual(['Late'])
    expect(overdue.body.meta.total).toBe(1)

    const finished = await api.get<FollowUpList>(listUrl(FOLLOW_UPS, { state: 'done' }))
    expect(finished.body.data.map((followUp) => followUp.title)).toEqual(['Finished'])

    const all = await api.get<FollowUpList>(FOLLOW_UPS)
    expect(all.body.meta.total).toBe(3)
  })

  it('orders soonest first and pages with an opaque cursor', async () => {
    const contact = await aContact()
    for (const day of ['2026-07-04', '2026-07-01', '2026-07-03', '2026-07-02']) {
      await aFollowUp(contact.id, { title: day, dueAt: day })
    }
    const first = await api.get<FollowUpList>(listUrl(FOLLOW_UPS, { limit: '2' }))
    expect(first.body.data.map((followUp) => followUp.dueAt)).toEqual(['2026-07-01', '2026-07-02'])
    expect(first.body.page.hasMore).toBe(true)

    const second = await api.get<FollowUpList>(
      listUrl(FOLLOW_UPS, { limit: '2', cursor: first.body.page.cursor ?? '' }),
    )
    expect(second.body.data.map((followUp) => followUp.dueAt)).toEqual(['2026-07-03', '2026-07-04'])
    expect(second.body.page.hasMore).toBe(false)
  })

  it('snoozes by moving the due date and the status', async () => {
    const contact = await aContact()
    const created = await aFollowUp(contact.id, { dueAt: '2026-06-01' })
    const snoozed = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, {
      status: 'Snoozed',
      dueAt: '2026-06-22',
    })
    expect(snoozed.body.data.status).toBe('Snoozed')
    expect(snoozed.body.data.state).toBe('snoozed')
    expect(snoozed.body.data.dueAt).toBe('2026-06-22')
    expect(snoozed.body.next).toBeNull()
  })
})

describe('recurrence', () => {
  it('creates exactly one successor when a repeating follow-up is marked done', async () => {
    const contact = await aContact()
    const created = await aFollowUp(contact.id, {
      title: 'Quarterly check-in',
      dueAt: '2026-06-01',
      recurrence: { kind: 'every_n_months', n: 3 },
    })

    const { status, body } = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, {
      status: 'Done',
    })
    expect(status).toBe(200)
    expect(body.data.status).toBe('Done')
    expect(body.data.completedAt).not.toBeNull()
    expect(body.next).not.toBeNull()
    expect(body.next?.dueAt).toBe('2026-09-01')
    expect(body.next?.status).toBe('Open')
    expect(body.next?.recurrence).toEqual({ kind: 'every_n_months', n: 3 })

    const all = await api.get<FollowUpList>(FOLLOW_UPS)
    expect(all.body.meta.total).toBe(2)
  })

  it('stays on the series anchor, so a 31st does not decay to a 28th', async () => {
    const contact = await aContact()
    // Anchored on 31 January. The first roll-over from a June "today" lands on 30 June — a real
    // month end — and the *next* one has to come back to the 31st rather than staying on the 30th.
    const january = await aFollowUp(contact.id, {
      dueAt: '2026-01-31',
      recurrence: { kind: 'monthly' },
    })
    const first = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${january.id}`, { status: 'Done' })
    expect(first.body.next?.dueAt).toBe('2026-06-30')

    const successorId = first.body.next?.id ?? ''
    const second = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${successorId}`, {
      status: 'Done',
    })
    expect(second.body.next?.dueAt).toBe('2026-07-31')
  })

  it('rolls forward past today rather than leaving a backlog of ghosts', async () => {
    const contact = await aContact()
    const stale = await aFollowUp(contact.id, {
      dueAt: '2020-01-15',
      recurrence: { kind: 'monthly' },
    })
    const { body } = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${stale.id}`, { status: 'Done' })
    // Six years late, and still exactly one successor, in the future.
    expect(body.next?.dueAt).toBe('2026-07-15')
    const all = await api.get<FollowUpList>(FOLLOW_UPS)
    expect(all.body.meta.total).toBe(2)
  })

  it('rolls over a row whose stored rule carries no anchor, as the seed writes them', async () => {
    // The series anchor rides in the `recurrence` jsonb next to the rule, because `follow_up` has
    // no column for it. A row written without one — by `pnpm seed`, or by hand in psql — must
    // still roll over, anchored on its own due date.
    const contact = await aContact()
    const created = await aFollowUp(contact.id, {
      dueAt: '2026-01-31',
      recurrence: { kind: 'monthly' },
    })
    await testDb()
      .updateTable('follow_up')
      .set({ recurrence: { kind: 'monthly' } })
      .where('id', '=', created.id)
      .execute()

    const { body } = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, {
      status: 'Done',
    })
    expect(body.data.recurrence).toEqual({ kind: 'monthly' })
    expect(body.next?.dueAt).toBe('2026-06-30')
  })

  it('creates no successor for a follow-up that does not repeat', async () => {
    const contact = await aContact()
    const created = await aFollowUp(contact.id)
    const { body } = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, {
      status: 'Done',
    })
    expect(body.next).toBeNull()
  })

  it('creates no second successor when an already-done follow-up is patched again', async () => {
    const contact = await aContact()
    const created = await aFollowUp(contact.id, {
      dueAt: '2026-06-01',
      recurrence: { kind: 'weekly' },
    })
    await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, { status: 'Done' })
    const again = await api.patch<UpdateResult>(`${FOLLOW_UPS}/${created.id}`, {
      status: 'Done',
      notes: 'still done',
    })
    expect(again.body.next).toBeNull()
    expect((await api.get<FollowUpList>(FOLLOW_UPS)).body.meta.total).toBe(2)
  })

  it('does not spawn successors from a bulk "mark done"', async () => {
    const contact = await aContact()
    const first = await aFollowUp(contact.id, { recurrence: { kind: 'weekly' } })
    const second = await aFollowUp(contact.id, { recurrence: { kind: 'weekly' } })
    const { body } = await api.post<{ meta: { succeeded: number } }>(`${FOLLOW_UPS}/bulk`, {
      ids: [first.id, second.id],
      status: 'Done',
    })
    expect(body.meta.succeeded).toBe(2)
    // Forty new follow-ups nobody asked for is the failure mode this guards.
    expect((await api.get<FollowUpList>(FOLLOW_UPS)).body.meta.total).toBe(2)
  })
})

describe('validation errors', () => {
  it('refuses a follow-up with no contact', async () => {
    const { status, body } = await api.post<Problem>(FOLLOW_UPS, {
      title: 'Orphan',
      dueAt: '2026-07-01',
    })
    expect(status).toBe(400)
    expect(body.errors?.some((error) => error.field === 'contactId')).toBe(true)
  })

  it('refuses a contact id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff'
    const { status, body } = await api.post<Problem>(FOLLOW_UPS, {
      title: 'Ghost',
      contactId: missing,
      dueAt: '2026-07-01',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('contactId')
  })

  it('refuses a due date that is not a civil date', async () => {
    const contact = await aContact()
    const { status, body } = await api.post<Problem>(FOLLOW_UPS, {
      title: 'Whenever',
      contactId: contact.id,
      dueAt: '20 July',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('dueAt')
  })

  it('refuses a recurrence outside the closed five-variant union', async () => {
    const contact = await aContact()
    const { status } = await api.post<Problem>(FOLLOW_UPS, {
      title: 'Fortnightly',
      contactId: contact.id,
      dueAt: '2026-07-01',
      recurrence: { kind: 'fortnightly' },
    })
    expect(status).toBe(400)
  })

  it('refuses a bulk update that says nothing', async () => {
    const contact = await aContact()
    const followUp = await aFollowUp(contact.id)
    const { status, body } = await api.post<Problem>(`${FOLLOW_UPS}/bulk`, { ids: [followUp.id] })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('status')
  })
})

describe('the destructive path', () => {
  it('deletes one, and answers 404 the second time', async () => {
    const contact = await aContact()
    const followUp = await aFollowUp(contact.id)
    expect((await api.delete(`${FOLLOW_UPS}/${followUp.id}`)).status).toBe(200)
    expect((await api.delete(`${FOLLOW_UPS}/${followUp.id}`)).status).toBe(404)
  })

  it('cascades when the contact goes', async () => {
    const contact = await aContact()
    await aFollowUp(contact.id)
    await api.delete(`/api/v1/contacts/${contact.id}`)
    expect((await api.get<FollowUpList>(FOLLOW_UPS)).body.meta.total).toBe(0)
  })

  it('reports a bulk update per item', async () => {
    const contact = await aContact()
    const real = await aFollowUp(contact.id)
    const missing = '00000000-0000-4000-8000-0000000000ff'
    const { body } = await api.post<{
      data: { succeeded: string[]; failed: { id: string }[] }
      meta: { attempted: number; succeeded: number; failed: number }
    }>(`${FOLLOW_UPS}/bulk`, { ids: [real.id, missing], dueAt: '2026-08-01' })
    expect(body.meta).toEqual({ attempted: 2, succeeded: 1, failed: 1 })
    expect(body.data.failed[0]?.id).toBe(missing)
  })
})
