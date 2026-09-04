import {
  OPERATORS_BY_TYPE,
  canonicalFilter,
  completeDefinition,
  makeFieldResolver,
  operatorShape,
  parseFilter,
  type AttributeDefinition,
  type AttributeType,
  type FieldDescriptor,
  type Filter,
  type OperatorId,
} from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { groupNameOf, matchesFieldSearch, pickerGroups } from './fields.ts'
import {
  dedupeFilters,
  emptyFilter,
  isComplete,
  operatorLabel,
  operatorNote,
  withField,
  withOperator,
} from './operators.ts'
import { describeFilter } from './sentence.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

function definition(
  slug: string,
  title: string,
  type: AttributeType,
  extra: Partial<AttributeDefinition> = {},
): AttributeDefinition {
  return completeDefinition(
    {
      id: `00000000-0000-4000-8000-${slug.padEnd(12, '0').slice(0, 12)}`,
      objectType: 'contact',
      title,
      slug,
      type,
      config: {},
      isSystem: false,
      position: 0,
      showByDefault: true,
      ...extra,
    },
    TIMESTAMPS,
  )
}

const JOB_ROLE = definition('jobrole', 'Job role', 'single_select', {
  slug: 'job_role',
  options: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      key: 'investor',
      label: 'Investor',
      color: 'blue',
      position: 0,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      key: 'angel',
      label: 'Angel',
      color: 'violet',
      position: 1,
    },
  ],
})

const CITY = definition('city', 'City', 'short_text', { group: 'Location' })
const BIRTHDAY = definition('birthday', 'Birthday', 'date')
const ORGANIZATION = definition('org', 'Organization', 'relation', {
  slug: 'organization',
  config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
})

const FIELDS: readonly FieldDescriptor[] = makeFieldResolver('contact', [
  JOB_ROLE,
  CITY,
  BIRTHDAY,
  ORGANIZATION,
]).list()

function field(slug: string): FieldDescriptor {
  const found = FIELDS.find((entry) => entry.slug === slug)
  if (found === undefined) throw new Error(`no field ${slug}`)
  return found
}

describe('the chip sentence', () => {
  it('reads like the brief’s example', () => {
    const sentence = describeFilter(
      { field: 'job_role', op: 'is_one_of', values: ['investor', 'angel'] },
      field('job_role'),
      {},
    )
    expect(sentence.text).toBe('Job role is one of Investor, Angel')
    expect(sentence.values.map((value) => value.color)).toEqual(['blue', 'violet'])
    expect(sentence.values.every((value) => value.asChip)).toBe(true)
  })

  it('makes the derived columns of §5.2 read as English', () => {
    const sentence = describeFilter(
      { field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' },
      field('last_interaction_at'),
      {},
    )
    expect(sentence.text).toBe('Last interaction is more than 90 days ago')
  })

  it('says one day, not 1 days', () => {
    const sentence = describeFilter(
      { field: 'last_interaction_at', op: 'newer_than', n: 1, unit: 'day' },
      field('last_interaction_at'),
      {},
    )
    expect(sentence.text).toBe('Last interaction is less than 1 day ago')
  })

  it('carries ADR-017’s three surprises into the tooltip', () => {
    const notes = (['is_empty', 'neq', 'is_not_one_of'] as const).map(
      (op) => operatorNote(op) ?? '',
    )
    expect(notes.every((note) => note !== '')).toBe(true)
    expect(operatorNote('neq')).toContain('no value are not matched')
    expect(operatorNote('is_not_one_of')).toContain('no value are matched too')
    expect(operatorNote('is_empty')).toContain('no value exists')
    // The operators that hold no surprise say nothing, rather than saying something obvious.
    expect(operatorNote('contains')).toBeUndefined()
  })

  it('formats dates through the injected formatter and nothing else', () => {
    const sentence = describeFilter(
      { field: 'birthday', op: 'before', value: '2026-03-01' },
      field('birthday'),
      {
        formatDate: (civil) => `«${civil}»`,
      },
    )
    expect(sentence.text).toBe('Birthday is before «2026-03-01»')
  })

  it('resolves relation ids to labels, and falls back to the id', () => {
    const filter: Filter = {
      field: 'organization',
      op: 'has_any_of',
      values: ['id-1', 'id-2'],
    }
    const sentence = describeFilter(filter, field('organization'), {
      recordLabels: new Map([['id-1', 'Vireo Fund']]),
    })
    expect(sentence.values.map((value) => value.text)).toEqual(['Vireo Fund', 'id-2'])
  })

  it('still renders a filter whose field has been deleted', () => {
    const sentence = describeFilter({ field: 'gone', op: 'contains', value: 'x' }, undefined, {})
    expect(sentence.unknownField).toBe(true)
    expect(sentence.text).toBe('gone contains x')
  })

  it('joins the two ends of a range with “and”', () => {
    const sentence = describeFilter(
      { field: 'warmth', op: 'between', from: '40', to: '80' },
      field('warmth'),
      {},
    )
    expect(sentence.text).toBe('Warmth is between 40 and 80')
  })
})

describe('building a filter', () => {
  /** Fills a freshly built filter in, the way the value control does. */
  function filled(filter: Filter): Filter {
    switch (operatorShape(filter.op)) {
      case 'value':
        return 'value' in filter ? { ...filter, value: '1' } : filter
      case 'range':
        return 'from' in filter ? { ...filter, from: '1', to: '2' } : filter
      case 'values':
        return 'values' in filter ? { ...filter, values: ['x'] } : filter
      default:
        return filter
    }
  }

  it('never produces a filter the API would refuse', () => {
    for (const [type, operators] of Object.entries(OPERATORS_BY_TYPE)) {
      for (const op of operators) {
        const complete = filled(emptyFilter('slug', op))
        expect(isComplete(complete), `${type}.${op}`).toBe(true)
        expect(parseFilter(complete).ok, `${type}.${op}`).toBe(true)
        expect(parseFilter(canonicalFilter(complete)).ok, `${type}.${op}`).toBe(true)
      }
    }
  })

  it('refuses to commit a half-typed value', () => {
    expect(isComplete(emptyFilter('city', 'contains'))).toBe(false)
    expect(isComplete({ field: 'warmth', op: 'between', from: '40', to: '' })).toBe(false)
    expect(isComplete(emptyFilter('job_role', 'is_one_of'))).toBe(false)
    // An operator that carries nothing is complete the moment it is chosen.
    expect(isComplete(emptyFilter('notes', 'is_empty'))).toBe(true)
  })

  it('keeps the payload when the new operator carries the same shape', () => {
    const chosen: Filter = { field: 'job_role', op: 'is_one_of', values: ['investor'] }
    expect(withOperator(chosen, 'is_not_one_of')).toEqual({
      field: 'job_role',
      op: 'is_not_one_of',
      values: ['investor'],
    })
  })

  it('drops it when the shapes disagree', () => {
    const chosen: Filter = { field: 'job_role', op: 'is_one_of', values: ['investor'] }
    expect(withOperator(chosen, 'is_empty')).toEqual({ field: 'job_role', op: 'is_empty' })
  })

  it('carries the text to another text field, where it still means something', () => {
    const text: Filter = { field: 'first_name', op: 'contains', value: 'Mun' }
    expect(withField(text, field('last_name'), field('first_name'))).toEqual({
      field: 'last_name',
      op: 'contains',
      value: 'Mun',
    })
  })

  it('does not carry it onto a field of another kind', () => {
    // "Munich" as a date filter would look right in the chip and be a 400 from the API: every
    // filter value is a string on the wire, so nothing but this check stands between the two.
    const text: Filter = { field: 'city', op: 'contains', value: 'Munich' }
    expect(withField(text, field('birthday'), field('city'))).toEqual({
      field: 'birthday',
      op: field('birthday').operators[0],
      value: '',
    })
    const moved = withField(text, field('job_role'), field('city'))
    expect(moved).toEqual({ field: 'job_role', op: 'is_one_of', values: [] })
  })

  it('keeps an operator the new field also offers', () => {
    const empty: Filter = { field: 'city', op: 'is_empty' }
    expect(withField(empty, field('job_role'), field('city'))).toEqual({
      field: 'job_role',
      op: 'is_empty',
    })
  })

  it('offers a label for every operator any field can have', () => {
    const every = new Set<OperatorId>(FIELDS.flatMap((entry) => [...entry.operators]))
    for (const op of every) expect(operatorLabel(op).length).toBeGreaterThan(0)
  })

  it('treats two identical conditions as one', () => {
    const one: Filter = { field: 'city', op: 'contains', value: 'Munich' }
    expect(dedupeFilters([one, { ...one }])).toHaveLength(1)
    // Different values are different conditions, however similar they look.
    expect(dedupeFilters([one, { ...one, value: 'Munch' }])).toHaveLength(2)
  })
})

describe('the field picker', () => {
  it('offers system columns, derived columns and attributes in one list', () => {
    const slugs = pickerGroups(FIELDS).flatMap((group) => group.fields.map((entry) => entry.slug))
    expect(slugs).toContain('display_name')
    expect(slugs).toContain('last_interaction_at')
    expect(slugs).toContain('job_role')
  })

  it('groups by §4.2’s group, and puts the ungrouped under Details', () => {
    const names = pickerGroups(FIELDS).map((group) => group.name)
    expect(names).toContain('Details')
    expect(names).toContain('Relationship')
    expect(names).toContain('Location')
    expect(groupNameOf(field('job_role'))).toBe('Details')
    expect(groupNameOf(field('warmth'))).toBe('Relationship')
  })

  it('matches on the label, the slug and the group', () => {
    expect(matchesFieldSearch(field('last_interaction_at'), 'inter')).toBe(true)
    expect(matchesFieldSearch(field('last_interaction_at'), 'LAST INT')).toBe(true)
    expect(matchesFieldSearch(field('job_role'), 'job_role')).toBe(true)
    expect(matchesFieldSearch(field('city'), 'location')).toBe(true)
    expect(matchesFieldSearch(field('city'), 'zzz')).toBe(false)
  })

  it('drops the groups a search empties', () => {
    const groups = pickerGroups(FIELDS, 'warmth')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.fields.map((entry) => entry.slug)).toEqual(['warmth'])
  })
})
