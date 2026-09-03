import { describe, expect, it } from 'vitest'
import {
  ARITY_BY_SHAPE,
  ATTRIBUTE_TYPE_NAMES,
  DATE_METRIC_OPERATORS,
  NUMERIC_METRIC_OPERATORS,
  OPERATORS,
  OPERATORS_BY_TYPE,
  OPERATOR_SHAPE_BY_ID,
  isOperatorAllowed,
  isOperatorId,
  operatorArity,
  operatorShape,
  type OperatorId,
} from './operators.ts'

describe('the operator vocabulary', () => {
  it('has no duplicates', () => {
    expect(new Set(OPERATORS).size).toBe(OPERATORS.length)
  })

  it('assigns a payload shape to every operator', () => {
    for (const op of OPERATORS) {
      expect(OPERATOR_SHAPE_BY_ID[op]).toBeDefined()
      expect(operatorShape(op)).toBe(OPERATOR_SHAPE_BY_ID[op])
    }
  })

  it('assigns an arity to every shape', () => {
    for (const op of OPERATORS) {
      expect(operatorArity(op)).toBe(ARITY_BY_SHAPE[OPERATOR_SHAPE_BY_ID[op]])
    }
    expect(operatorArity('is_empty')).toBe(0)
    expect(operatorArity('contains')).toBe(1)
    expect(operatorArity('in_relative')).toBe(1)
    expect(operatorArity('between')).toBe(2)
    expect(operatorArity('older_than')).toBe(2)
    expect(operatorArity('is_one_of')).toBe(-1)
  })

  it('recognises its own members and nothing else', () => {
    expect(isOperatorId('contains')).toBe(true)
    expect(isOperatorId('in_relative')).toBe(true)
    expect(isOperatorId('sounds_like')).toBe(false)
  })
})

describe('OPERATORS_BY_TYPE', () => {
  it('covers all twelve attribute types', () => {
    expect(Object.keys(OPERATORS_BY_TYPE).sort()).toEqual([...ATTRIBUTE_TYPE_NAMES].sort())
  })

  it('offers only real operators, with no duplicates', () => {
    for (const type of ATTRIBUTE_TYPE_NAMES) {
      const operators: readonly OperatorId[] = OPERATORS_BY_TYPE[type]
      expect(operators.length).toBeGreaterThan(0)
      expect(new Set(operators).size).toBe(operators.length)
      for (const op of operators) expect(isOperatorId(op)).toBe(true)
    }
  })

  /** ADR-017: one definition of "empty", identically for all twelve types. */
  it('offers is_empty on every type', () => {
    for (const type of ATTRIBUTE_TYPE_NAMES) {
      expect(isOperatorAllowed(type, 'is_empty')).toBe(true)
      expect(isOperatorAllowed(type, 'is_not_empty')).toBe(true)
    }
  })

  it('transcribes §4.2 exactly', () => {
    expect(OPERATORS_BY_TYPE.short_text).toEqual(['contains', 'equals', 'is_empty', 'is_not_empty'])
    expect(OPERATORS_BY_TYPE.long_text).toEqual(['contains', 'is_empty', 'is_not_empty'])
    expect(OPERATORS_BY_TYPE.number).toEqual([
      'eq',
      'neq',
      'lt',
      'gt',
      'between',
      'is_empty',
      'is_not_empty',
    ])
    expect(OPERATORS_BY_TYPE.yes_no).toEqual(['is_yes', 'is_no', 'is_empty', 'is_not_empty'])
    expect(OPERATORS_BY_TYPE.single_select).toEqual([
      'is_one_of',
      'is_not_one_of',
      'is_empty',
      'is_not_empty',
    ])
    expect(OPERATORS_BY_TYPE.multi_select).toEqual([
      'contains_any_of',
      'contains_all_of',
      'is_empty',
      'is_not_empty',
    ])
    expect(OPERATORS_BY_TYPE.tags).toEqual(['contains_any_of', 'is_empty', 'is_not_empty'])
    expect(OPERATORS_BY_TYPE.relation).toEqual(['has_any_of', 'is_empty', 'is_not_empty'])
  })

  it('gives dates the relative operators a saved view needs', () => {
    expect(isOperatorAllowed('date', 'in_relative')).toBe(true)
    expect(isOperatorAllowed('date', 'older_than')).toBe(true)
    expect(isOperatorAllowed('date', 'newer_than')).toBe(true)
  })

  it('refuses an operator the type does not offer', () => {
    expect(isOperatorAllowed('long_text', 'equals')).toBe(false)
    expect(isOperatorAllowed('date', 'contains')).toBe(false)
    expect(isOperatorAllowed('tags', 'contains_all_of')).toBe(false)
  })
})

describe('the derived-column operator sets (§5.2)', () => {
  it('lets a number metric be compared and ranged, with no empty state', () => {
    expect(NUMERIC_METRIC_OPERATORS).toEqual(['eq', 'neq', 'lt', 'gt', 'between'])
    expect(NUMERIC_METRIC_OPERATORS).not.toContain('is_empty')
  })

  /** "Last interaction is more than 90 days ago" is the seeded view the brief names in §6.2. */
  it('lets a date metric express "more than 90 days ago"', () => {
    expect(DATE_METRIC_OPERATORS).toContain('older_than')
    expect(DATE_METRIC_OPERATORS).toContain('is_empty')
  })

  it('uses only real operators', () => {
    for (const op of [...NUMERIC_METRIC_OPERATORS, ...DATE_METRIC_OPERATORS]) {
      expect(isOperatorId(op)).toBe(true)
    }
  })
})
