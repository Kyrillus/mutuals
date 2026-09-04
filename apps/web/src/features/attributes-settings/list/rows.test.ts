import type { AttributeDefinitionDto } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { attributeRow, attributeRows } from './rows.ts'

function dto(overrides: Partial<AttributeDefinitionDto> = {}): AttributeDefinitionDto {
  return {
    id: '00000001-0000-4000-8000-000000000001',
    objectType: 'contact',
    title: 'Areas of interest',
    slug: 'areas_of_interest',
    type: 'tags',
    config: {},
    options: [],
    group: null,
    description: null,
    isSystem: false,
    isMulti: true,
    isDerived: false,
    sortable: false,
    position: 7,
    showByDefault: true,
    recordCount: 143,
    createdAt: '2026-09-03T20:30:49.737Z',
    updatedAt: '2026-09-04T06:00:00.000Z',
    ...overrides,
  }
}

describe('attributeRow', () => {
  it('carries the title as both the label and a value, so the cell and the CSV agree', () => {
    const row = attributeRow(dto(), 'UTC')
    expect(row.displayName).toBe('Areas of interest')
    expect(row.attributes['title']).toEqual({ type: 'short_text', value: 'Areas of interest' })
  })

  it('names the type in words, from the registry, not by echoing the wire value', () => {
    expect(attributeRow(dto({ type: 'single_select' }), 'UTC').attributes['type']).toEqual({
      type: 'single_select',
      value: { key: 'single_select', label: 'Single select', color: null },
    })
  })

  it('states the usage count as a number, so the column sorts and filters as one', () => {
    expect(attributeRow(dto({ recordCount: 0 }), 'UTC').attributes['used_in']).toEqual({
      type: 'number',
      value: '0',
    })
  })

  it('leaves an ungrouped attribute with no group key at all (ADR-017)', () => {
    expect('group' in attributeRow(dto(), 'UTC').attributes).toBe(false)
    expect('group' in attributeRow(dto({ group: '' }), 'UTC').attributes).toBe(false)
    expect(attributeRow(dto({ group: 'Relationship' }), 'UTC').attributes['group']).toEqual({
      type: 'short_text',
      value: 'Relationship',
    })
  })

  it('shows the calendar day the timestamp fell on where the user is, not where the server is', () => {
    // 20:30 UTC on the 3rd is already the 4th in Auckland and still the 3rd in London.
    expect(attributeRow(dto(), 'Europe/London').attributes['created_at']).toEqual({
      type: 'date',
      value: '2026-09-03',
    })
    expect(attributeRow(dto(), 'Pacific/Auckland').attributes['created_at']).toEqual({
      type: 'date',
      value: '2026-09-04',
    })
  })

  it('keeps the raw instants on the row, so nothing downstream has to re-parse a day', () => {
    const row = attributeRow(dto(), 'UTC')
    expect(row.createdAt).toBe('2026-09-03T20:30:49.737Z')
    expect(row.updatedAt).toBe('2026-09-04T06:00:00.000Z')
  })

  it('maps a list in order', () => {
    const rows = attributeRows([dto({ id: 'a' }), dto({ id: 'b', title: 'Asks' })], 'UTC')
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(rows[1]?.displayName).toBe('Asks')
  })
})
