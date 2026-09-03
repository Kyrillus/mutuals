import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import {
  MAX_FILTERS,
  MAX_FILTER_VALUES,
  MAX_FILTER_VALUE_LENGTH,
  canonicalFilter,
  canonicalFilterSet,
  filterSchema,
  parseFilter,
  parseFilterSet,
  shapeOf,
  type Filter,
} from './model.ts'
import { OPERATORS, OPERATORS_BY_TYPE, type OperatorId } from './operators.ts'

/** One well-formed filter per operator, so completeness can be asserted rather than assumed. */
const SAMPLES: Readonly<Record<OperatorId, Filter>> = {
  contains: { field: 'city', op: 'contains', value: 'münchen' },
  equals: { field: 'city', op: 'equals', value: 'Munich' },
  is_empty: { field: 'city', op: 'is_empty' },
  is_not_empty: { field: 'city', op: 'is_not_empty' },
  eq: { field: 'check_size', op: 'eq', value: '250000' },
  neq: { field: 'check_size', op: 'neq', value: '250000' },
  lt: { field: 'check_size', op: 'lt', value: '250000' },
  gt: { field: 'check_size', op: 'gt', value: '250000' },
  between: { field: 'check_size', op: 'between', from: '250000', to: '1000000' },
  before: { field: 'birthday', op: 'before', value: '1990-01-01' },
  after: { field: 'birthday', op: 'after', value: '1990-01-01' },
  in_relative: { field: 'created_at', op: 'in_relative', preset: 'last_30_days' },
  older_than: { field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' },
  newer_than: { field: 'last_interaction_at', op: 'newer_than', n: 7, unit: 'day' },
  is_yes: { field: 'is_mutual', op: 'is_yes' },
  is_no: { field: 'is_mutual', op: 'is_no' },
  is_one_of: { field: 'job_role', op: 'is_one_of', values: ['investor', 'angel'] },
  is_not_one_of: { field: 'job_role', op: 'is_not_one_of', values: ['student'] },
  contains_any_of: { field: 'areas_of_interest', op: 'contains_any_of', values: ['climate tech'] },
  contains_all_of: { field: 'industry', op: 'contains_all_of', values: ['a', 'b'] },
  has_any_of: { field: 'organization', op: 'has_any_of', values: ['3f8c1e6a'] },
}

describe('completeness', () => {
  it('every operator in the vocabulary has a parseable filter shape', () => {
    for (const op of OPERATORS) {
      const sample = SAMPLES[op]
      expect(sample, `no sample filter for ${op}`).toBeDefined()
      expect(unwrap(parseFilter(sample))).toEqual(sample)
    }
  })

  it('every operator any attribute type offers is in the model', () => {
    for (const operators of Object.values(OPERATORS_BY_TYPE)) {
      for (const op of operators) expect(SAMPLES[op]).toBeDefined()
    }
  })

  it('reports the payload shape for the UI', () => {
    expect(shapeOf(SAMPLES.is_empty)).toBe('none')
    expect(shapeOf(SAMPLES.between)).toBe('range')
    expect(shapeOf(SAMPLES.is_one_of)).toBe('values')
    expect(shapeOf(SAMPLES.older_than)).toBe('duration')
    expect(shapeOf(SAMPLES.in_relative)).toBe('preset')
  })
})

describe('arity is enforced at the boundary', () => {
  it('refuses a value on a no-payload operator', () => {
    const result = parseFilter({ field: 'city', op: 'is_empty', value: 'munich' })
    expect(result.ok).toBe(false)
  })

  it('refuses a between missing its second bound', () => {
    const result = parseFilter({ field: 'check_size', op: 'between', from: '1' })
    expect(result.ok).toBe(false)
  })

  it('refuses an empty value list', () => {
    expect(parseFilter({ field: 'job_role', op: 'is_one_of', values: [] }).ok).toBe(false)
  })

  it('names the unknown operator rather than the missing field', () => {
    const result = parseFilter({ field: 'city', op: 'sounds_like', value: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/discriminator/i)
  })

  it('refuses a filter with no field', () => {
    expect(parseFilter({ op: 'is_empty' }).ok).toBe(false)
    expect(parseFilter({ field: '', op: 'is_empty' }).ok).toBe(false)
  })

  it('refuses an unknown relative preset and an unknown unit', () => {
    expect(parseFilter({ field: 'x', op: 'in_relative', preset: 'next_week' }).ok).toBe(false)
    expect(parseFilter({ field: 'x', op: 'older_than', n: 1, unit: 'fortnight' }).ok).toBe(false)
    expect(parseFilter({ field: 'x', op: 'older_than', n: 1.5, unit: 'day' }).ok).toBe(false)
  })

  it('bounds the payload so a hand-edited URL cannot carry a novel', () => {
    const long = 'x'.repeat(MAX_FILTER_VALUE_LENGTH + 1)
    expect(parseFilter({ field: 'city', op: 'contains', value: long }).ok).toBe(false)
    const many = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => String(i))
    expect(parseFilter({ field: 'job_role', op: 'is_one_of', values: many }).ok).toBe(false)
  })

  it('is exposed as a Zod schema for the API and OpenAPI', () => {
    expect(filterSchema.safeParse(SAMPLES.contains).success).toBe(true)
  })
})

describe('parseFilterSet', () => {
  it('accepts an empty set', () => {
    expect(unwrap(parseFilterSet([]))).toEqual([])
  })

  it('accepts a realistic set', () => {
    const set = [SAMPLES.is_one_of, SAMPLES.contains, SAMPLES.older_than]
    expect(unwrap(parseFilterSet(set))).toEqual(set)
  })

  it('refuses more filters than the planner handles well', () => {
    const many = Array.from({ length: MAX_FILTERS + 1 }, () => SAMPLES.is_empty)
    const result = parseFilterSet(many)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('too_many_filters')
  })

  it('refuses a non-array', () => {
    expect(parseFilterSet({ all: [] }).ok).toBe(false)
  })

  it('points at the offending element', () => {
    const result = parseFilterSet([SAMPLES.contains, { field: 'x', op: 'contains' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.path).toEqual([1, 'value'])
  })
})

describe('canonical form', () => {
  it('gives every operator a stable key order', () => {
    for (const op of OPERATORS) {
      const sample = SAMPLES[op]
      expect(JSON.stringify(canonicalFilter(sample))).toBe(
        JSON.stringify(canonicalFilter(canonicalFilter(sample))),
      )
    }
  })

  it('puts field before op, then the payload', () => {
    expect(JSON.stringify(canonicalFilter(SAMPLES.between))).toBe(
      '{"field":"check_size","op":"between","from":"250000","to":"1000000"}',
    )
  })

  it('treats a value list as a set: deduplicated and sorted', () => {
    const a = canonicalFilter({ field: 'job_role', op: 'is_one_of', values: ['investor', 'angel'] })
    const b = canonicalFilter({
      field: 'job_role',
      op: 'is_one_of',
      values: ['angel', 'investor', 'angel'],
    })
    expect(a).toEqual(b)
    expect(a).toEqual({ field: 'job_role', op: 'is_one_of', values: ['angel', 'investor'] })
  })

  it('orders the set, because AND is commutative and dirtiness is deep equality', () => {
    const forwards = canonicalFilterSet([SAMPLES.is_one_of, SAMPLES.contains])
    const backwards = canonicalFilterSet([SAMPLES.contains, SAMPLES.is_one_of])
    expect(forwards).toEqual(backwards)
  })

  it('does not lose a filter while ordering', () => {
    const set = [SAMPLES.contains, SAMPLES.is_empty, SAMPLES.between, SAMPLES.older_than]
    expect(canonicalFilterSet(set)).toHaveLength(4)
  })

  it('survives a round-trip through JSON unchanged', () => {
    const set = canonicalFilterSet(Object.values(SAMPLES).slice(0, MAX_FILTERS))
    const reparsed = unwrap(parseFilterSet(JSON.parse(JSON.stringify(set))))
    expect(canonicalFilterSet(reparsed)).toEqual(set)
  })

  it('keeps values with commas, colons, percent signs and emoji intact', () => {
    const awkward: Filter = {
      field: 'notes',
      op: 'contains',
      value: 'a,b:c%d+e "f" \\g 🌱',
    }
    const reparsed = unwrap(parseFilter(JSON.parse(JSON.stringify(canonicalFilter(awkward)))))
    expect(reparsed).toEqual(awkward)
  })
})

describe('the exhaustiveness guard', () => {
  it('throws on an operator the union does not know', () => {
    expect(() => canonicalFilter({ field: 'x', op: 'wat' } as unknown as Filter)).toThrow(
      /filter operator/,
    )
  })
})
