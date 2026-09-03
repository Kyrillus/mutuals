/**
 * Contacts, driven through the real Fastify app against a real database (ADR-075).
 *
 * Five blocks, as the ADR asks: the happy path, the validation errors, **the dynamic filter and
 * sort on a custom attribute** — the case §8.1 singles out — pagination, and the destructive path.
 *
 * The custom-attribute block is the one that matters. It creates an attribute over HTTP that no
 * line of this codebase knows the name of, writes values through it, then filters and sorts by it.
 * If any part of the stack had hard-coded a column, it would fail here.
 */
import type { BulkResult, Contact, Problem } from '@mutuals/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { api, listUrl } from '../test-support/app.ts'
import { aContact, anAttribute, anOrganization } from '../test-support/fixtures.ts'

interface ContactList {
  data: Contact[]
  page: { cursor: string | null; hasMore: boolean }
  meta: { total: number | null }
}

const CONTACTS = '/api/v1/contacts'

describe('the happy path', () => {
  it('creates a contact with values on the seeded attributes and reads them back', async () => {
    const created = await aContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: {
        email: 'Anna.Berger@Example.COM',
        city: 'München',
        birthday: '1990-03-01',
        asks: ['seed investor', 'CTO'],
        job_role: 'investor',
      },
    })

    expect(created.displayName).toBe('Anna Berger')
    expect(created.warmth).toBe(0)
    expect(created.provenance.createdVia).toBe('manual')
    // The email type lower-cases on the way in, so the identifier table and the value agree.
    expect(created.attributes['email']).toEqual({ type: 'email', value: 'anna.berger@example.com' })
    expect(created.attributes['city']).toEqual({ type: 'short_text', value: 'München' })
    expect(created.attributes['birthday']).toEqual({ type: 'date', value: '1990-03-01' })
    expect(created.attributes['job_role']).toEqual({
      type: 'single_select',
      value: { key: 'investor', label: 'Investor', color: null },
    })

    const read = await api.get<Contact>(`${CONTACTS}/${created.id}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual(created)
  })

  it('leaves an empty attribute out of the map entirely (ADR-017)', async () => {
    const created = await aContact({ attributes: { city: 'Berlin' } })
    expect(Object.keys(created.attributes)).toEqual(['city'])
    expect('notes' in created.attributes).toBe(false)
  })

  it('clears an attribute when the value is null, and the key disappears', async () => {
    const created = await aContact({ attributes: { city: 'Berlin' } })
    const cleared = await api.patch<Contact>(`${CONTACTS}/${created.id}`, {
      attributes: { city: null },
    })
    expect(cleared.status).toBe(200)
    expect('city' in cleared.body.attributes).toBe(false)
  })

  it('writes a relation with its link metadata and returns it as a chip', async () => {
    const organization = await anOrganization({ name: 'Northstar Ventures' })
    const contact = await aContact({
      attributes: {
        organization: [
          { id: organization.id, title: 'Partner', from: '2023-06-01', isPrimary: true },
        ],
      },
    })

    expect(contact.attributes['organization']).toEqual({
      type: 'relation',
      value: [
        {
          id: organization.id,
          label: 'Northstar Ventures',
          objectType: 'organization',
          title: 'Partner',
          from: '2023-06-01',
          to: null,
          isPrimary: true,
        },
      ],
    })

    const connections = await api.get<{
      organizations: { id: string; title: string | null }[]
      alsoAtSameOrganization: unknown[]
    }>(`${CONTACTS}/${contact.id}/connections`)
    expect(connections.status).toBe(200)
    expect(connections.body.organizations).toEqual([
      expect.objectContaining({ id: organization.id, title: 'Partner', isPrimary: true }),
    ])
  })

  it('lists "also at the same organization" without listing the contact itself', async () => {
    const organization = await anOrganization({ name: 'Stripe' })
    const anna = await aContact({
      firstName: 'Anna',
      attributes: { organization: [{ id: organization.id }] },
    })
    await aContact({ firstName: 'Bruno', attributes: { organization: [{ id: organization.id }] } })

    const connections = await api.get<{
      alsoAtSameOrganization: { id: string; displayName: string; organizationName: string }[]
    }>(`${CONTACTS}/${anna.id}/connections`)
    expect(connections.body.alsoAtSameOrganization).toEqual([
      expect.objectContaining({ displayName: 'Bruno Berger', organizationName: 'Stripe' }),
    ])
    expect(connections.body.alsoAtSameOrganization.map((row) => row.id)).not.toContain(anna.id)
  })

  it('supersedes rather than overwrites: the new value wins and updated_at moves', async () => {
    const created = await aContact({ attributes: { city: 'Berlin' } })
    const updated = await api.patch<Contact>(`${CONTACTS}/${created.id}`, {
      attributes: { city: 'Hamburg' },
    })
    expect(updated.body.attributes['city']).toEqual({ type: 'short_text', value: 'Hamburg' })
    expect(new Date(updated.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    )
  })
})

describe('validation errors', () => {
  it('refuses a contact with no name at all, naming the field', async () => {
    const { status, body } = await api.post<Problem>(CONTACTS, {})
    expect(status).toBe(400)
    expect(body.errors).toEqual([
      { field: 'firstName', code: 'required', message: 'Give the contact a first or a last name.' },
    ])
  })

  it('reports every bad attribute at once, each with its own path', async () => {
    const contact = await aContact()
    const { status, body } = await api.patch<Problem>(`${CONTACTS}/${contact.id}`, {
      attributes: { email: 'not-an-email', birthday: '31/02/2026', nope: 'x' },
    })
    expect(status).toBe(400)
    expect(body.errors?.map((error) => error.field).sort()).toEqual([
      'attributes.birthday',
      'attributes.email',
      'attributes.nope',
    ])
    expect(body.errors?.find((error) => error.field === 'attributes.nope')?.code).toBe(
      'unknown_field',
    )
  })

  it('answers problem+json, not a Fastify error body', async () => {
    const app = await api.get<Problem>(`${CONTACTS}/not-a-uuid`)
    expect(app.status).toBe(400)
    expect(app.contentType).toContain('application/problem+json')
    expect(app.body.type).toContain('ERRORS.md#')
    expect(app.body.errors?.[0]?.field).toBe('id')
  })

  it('refuses a relation that points at the wrong object type', async () => {
    const other = await aContact({ firstName: 'Bruno' })
    const { status, body } = await api.post<Problem>(CONTACTS, {
      firstName: 'Anna',
      attributes: { organization: [{ id: other.id }] },
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('attributes.organization')
    expect(body.errors?.[0]?.message).toContain('is a contact')
  })

  it('answers 404 for an organization id on the contacts route', async () => {
    const organization = await anOrganization()
    const { status, body } = await api.get<Problem>(`${CONTACTS}/${organization.id}`)
    expect(status).toBe(404)
    expect(body.detail).toContain('There is no contact')
  })

  it('refuses a sort on a field that has no sort semantics', async () => {
    const { status, body } = await api.get<Problem>(listUrl(CONTACTS, { sort: 'notes:asc' }))
    expect(status).toBe(400)
    expect(body.errors?.[0]?.code).toBe('not_sortable')
  })
})

describe('a custom attribute, created at runtime', () => {
  let checkSize: string

  beforeEach(async () => {
    const attribute = await anAttribute({
      objectType: 'contact',
      title: 'Check size',
      slug: 'check_size',
      type: 'number',
      config: { unit: 'EUR' },
      group: 'Investing',
    })
    checkSize = attribute.id
  })

  it('appears in the definition list with a usage count', async () => {
    await aContact({ attributes: { check_size: '250000.50' } })
    const { body } = await api.get<{ data: { id: string; recordCount: number }[] }>(
      '/api/v1/attribute-definitions?objectType=contact',
    )
    expect(body.data.find((definition) => definition.id === checkSize)?.recordCount).toBe(1)
  })

  it('round-trips an exact decimal, digits and all (ADR-039)', async () => {
    const contact = await aContact({ attributes: { check_size: '250000.50' } })
    expect(contact.attributes['check_size']).toEqual({
      type: 'number',
      value: '250000.50',
      unit: 'EUR',
    })
  })

  it('filters on it', async () => {
    await aContact({ firstName: 'Small', attributes: { check_size: '50000' } })
    const big = await aContact({ firstName: 'Big', attributes: { check_size: '2000000' } })
    await aContact({ firstName: 'Nothing' })

    const { status, body } = await api.get<ContactList>(
      listUrl(CONTACTS, {
        filter: JSON.stringify([{ field: 'check_size', op: 'gt', value: '100000' }]),
      }),
    )
    expect(status).toBe(200)
    expect(body.meta.total).toBe(1)
    expect(body.data.map((contact) => contact.id)).toEqual([big.id])
  })

  it('sorts on it, numerically and not alphabetically', async () => {
    await aContact({ firstName: 'Nine', attributes: { check_size: '9' } })
    await aContact({ firstName: 'Ten', attributes: { check_size: '10' } })
    await aContact({ firstName: 'Hundred', attributes: { check_size: '100' } })

    const ascending = await api.get<ContactList>(
      listUrl(CONTACTS, { sort: 'check_size:asc', columns: 'display_name,check_size' }),
    )
    // '9' sorts before '10' only because the key is a real `numeric` column, not a string.
    expect(ascending.body.data.map((contact) => contact.firstName)).toEqual([
      'Nine',
      'Ten',
      'Hundred',
    ])

    const descending = await api.get<ContactList>(listUrl(CONTACTS, { sort: 'check_size:desc' }))
    expect(descending.body.data.map((contact) => contact.firstName)).toEqual([
      'Hundred',
      'Ten',
      'Nine',
    ])
  })

  it('sorts empty values last in both directions', async () => {
    await aContact({ firstName: 'Valued', attributes: { check_size: '10' } })
    await aContact({ firstName: 'Empty' })
    for (const direction of ['asc', 'desc'] as const) {
      const { body } = await api.get<ContactList>(
        listUrl(CONTACTS, { sort: `check_size:${direction}` }),
      )
      expect(body.data.map((contact) => contact.firstName)).toEqual(['Valued', 'Empty'])
    }
  })

  it('filters on a tags attribute with contains_any_of, folded by SQL', async () => {
    const anna = await aContact({ firstName: 'Anna', attributes: { asks: ['Seed Investor'] } })
    await aContact({ firstName: 'Bruno', attributes: { asks: ['CTO'] } })

    const { body } = await api.get<ContactList>(
      listUrl(CONTACTS, {
        // The stored tag is "Seed Investor"; the needle is lower case. Normalisation is SQL's job
        // and only SQL's (ADR-019), so this matches.
        filter: JSON.stringify([
          { field: 'asks', op: 'contains_any_of', values: ['seed investor'] },
        ]),
      }),
    )
    expect(body.data.map((contact) => contact.id)).toEqual([anna.id])
  })

  it('combines a chip on a custom attribute with one on a derived column', async () => {
    await aContact({ firstName: 'Cold', attributes: { check_size: '10' } })
    const { body } = await api.get<ContactList>(
      listUrl(CONTACTS, {
        filter: JSON.stringify([
          { field: 'check_size', op: 'gt', value: '1' },
          { field: 'warmth', op: 'lt', value: '50' },
        ]),
      }),
    )
    expect(body.data.map((contact) => contact.firstName)).toEqual(['Cold'])
  })

  it('is gone, with its values, once the attribute is deleted', async () => {
    const contact = await aContact({ attributes: { check_size: '10' } })
    const preview = await api.get<{ recordCount: number; message: string }>(
      `/api/v1/attribute-definitions/${checkSize}/delete-preview`,
    )
    expect(preview.body.recordCount).toBe(1)
    expect(preview.body.message).toBe('This will delete "Check size" and its value on 1 contact.')

    expect((await api.delete(`/api/v1/attribute-definitions/${checkSize}`)).status).toBe(200)

    const after = await api.get<Contact>(`${CONTACTS}/${contact.id}`)
    expect(after.status).toBe(200)
    expect('check_size' in after.body.attributes).toBe(false)
  })
})

describe('pagination', () => {
  it('walks the default ordering with an opaque cursor and no gaps', async () => {
    for (let index = 0; index < 7; index += 1) {
      await aContact({ firstName: `Person${String(index)}` })
    }

    const seen: string[] = []
    let url = listUrl(CONTACTS, { limit: '3' })
    for (let page = 0; page < 5; page += 1) {
      const { body } = await api.get<ContactList>(url)
      expect(body.meta.total).toBe(7)
      seen.push(...body.data.map((contact) => contact.id))
      if (!body.page.hasMore) break
      expect(body.page.cursor).not.toBeNull()
      url = listUrl(CONTACTS, { limit: '3', cursor: body.page.cursor ?? '' })
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('pages a sorted list too, and the count is the same on every page', async () => {
    for (const city of ['Aachen', 'Berlin', 'Cologne', 'Dresden']) {
      await aContact({ firstName: city, attributes: { city } })
    }
    const first = await api.get<ContactList>(listUrl(CONTACTS, { sort: 'city:asc', limit: '2' }))
    expect(first.body.data.map((contact) => contact.firstName)).toEqual(['Aachen', 'Berlin'])
    expect(first.body.page.hasMore).toBe(true)

    const second = await api.get<ContactList>(
      listUrl(CONTACTS, { sort: 'city:asc', limit: '2', cursor: first.body.page.cursor ?? '' }),
    )
    expect(second.body.data.map((contact) => contact.firstName)).toEqual(['Cologne', 'Dresden'])
    expect(second.body.page.hasMore).toBe(false)
    expect(second.body.meta.total).toBe(4)
  })

  it('refuses a cursor from a different sort rather than returning the wrong page', async () => {
    for (let index = 0; index < 4; index += 1) {
      await aContact({
        firstName: `P${String(index)}`,
        attributes: { city: `City${String(index)}` },
      })
    }
    const sorted = await api.get<ContactList>(listUrl(CONTACTS, { sort: 'city:asc', limit: '2' }))
    const { status, body } = await api.get<Problem>(
      listUrl(CONTACTS, { limit: '2', cursor: sorted.body.page.cursor ?? '' }),
    )
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('cursor')
  })

  it('rejects a limit outside the documented range', async () => {
    const { status, body } = await api.get<Problem>(listUrl(CONTACTS, { limit: '5000' }))
    expect(status).toBe(400)
    expect(body.errors?.[0]?.code).toBe('out_of_range')
  })
})

describe('the destructive path', () => {
  it('deletes a contact and everything that hangs off it', async () => {
    const contact = await aContact()
    const { status, body } = await api.delete<{ id: string; deleted: boolean }>(
      `${CONTACTS}/${contact.id}`,
    )
    expect(status).toBe(200)
    expect(body).toEqual({ id: contact.id, deleted: true })
    expect((await api.get(`${CONTACTS}/${contact.id}`)).status).toBe(404)
  })

  it('answers 404 the second time, rather than pretending', async () => {
    const contact = await aContact()
    await api.delete(`${CONTACTS}/${contact.id}`)
    expect((await api.delete(`${CONTACTS}/${contact.id}`)).status).toBe(404)
  })

  it('reports a bulk delete per item, and one bad id does not roll back the rest', async () => {
    const first = await aContact({ firstName: 'One' })
    const second = await aContact({ firstName: 'Two' })
    const missing = '00000000-0000-4000-8000-0000000000ff'

    const { status, body } = await api.post<BulkResult>(`${CONTACTS}/bulk-delete`, {
      ids: [first.id, missing, second.id],
    })
    expect(status).toBe(200)
    expect(body.meta).toEqual({ attempted: 3, succeeded: 2, failed: 1 })
    expect(body.data.succeeded).toEqual([first.id, second.id])
    expect(body.data.failed[0]?.code).toBe('not_found')
    expect((await api.get(`${CONTACTS}/${first.id}`)).status).toBe(404)
  })

  it('sets one attribute across many contacts in a single operation', async () => {
    const first = await aContact({ firstName: 'One' })
    const second = await aContact({ firstName: 'Two' })
    const { body } = await api.post<BulkResult>(`${CONTACTS}/bulk-attribute`, {
      ids: [first.id, second.id],
      slug: 'city',
      value: 'Munich',
    })
    expect(body.meta.succeeded).toBe(2)
    const read = await api.get<Contact>(`${CONTACTS}/${first.id}`)
    expect(read.body.attributes['city']).toEqual({ type: 'short_text', value: 'Munich' })
  })
})
