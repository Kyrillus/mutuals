/**
 * §4.8's global search, over a real database.
 *
 * The assertion that matters is the **ordering**, because it is the one thing a palette gets wrong
 * in a way people notice: typing a name and getting a meeting note first. An identifier is an exact
 * claim about who someone is, a name is an approximate one, and a body mentioning the word is not a
 * claim at all — so the three probes rank by kind before they rank by score.
 */
import { describe, expect, it } from 'vitest'
import type { Problem } from '@mutuals/core'

import { api, listUrl } from '../test-support/app.ts'
import { aContact, anInteraction, anOrganization } from '../test-support/fixtures.ts'

interface SearchResponse {
  data: {
    record: { id: string; displayName: string; objectType: string }
    via: 'label' | 'identifier' | 'text'
    snippet: string | null
  }[]
}

function search(q: string, limit?: number): Promise<{ status: number; body: SearchResponse }> {
  return api.get<SearchResponse>(
    listUrl('/api/v1/search', { q, ...(limit === undefined ? {} : { limit: String(limit) }) }),
  )
}

describe('GET /search', () => {
  it('finds a contact by a substring of their name', async () => {
    await aContact({ firstName: 'Anna', lastName: 'Berger' })
    await aContact({ firstName: 'Ben', lastName: 'Roth' })

    const { status, body } = await search('erge')
    expect(status).toBe(200)
    expect(body.data.map((hit) => hit.record.displayName)).toEqual(['Anna Berger'])
    expect(body.data[0]?.via).toBe('label')
    expect(body.data[0]?.snippet).toBeNull()
  })

  it('finds an organization by name, and says which type it is', async () => {
    await anOrganization({ name: 'Northstar Ventures' })
    const { body } = await search('northstar')
    expect(body.data[0]?.record.objectType).toBe('organization')
  })

  it('finds a contact by a substring of their email, and shows the address that matched', async () => {
    await aContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { email: 'a.b@northstar.vc' },
    })

    const { body } = await search('northstar.vc')
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.via).toBe('identifier')
    expect(body.data[0]?.snippet).toBe('a.b@northstar.vc')
  })

  it('finds an interaction by its title', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    await anInteraction({ title: 'Coffee about the fundraise', contactIds: [contact.id] })

    const { body } = await search('fundraise')
    const hit = body.data.find((one) => one.record.objectType === 'interaction')
    expect(hit?.record.displayName).toContain('Coffee about the fundraise')
  })

  /**
   * The ordering, asserted rather than assumed. All three records match "hallmark": one by email,
   * one by name, one only in the body of a note. A single merged score would let the note win.
   */
  it('ranks an identifier above a name above a body', async () => {
    const byEmail = await aContact({
      firstName: 'Ida',
      lastName: 'Nord',
      attributes: { email: 'ida@hallmark.example' },
    })
    const byName = await aContact({ firstName: 'Hallmark', lastName: 'Kaufmann' })
    const byBody = await aContact({ firstName: 'Ulf', lastName: 'Sorensen' })
    await anInteraction({
      title: 'Workshop',
      body: 'We talked at length about the hallmark of a good introduction.',
      contactIds: [byBody.id],
    })

    const { body } = await search('hallmark')
    const order = body.data.map((hit) => hit.via)
    expect(order.indexOf('identifier')).toBe(0)
    expect(order.indexOf('label')).toBeLessThan(order.indexOf('text'))
    expect(body.data[0]?.record.id).toBe(byEmail.id)
    expect(body.data[1]?.record.id).toBe(byName.id)
  })

  it('returns a record once, under its strongest evidence', async () => {
    await aContact({
      firstName: 'Northstar',
      lastName: 'Tester',
      attributes: { email: 'hi@northstar.example' },
    })
    const { body } = await search('northstar')
    // The same contact matches by name *and* by email; the palette must not list them twice.
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.via).toBe('identifier')
  })

  it('carries a readable fragment for a full-text hit', async () => {
    const contact = await aContact({ firstName: 'Anna', lastName: 'Berger' })
    await anInteraction({
      title: 'Workshop',
      body: 'A long note that mentions photovoltaics somewhere in the middle of the sentence.',
      contactIds: [contact.id],
    })

    const { body } = await search('photovoltaics')
    const hit = body.data.find((one) => one.via === 'text')
    expect(hit?.snippet).toContain('photovoltaics')
  })

  /**
   * `gin_trgm_ops` cannot extract a trigram from two characters. The palette sends every keystroke,
   * so the first two are a word being typed and not a mistake to correct with a 400.
   */
  it('answers empty under three characters rather than scanning the workspace', async () => {
    await aContact({ firstName: 'Anna', lastName: 'Berger' })
    expect((await search('an')).body.data).toEqual([])
    expect((await search('ann')).body.data.length).toBeGreaterThan(0)
  })

  it('refuses an empty q, which is a client bug rather than a word being typed', async () => {
    const { status, body } = await api.get<Problem>('/api/v1/search?q=')
    expect(status).toBe(400)
    expect(body.type).toContain('validation_failed')
  })

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await aContact({ firstName: 'Testperson', lastName: `Number${String(i)}` })
    }
    expect((await search('testperson', 2)).body.data).toHaveLength(2)
  })

  /** `%` and `_` are wildcards in LIKE and must not be, because the needle is what a person typed. */
  it('treats a percent sign as a character, not as a wildcard', async () => {
    await aContact({ firstName: 'Anna', lastName: 'Berger' })
    expect((await search('%er%')).body.data).toEqual([])

    await aContact({ firstName: '100%', lastName: 'Certain' })
    expect((await search('100%')).body.data.map((hit) => hit.record.displayName)).toEqual([
      '100% Certain',
    ])
  })
})
