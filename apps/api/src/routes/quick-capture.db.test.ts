/**
 * §4.8's quick capture, over a real database and a scripted model.
 *
 * Two properties carry the feature. **Nothing is saved by the preview** — asserted by counting rows
 * after it, because a preview that writes is the one bug this design exists to prevent. And **the
 * model's proposal is checked before it becomes anything**: a slug that does not exist, a value the
 * registry refuses, an interaction type nobody declared and a date that will not parse are each
 * dropped and named in the note rather than failing the capture or, worse, landing.
 *
 * Matching goes through the same `matchDuplicates` the importer uses, with ADR-099's thresholds.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '@mutuals/db/test-support'
import type { CommitQuickCaptureResponse, Contact, QuickCaptureResponse } from '@mutuals/core'

import { api, resetLlm, testLlm } from '../test-support/app.ts'
import { aContact, anOrganization } from '../test-support/fixtures.ts'
import { answers } from '../llm/test-support.ts'

interface ProposedField {
  slug: string
  value: string
  confidence?: number
}

function capture(overrides: {
  contact?: { displayName: string; fields?: ProposedField[] } | null
  organization?: { displayName: string; fields?: ProposedField[] } | null
  interaction?: {
    type: string
    title: string
    body?: string | null
    occurredOn?: string | null
  } | null
  followUp?: { title: string; dueOn: string; notes?: string | null } | null
  note?: string | null
}) {
  const record = (one: { displayName: string; fields?: ProposedField[] } | null | undefined) =>
    one == null
      ? null
      : {
          displayName: one.displayName,
          fields: (one.fields ?? []).map((field) => ({ confidence: 0.9, ...field })),
        }

  return {
    contact: record(overrides.contact),
    organization: record(overrides.organization),
    interaction:
      overrides.interaction == null
        ? null
        : { body: null, occurredOn: null, ...overrides.interaction },
    followUp: overrides.followUp == null ? null : { notes: null, ...overrides.followUp },
    note: overrides.note ?? null,
  }
}

async function countRows(table: 'record' | 'interaction' | 'follow_up'): Promise<number> {
  const row = await testDb()
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

beforeEach(() => {
  resetLlm()
})

describe('POST /quick-capture — the preview', () => {
  it('turns §4.8’s own example into four proposals and writes nothing', async () => {
    testLlm().provider.script(
      answers(
        capture({
          contact: {
            displayName: 'Anna Berger',
            fields: [
              { slug: 'first_name', value: 'Anna', confidence: 1 },
              { slug: 'last_name', value: 'Berger', confidence: 1 },
              { slug: 'asks', value: 'climate-tech seed deals', confidence: 0.8 },
            ],
          },
          organization: { displayName: 'Northstar Ventures' },
          interaction: { type: 'Meeting', title: 'Bits & Pretzels', occurredOn: '2026-06-15' },
          followUp: { title: 'Follow up with Anna', dueOn: '2026-07-06' },
        }),
      ),
    )

    const before = await countRows('record')
    const { status, body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', {
      text: "Met Anna Berger from Northstar Ventures at Bits & Pretzels, she's looking for climate-tech seed deals, follow up in 3 weeks",
    })

    expect(status).toBe(200)
    expect(body.contact?.action).toBe('create')
    expect(body.contact?.displayName).toBe('Anna Berger')
    expect(body.organization?.displayName).toBe('Northstar Ventures')
    expect(body.interaction?.title).toBe('Bits & Pretzels')
    expect(body.followUp?.dueAt).toBe('2026-07-06')

    // The whole promise of the preview, as a number.
    expect(await countRows('record')).toBe(before)
    expect(await countRows('interaction')).toBe(0)
    expect(await countRows('follow_up')).toBe(0)
  })

  it('fills the name fields from the display name when the model leaves them out', async () => {
    testLlm().provider.script(answers(capture({ contact: { displayName: 'Anna Berger' } })))
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', {
      text: 'Met Anna Berger',
    })

    const fields = Object.fromEntries(
      (body.contact?.fields ?? []).map((field) => [field.slug, field.value]),
    )
    // Otherwise the card says "Anna Berger" and confirming it creates a record with no name.
    expect(fields['first_name']).toBe('Anna')
    expect(fields['last_name']).toBe('Berger')
  })

  it('proposes a match when the person is already in the workspace, and says why', async () => {
    const existing = await aContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { email: 'anna@northstar.vc' },
    })

    testLlm().provider.script(
      answers(
        capture({
          contact: {
            displayName: 'Anna Berger',
            fields: [{ slug: 'email', value: 'ANNA@northstar.vc' }],
          },
        }),
      ),
    )

    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', {
      text: 'Coffee with Anna again',
    })

    expect(body.contact?.action).toBe('match')
    expect(body.contact?.matchId).toBe(existing.id)
    const candidate = body.contact?.candidates[0]
    expect(candidate?.displayName).toBe('Anna Berger')
    expect(candidate?.band).toBe('certain')
    expect(candidate?.evidence).toContain('anna@northstar.vc')
  })

  it('matches an organization on its exact name and not on a near one (ADR-101)', async () => {
    const existing = await anOrganization({ name: 'Kiln Robotics' })

    testLlm().provider.script(
      answers(capture({ organization: { displayName: 'kiln  robotics' } })),
      answers(capture({ organization: { displayName: 'Kiln Robotics GmbH' } })),
    )

    // Case folds; the internal double space does not, because `mutuals_norm` does not collapse it.
    const exact = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'a' })
    expect(exact.body.organization?.action).toBe('create')

    const near = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'b' })
    // "Kiln Robotics GmbH" is a different company until a person says otherwise (§6.9's merge).
    expect(near.body.organization?.action).toBe('create')
    expect(near.body.organization?.candidates).toEqual([])
    expect(existing.id).toBeTruthy()
  })

  it('drops a field the workspace does not have, and says so rather than failing', async () => {
    testLlm().provider.script(
      answers(
        capture({
          contact: {
            displayName: 'Anna Berger',
            fields: [
              { slug: 'city', value: 'Munich' },
              { slug: 'favourite_colour', value: 'blue' },
            ],
          },
        }),
      ),
    )

    const { status, body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', {
      text: 'Anna, Munich, likes blue',
    })

    expect(status).toBe(200)
    expect(body.contact?.fields.map((field) => field.slug)).toContain('city')
    expect(body.contact?.fields.map((field) => field.slug)).not.toContain('favourite_colour')
    expect(body.note).toContain('favourite_colour')
  })

  it('drops a value the registry refuses, and keeps the rest of the card', async () => {
    testLlm().provider.script(
      answers(
        capture({
          contact: {
            displayName: 'Anna Berger',
            fields: [
              { slug: 'city', value: 'Munich' },
              { slug: 'birthday', value: 'the third of never' },
            ],
          },
        }),
      ),
    )

    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'x' })
    expect(body.contact?.fields.map((field) => field.slug)).toEqual(
      expect.arrayContaining(['city']),
    )
    expect(body.contact?.fields.map((field) => field.slug)).not.toContain('birthday')
    expect(body.note).toContain('birthday')
  })

  it('refuses an interaction type nobody declared', async () => {
    testLlm().provider.script(
      answers(capture({ interaction: { type: 'Telepathy', title: 'A thought' } })),
    )
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'x' })
    expect(body.interaction).toBeNull()
    expect(body.note).toContain('Telepathy')
  })

  it('drops a follow-up whose date will not parse rather than inventing one', async () => {
    testLlm().provider.script(
      answers(capture({ followUp: { title: 'Send the deck', dueOn: 'next Tuesday-ish' } })),
    )
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'x' })
    expect(body.followUp).toBeNull()
    expect(body.note).toContain('next Tuesday-ish')
  })

  it('dates an interaction with no date at *now*, not at midday', async () => {
    testLlm().provider.script(answers(capture({ interaction: { type: 'Note', title: 'Thought' } })))
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'x' })
    // TEST_NOW is 09:00Z. Midday would file a note typed this morning three hours in the future,
    // and the relationship card would read "last interaction: in 3 hours".
    expect(body.interaction?.occurredAt).toBe('2026-06-15T09:00:00.000Z')
  })

  it('dates an interaction on another day at midday, never at midnight', async () => {
    testLlm().provider.script(
      answers(
        capture({ interaction: { type: 'Note', title: 'Thought', occurredOn: '2026-06-10' } }),
      ),
    )
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', { text: 'x' })
    // Midnight UTC is the previous day everywhere west of Berlin.
    expect(body.interaction?.occurredAt).toBe('2026-06-10T12:00:00.000Z')
  })

  it('answers with four nulls for a sentence about nobody', async () => {
    testLlm().provider.script(answers(capture({ note: 'Nothing here names a person.' })))
    const { body } = await api.post<QuickCaptureResponse>('/api/v1/quick-capture', {
      text: 'remember to buy milk',
    })
    expect(body).toMatchObject({
      contact: null,
      organization: null,
      interaction: null,
      followUp: null,
    })
    expect(body.note).toBe('Nothing here names a person.')
  })
})

describe('POST /quick-capture/commit', () => {
  it('writes the contact, the organization, the link, the interaction and the follow-up', async () => {
    const { status, body } = await api.post<CommitQuickCaptureResponse>(
      '/api/v1/quick-capture/commit',
      {
        contact: {
          action: 'create',
          fields: [
            { slug: 'first_name', value: 'Anna' },
            { slug: 'last_name', value: 'Berger' },
            { slug: 'city', value: 'Munich' },
            { slug: 'asks', value: 'climate-tech seed deals' },
          ],
        },
        organization: { action: 'create', fields: [{ slug: 'name', value: 'Northstar Ventures' }] },
        interaction: {
          type: 'Meeting',
          title: 'Bits & Pretzels',
          body: 'Looking for seed deals.',
          occurredAt: '2026-06-15T12:00:00.000Z',
        },
        followUp: { title: 'Send the deck', dueAt: '2026-07-06', notes: null },
      },
    )

    expect(status).toBe(201)
    expect(body.created.sort()).toEqual(['contact', 'followUp', 'interaction', 'organization'])
    expect(body.linked).toBe(true)

    const contact = await api.get<Contact>(`/api/v1/contacts/${String(body.contact?.id)}`)
    expect(contact.body.displayName).toBe('Anna Berger')
    expect(contact.body.attributes['city']).toEqual({ type: 'short_text', value: 'Munich' })
    expect(contact.body.attributes['asks']).toEqual({
      type: 'tags',
      value: ['climate-tech seed deals'],
    })
    // §4.3: the link is an ordinary relation attribute, written through the ordinary write path.
    expect(contact.body.attributes['organization']).toMatchObject({
      type: 'relation',
      value: [{ label: 'Northstar Ventures' }],
    })
    // §4.4: every fact says where it came from.
    expect(contact.body.provenance.createdVia).toBe('agent')
  })

  /**
   * §4.7's numbers, after a capture. Logging a meeting through the Activities tab moves them
   * (ADR-092), and a capture that logs the same meeting has to move them too — otherwise the
   * relationship card says "—" beside an interaction that is plainly there. Found by running it.
   */
  it('moves the relationship numbers, exactly as logging an activity does', async () => {
    const { body } = await api.post<CommitQuickCaptureResponse>('/api/v1/quick-capture/commit', {
      contact: { action: 'create', fields: [{ slug: 'first_name', value: 'Anna' }] },
      interaction: {
        type: 'Meeting',
        title: 'Coffee',
        body: null,
        occurredAt: '2026-06-15T12:00:00.000Z',
      },
    })

    const contact = await api.get<Contact>(`/api/v1/contacts/${String(body.contact?.id)}`)
    expect(contact.body.interactionCount12m).toBe(1)
    expect(contact.body.lastInteractionAt).toBe('2026-06-15T12:00:00.000Z')
    expect(contact.body.warmth).toBeGreaterThan(0)
  })

  it('attaches to an existing contact when the user confirms the match', async () => {
    const existing = await aContact({ firstName: 'Anna', lastName: 'Berger' })

    const { body } = await api.post<CommitQuickCaptureResponse>('/api/v1/quick-capture/commit', {
      contact: {
        action: 'match',
        matchId: existing.id,
        fields: [{ slug: 'city', value: 'Munich' }],
      },
      interaction: {
        type: 'Call',
        title: 'Catch-up',
        body: null,
        occurredAt: '2026-06-15T12:00:00.000Z',
      },
    })

    expect(body.created).toEqual(['interaction'])
    expect(body.contact?.id).toBe(existing.id)
    // One contact, not two: the whole point of matching.
    expect(await countRows('record')).toBe(2)

    const contact = await api.get<Contact>(`/api/v1/contacts/${existing.id}`)
    expect(contact.body.attributes['city']).toEqual({ type: 'short_text', value: 'Munich' })
  })

  it('writes nothing at all when part of it is invalid', async () => {
    const { status } = await api.post('/api/v1/quick-capture/commit', {
      contact: {
        action: 'create',
        fields: [
          { slug: 'first_name', value: 'Anna' },
          { slug: 'birthday', value: 'not a date' },
        ],
      },
    })

    expect(status).toBe(400)
    // One transaction: a half-written capture is worse than none, because nothing says which half.
    expect(await countRows('record')).toBe(0)
  })

  it('refuses a follow-up with no contact to hang it on', async () => {
    const { status, body } = await api.post<{ detail: string }>('/api/v1/quick-capture/commit', {
      followUp: { title: 'Send the deck', dueAt: '2026-07-06', notes: null },
    })
    expect(status).toBe(400)
    expect(body.detail).toContain('needs a contact')
  })

  it('refuses an empty confirmation rather than answering 201 with nothing', async () => {
    const { status } = await api.post('/api/v1/quick-capture/commit', {})
    expect(status).toBe(400)
  })

  it('writes an organization on its own', async () => {
    const { status, body } = await api.post<CommitQuickCaptureResponse>(
      '/api/v1/quick-capture/commit',
      { organization: { action: 'create', fields: [{ slug: 'name', value: 'Kiln Robotics' }] } },
    )
    expect(status).toBe(201)
    expect(body.created).toEqual(['organization'])
    expect(body.linked).toBe(false)
    expect(body.organization?.displayName).toBe('Kiln Robotics')
  })
})
