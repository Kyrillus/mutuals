import { describe, expect, it } from 'vitest'

import {
  completeDefinition,
  definitionOperators,
  definitionOptions,
  type AttributeDefinitionDraft,
} from './definition.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function draft(overrides: Partial<AttributeDefinitionDraft> = {}): AttributeDefinitionDraft {
  return {
    id: 'attr-1',
    objectType: 'contact',
    title: 'City',
    slug: 'city',
    type: 'short_text',
    config: {},
    isSystem: false,
    position: 3,
    showByDefault: true,
    ...overrides,
  }
}

describe('completeDefinition', () => {
  it('derives cardinality and sortability from the type rather than trusting the caller', () => {
    const single = completeDefinition(draft(), TIMESTAMPS)
    expect(single.isMulti).toBe(false)
    expect(single.sortable).toBe(true)

    const multi = completeDefinition(draft({ type: 'tags', slug: 'asks' }), TIMESTAMPS)
    expect(multi.isMulti).toBe(true)
    expect(multi.sortable).toBe(false)
  })

  it('reads relation cardinality out of the config', () => {
    const many = completeDefinition(
      draft({
        type: 'relation',
        slug: 'organization',
        config: { targetObjectType: 'organization', cardinality: 'many' },
      }),
      TIMESTAMPS,
    )
    expect(many.isMulti).toBe(true)

    const one = completeDefinition(
      draft({
        type: 'relation',
        slug: 'introduced_by',
        config: { targetObjectType: 'contact', cardinality: 'one' },
      }),
      TIMESTAMPS,
    )
    expect(one.isMulti).toBe(false)
  })

  it('defaults isDerived to false and fills timestamps only when they are missing', () => {
    expect(completeDefinition(draft(), TIMESTAMPS).isDerived).toBe(false)
    expect(completeDefinition(draft(), TIMESTAMPS).createdAt).toBe(TIMESTAMPS.createdAt)
    const kept = completeDefinition(
      draft({
        isDerived: true,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
      }),
      TIMESTAMPS,
    )
    expect(kept.isDerived).toBe(true)
    expect(kept.createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect(kept.updatedAt).toBe('2020-01-02T00:00:00.000Z')
  })
})

describe('reading a definition', () => {
  it('takes its operators from the registry, not from the row', () => {
    const definition = completeDefinition(draft({ type: 'email', slug: 'email' }), TIMESTAMPS)
    expect(definitionOperators(definition)).toEqual(['contains', 'is_empty', 'is_not_empty'])
  })

  it('reports an empty option list for a type that has none', () => {
    expect(definitionOptions(completeDefinition(draft(), TIMESTAMPS))).toEqual([])
    const withOptions = completeDefinition(
      draft({
        type: 'single_select',
        slug: 'job_role',
        options: [{ id: 'a', key: 'investor', label: 'Investor', position: 1 }],
      }),
      TIMESTAMPS,
    )
    expect(definitionOptions(withOptions)).toHaveLength(1)
  })
})
