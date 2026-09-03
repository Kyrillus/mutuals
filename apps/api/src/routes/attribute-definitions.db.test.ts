/**
 * Attribute definitions, through the real app (ADR-075).
 *
 * The block that earns its keep is "all twelve types": it creates one attribute of every type in
 * the registry over HTTP, writes a value through each, reads it back and checks the wire shape. If
 * a thirteenth type is added and this file still passes, the registry is not driving everything.
 */
import { ATTRIBUTE_TYPES, type AttributeType, type Contact, type Problem } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { api } from '../test-support/app.ts'
import { aContact, anAttribute, anOrganization } from '../test-support/fixtures.ts'

interface DefinitionList {
  data: {
    id: string
    slug: string
    type: string
    isMulti: boolean
    sortable: boolean
    recordCount: number
    options: { id: string; key: string; label: string; color: string | null; position: number }[]
    group: string | null
  }[]
  meta: { total: number | null }
}

const ATTRIBUTES = '/api/v1/attribute-definitions'

describe('the happy path', () => {
  it('lists the seeded definitions for one object type, in position order', async () => {
    const { status, body } = await api.get<DefinitionList>(`${ATTRIBUTES}?objectType=contact`)
    expect(status).toBe(200)
    expect(body.data.map((definition) => definition.slug)).toEqual([
      'email',
      'phone',
      'job_role',
      'organization',
      'city',
      'country',
      'birthday',
      'areas_of_interest',
      'asks',
      'offers',
      'linkedin_url',
      'website',
      'how_we_met',
      'notes',
    ])
  })

  it('creates one, and it is immediately usable without any DDL', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Check size',
      slug: 'check_size',
      type: 'number',
      config: { unit: 'EUR', decimals: 0 },
      group: 'Investing',
      description: 'Typical first cheque',
    })

    const contact = await aContact({ attributes: { check_size: '250000' } })
    expect(contact.attributes['check_size']).toEqual({
      type: 'number',
      value: '250000',
      unit: 'EUR',
    })

    const listed = await api.get<DefinitionList>(`${ATTRIBUTES}?objectType=contact`)
    const definition = listed.body.data.find((entry) => entry.id === created.id)
    expect(definition?.group).toBe('Investing')
    expect(definition?.recordCount).toBe(1)
  })

  it('renames and regroups without touching the slug', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Cheque',
      slug: 'cheque',
      type: 'number',
    })
    const updated = await api.patch<{ title: string; slug: string; group: string | null }>(
      `${ATTRIBUTES}/${created.id}`,
      { title: 'Cheque size', group: 'Investing', slug: 'renamed' },
    )
    expect(updated.status).toBe(200)
    expect(updated.body.title).toBe('Cheque size')
    // The update schema has no `slug`, so a client that sends one is ignored rather than obeyed.
    expect(updated.body.slug).toBe('cheque')
  })

  it('adds and relabels select options, keeping the stable key', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Stage of relationship',
      slug: 'relationship_stage',
      type: 'single_select',
      options: [
        { key: 'cold', label: 'Cold' },
        { key: 'warm', label: 'Warm' },
      ],
    })

    const contact = await aContact({ attributes: { relationship_stage: 'warm' } })
    expect(contact.attributes['relationship_stage']).toEqual({
      type: 'single_select',
      value: { key: 'warm', label: 'Warm', color: null },
    })

    const listed = await api.get<DefinitionList>(`${ATTRIBUTES}?objectType=contact`)
    const options = listed.body.data.find((entry) => entry.id === created.id)?.options ?? []
    const warm = options.find((option) => option.key === 'warm')

    await api.patch(`${ATTRIBUTES}/${created.id}`, {
      options: [
        { id: warm?.id ?? '', key: 'warm', label: 'Warm and friendly', color: 'amber' },
        { key: 'hot', label: 'Hot' },
      ],
    })

    const reread = await api.get<Contact>(`/api/v1/contacts/${contact.id}`)
    // The value still resolves, under its new label: the key is the identity, so a rename is free.
    expect(reread.body.attributes['relationship_stage']).toEqual({
      type: 'single_select',
      value: { key: 'warm', label: 'Warm and friendly', color: 'amber' },
    })
  })
})

describe('all twelve types', () => {
  it('creates one attribute of every type in the registry', async () => {
    const organization = await anOrganization({ name: 'Northstar Ventures' })

    const created: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}

    for (const type of ATTRIBUTE_TYPES) {
      const slug = `custom_${type}`
      await anAttribute({
        objectType: 'contact',
        title: `Custom ${type}`,
        slug,
        type,
        ...configFor(type),
        ...optionsFor(type),
      })
      created[slug] = inputFor(type, organization.id)
      expected[slug] = expectedFor(type, organization.id)
    }

    const contact = await aContact({ attributes: created })
    for (const type of ATTRIBUTE_TYPES) {
      const slug = `custom_${type}`
      expect(contact.attributes[slug], `${type} did not round-trip`).toEqual(expected[slug])
    }

    // Twelve, and the registry says so — not a literal somebody has to remember to bump.
    expect(Object.keys(contact.attributes)).toHaveLength(ATTRIBUTE_TYPES.length)
  })

  it('marks exactly the sortable types sortable', async () => {
    for (const type of ATTRIBUTE_TYPES) {
      await anAttribute({
        objectType: 'organization',
        title: `Sortable ${type}`,
        slug: `sortable_${type}`,
        type,
        ...configFor(type),
        ...optionsFor(type),
      })
    }
    const { body } = await api.get<DefinitionList>(`${ATTRIBUTES}?objectType=organization`)
    const sortable = body.data
      .filter((definition) => definition.slug.startsWith('sortable_') && definition.sortable)
      .map((definition) => definition.type)
      .sort()
    // §4.2's table: the types whose Sort column is not "—".
    expect(sortable).toEqual(['date', 'email', 'number', 'short_text', 'single_select', 'yes_no'])
  })
})

describe('validation errors', () => {
  it('refuses a duplicate slug on the same object type', async () => {
    await anAttribute({
      objectType: 'contact',
      title: 'Check size',
      slug: 'check_size',
      type: 'number',
    })
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Check size again',
      slug: 'check_size',
      type: 'number',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]).toEqual({
      field: 'slug',
      code: 'duplicate_slug',
      message: '"check_size" is already used by another attribute.',
    })
  })

  it('allows the same slug on a different object type', async () => {
    await anAttribute({ objectType: 'contact', title: 'Size', slug: 'size', type: 'number' })
    await anAttribute({ objectType: 'organization', title: 'Size', slug: 'size', type: 'number' })
  })

  it('refuses a slug that shadows a system field, and suggests one that does not', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Warmth',
      slug: 'warmth',
      type: 'number',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.code).toBe('reserved_slug')
    expect(body.errors?.[0]?.message).toContain('warmth_1')
  })

  it('refuses a JavaScript hazard as a slug', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Proto',
      slug: 'constructor',
      type: 'short_text',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.code).toBe('reserved_slug')
  })

  it('refuses a slug that is not a slug', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Bad',
      slug: 'Check Size',
      type: 'short_text',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('slug')
  })

  it('refuses a type outside the registry', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Colour',
      slug: 'colour',
      type: 'colour_picker',
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('type')
  })

  it('refuses a select with no options (ADR-038)', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Empty select',
      slug: 'empty_select',
      type: 'single_select',
      options: [],
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]).toEqual({
      field: 'options',
      code: 'required',
      message: 'A select field needs at least one option.',
    })
  })

  it('refuses two options sharing a key', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Twins',
      slug: 'twins',
      type: 'single_select',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'Also A' },
      ],
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('options.1.key')
  })

  it('refuses a relation with no target object type', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Introduced by',
      slug: 'introduced_by',
      type: 'relation',
      config: {},
    })
    expect(status).toBe(400)
    expect(body.errors?.some((error) => error.field.startsWith('config'))).toBe(true)
  })

  it('refuses a number config whose bounds are not decimals', async () => {
    const { status, body } = await api.post<Problem>(ATTRIBUTES, {
      objectType: 'contact',
      title: 'Bounded',
      slug: 'bounded',
      type: 'number',
      config: { min: 'a lot' },
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('config.min')
  })

  it('enforces a configured range on the value, not only on the config', async () => {
    await anAttribute({
      objectType: 'contact',
      title: 'Score',
      slug: 'score',
      type: 'number',
      config: { min: '0', max: '10' },
    })
    const { status, body } = await api.post<Problem>('/api/v1/contacts', {
      firstName: 'Anna',
      attributes: { score: '11' },
    })
    expect(status).toBe(400)
    expect(body.errors?.[0]?.field).toBe('attributes.score')
  })

  it('answers 404 for an attribute that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff'
    expect((await api.get(`${ATTRIBUTES}/${missing}/delete-preview`)).status).toBe(404)
    expect((await api.delete(`${ATTRIBUTES}/${missing}`)).status).toBe(404)
  })
})

describe('the destructive path', () => {
  it('states the consequence in numbers before it is done (§5.4)', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Check size',
      slug: 'check_size',
      type: 'number',
    })
    const empty = await api.get<{ recordCount: number; message: string }>(
      `${ATTRIBUTES}/${created.id}/delete-preview`,
    )
    expect(empty.body.message).toBe('This will delete "Check size". No contacts have a value.')

    await aContact({ firstName: 'One', attributes: { check_size: '1' } })
    await aContact({ firstName: 'Two', attributes: { check_size: '2' } })

    const used = await api.get<{ recordCount: number; message: string }>(
      `${ATTRIBUTES}/${created.id}/delete-preview`,
    )
    expect(used.body.recordCount).toBe(2)
    expect(used.body.message).toBe('This will delete "Check size" and its value on 2 contacts.')
  })

  it('deletes the definition and every value of it', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Check size',
      slug: 'check_size',
      type: 'number',
    })
    const contact = await aContact({ attributes: { check_size: '1' } })

    const { status, body } = await api.delete<{ id: string; deleted: boolean }>(
      `${ATTRIBUTES}/${created.id}`,
    )
    expect(status).toBe(200)
    expect(body).toEqual({ id: created.id, deleted: true })

    const after = await api.get<Contact>(`/api/v1/contacts/${contact.id}`)
    expect('check_size' in after.body.attributes).toBe(false)
    const listed = await api.get<DefinitionList>(`${ATTRIBUTES}?objectType=contact`)
    expect(listed.body.data.map((definition) => definition.id)).not.toContain(created.id)
  })

  it('takes the relation links with it', async () => {
    const created = await anAttribute({
      objectType: 'contact',
      title: 'Introduced by',
      slug: 'introduced_by',
      type: 'relation',
      config: { targetObjectType: 'contact', cardinality: 'one', hasLinkMetadata: false },
    })
    const mentor = await aContact({ firstName: 'Mentor' })
    const mentee = await aContact({
      firstName: 'Mentee',
      attributes: { introduced_by: [{ id: mentor.id }] },
    })
    expect(mentee.attributes['introduced_by']).toBeDefined()

    await api.delete(`${ATTRIBUTES}/${created.id}`)
    const after = await api.get<Contact>(`/api/v1/contacts/${mentee.id}`)
    expect('introduced_by' in after.body.attributes).toBe(false)
  })
})

// -- the per-type table this file is driven from ------------------------------------------------

function configFor(type: AttributeType): { config?: Record<string, unknown> } {
  if (type === 'relation') {
    return {
      config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
    }
  }
  if (type === 'number') return { config: { unit: 'EUR' } }
  return {}
}

function optionsFor(type: AttributeType): { options?: { key: string; label: string }[] } {
  return type === 'single_select' || type === 'multi_select'
    ? {
        options: [
          { key: 'one', label: 'One' },
          { key: 'two', label: 'Two' },
        ],
      }
    : {}
}

function inputFor(type: AttributeType, organizationId: string): unknown {
  switch (type) {
    case 'short_text':
      return 'München'
    case 'long_text':
      return 'A **long** note.'
    case 'number':
      return '250000.50'
    case 'date':
      return '1990-03-01'
    case 'yes_no':
      return true
    case 'single_select':
      return 'two'
    case 'multi_select':
      return ['one', 'two']
    case 'tags':
      return ['climate', 'deeptech']
    case 'url':
      return 'northstar.vc'
    case 'email':
      return 'Anna@Example.COM'
    case 'phone':
      return '089 1234567'
    case 'relation':
      return [{ id: organizationId, title: 'Partner', from: '2023-06-01', isPrimary: true }]
  }
}

function expectedFor(type: AttributeType, organizationId: string): unknown {
  switch (type) {
    case 'short_text':
      return { type, value: 'München' }
    case 'long_text':
      return { type, value: 'A **long** note.' }
    case 'number':
      return { type, value: '250000.50', unit: 'EUR' }
    case 'date':
      return { type, value: '1990-03-01' }
    case 'yes_no':
      return { type, value: true }
    case 'single_select':
      return { type, value: { key: 'two', label: 'Two', color: null } }
    case 'multi_select':
      return {
        type,
        value: [
          { key: 'one', label: 'One', color: null },
          { key: 'two', label: 'Two', color: null },
        ],
      }
    case 'tags':
      return { type, value: ['climate', 'deeptech'] }
    case 'url':
      // Canonicalised on the way in: a bare host gains its scheme.
      return { type, value: 'https://northstar.vc' }
    case 'email':
      // Lower-cased, because the identifier table is unique on the lower-cased address.
      return { type, value: 'anna@example.com' }
    case 'phone':
      // E.164, using the profile's phone region — which is what makes duplicate matching work.
      return { type, value: '+49891234567' }
    case 'relation':
      return {
        type,
        value: [
          {
            id: organizationId,
            label: 'Northstar Ventures',
            objectType: 'organization',
            title: 'Partner',
            from: '2023-06-01',
            to: null,
            isPrimary: true,
          },
        ],
      }
  }
}
