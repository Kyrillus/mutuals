import { describe, expect, it } from 'vitest'

import {
  SELECT_COLUMN_ID,
  columnLayout,
  layoutToColumns,
  moveColumn,
  visibleColumns,
} from './column-layout.ts'
import { field } from './test-support.ts'

const FIELDS = [
  field('display_name', { showByDefault: true }),
  field('email', { showByDefault: true }),
  field('city', { showByDefault: false }),
  field('warmth', { showByDefault: false }),
]

describe('visibleColumns', () => {
  it('falls back to the fields that declare showByDefault', () => {
    expect(visibleColumns(FIELDS, 'display_name', null)).toEqual(['display_name', 'email'])
  })

  it('keeps the label column first even when the URL omits it', () => {
    expect(visibleColumns(FIELDS, 'display_name', ['city', 'email'])).toEqual([
      'display_name',
      'city',
      'email',
    ])
  })

  it('drops slugs no field declares, so a stale saved view still opens', () => {
    expect(visibleColumns(FIELDS, 'display_name', ['email', 'deleted_attribute'])).toEqual([
      'display_name',
      'email',
    ])
  })

  it('deduplicates, because a repeated column renders twice', () => {
    expect(visibleColumns(FIELDS, 'display_name', ['email', 'email'])).toEqual([
      'display_name',
      'email',
    ])
  })
})

describe('columnLayout', () => {
  it('orders selection, then the visible columns, then the hidden ones', () => {
    const layout = columnLayout(FIELDS, 'display_name', ['email'])
    expect(layout.order).toEqual([SELECT_COLUMN_ID, 'display_name', 'email', 'city', 'warmth'])
    expect(layout.visibility).toEqual({ city: false, warmth: false })
  })

  it('round-trips through the table state the URL is rebuilt from', () => {
    const requested = ['display_name', 'city', 'email']
    const layout = columnLayout(FIELDS, 'display_name', requested)
    expect(layoutToColumns(layout.order, layout.visibility)).toEqual(requested)
  })
})

describe('moveColumn', () => {
  const columns = ['a', 'b', 'c', 'd']

  it('moves a column up', () => {
    expect(moveColumn(columns, 'c', 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves a column down', () => {
    expect(moveColumn(columns, 'b', 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('clamps past either end rather than dropping the column', () => {
    expect(moveColumn(columns, 'a', -3)).toEqual(['a', 'b', 'c', 'd'])
    expect(moveColumn(columns, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('leaves a list it does not contain alone', () => {
    expect(moveColumn(columns, 'z', 0)).toBe(columns)
  })
})
