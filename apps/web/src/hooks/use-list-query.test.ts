import {
  canonicalListQuery,
  parseListQuery,
  serializeListQuery,
  viewSnapshotsEqual,
  type ListQuery,
} from '@mutuals/core'
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import {
  ListSearchError,
  rawFromSearchString,
  readListQuery,
  toListSearch,
  toRawQuery,
  validateListSearch,
} from './use-list-query.ts'

/**
 * These tests run the *real* router codecs, not a model of them.
 *
 * The whole risk in this file is that TanStack's `parseSearch`/`stringifySearch` are not the
 * identity: `decode()` turns `"50"` into `50` and `"true"` into `true` before `JSON.parse` gets a
 * look, and `stringifySearch` re-quotes any string that happens to parse as JSON. A round-trip
 * asserted against a hand-written querystring would prove nothing about either.
 */
function roundTrip(query: ListQuery): ListQuery {
  const url = defaultStringifySearch(toListSearch(query))
  const parsed = parseListQuery(toRawQuery(defaultParseSearch(url)))
  if (!parsed.ok) throw new Error(parsed.issues.map((problem) => problem.message).join(' '))
  return canonicalListQuery(parsed.value)
}

function paramsOf(query: ListQuery): Record<string, string> {
  const url = defaultStringifySearch(toListSearch(query))
  return Object.fromEntries(new URLSearchParams(url))
}

const BASE: ListQuery = {
  filter: [],
  sort: null,
  columns: null,
  q: null,
  view: null,
  limit: null,
  cursor: null,
}

const EVERY_SHAPE: ListQuery = {
  ...BASE,
  filter: [
    { field: 'city', op: 'contains', value: 'Munich' },
    { field: 'job_role', op: 'is_one_of', values: ['investor', 'founder'] },
    { field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' },
    { field: 'birthday', op: 'in_relative', preset: 'this_year' },
    { field: 'warmth', op: 'between', from: '40', to: '80' },
    { field: 'notes', op: 'is_empty' },
    { field: 'pinned_important', op: 'is_yes' },
    { field: 'organization', op: 'has_any_of', values: ['3f1a0d1e-0000-4000-8000-000000000001'] },
  ],
  sort: { field: 'display_name', direction: 'desc' },
  columns: ['display_name', 'email', 'job_role'],
  q: 'ann',
  view: 'investors',
}

describe('the URL round-trip', () => {
  it('survives every operator shape through the router codecs', () => {
    expect(roundTrip(EVERY_SHAPE)).toEqual(canonicalListQuery(EVERY_SHAPE))
  })

  it('writes the wire format the API parses, byte for byte', () => {
    const expected = serializeListQuery(EVERY_SHAPE)
    expect(paramsOf(EVERY_SHAPE)).toEqual(expected)
    // Not a coincidence worth trusting silently: ADR-032 says `?filter=` carries the JSON array.
    expect(paramsOf(EVERY_SHAPE)['filter']).toBe(
      JSON.stringify(canonicalListQuery(EVERY_SHAPE).filter),
    )
  })

  it('keeps an empty query out of the URL entirely', () => {
    expect(defaultStringifySearch(toListSearch(BASE))).toBe('')
    expect(roundTrip(BASE)).toEqual(BASE)
  })

  it('survives search text the router would otherwise read as JSON', () => {
    // `decode()` alone turns each of these into a number, a boolean or an array, and every one of
    // them is something a person might type into the search box.
    for (const q of ['42', '-3', 'true', 'false', '[1,2]', '{"a":1}', 'null', '  spaced  ']) {
      expect(roundTrip({ ...BASE, q }).q).toBe(q)
    }
  })

  it('survives a limit, which the router decodes as a number', () => {
    expect(roundTrip({ ...BASE, limit: 50 }).limit).toBe(50)
  })

  it('drops the cursor, which is not part of a shareable link', () => {
    expect(toListSearch({ ...BASE, cursor: 'eyJtIjoibyJ9' })).toEqual({})
  })
})

describe('canonicalisation', () => {
  it('makes two equivalent URLs identical, which is what view dirtiness compares', () => {
    const one = validateListSearch({
      filter: [
        { field: 'job_role', op: 'is_one_of', values: ['investor', 'founder', 'investor'] },
        { field: 'city', op: 'contains', value: 'Munich' },
      ],
    })
    const other = validateListSearch({
      filter: [
        { field: 'city', op: 'contains', value: 'Munich' },
        { field: 'job_role', op: 'is_one_of', values: ['founder', 'investor'] },
      ],
    })
    expect(defaultStringifySearch(one)).toBe(defaultStringifySearch(other))
    expect(
      viewSnapshotsEqual({ ...BASE, ...readListQuery(one) }, { ...BASE, ...readListQuery(other) }),
    ).toBe(true)
  })

  it('keeps column order, which is display order and therefore meaning', () => {
    expect(toListSearch({ ...BASE, columns: ['email', 'display_name'] })['columns']).toBe(
      'email,display_name',
    )
  })
})

describe('a hand-edited URL', () => {
  it('is refused rather than silently returning everybody', () => {
    expect(() => validateListSearch({ filter: [{ field: 'city', op: 'nonsense' }] })).toThrow(
      ListSearchError,
    )
  })

  it('reports a repeated parameter by name', () => {
    let issues: readonly { readonly code: string }[] = []
    try {
      validateListSearch(defaultParseSearch('?q=one&q=two'))
    } catch (error) {
      issues = error instanceof ListSearchError ? error.issues : []
    }
    expect(issues.map((problem) => problem.code)).toEqual(['repeated_parameter'])
  })

  it('reports every problem at once, not the first', () => {
    let count = 0
    try {
      validateListSearch({ sort: 'display_name:sideways', limit: 5000 })
    } catch (error) {
      count = error instanceof ListSearchError ? error.issues.length : 0
    }
    expect(count).toBe(2)
  })
})

describe('reading the address bar', () => {
  it('parses the querystring exactly as the API would', () => {
    const url = defaultStringifySearch(toListSearch(EVERY_SHAPE))
    const parsed = parseListQuery(rawFromSearchString(url))
    expect(parsed.ok && canonicalListQuery(parsed.value)).toEqual(canonicalListQuery(EVERY_SHAPE))
  })

  it('keeps a repeated parameter repeated, so the codec can refuse it', () => {
    expect(rawFromSearchString('?q=one&q=two')).toEqual({ q: ['one', 'two'] })
    const parsed = parseListQuery(rawFromSearchString('?q=one&q=two'))
    expect(parsed.ok).toBe(false)
  })

  it('takes a bare `?` and an empty string as no query at all', () => {
    expect(rawFromSearchString('?')).toEqual({})
    expect(rawFromSearchString('')).toEqual({})
  })
})

describe('toRawQuery', () => {
  it('puts the router’s decoded values back into the text the codec parses', () => {
    expect(
      toRawQuery({ limit: 50, view: 'investors', filter: [{ field: 'a', op: 'is_empty' }] }),
    ).toEqual({
      limit: '50',
      view: 'investors',
      filter: '[{"field":"a","op":"is_empty"}]',
    })
  })

  it('drops absent keys instead of turning them into empty strings', () => {
    expect(toRawQuery({ q: undefined, view: null })).toEqual({})
  })
})
