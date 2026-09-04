import { EMPTY_LIST_QUERY, civil, type AttributeDefinitionDto, type Filter } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { applyListQuery, matchesFilter, matchesSearch } from './filtering.ts'
import { attributeRows } from './rows.ts'
import { attributeListSchema } from './schema.ts'

const TODAY = civil('2026-09-04')

function dto(overrides: Partial<AttributeDefinitionDto>): AttributeDefinitionDto {
  return {
    id: overrides.slug ?? 'id',
    objectType: 'contact',
    title: 'Email',
    slug: 'email',
    type: 'email',
    config: {},
    options: [],
    group: null,
    description: null,
    isSystem: false,
    isMulti: false,
    isDerived: false,
    sortable: true,
    position: 0,
    showByDefault: true,
    recordCount: 183,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  }
}

const DEFINITIONS = [
  dto({ slug: 'email', title: 'Email', type: 'email', recordCount: 183, group: 'Contact data' }),
  dto({
    slug: 'job_role',
    title: 'Job role',
    type: 'single_select',
    recordCount: 200,
    createdAt: '2026-06-01T00:00:00.000Z',
  }),
  dto({
    slug: 'areas_of_interest',
    title: 'Areas of interest',
    type: 'tags',
    recordCount: 0,
    group: 'Relationship',
    createdAt: '2026-09-01T00:00:00.000Z',
  }),
]

const ROWS = attributeRows(DEFINITIONS, 'UTC')
const FIELDS = attributeListSchema('contact').fields

function slugsMatching(filter: Filter): string[] {
  return ROWS.filter((row) => matchesFilter(row, filter, TODAY)).map((row) =>
    row.attributes['slug']?.type === 'short_text' ? row.attributes['slug'].value : '',
  )
}

describe('matchesFilter', () => {
  it('reads text case-insensitively, on contains and on equals', () => {
    expect(slugsMatching({ field: 'title', op: 'contains', value: 'ROLE' })).toEqual(['job_role'])
    expect(slugsMatching({ field: 'title', op: 'equals', value: 'email' })).toEqual(['email'])
    expect(slugsMatching({ field: 'title', op: 'equals', value: 'ema' })).toEqual([])
  })

  it('treats a missing group as empty, and a present one as not (ADR-017)', () => {
    expect(slugsMatching({ field: 'group', op: 'is_empty' })).toEqual(['job_role'])
    expect(slugsMatching({ field: 'group', op: 'is_not_empty' })).toEqual([
      'email',
      'areas_of_interest',
    ])
  })

  it('filters the Type column by option key, in both directions', () => {
    expect(
      slugsMatching({ field: 'type', op: 'is_one_of', values: ['single_select', 'tags'] }),
    ).toEqual(['job_role', 'areas_of_interest'])
    expect(slugsMatching({ field: 'type', op: 'is_not_one_of', values: ['email'] })).toEqual([
      'job_role',
      'areas_of_interest',
    ])
  })

  it('compares Used in as a number, not as the string it travels as', () => {
    expect(slugsMatching({ field: 'used_in', op: 'gt', value: '9' })).toEqual(['email', 'job_role'])
    expect(slugsMatching({ field: 'used_in', op: 'eq', value: '0' })).toEqual(['areas_of_interest'])
    expect(slugsMatching({ field: 'used_in', op: 'between', from: '100', to: '190' })).toEqual([
      'email',
    ])
  })

  it('compares Created as a day, absolutely and relatively', () => {
    expect(slugsMatching({ field: 'created_at', op: 'before', value: '2026-05-01' })).toEqual([
      'email',
    ])
    expect(
      slugsMatching({ field: 'created_at', op: 'in_relative', preset: 'last_30_days' }),
    ).toEqual(['areas_of_interest'])
    expect(slugsMatching({ field: 'created_at', op: 'older_than', n: 6, unit: 'month' })).toEqual([
      'email',
    ])
  })

  it('matches nothing when a hand-edited URL pairs an operator with the wrong column', () => {
    expect(slugsMatching({ field: 'title', op: 'is_yes' })).toEqual([])
    expect(slugsMatching({ field: 'created_at', op: 'gt', value: '3' })).toEqual([])
    expect(slugsMatching({ field: 'used_in', op: 'before', value: '2026-01-01' })).toEqual([])
    expect(slugsMatching({ field: 'not_a_column', op: 'contains', value: 'a' })).toEqual([])
  })

  it('combines with AND, one filter at a time (ADR-032)', () => {
    const rows = applyListQuery(
      ROWS,
      FIELDS,
      {
        ...EMPTY_LIST_QUERY,
        filter: [
          { field: 'used_in', op: 'gt', value: '0' },
          { field: 'group', op: 'is_not_empty' },
        ],
      },
      TODAY,
    )
    expect(rows.map((row) => row.displayName)).toEqual(['Email'])
  })
})

describe('matchesSearch', () => {
  it('searches everything the row says, including the type in words', () => {
    const row = ROWS[1]
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(matchesSearch(row, 'job')).toBe(true)
    expect(matchesSearch(row, 'JOB_ROLE')).toBe(true)
    expect(matchesSearch(row, 'single select')).toBe(true)
    expect(matchesSearch(row, 'birthday')).toBe(false)
  })

  it('an empty term is not a filter', () => {
    const row = ROWS[0]
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(matchesSearch(row, '   ')).toBe(true)
  })
})

describe('applyListQuery', () => {
  function sorted(field: string, direction: 'asc' | 'desc'): string[] {
    return applyListQuery(
      ROWS,
      FIELDS,
      { ...EMPTY_LIST_QUERY, sort: { field, direction } },
      TODAY,
    ).map((row) => row.displayName)
  }

  it('orders text case-insensitively', () => {
    expect(sorted('title', 'asc')).toEqual(['Areas of interest', 'Email', 'Job role'])
    expect(sorted('title', 'desc')).toEqual(['Job role', 'Email', 'Areas of interest'])
  })

  it('orders Used in numerically, not lexically', () => {
    expect(sorted('used_in', 'asc')).toEqual(['Areas of interest', 'Email', 'Job role'])
  })

  it('orders Type by the registry’s order, which is what a select sorts by', () => {
    // `single_select` precedes `tags` precedes `email` in `ATTRIBUTE_TYPES`.
    expect(sorted('type', 'asc')).toEqual(['Job role', 'Areas of interest', 'Email'])
  })

  it('keeps rows with no value last in both directions', () => {
    expect(sorted('group', 'asc')).toEqual(['Email', 'Areas of interest', 'Job role'])
    expect(sorted('group', 'desc')).toEqual(['Areas of interest', 'Email', 'Job role'])
  })

  it('breaks a tie by the row label rather than by load order', () => {
    const tied = attributeRows(
      [
        dto({ slug: 'z', title: 'Zurich', recordCount: 5 }),
        dto({ slug: 'a', title: 'Amsterdam', recordCount: 5 }),
      ],
      'UTC',
    )
    const rows = applyListQuery(
      tied,
      FIELDS,
      { ...EMPTY_LIST_QUERY, sort: { field: 'used_in', direction: 'desc' } },
      TODAY,
    )
    expect(rows.map((row) => row.displayName)).toEqual(['Amsterdam', 'Zurich'])
  })

  it('leaves the order alone when nothing is sorted', () => {
    expect(applyListQuery(ROWS, FIELDS, EMPTY_LIST_QUERY, TODAY).map((row) => row.id)).toEqual([
      'email',
      'job_role',
      'areas_of_interest',
    ])
  })
})
