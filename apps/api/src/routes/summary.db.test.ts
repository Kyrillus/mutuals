/**
 * §6.5's Summary card, over a real database.
 *
 * The property under test is the **cache**, not the prose. A summary is written once, read many
 * times, and regenerated on demand — so what matters is that the read costs nothing, that the write
 * replaces rather than accumulates, and that what the model was given was assembled from this
 * contact's own fields rather than fetched by the model itself.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '@mutuals/db/test-support'
import type { ContactSummary, Problem } from '@mutuals/core'

import { api, resetLlm, testLlm } from '../test-support/app.ts'
import { aContact, aFollowUp, anInteraction } from '../test-support/fixtures.ts'
import { answers, failsWith } from '../llm/test-support.ts'
import { LlmTransportError } from '../llm/errors.ts'

function said(summary: string) {
  return answers({ summary })
}

async function summaryRows(): Promise<number> {
  const row = await testDb()
    .selectFrom('record_summary')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

beforeEach(() => {
  resetLlm()
})

describe('the summary', () => {
  it('is empty until it is generated, and the read costs no model call', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })

    const { status, body } = await api.get<ContactSummary>(`/api/v1/contacts/${contact.id}/summary`)
    expect(status).toBe(200)
    expect(body).toEqual({ summary: null, generatedAt: null, model: null })
    expect(testLlm().provider.requests).toHaveLength(0)
  })

  it('generates on demand and caches with a timestamp and the model that wrote it', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    testLlm().provider.script(said('An investor in Munich. Currently looking for seed deals.'))

    const generated = await api.post<ContactSummary>(`/api/v1/contacts/${contact.id}/summary`)
    expect(generated.status).toBe(200)
    expect(generated.body.summary).toBe('An investor in Munich. Currently looking for seed deals.')
    expect(generated.body.model).toBe('openai/gpt-4.1-mini')
    expect(generated.body.generatedAt).toBe('2026-06-15T09:00:00.000Z')

    // The read after the write is the cache: no second call to the model.
    const read = await api.get<ContactSummary>(`/api/v1/contacts/${contact.id}/summary`)
    expect(read.body).toEqual(generated.body)
    expect(testLlm().provider.requests).toHaveLength(1)
  })

  it('replaces on regenerate rather than accumulating rows', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    testLlm().provider.script(said('First version.'), said('Second version.'))

    await api.post(`/api/v1/contacts/${contact.id}/summary`)
    await api.post(`/api/v1/contacts/${contact.id}/summary`)

    expect(await summaryRows()).toBe(1)
    const read = await api.get<ContactSummary>(`/api/v1/contacts/${contact.id}/summary`)
    expect(read.body.summary).toBe('Second version.')
  })

  /**
   * The model is handed rendered facts, never a record id and a way to look things up. That is what
   * keeps the cost of this feature knowable, and it is the same boundary as everywhere else.
   */
  it('is written from this contact’s own fields, interactions and open follow-ups', async () => {
    const contact = await aContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { city: 'Munich', asks: ['climate-tech seed deals'] },
    })
    await anInteraction({
      type: 'Meeting',
      title: 'Coffee at Bits & Pretzels',
      body: 'Writes €250k tickets.',
      occurredAt: '2026-06-01T10:00:00.000Z',
      contactIds: [contact.id],
    })
    await aFollowUp(contact.id, { title: 'Send the deck', dueAt: '2026-06-22' })

    testLlm().provider.script(said('A summary.'))
    await api.post(`/api/v1/contacts/${contact.id}/summary`)

    const prompt = testLlm().provider.requests[0]?.messages[1]?.content ?? ''
    expect(prompt).toContain('Anna Berger')
    // Rendered by label, not by slug — so a workspace that renamed "City" reads correctly.
    expect(prompt).toContain('City: Munich')
    expect(prompt).toContain('Asks: climate-tech seed deals')
    expect(prompt).toContain('Coffee at Bits & Pretzels')
    expect(prompt).toContain('Writes €250k tickets.')
    expect(prompt).toContain('due 2026-06-22: Send the deck')
    // The day, not the instant.
    expect(prompt).toContain('2026-06-01')
    expect(prompt).not.toContain(contact.id)
  })

  it('writes a summary for a contact with nothing on them at all', async () => {
    const contact = await aContact({ firstName: 'Blank', lastName: 'Slate' })
    testLlm().provider.script(said('Not much is recorded about them yet.'))

    const { status } = await api.post(`/api/v1/contacts/${contact.id}/summary`)
    expect(status).toBe(200)

    const prompt = testLlm().provider.requests[0]?.messages[1]?.content ?? ''
    expect(prompt).toContain('(no interactions logged)')
    expect(prompt).toContain('(none open)')
  })

  it('records the call in the trace and points the summary at it', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    testLlm().provider.script(said('A summary.'))
    await api.post(`/api/v1/contacts/${contact.id}/summary`)

    const call = await testDb()
      .selectFrom('llm_call')
      .select(['id', 'task_kind', 'prompt_id', 'record_id'])
      .executeTakeFirst()
    expect(call?.task_kind).toBe('summary')
    expect(call?.prompt_id).toBe('contact.summary')
    // `llm_call.record_id` is why the index on it exists: "what did this contact's summary cost".
    expect(call?.record_id).toBe(contact.id)

    const row = await testDb()
      .selectFrom('record_summary')
      .select(['llm_call_id'])
      .executeTakeFirst()
    expect(row?.llm_call_id).toBe(call?.id)
  })

  it('answers 404 for an organization id, because a summary is a contact’s (§6.5)', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    const { status } = await api.get(`/api/v1/contacts/${contact.id.replace(/.$/, '0')}/summary`)
    expect([404, 400]).toContain(status)
  })

  it('leaves the cached summary alone when a regenerate fails', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    testLlm().provider.script(
      said('The good one.'),
      failsWith(new LlmTransportError('nothing answered', { callStatus: 'timeout' })),
    )

    await api.post(`/api/v1/contacts/${contact.id}/summary`)
    const failed = await api.post<Problem>(`/api/v1/contacts/${contact.id}/summary`)
    expect(failed.status).toBe(504)

    // A failed regenerate must not blank the card: the old summary is stale, not wrong.
    const read = await api.get<ContactSummary>(`/api/v1/contacts/${contact.id}/summary`)
    expect(read.body.summary).toBe('The good one.')
  })

  it('deletes the summary with the contact, and keeps the trace row', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    testLlm().provider.script(said('A summary.'))
    await api.post(`/api/v1/contacts/${contact.id}/summary`)

    await api.delete(`/api/v1/contacts/${contact.id}`)

    expect(await summaryRows()).toBe(0)
    // ADR-068: deleting a contact should not erase the cost record of work already paid for.
    const calls = await testDb().selectFrom('llm_call').select(['record_id']).execute()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.record_id).toBeNull()
  })
})
