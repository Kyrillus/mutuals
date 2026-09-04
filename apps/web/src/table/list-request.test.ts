import { EMPTY_LIST_QUERY, type ListQuery } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { requestParams } from './list-request.ts'

function query(overrides: Partial<ListQuery>): ListQuery {
  return { ...EMPTY_LIST_QUERY, ...overrides }
}

describe('requestParams', () => {
  it('sends nothing at all for an untouched list', () => {
    expect(requestParams(EMPTY_LIST_QUERY)).toEqual({})
  })

  it('drops `columns` when there is no search, so hiding a column costs no request', () => {
    expect(requestParams(query({ columns: ['display_name', 'city'] }))).toEqual({})
  })

  it('keeps `columns` when there is a search, because it scopes what is searched', () => {
    expect(requestParams(query({ columns: ['display_name', 'city'], q: 'berlin' }))).toEqual({
      columns: 'display_name,city',
      q: 'berlin',
    })
  })

  it('drops `view`, which names the saved view rather than changing the answer', () => {
    expect(requestParams(query({ view: 'investors' }))).toEqual({})
  })

  it('never sends a cursor: it belongs to getNextPageParam, not to the cache key', () => {
    expect(requestParams(query({ cursor: 'abc' }))).toEqual({})
  })

  it('serialises the filter set as one JSON parameter (ADR-032)', () => {
    const params = requestParams(
      query({ filter: [{ field: 'city', op: 'contains', value: 'Munich' }] }),
    )
    expect(params['filter']).toBe('[{"field":"city","op":"contains","value":"Munich"}]')
  })

  it('serialises the sort as field:direction', () => {
    expect(requestParams(query({ sort: { field: 'display_name', direction: 'desc' } }))).toEqual({
      sort: 'display_name:desc',
    })
  })

  it('is canonical: two equivalent queries produce the same parameters, so they share a cache entry', () => {
    const a = requestParams(
      query({
        filter: [
          { field: 'job_role', op: 'is_one_of', values: ['investor', 'founder'] },
          { field: 'city', op: 'contains', value: 'Munich' },
        ],
      }),
    )
    const b = requestParams(
      query({
        filter: [
          { field: 'city', op: 'contains', value: 'Munich' },
          { field: 'job_role', op: 'is_one_of', values: ['founder', 'investor'] },
        ],
      }),
    )
    expect(a).toEqual(b)
  })
})
