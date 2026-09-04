import { describe, expect, it } from 'vitest'

import type { RecordRow } from '@/table/record-row.ts'

import {
  cellKey,
  patchRecord,
  patchRowInPages,
  withAttribute,
  type RecordListData,
} from './record-cache.ts'

function row(id: string, city?: string): RecordRow {
  return {
    id,
    objectType: 'contact',
    displayName: id,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
    attributes: city === undefined ? {} : { city: { type: 'short_text', value: city } },
  }
}

function pages(...groups: RecordRow[][]): RecordListData {
  return {
    pages: groups.map((data) => ({
      data,
      page: { cursor: null, hasMore: false },
      meta: { total: data.length },
    })),
    pageParams: groups.map(() => null),
  }
}

describe('withAttribute', () => {
  it('sets a value without touching the rest of the row', () => {
    const next = withAttribute(row('a', 'Munich'), 'city', { type: 'short_text', value: 'Berlin' })
    expect(next.attributes['city']).toEqual({ type: 'short_text', value: 'Berlin' })
    expect(next.id).toBe('a')
  })

  it('deletes the key when the value is cleared: an empty attribute is an absent key', () => {
    const next = withAttribute(row('a', 'Munich'), 'city', undefined)
    expect('city' in next.attributes).toBe(false)
  })

  it('does not mutate the row it was given', () => {
    const original = row('a', 'Munich')
    withAttribute(original, 'city', undefined)
    expect(original.attributes['city']).toEqual({ type: 'short_text', value: 'Munich' })
  })
})

describe('patchRowInPages', () => {
  it('patches the row on whichever page holds it', () => {
    const data = pages([row('a'), row('b')], [row('c')])
    const next = patchRowInPages(data, 'c', (entry) =>
      withAttribute(entry, 'city', { type: 'short_text', value: 'Lisbon' }),
    )
    expect(next?.pages[1]?.data[0]?.attributes['city']).toEqual({
      type: 'short_text',
      value: 'Lisbon',
    })
  })

  it('returns the identical object when no page holds the row', () => {
    const data = pages([row('a')])
    expect(patchRowInPages(data, 'zzz', (entry) => entry)).toBe(data)
  })

  it('leaves untouched pages referentially equal, so other observers do not re-render', () => {
    const data = pages([row('a')], [row('b')])
    const next = patchRowInPages(data, 'b', (entry) => ({ ...entry, displayName: 'B' }))
    expect(next?.pages[0]).toBe(data.pages[0])
    expect(next?.pages[1]).not.toBe(data.pages[1])
  })

  it('passes an empty cache through, because a mutation can start before the first fetch lands', () => {
    expect(patchRowInPages(undefined, 'a', (entry) => entry)).toBeUndefined()
  })
})

describe('patchRecord', () => {
  it('patches the detail entry only when it is the same record', () => {
    const detail = row('a', 'Munich')
    expect(patchRecord(detail, 'b', (entry) => ({ ...entry, displayName: 'X' }))).toBe(detail)
    expect(patchRecord(detail, 'a', (entry) => ({ ...entry, displayName: 'X' }))?.displayName).toBe(
      'X',
    )
  })
})

describe('cellKey', () => {
  it('identifies one cell, which is what the in-flight map is keyed by', () => {
    expect(cellKey('a', 'city')).toBe('a:city')
  })
})
