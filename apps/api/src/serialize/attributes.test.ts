/**
 * The serialisation boundary, without a database.
 *
 * Two claims worth pinning here rather than only in an integration test: an empty attribute
 * produces **no key** (ADR-017), and the renderer covers every type the registry declares — so a
 * thirteenth type cannot slip through as a silently missing field.
 */
import {
  ATTRIBUTE_TYPES,
  completeDefinition,
  makeFieldResolver,
  type AttributeDefinition,
  type AttributeType,
} from '@mutuals/core'
import type { HydratedRecord, RecordRelation, RecordValue } from '@mutuals/db'
import { describe, expect, it } from 'vitest'

import type { Schema } from '../context.ts'
import { serializeAttributes } from './attributes.ts'

const TIMESTAMPS = { createdAt: '2026-06-15T09:00:00.000Z', updatedAt: '2026-06-15T09:00:00.000Z' }

let nextId = 1

function define(type: AttributeType, overrides: Partial<AttributeDefinition> = {}) {
  const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
  return completeDefinition(
    {
      id,
      objectType: 'contact',
      title: type,
      slug: `custom_${type}`,
      type,
      config:
        type === 'relation'
          ? { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true }
          : type === 'number'
            ? { unit: 'EUR' }
            : {},
      isSystem: false,
      position: 0,
      showByDefault: true,
      ...(type === 'single_select' || type === 'multi_select'
        ? { options: [{ id: `${id}-o`, key: 'one', label: 'One', color: 'amber', position: 0 }] }
        : {}),
      ...overrides,
    },
    TIMESTAMPS,
  )
}

function schemaOf(definitions: readonly AttributeDefinition[]): Schema {
  return {
    definitions,
    resolver: makeFieldResolver('contact', definitions),
    bySlug: new Map(definitions.map((definition) => [definition.slug, definition])),
    byId: new Map(definitions.map((definition) => [definition.id, definition])),
  }
}

function record(
  values: readonly Partial<RecordValue>[],
  links: readonly Partial<RecordRelation>[] = [],
): HydratedRecord {
  return {
    id: 'r1',
    objectType: 'contact',
    displayLabel: 'Anna Berger',
    createdVia: 'manual',
    importBatchId: null,
    createdAt: TIMESTAMPS.createdAt,
    updatedAt: TIMESTAMPS.updatedAt,
    values: values.map((value) => ({
      attributeId: '',
      valueKind: 'text',
      valueKey: '',
      position: 0,
      factId: 'f1',
      text: null,
      num: null,
      date: null,
      bool: null,
      optionId: null,
      optionKey: null,
      optionLabel: null,
      ...value,
    })),
    links: links.map((link) => ({
      attributeId: '',
      toRecordId: 'o1',
      toLabel: 'Northstar Ventures',
      toObjectType: 'organization',
      title: null,
      from: null,
      to: null,
      isPrimary: false,
      position: 0,
      factId: 'f2',
      ...link,
    })),
  }
}

describe('an attribute with no value', () => {
  it('produces no key at all — not null, not an empty string (ADR-017)', () => {
    const city = define('short_text')
    const attributes = serializeAttributes(record([]), schemaOf([city]))
    expect(attributes).toEqual({})
    expect(city.slug in attributes).toBe(false)
  })
})

describe('every type the registry declares', () => {
  it('renders, and renders as its own discriminant', () => {
    for (const type of ATTRIBUTE_TYPES) {
      const definition = define(type)
      const values: Partial<RecordValue>[] =
        type === 'relation' ? [] : [{ attributeId: definition.id, ...slotFor(type, definition) }]
      const links = type === 'relation' ? [{ attributeId: definition.id, title: 'Partner' }] : []

      const attributes = serializeAttributes(record(values, links), schemaOf([definition]))
      const rendered = attributes[definition.slug]
      expect(rendered, `${type} rendered nothing`).toBeDefined()
      expect(rendered?.type).toBe(type)
    }
  })

  it('carries a select option by its stable key, with its label and colour', () => {
    const definition = define('single_select')
    const option = definition.options?.[0]
    const attributes = serializeAttributes(
      record([
        {
          attributeId: definition.id,
          valueKind: 'option',
          optionId: option?.id ?? null,
          optionKey: 'one',
          optionLabel: 'stale label from the join',
        },
      ]),
      schemaOf([definition]),
    )
    // The definition wins over the joined label: one of them is what Settings just renamed.
    expect(attributes[definition.slug]).toEqual({
      type: 'single_select',
      value: { key: 'one', label: 'One', color: 'amber' },
    })
  })

  it('attaches the configured unit to a number, and omits it when there is none', () => {
    const withUnit = define('number')
    const withoutUnit = define('number', { slug: 'plain_number', config: {} })
    const attributes = serializeAttributes(
      record([
        { attributeId: withUnit.id, valueKind: 'number', num: '250000.50' },
        { attributeId: withoutUnit.id, valueKind: 'number', num: '7' },
      ]),
      schemaOf([withUnit, withoutUnit]),
    )
    expect(attributes[withUnit.slug]).toEqual({
      type: 'number',
      value: '250000.50',
      unit: 'EUR',
    })
    expect(attributes[withoutUnit.slug]).toEqual({ type: 'number', value: '7' })
  })

  it('keeps multi-valued elements in the order the projector positioned them', () => {
    const tags = define('tags')
    const attributes = serializeAttributes(
      record([
        { attributeId: tags.id, text: 'climate', position: 0 },
        { attributeId: tags.id, text: 'deeptech', position: 1 },
      ]),
      schemaOf([tags]),
    )
    expect(attributes[tags.slug]).toEqual({ type: 'tags', value: ['climate', 'deeptech'] })
  })
})

function slotFor(type: AttributeType, definition: AttributeDefinition): Partial<RecordValue> {
  switch (type) {
    case 'number':
      return { valueKind: 'number', num: '1' }
    case 'date':
      return { valueKind: 'date', date: '2026-06-15' }
    case 'yes_no':
      return { valueKind: 'bool', bool: true }
    case 'single_select':
    case 'multi_select':
      return {
        valueKind: 'option',
        optionId: definition.options?.[0]?.id ?? null,
        optionKey: 'one',
        optionLabel: 'One',
      }
    case 'relation':
      return {}
    default:
      return { valueKind: 'text', text: 'something' }
  }
}
