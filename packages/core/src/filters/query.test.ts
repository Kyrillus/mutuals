import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { canonicalFilterSet, type Filter } from './model.ts'
import {
  EMPTY_LIST_QUERY,
  MAX_LIMIT,
  canonicalListQuery,
  canonicalViewSnapshot,
  listQuerySignature,
  parseListQuery,
  parseSort,
  serializeListQuery,
  serializeSort,
  stringifyListQuery,
  viewSnapshotsEqual,
  type ListQuery,
} from './query.ts'

const INVESTORS: Filter = { field: 'job_role', op: 'is_one_of', values: ['investor', 'angel'] }
const IN_MUNICH: Filter = { field: 'city', op: 'contains', value: 'münchen' }
const GONE_QUIET: Filter = { field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }

function query(overrides: Partial<ListQuery> = {}): ListQuery {
  return { ...EMPTY_LIST_QUERY, ...overrides }
}

describe('parseSort and serializeSort', () => {
  it('round-trips', () => {
    expect(unwrap(parseSort('check_size:desc'))).toEqual({ field: 'check_size', direction: 'desc' })
    expect(serializeSort({ field: 'check_size', direction: 'desc' })).toBe('check_size:desc')
  })

  it('refuses anything that is not a direction', () => {
    for (const raw of ['check_size', 'check_size:sideways', ':asc', 'check_size:', '']) {
      expect(parseSort(raw).ok).toBe(false)
    }
  })

  it('refuses an absurdly long field name', () => {
    expect(parseSort(`${'x'.repeat(65)}:asc`).ok).toBe(false)
  })
})

describe('parseListQuery', () => {
  it('parses the whole surface', () => {
    const parsed = unwrap(
      parseListQuery({
        filter: JSON.stringify([INVESTORS, IN_MUNICH]),
        sort: 'display_name:asc',
        columns: 'display_name,email,city',
        q: 'anna',
        view: 'view-1',
        limit: '50',
        cursor: 'opaque-cursor',
      }),
    )
    expect(parsed).toEqual({
      filter: [INVESTORS, IN_MUNICH],
      sort: { field: 'display_name', direction: 'asc' },
      columns: ['display_name', 'email', 'city'],
      q: 'anna',
      view: 'view-1',
      limit: 50,
      cursor: 'opaque-cursor',
    })
  })

  it('treats a bare querystring as the empty query', () => {
    expect(unwrap(parseListQuery({}))).toEqual(EMPTY_LIST_QUERY)
  })

  it('treats blank parameters as absent', () => {
    expect(unwrap(parseListQuery({ q: '  ', view: '', sort: '' }))).toEqual(EMPTY_LIST_QUERY)
  })

  it('rejects a repeated parameter rather than silently dropping half the filters', () => {
    const result = parseListQuery({ filter: ['[]', '[]'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('repeated_parameter')
  })

  it('rejects filter JSON that is not JSON, and JSON that is not an array', () => {
    expect(parseListQuery({ filter: 'not json' }).ok).toBe(false)
    expect(parseListQuery({ filter: '{"all":[]}' }).ok).toBe(false)
  })

  it('prefixes filter issue paths so the API can point at a chip', () => {
    const result = parseListQuery({ filter: JSON.stringify([{ field: 'x', op: 'contains' }]) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.path).toEqual(['filter', 0, 'value'])
  })

  it('collects every problem at once, so a hand-edited URL reports all of them', () => {
    const result = parseListQuery({ sort: 'bad', limit: '0', columns: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.length).toBeGreaterThanOrEqual(2)
  })

  it('bounds the limit', () => {
    expect(parseListQuery({ limit: '0' }).ok).toBe(false)
    expect(parseListQuery({ limit: String(MAX_LIMIT + 1) }).ok).toBe(false)
    expect(parseListQuery({ limit: '12.5' }).ok).toBe(false)
    expect(parseListQuery({ limit: 'lots' }).ok).toBe(false)
    expect(unwrap(parseListQuery({ limit: String(MAX_LIMIT) })).limit).toBe(MAX_LIMIT)
  })

  it('bounds the search text and the cursor', () => {
    expect(parseListQuery({ q: 'x'.repeat(257) }).ok).toBe(false)
    expect(parseListQuery({ cursor: 'x'.repeat(513) }).ok).toBe(false)
  })

  it('deduplicates and bounds the column list', () => {
    expect(unwrap(parseListQuery({ columns: 'email, city ,email' })).columns).toEqual([
      'email',
      'city',
    ])
    expect(parseListQuery({ columns: ',,,' }).ok).toBe(false)
    expect(parseListQuery({ columns: `a,${'x'.repeat(65)}` }).ok).toBe(false)
    const tooMany = Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')
    expect(parseListQuery({ columns: tooMany }).ok).toBe(false)
  })
})

describe('serializeListQuery', () => {
  it('omits everything that is absent, so an untouched list page has a bare URL', () => {
    expect(serializeListQuery(EMPTY_LIST_QUERY)).toEqual({})
  })

  it('emits the filter set as one JSON array', () => {
    const params = serializeListQuery(query({ filter: [IN_MUNICH] }))
    expect(params['filter']).toBe('[{"field":"city","op":"contains","value":"münchen"}]')
  })

  it('round-trips through parse', () => {
    const original = query({
      filter: [INVESTORS, IN_MUNICH, GONE_QUIET],
      sort: { field: 'warmth', direction: 'desc' },
      columns: ['display_name', 'email'],
      q: 'anna',
      view: 'v1',
      limit: 25,
      cursor: 'abc',
    })
    const reparsed = unwrap(parseListQuery(serializeListQuery(original)))
    expect(reparsed).toEqual(canonicalListQuery(original))
  })

  it('round-trips values that break naive escaping', () => {
    const awkward: Filter = { field: 'notes', op: 'contains', value: 'a,b:c%d+e&f=g 🌱' }
    const params = serializeListQuery(query({ filter: [awkward] }))
    const reparsed = unwrap(parseListQuery(params))
    expect(reparsed.filter).toEqual([awkward])
  })

  /**
   * The `+` is why the filter set travels as one JSON value: Fastify's default querystring parser
   * decodes a bare `+` as a space, so a two-layer `field:op:value` encoding would silently turn a
   * phone fragment into a different search.
   */
  it('percent-encodes a plus sign in the URL form', () => {
    const params = stringifyListQuery(query({ q: '+49 89' }))
    expect(params).toContain('%2B49')
    const back = Object.fromEntries(new URLSearchParams(params))
    expect(unwrap(parseListQuery(back)).q).toBe('+49 89')
  })
})

describe('canonical form', () => {
  it('is stable under filter reordering and value reordering', () => {
    const a = query({ filter: [INVESTORS, IN_MUNICH] })
    const b = query({
      filter: [
        IN_MUNICH,
        { field: 'job_role', op: 'is_one_of', values: ['angel', 'investor', 'angel'] },
      ],
    })
    expect(serializeListQuery(a)).toEqual(serializeListQuery(b))
    expect(listQuerySignature(a)).toBe(listQuerySignature(b))
  })

  it('keeps column order, because column order is display order', () => {
    const a = query({ columns: ['email', 'city'] })
    const b = query({ columns: ['city', 'email'] })
    expect(serializeListQuery(a)).not.toEqual(serializeListQuery(b))
  })

  it('canonicalises the filter set the same way the model does', () => {
    const q = query({ filter: [INVESTORS, IN_MUNICH] })
    expect(canonicalListQuery(q).filter).toEqual(canonicalFilterSet(q.filter))
  })

  it('deduplicates columns', () => {
    expect(canonicalListQuery(query({ columns: ['a', 'b', 'a'] })).columns).toEqual(['a', 'b'])
  })
})

describe('saved-view dirtiness (ADR-048)', () => {
  const stored = { filter: [INVESTORS, IN_MUNICH], sort: null, columns: ['display_name', 'city'] }

  it('is clean when the URL still matches the snapshot, whatever the order', () => {
    expect(
      viewSnapshotsEqual(stored, {
        filter: [IN_MUNICH, INVESTORS],
        sort: null,
        columns: ['display_name', 'city'],
      }),
    ).toBe(true)
  })

  it('is dirty when a filter is added, a sort is set or a column is reordered', () => {
    expect(viewSnapshotsEqual(stored, { ...stored, filter: [INVESTORS] })).toBe(false)
    expect(
      viewSnapshotsEqual(stored, { ...stored, sort: { field: 'warmth', direction: 'desc' } }),
    ).toBe(false)
    expect(viewSnapshotsEqual(stored, { ...stored, columns: ['city', 'display_name'] })).toBe(false)
  })

  it('ignores the parts of the URL a view does not store', () => {
    const withNoise = canonicalViewSnapshot({ ...stored })
    expect(viewSnapshotsEqual(withNoise, stored)).toBe(true)
    // `q`, `limit`, `cursor` and `view` are not part of the snapshot at all.
    expect(canonicalViewSnapshot(stored)).toEqual({
      filter: canonicalFilterSet(stored.filter),
      sort: null,
      columns: ['display_name', 'city'],
    })
  })
})
