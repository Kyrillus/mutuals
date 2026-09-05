/**
 * §6.9 through the API: the preview a person reads, and the merge they confirm.
 *
 * The write path itself is tested hard in `packages/db/src/write/merge.db.test.ts` — what moves,
 * what survives, and the three shapes the database would otherwise refuse. What is tested here is
 * the part a person actually meets: whether the side-by-side tells the truth about which fields are
 * in conflict, and whether the counts in the confirmation match what the merge then does.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '@mutuals/db/test-support'

import { api } from '../test-support/app.ts'

interface Preview {
  survivor: { id: string; label: string }
  loser: { id: string; label: string }
  fields: {
    slug: string
    label: string
    survivor: string | null
    loser: string | null
    conflicting: boolean
    isMulti: boolean
    attributeId: string | null
  }[]
  moves: { interactions: number; followUps: number; incomingLinks: number }
  conflictCount: number
}

/** The wire shape of an attribute value: the type travels with it (ADR-030). */
interface AttributeValue {
  type: string
  value: unknown
}

interface MergeResult {
  survivorId: string
  followUpsMoved: number
  interactionsMoved: number
  conflictsResolved: number
}

let anna: string
let duplicate: string

async function createContact(body: Record<string, unknown>): Promise<string> {
  const response = await api.post<{ id: string }>('/api/v1/contacts', body)
  expect(response.status).toBe(201)
  return response.body.id
}

function fieldOf(preview: Preview, slug: string) {
  return preview.fields.find((field) => field.slug === slug)
}

beforeEach(async () => {
  anna = await createContact({
    firstName: 'Anna',
    lastName: 'Berger',
    attributes: { email: 'anna@northstar.example', city: 'Munich' },
  })
  duplicate = await createContact({
    firstName: 'Anna',
    lastName: 'Berger',
    attributes: { city: 'Berlin', phone: '+49 151 23456789' },
  })
})

describe('the side-by-side', () => {
  it('shows both records and marks only the fields that actually conflict', async () => {
    const response = await api.get<Preview>(
      `/api/v1/contacts/${anna}/merge-preview?loserId=${duplicate}`,
    )
    expect(response.status).toBe(200)
    const preview = response.body

    expect(preview.survivor.label).toBe('Anna Berger')
    expect(preview.loser.label).toBe('Anna Berger')

    // Both have a city, and they differ — a real choice.
    expect(fieldOf(preview, 'city')).toMatchObject({
      survivor: 'Munich',
      loser: 'Berlin',
      conflicting: true,
    })

    // Only one has an email, and only one has a phone. Neither is a choice: the merge takes both,
    // and a radio would ask the user to pick between a value and nothing.
    expect(fieldOf(preview, 'email')).toMatchObject({ loser: null, conflicting: false })
    expect(fieldOf(preview, 'phone')).toMatchObject({ survivor: null, conflicting: false })

    expect(preview.conflictCount).toBe(1)
  })

  it('leaves out fields neither record has', async () => {
    const response = await api.get<Preview>(
      `/api/v1/contacts/${anna}/merge-preview?loserId=${duplicate}`,
    )
    expect(fieldOf(response.body, 'how_we_met')).toBeUndefined()
    expect(fieldOf(response.body, 'birthday')).toBeUndefined()
  })

  /** Derived and read-only columns are not things a person chooses between. */
  it('offers no row for warmth or the timestamps', async () => {
    const response = await api.get<Preview>(
      `/api/v1/contacts/${anna}/merge-preview?loserId=${duplicate}`,
    )
    const slugs = response.body.fields.map((field) => field.slug)
    for (const slug of ['warmth', 'created_at', 'updated_at', 'last_interaction_at']) {
      expect(slugs, slug).not.toContain(slug)
    }
  })

  /** A set is merged as a union, so it is shown but never offered as a choice. */
  it('marks a multi-valued field as multi and not as a conflict', async () => {
    const withTags = await createContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { asks: ['intros', 'hiring'] },
    })
    const other = await createContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { asks: ['seed capital'] },
    })

    const response = await api.get<Preview>(
      `/api/v1/contacts/${withTags}/merge-preview?loserId=${other}`,
    )
    expect(fieldOf(response.body, 'asks')).toMatchObject({ isMulti: true, conflicting: false })
  })

  it('counts what will move, so the confirmation can say it', async () => {
    await api.post(`/api/v1/interactions`, {
      type: 'Call',
      occurredAt: '2026-02-05T09:00:00.000Z',
      title: 'A call with the duplicate',
      contactIds: [duplicate],
    })
    await api.post(`/api/v1/follow-ups`, {
      contactId: duplicate,
      title: 'Send the deck',
      dueAt: '2026-07-01',
    })

    const response = await api.get<Preview>(
      `/api/v1/contacts/${anna}/merge-preview?loserId=${duplicate}`,
    )
    expect(response.body.moves).toMatchObject({ interactions: 1, followUps: 1 })
  })

  it('refuses to preview a record against itself', async () => {
    const response = await api.get(`/api/v1/contacts/${anna}/merge-preview?loserId=${anna}`)
    expect(response.status).toBe(409)
  })

  it('answers 404 for a record that is not there or is the wrong kind', async () => {
    const organization = await api.post<{ id: string }>('/api/v1/organizations', {
      name: 'Northstar Ventures',
    })
    expect(
      (await api.get(`/api/v1/contacts/${anna}/merge-preview?loserId=${organization.body.id}`))
        .status,
    ).toBe(404)
  })
})

describe('the merge', () => {
  it('keeps the survivor’s value by default and reports what it did', async () => {
    const response = await api.post<MergeResult>(`/api/v1/contacts/${anna}/merge`, {
      loserId: duplicate,
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ survivorId: anna, conflictsResolved: 1 })

    const after = await api.get<{ attributes: Record<string, AttributeValue> }>(
      `/api/v1/contacts/${anna}`,
    )
    expect(after.body.attributes['city']?.value).toBe('Munich')
    // And it took what only the other one had.
    expect(after.body.attributes['phone']?.value).toBeTruthy()

    expect((await api.get(`/api/v1/contacts/${duplicate}`)).status).toBe(404)
  })

  it('takes the other side’s value where the user chose it', async () => {
    const preview = await api.get<Preview>(
      `/api/v1/contacts/${anna}/merge-preview?loserId=${duplicate}`,
    )
    const city = fieldOf(preview.body, 'city')?.attributeId as string

    await api.post(`/api/v1/contacts/${anna}/merge`, {
      loserId: duplicate,
      choices: { [city]: 'loser' },
    })

    const after = await api.get<{ attributes: Record<string, AttributeValue> }>(
      `/api/v1/contacts/${anna}`,
    )
    expect(after.body.attributes['city']?.value).toBe('Berlin')
  })

  it('moves the follow-ups and the interactions §6.9 promises', async () => {
    await api.post('/api/v1/interactions', {
      type: 'Call',
      occurredAt: '2026-02-05T09:00:00.000Z',
      title: 'A call with the duplicate',
      contactIds: [duplicate],
    })
    await api.post('/api/v1/follow-ups', {
      contactId: duplicate,
      title: 'Send the deck',
      dueAt: '2026-07-01',
    })

    const response = await api.post<MergeResult>(`/api/v1/contacts/${anna}/merge`, {
      loserId: duplicate,
    })
    expect(response.body).toMatchObject({ followUpsMoved: 1, interactionsMoved: 1 })

    const followUps = await api.get<{ data: { title: string }[] }>(
      `/api/v1/follow-ups?contactId=${anna}`,
    )
    expect(followUps.body.data.map((row) => row.title)).toContain('Send the deck')
  })

  it('refuses to merge a record into itself', async () => {
    const response = await api.post(`/api/v1/contacts/${anna}/merge`, { loserId: anna })
    expect(response.status).toBe(409)
  })

  /**
   * §6.9 calls this "lower priority; can be Stage 6". It ships now because Session A created the
   * need: the importer matches company names exactly and never fuzzily, so two spellings of one
   * company are two records by design and this is the remedy.
   */
  it('merges two organizations and repoints the contacts of the absorbed one', async () => {
    const northstar = await api.post<{ id: string }>('/api/v1/organizations', {
      name: 'Northstar Ventures',
    })
    const misspelled = await api.post<{ id: string }>('/api/v1/organizations', {
      name: 'Northstar Ventures GmbH',
    })

    await api.patch(`/api/v1/contacts/${anna}`, {
      attributes: { organization: [{ id: misspelled.body.id }] },
    })

    const response = await api.post<MergeResult>(
      `/api/v1/organizations/${northstar.body.id}/merge`,
      { loserId: misspelled.body.id },
    )
    expect(response.status).toBe(200)

    const links = await testDb()
      .selectFrom('record_link')
      .select('to_record_id')
      .where('from_record_id', '=', anna)
      .execute()
    expect(links.map((row) => row.to_record_id)).toEqual([northstar.body.id])
    expect((await api.get(`/api/v1/organizations/${misspelled.body.id}`)).status).toBe(404)
  })
})
