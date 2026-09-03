/**
 * The attribute-definition repository.
 *
 * What is worth testing here is the part that is *not* taken from the caller: `value_kind`,
 * `is_multi` and `sortable` are functions of `type` and `config`, derived by `packages/core`'s
 * registry, and the composite foreign key turns a disagreement into a write error rather than a
 * silently wrong column. So every creation test reads the stored row back, not the returned object.
 */
import { describe, expect, it } from 'vitest'
import { attributeIdBySlug, optionIdByKey, testDb } from '../test-support/index.ts'
import {
  addAttributeOption,
  archiveAttributeOption,
  countRecordsUsingAttribute,
  createAttributeDefinition,
  deleteAttributeDefinition,
  getAttributeDefinition,
  getAttributeDefinitionBySlug,
  listAttributeDefinitions,
  reorderAttributeDefinitions,
  reorderAttributeOptions,
  updateAttributeDefinition,
  updateAttributeOption,
} from './attributes.ts'
import { createContact, createOrganization } from '../write/records.ts'
import { addElement, setValue } from '../write/facts.ts'
import { WriteError } from '../write/types.ts'

const MANUAL = { source: 'manual' } as const

async function storedShape(id: string) {
  return testDb()
    .selectFrom('attribute_definition')
    .select(['type', 'value_kind', 'is_multi', 'position', 'config'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

describe('the seeded definitions', () => {
  it('come back in position order, per object type', async () => {
    const contact = await listAttributeDefinitions(testDb(), 'contact')
    const organization = await listAttributeDefinitions(testDb(), 'organization')

    expect(contact.map((definition) => definition.slug)).toEqual([
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
    expect(organization).toHaveLength(8)
    expect(await listAttributeDefinitions(testDb())).toHaveLength(22)
  })

  it('carry their options in option order', async () => {
    const jobRole = await getAttributeDefinitionBySlug(testDb(), 'contact', 'job_role')
    expect(jobRole?.options?.map((option) => option.key)).toEqual([
      'founder',
      'investor',
      'operator',
      'student',
      'community_builder',
      'other',
    ])
  })

  /**
   * Migration 0002 seeds the relation's config in snake_case and without a cardinality, while the
   * type's `configSchema` reads camelCase and has no default for it. Reading the seeded row is the
   * case that used to throw, so it is asserted rather than assumed.
   */
  it('read the relation config the migration wrote', async () => {
    const relation = await getAttributeDefinitionBySlug(testDb(), 'contact', 'organization')
    expect(relation?.config).toMatchObject({
      targetObjectType: 'organization',
      cardinality: 'many',
      hasLinkMetadata: true,
    })
    expect(relation?.isMulti).toBe(true)
  })

  it('are all visible by default', async () => {
    const definitions = await listAttributeDefinitions(testDb(), 'contact')
    expect(definitions.every((definition) => definition.showByDefault)).toBe(true)
  })
})

describe('createAttributeDefinition', () => {
  it('derives value_kind and is_multi from the type, never from the caller', async () => {
    const tags = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Communities',
      slug: 'communities',
      type: 'tags',
    })
    const amount = await createAttributeDefinition(testDb(), {
      objectType: 'organization',
      title: 'Raised',
      slug: 'raised',
      type: 'number',
    })

    expect(await storedShape(tags.id)).toMatchObject({ value_kind: 'text', is_multi: true })
    expect(await storedShape(amount.id)).toMatchObject({ value_kind: 'number', is_multi: false })
    expect(tags.sortable).toBe(false)
    expect(amount.sortable).toBe(true)
  })

  it('creates a select with its options, in the order they were given', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Communities',
      slug: 'communities',
      type: 'multi_select',
      options: [
        { key: 'yc', label: 'Y Combinator' },
        { key: 'ef', label: 'Entrepreneur First' },
      ],
    })

    expect(await storedShape(definition.id)).toMatchObject({ value_kind: 'option', is_multi: true })
    expect(definition.options?.map((option) => [option.key, option.position])).toEqual([
      ['yc', 0],
      ['ef', 1],
    ])
  })

  it('puts a new attribute at the end of its own object type', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'organization',
      title: 'Raised',
      slug: 'raised',
      type: 'number',
    })
    // The organization seed ends at position 7; the contact seed's fourteen do not move it.
    expect((await storedShape(definition.id)).position).toBe(8)
  })

  it('keeps show_by_default out of the config the caller sees', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Internal note',
      slug: 'internal_note',
      type: 'long_text',
      showByDefault: false,
    })

    expect(definition.showByDefault).toBe(false)
    expect(definition.config).toEqual({})
    expect((await storedShape(definition.id)).config).toEqual({ show_by_default: false })
  })

  it('refuses a type that is not in the registry', async () => {
    await expect(
      createAttributeDefinition(testDb(), {
        objectType: 'contact',
        title: 'Colour',
        slug: 'colour',
        type: 'colour' as never,
      }),
    ).rejects.toBeInstanceOf(WriteError)
  })

  it('refuses a duplicate slug on the same object type', async () => {
    await expect(
      createAttributeDefinition(testDb(), {
        objectType: 'contact',
        title: 'City again',
        slug: 'city',
        type: 'short_text',
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ad_slug_uq' })
  })

  it('refuses a slug the CHECK does not accept', async () => {
    await expect(
      createAttributeDefinition(testDb(), {
        objectType: 'contact',
        title: 'Favourite Colour',
        slug: 'Favourite Colour',
        type: 'short_text',
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('updateAttributeDefinition', () => {
  it('renames, regroups and repositions', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const updated = await updateAttributeDefinition(testDb(), city, {
      title: 'Town',
      group: 'Location',
      description: 'Where they are based',
      position: 2,
    })

    expect(updated).toMatchObject({
      title: 'Town',
      group: 'Location',
      description: 'Where they are based',
      position: 2,
      slug: 'city',
    })
  })

  it('merges the config rather than replacing it', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Score',
      slug: 'score',
      type: 'number',
      config: { precision: 2 },
    })

    await updateAttributeDefinition(testDb(), definition.id, { showByDefault: false })
    expect((await storedShape(definition.id)).config).toEqual({
      precision: 2,
      show_by_default: false,
    })

    await updateAttributeDefinition(testDb(), definition.id, { showByDefault: true })
    expect((await storedShape(definition.id)).config).toEqual({ precision: 2 })
  })

  it('returns undefined for an id that is not there', async () => {
    const missing = await updateAttributeDefinition(
      testDb(),
      '00000000-0000-4000-8000-0000000000ff',
      { title: 'Nothing' },
    )
    expect(missing).toBeUndefined()
  })
})

describe('reorderAttributeDefinitions', () => {
  it('rewrites positions to 0..n-1 in one transaction', async () => {
    const definitions = await listAttributeDefinitions(testDb(), 'organization')
    const reversed = [...definitions].reverse().map((definition) => definition.id)

    await reorderAttributeDefinitions(testDb(), reversed)

    const after = await listAttributeDefinitions(testDb(), 'organization')
    expect(after.map((definition) => definition.id)).toEqual(reversed)
    expect(after.map((definition) => definition.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

describe('countRecordsUsingAttribute', () => {
  it('counts distinct records across values and links', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const relation = await attributeIdBySlug('contact', 'organization')
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })

    expect(await countRecordsUsingAttribute(testDb(), city)).toBe(0)

    for (const name of ['Anna', 'Ben']) {
      const id = await createContact(testDb(), { firstName: name })
      await setValue(testDb(), {
        recordId: id,
        attributeId: city,
        value: { kind: 'text', text: 'Berlin' },
        provenance: MANUAL,
      })
      await addElement(testDb(), {
        recordId: id,
        attributeId: relation,
        value: { kind: 'relation', targetRecordId: org },
        provenance: MANUAL,
      })
    }

    expect(await countRecordsUsingAttribute(testDb(), city)).toBe(2)
    expect(await countRecordsUsingAttribute(testDb(), relation)).toBe(2)
  })
})

describe('deleteAttributeDefinition', () => {
  it('takes its facts, its values and its options with it', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Communities',
      slug: 'communities',
      type: 'multi_select',
      options: [{ key: 'yc', label: 'Y Combinator' }],
    })
    const contact = await createContact(testDb(), { firstName: 'Anna' })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: definition.id,
      value: {
        kind: 'option',
        optionId: await optionIdByKey(definition.id, 'yc'),
        optionKey: 'yc',
      },
      provenance: MANUAL,
    })

    expect(await deleteAttributeDefinition(testDb(), definition.id)).toBe(true)

    const facts = await testDb()
      .selectFrom('fact')
      .select('id')
      .where('attribute_id', '=', definition.id)
      .execute()
    const options = await testDb()
      .selectFrom('attribute_option')
      .select('id')
      .where('attribute_id', '=', definition.id)
      .execute()
    expect([...facts, ...options]).toEqual([])
    expect(await getAttributeDefinition(testDb(), definition.id)).toBeUndefined()
  })

  it('reports false for an id that is not there', async () => {
    expect(await deleteAttributeDefinition(testDb(), '00000000-0000-4000-8000-0000000000ff')).toBe(
      false,
    )
  })
})

describe('options', () => {
  it('are added at the end and can be renamed', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    const added = await addAttributeOption(testDb(), jobRole, { key: 'angel', label: 'Angel' })
    expect(added.position).toBe(6)

    expect(await updateAttributeOption(testDb(), added.id, { label: 'Business angel' })).toBe(true)
    const definition = await getAttributeDefinition(testDb(), jobRole)
    expect(definition?.options?.at(-1)?.label).toBe('Business angel')
  })

  /**
   * `ao_pos_uq` is a full UNIQUE constraint rather than a partial unique index precisely so it can
   * be deferred: a drag-reorder passes through states where two options share a position.
   */
  it('are reordered through the deferred unique constraint', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    const definition = await getAttributeDefinition(testDb(), jobRole)
    const reversed = [...(definition?.options ?? [])].reverse().map((option) => option.id)

    await reorderAttributeOptions(testDb(), reversed)

    const after = await getAttributeDefinition(testDb(), jobRole)
    expect(after?.options?.map((option) => option.id)).toEqual(reversed)
  })

  it('are archived rather than deleted once a value points at one', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    const founder = await optionIdByKey(jobRole, 'founder')
    const contact = await createContact(testDb(), { firstName: 'Anna' })
    await setValue(testDb(), {
      recordId: contact,
      attributeId: jobRole,
      value: { kind: 'option', optionId: founder, optionKey: 'founder' },
      provenance: MANUAL,
    })

    // ON DELETE RESTRICT on fact.option_id is what makes "archive, never delete" a rule the
    // database keeps rather than a convention the UI remembers.
    await expect(
      testDb().deleteFrom('attribute_option').where('id', '=', founder).execute(),
    ).rejects.toMatchObject({ code: '23503' })

    expect(await archiveAttributeOption(testDb(), founder, '2026-02-01T00:00:00Z')).toBe(true)
    const definition = await getAttributeDefinition(testDb(), jobRole)
    // Archived options still come back, so history renders their label; the picker filters them.
    expect(definition?.options?.find((option) => option.id === founder)?.archivedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    )
  })

  it('refuse a duplicate key on one attribute', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    await expect(
      addAttributeOption(testDb(), jobRole, { key: 'founder', label: 'Founder again' }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ao_key_uq' })
  })
})
