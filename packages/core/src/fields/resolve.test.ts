import { describe, expect, it } from 'vitest'

import { completeDefinition, type AttributeDefinition } from '../attributes/definition.ts'
import {
  MIN_SUBSTRING_LENGTH,
  describeAttribute,
  fieldValueKind,
  makeFieldResolver,
} from './resolve.ts'
import { allSystemSlugs, systemFields } from './system.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function attribute(
  overrides: Partial<Parameters<typeof completeDefinition>[0]> = {},
): AttributeDefinition {
  return completeDefinition(
    {
      id: 'attr-city',
      objectType: 'contact',
      title: 'City',
      slug: 'city',
      type: 'short_text',
      config: {},
      isSystem: false,
      position: 10,
      showByDefault: true,
      ...overrides,
    },
    TIMESTAMPS,
  )
}

describe('makeFieldResolver', () => {
  it('answers for a system column, a metric column and an attribute through one interface', () => {
    const resolver = makeFieldResolver('contact', [attribute()])

    expect(resolver.get('display_name')?.source.kind).toBe('column')
    expect(resolver.get('warmth')?.source.kind).toBe('metric')
    expect(resolver.get('city')?.source.kind).toBe('attribute')
    expect(resolver.get('nonesuch')).toBeUndefined()
    expect(resolver.objectType).toBe('contact')
  })

  it('lists system fields first, then attributes by position and then slug', () => {
    const resolver = makeFieldResolver('contact', [
      attribute({ id: 'b', slug: 'zeta', title: 'Zeta', position: 2 }),
      attribute({ id: 'a', slug: 'alpha', title: 'Alpha', position: 2 }),
      attribute({ id: 'c', slug: 'first', title: 'First', position: 1 }),
    ])
    const slugs = resolver.list().map((field) => field.slug)
    expect(slugs.slice(0, systemFields('contact').length)).toEqual(allSystemSlugs('contact'))
    expect(slugs.slice(systemFields('contact').length)).toEqual(['first', 'alpha', 'zeta'])
  })

  it('gives system fields a position ahead of every attribute', () => {
    const resolver = makeFieldResolver('contact', [attribute({ position: 0 })])
    for (const field of resolver.list()) {
      if (field.source.kind !== 'attribute') expect(field.position).toBeLessThan(0)
    }
  })

  it('refuses a slug that shadows a system field', () => {
    expect(() => makeFieldResolver('contact', [attribute({ slug: 'warmth' })])).toThrow(/collides/)
  })

  it('refuses an attribute belonging to another object type', () => {
    expect(() => makeFieldResolver('contact', [attribute({ objectType: 'organization' })])).toThrow(
      /belongs to organization/,
    )
  })

  it('returns a frozen list, so a caller cannot reorder the shared descriptor array', () => {
    expect(Object.isFrozen(makeFieldResolver('contact', []).list())).toBe(true)
  })
})

describe('field descriptors', () => {
  it('carries a substring hint only where `contains` is offered', () => {
    const resolver = makeFieldResolver('contact', [
      attribute(),
      attribute({ id: 'attr-birthday', slug: 'birthday', title: 'Birthday', type: 'date' }),
    ])
    expect(resolver.get('city')?.minSubstringLength).toBe(MIN_SUBSTRING_LENGTH)
    expect(resolver.get('birthday')?.minSubstringLength).toBeUndefined()
    expect(resolver.get('warmth')?.minSubstringLength).toBeUndefined()
  })

  it('marks derived and generated columns read-only', () => {
    const resolver = makeFieldResolver('contact', [attribute()])
    expect(resolver.get('warmth')?.readOnly).toBe(true)
    expect(resolver.get('display_name')?.readOnly).toBe(true)
    expect(resolver.get('first_name')?.readOnly).toBe(false)
    expect(resolver.get('city')?.readOnly).toBe(false)
  })

  it('reports the value kind whatever the source is', () => {
    const resolver = makeFieldResolver('contact', [
      attribute({ id: 'attr-asks', slug: 'asks', title: 'Asks', type: 'tags' }),
    ])
    expect(fieldValueKind(resolver.get('asks')!)).toBe('text')
    expect(fieldValueKind(resolver.get('warmth')!)).toBe('number')
    expect(fieldValueKind(resolver.get('display_name')!)).toBe('text')
  })

  it('takes an attribute label from its title and its group from its group', () => {
    const descriptor = describeAttribute(
      attribute({ title: 'Home city', group: 'Location', type: 'tags' }),
    )
    expect(descriptor.label).toBe('Home city')
    expect(descriptor.group).toBe('Location')
    expect(descriptor.isMulti).toBe(true)
    expect(descriptor.sortable).toBe(false)
    expect(describeAttribute(attribute()).group).toBeUndefined()
  })

  it('marks a derived pseudo-attribute read-only like a derived column', () => {
    expect(describeAttribute(attribute({ isDerived: true })).readOnly).toBe(true)
  })

  it('resolves organization and interaction fields too', () => {
    expect(makeFieldResolver('organization', []).get('people_count')?.source.kind).toBe('metric')
    expect(makeFieldResolver('interaction', []).get('occurred_at')?.source.kind).toBe('column')
  })
})
