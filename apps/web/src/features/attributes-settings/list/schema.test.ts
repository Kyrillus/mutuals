import { ATTRIBUTE_TYPES, EMPTY_LIST_QUERY, fieldValueKind } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { columnLayout } from '../../../table/column-layout.ts'

import { ATTRIBUTE_LIST_COLUMNS, LABEL_SLUG, attributeListSchema } from './schema.ts'

const schema = attributeListSchema('contact')

describe('attributeListSchema', () => {
  it('describes exactly §6.7’s columns, in its order', () => {
    expect(schema.fields.map((field) => field.label)).toEqual([
      'Title',
      'Slug',
      'Type',
      'Group',
      'Used in',
      'Created',
      'Updated',
    ])
  })

  it('offers the twelve types as the Type column’s options, from the registry', () => {
    const type = schema.fields.find((field) => field.slug === 'type')
    const options = type?.source.kind === 'attribute' ? (type.source.def.options ?? []) : []
    // Membership *and* order come from `packages/core`: a thirteenth type appears in this filter
    // with no edit to the settings page.
    expect(options.map((option) => option.key)).toEqual([...ATTRIBUTE_TYPES])
    expect(options.every((option) => option.label !== option.key)).toBe(true)
  })

  it('offers "is one of" on Type, because that is what a select filter is', () => {
    const type = schema.fields.find((field) => field.slug === 'type')
    expect(type?.operators).toContain('is_one_of')
  })

  it('keeps the emptiness operators only where a value can actually be missing', () => {
    const operatorsOf = (slug: string) =>
      schema.fields.find((field) => field.slug === slug)?.operators ?? []
    expect(operatorsOf('group')).toContain('is_empty')
    for (const slug of ['title', 'slug', 'type', 'used_in', 'created_at', 'updated_at']) {
      expect(operatorsOf(slug), slug).not.toContain('is_empty')
      expect(operatorsOf(slug), slug).not.toContain('is_not_empty')
    }
  })

  it('types the columns so the table right-aligns the count and formats the dates', () => {
    const kindOf = (slug: string) => {
      const field = schema.fields.find((entry) => entry.slug === slug)
      return field === undefined ? undefined : fieldValueKind(field)
    }
    expect(kindOf('used_in')).toBe('number')
    expect(kindOf('created_at')).toBe('date')
    expect(kindOf('type')).toBe('option')
  })

  it('is sortable in every column: an attributes list is read by asking it questions', () => {
    expect(schema.fields.every((field) => field.sortable)).toBe(true)
  })

  it('gives every column a definition for the cell registry to render through', () => {
    for (const column of ATTRIBUTE_LIST_COLUMNS) {
      expect(schema.definitions.get(column.slug)?.type, column.slug).toBe(column.type)
    }
  })

  it('shows every column by default, with the label pinned first', () => {
    const layout = columnLayout(schema.fields, LABEL_SLUG, EMPTY_LIST_QUERY.columns)
    expect(layout.order).toEqual([
      '__select',
      'title',
      'slug',
      'type',
      'group',
      'used_in',
      'created_at',
      'updated_at',
    ])
    expect(layout.visibility).toEqual({})
  })
})
