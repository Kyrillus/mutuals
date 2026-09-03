/**
 * Organizations, through the real app (ADR-075).
 *
 * The same five blocks as contacts. What is worth its own file is the parts that differ: the
 * `people_count` derived column, the rename that has to refresh the search index, and the fact that
 * deleting an organization must not delete the people who worked there.
 */
import type { Organization, Problem } from '@mutuals/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { api, listUrl } from '../test-support/app.ts'
import { aContact, anAttribute, anOrganization } from '../test-support/fixtures.ts'

interface OrganizationList {
  data: Organization[]
  page: { cursor: string | null; hasMore: boolean }
  meta: { total: number | null }
}

const ORGANIZATIONS = '/api/v1/organizations'

describe('the happy path', () => {
  it('creates an organization with attribute values and reads them back', async () => {
    const created = await anOrganization({
      name: 'Northstar Ventures',
      attributes: {
        type: 'vc_fund',
        industry: ['climate', 'deeptech'],
        city: 'Berlin',
        website: 'northstar.vc',
      },
    })

    expect(created.name).toBe('Northstar Ventures')
    expect(created.displayName).toBe('Northstar Ventures')
    expect(created.peopleCount).toBe(0)
    expect(created.attributes['type']).toEqual({
      type: 'single_select',
      value: { key: 'vc_fund', label: 'VC Fund', color: null },
    })
    // The url type canonicalises: a bare host gains its scheme on the way in.
    expect(created.attributes['website']).toEqual({ type: 'url', value: 'https://northstar.vc' })
    expect(created.attributes['industry']).toEqual({
      type: 'tags',
      value: ['climate', 'deeptech'],
    })

    const read = await api.get<Organization>(`${ORGANIZATIONS}/${created.id}`)
    expect(read.body).toEqual(created)
  })

  it('renames without disturbing its attribute values', async () => {
    const created = await anOrganization({ name: 'Old Name', attributes: { city: 'Berlin' } })
    const renamed = await api.patch<Organization>(`${ORGANIZATIONS}/${created.id}`, {
      name: 'New Name',
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body.name).toBe('New Name')
    expect(renamed.body.displayName).toBe('New Name')
    expect(renamed.body.attributes['city']).toEqual({ type: 'short_text', value: 'Berlin' })
  })

  it('lists organizations with the exact row count', async () => {
    await anOrganization({ name: 'A' })
    await anOrganization({ name: 'B' })
    const { status, body } = await api.get<OrganizationList>(ORGANIZATIONS)
    expect(status).toBe(200)
    expect(body.meta.total).toBe(2)
    expect(body.page.hasMore).toBe(false)
  })
})

describe('validation errors', () => {
  it('refuses an organization with no name', async () => {
    const { status, body } = await api.post<Problem>(ORGANIZATIONS, { name: '   ' })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('name')
  })

  it('refuses an unknown select option, naming the attribute', async () => {
    const { status, body } = await api.post<Problem>(ORGANIZATIONS, {
      name: 'Acme',
      attributes: { type: 'not_a_type' },
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('attributes.type')
  })

  it('refuses a contact attribute on an organization', async () => {
    // `birthday` exists, but on contacts. The resolver is per object type, so this is an unknown
    // field here rather than a value silently written into another object's namespace.
    const { status, body } = await api.post<Problem>(ORGANIZATIONS, {
      name: 'Acme',
      attributes: { birthday: '1990-01-01' },
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]).toEqual({
      field: 'attributes.birthday',
      code: 'unknown_field',
      message: 'There is no field called "birthday".',
    })
  })

  it('answers 404 for a contact id on the organizations route', async () => {
    const contact = await aContact()
    expect((await api.get(`${ORGANIZATIONS}/${contact.id}`)).status).toBe(404)
  })
})

describe('a custom attribute on organizations', () => {
  beforeEach(async () => {
    await anAttribute({
      objectType: 'organization',
      title: 'Assets under management',
      slug: 'aum',
      type: 'number',
      config: { unit: 'EUR' },
    })
  })

  it('filters and sorts on it', async () => {
    await anOrganization({ name: 'Small fund', attributes: { aum: '5000000' } })
    const big = await anOrganization({ name: 'Big fund', attributes: { aum: '900000000' } })
    await anOrganization({ name: 'Not a fund' })

    const filtered = await api.get<OrganizationList>(
      listUrl(ORGANIZATIONS, {
        filter: JSON.stringify([{ field: 'aum', op: 'gt', value: '10000000' }]),
        sort: 'aum:desc',
      }),
    )
    expect(filtered.body.data.map((organization) => organization.id)).toEqual([big.id])
    expect(filtered.body.meta.total).toBe(1)
  })

  it('sorts organizations by name in a stable byte order', async () => {
    await anOrganization({ name: 'Zeta' })
    await anOrganization({ name: 'alpha' })
    await anOrganization({ name: 'Beta' })
    const { body } = await api.get<OrganizationList>(listUrl(ORGANIZATIONS, { sort: 'name:asc' }))
    // The sort key is `lower(name) COLLATE "C"`, so it is case-insensitive and immune to a glibc
    // collation change on somebody else's machine.
    expect(body.data.map((organization) => organization.name)).toEqual(['alpha', 'Beta', 'Zeta'])
  })
})

describe('the destructive path', () => {
  it('deletes the organization and the link, and leaves the contact standing', async () => {
    const organization = await anOrganization({ name: 'Northstar Ventures' })
    const contact = await aContact({
      attributes: { organization: [{ id: organization.id, title: 'Partner' }] },
    })

    expect((await api.delete(`${ORGANIZATIONS}/${organization.id}`)).status).toBe(200)
    expect((await api.get(`${ORGANIZATIONS}/${organization.id}`)).status).toBe(404)

    const survivor = await api.get<{ attributes: Record<string, unknown> }>(
      `/api/v1/contacts/${contact.id}`,
    )
    expect(survivor.status).toBe(200)
    expect('organization' in survivor.body.attributes).toBe(false)
  })
})
