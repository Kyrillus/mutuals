/**
 * The brief's §4.2 table, transcribed once.
 *
 * This is the only place the table is written down a second time, and it exists so that changing a
 * type's operator list, its sort semantics or its storage is a deliberate two-file edit rather
 * than an accident. All four columns of all twelve rows are asserted.
 */
import { describe, expect, it } from 'vitest'

import { VALUE_KIND_BY_ATTRIBUTE_TYPE, VALUE_KINDS, type ValueKind } from './kinds.ts'
import { OPERATORS, isOperatorId, type OperatorId } from './operators.ts'
import {
  ATTRIBUTE_TYPES,
  REGISTRY,
  anyTypeDef,
  isAttributeType,
  isMultiCardinality,
  isMultiValued,
  isSortableType,
  operatorsFor,
  sortSpecFor,
  typeDef,
  valueKindOf,
  type AttributeType,
} from './registry.ts'
import { SLOT_COLUMNS } from './slots.ts'
import type { AttributeUi, Cardinality, SortSpec } from './types/def.ts'

interface BriefRow {
  readonly type: AttributeType
  /** Column 1, "Stored as". */
  readonly storedAs: { readonly valueKind: ValueKind; readonly multi: boolean | 'from-config' }
  /** Column 2, "UI". */
  readonly ui: AttributeUi
  /** Column 3, "Filter operators", verbatim. `is_empty` implies its complement. */
  readonly operators: readonly OperatorId[]
  /** Column 4, "Sort". `null` is the brief's dash. */
  readonly sort: SortSpec | null
}

const BRIEF_TABLE: readonly BriefRow[] = [
  {
    type: 'short_text',
    storedAs: { valueKind: 'text', multi: false },
    ui: 'text_input',
    operators: ['contains', 'equals', 'is_empty'],
    sort: { via: 'slot', column: SLOT_COLUMNS.text.sort },
  },
  {
    type: 'long_text',
    storedAs: { valueKind: 'text', multi: false },
    ui: 'textarea',
    operators: ['contains', 'is_empty'],
    sort: null,
  },
  {
    type: 'number',
    storedAs: { valueKind: 'number', multi: false },
    ui: 'number_input',
    operators: ['eq', 'neq', 'lt', 'gt', 'between', 'is_empty'],
    sort: { via: 'slot', column: SLOT_COLUMNS.number.sort },
  },
  {
    type: 'date',
    storedAs: { valueKind: 'date', multi: false },
    ui: 'date_picker',
    // "before, after, between, is empty; relative shortcuts (last 30 days, this year)" — the
    // relative shortcuts are `in_relative` plus the two open-ended forms a saved view needs.
    operators: [
      'before',
      'after',
      'between',
      'in_relative',
      'older_than',
      'newer_than',
      'is_empty',
    ],
    sort: { via: 'slot', column: SLOT_COLUMNS.date.sort },
  },
  {
    type: 'yes_no',
    storedAs: { valueKind: 'bool', multi: false },
    ui: 'switch',
    operators: ['is_yes', 'is_no', 'is_empty'],
    // "yes first": an ascending click has to emit DESC.
    sort: { via: 'slot', column: SLOT_COLUMNS.bool.sort, invert: true },
  },
  {
    type: 'single_select',
    storedAs: { valueKind: 'option', multi: false },
    ui: 'select',
    operators: ['is_one_of', 'is_not_one_of', 'is_empty'],
    sort: { via: 'option-position' },
  },
  {
    type: 'multi_select',
    storedAs: { valueKind: 'option', multi: true },
    ui: 'multi_select',
    operators: ['contains_any_of', 'contains_all_of', 'is_empty'],
    sort: null,
  },
  {
    type: 'tags',
    storedAs: { valueKind: 'text', multi: true },
    ui: 'tag_input',
    operators: ['contains_any_of', 'is_empty'],
    sort: null,
  },
  {
    type: 'url',
    storedAs: { valueKind: 'text', multi: false },
    ui: 'url_input',
    operators: ['contains', 'is_empty'],
    sort: null,
  },
  {
    type: 'email',
    storedAs: { valueKind: 'text', multi: false },
    ui: 'email_input',
    operators: ['contains', 'is_empty'],
    sort: { via: 'slot', column: SLOT_COLUMNS.text.sort },
  },
  {
    type: 'phone',
    storedAs: { valueKind: 'text', multi: false },
    ui: 'phone_input',
    operators: ['contains', 'is_empty'],
    sort: null,
  },
  {
    type: 'relation',
    storedAs: { valueKind: 'relation', multi: 'from-config' },
    ui: 'record_picker',
    operators: ['has_any_of', 'is_empty'],
    sort: null,
  },
]

/**
 * The brief writes "is empty"; the product ships its complement too, because a filter chip that
 * cannot be negated forces the user to think in double negatives. Expanding it here keeps the
 * transcription above literal.
 */
function expected(row: BriefRow): readonly OperatorId[] {
  return row.operators.flatMap((op) => (op === 'is_empty' ? ['is_empty', 'is_not_empty'] : [op]))
}

describe('registry', () => {
  it('holds exactly the twelve types the brief names', () => {
    expect([...ATTRIBUTE_TYPES].sort()).toEqual([...BRIEF_TABLE.map((r) => r.type)].sort())
    expect(Object.keys(REGISTRY).sort()).toEqual([...ATTRIBUTE_TYPES].sort())
  })

  it('keys every entry by its own type', () => {
    for (const type of ATTRIBUTE_TYPES) expect(anyTypeDef(type).type).toBe(type)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true)
    expect(Object.isFrozen(ATTRIBUTE_TYPES)).toBe(true)
  })

  it('recognises its own type names and nothing else', () => {
    expect(isAttributeType('short_text')).toBe(true)
    expect(isAttributeType('rating')).toBe(false)
  })
})

describe('brief §4.2, row by row', () => {
  it.each(BRIEF_TABLE)('$type stores as the documented kind and cardinality', (row) => {
    const definition = anyTypeDef(row.type)
    expect(definition.valueKind).toBe(row.storedAs.valueKind)
    expect(valueKindOf(row.type)).toBe(row.storedAs.valueKind)

    if (row.storedAs.multi === 'from-config') {
      expect(definition.cardinality).toBe('from-config')
    } else {
      expect(definition.cardinality).toBe(row.storedAs.multi ? 'multi' : 'single')
    }
  })

  it.each(BRIEF_TABLE)('$type renders with the documented control', (row) => {
    expect(anyTypeDef(row.type).ui).toBe(row.ui)
  })

  it.each(BRIEF_TABLE)('$type offers exactly the documented filter operators', (row) => {
    expect(operatorsFor(row.type)).toEqual(expected(row))
  })

  it.each(BRIEF_TABLE)('$type sorts as the brief describes', (row) => {
    expect(sortSpecFor(row.type)).toEqual(row.sort)
    expect(isSortableType(row.type)).toBe(row.sort !== null)
  })
})

describe('registry invariants the database also enforces', () => {
  it('matches the ad_kind_matches_type CHECK', () => {
    expect(Object.keys(VALUE_KIND_BY_ATTRIBUTE_TYPE).sort()).toEqual([...ATTRIBUTE_TYPES].sort())
    for (const type of ATTRIBUTE_TYPES) {
      expect(anyTypeDef(type).valueKind).toBe(VALUE_KIND_BY_ATTRIBUTE_TYPE[type])
      expect(VALUE_KINDS).toContain(anyTypeDef(type).valueKind)
    }
  })

  it('matches the ad_multi_matches_type CHECK', () => {
    const alwaysMulti = ATTRIBUTE_TYPES.filter((t) => anyTypeDef(t).cardinality === 'multi')
    expect([...alwaysMulti].sort()).toEqual(['multi_select', 'tags'])
    const fromConfig = ATTRIBUTE_TYPES.filter((t) => anyTypeDef(t).cardinality === 'from-config')
    expect(fromConfig).toEqual(['relation'])
  })

  it('uses only operators from the closed vocabulary', () => {
    for (const type of ATTRIBUTE_TYPES) {
      for (const operator of operatorsFor(type)) expect(isOperatorId(operator)).toBe(true)
    }
    expect(new Set(OPERATORS).size).toBe(OPERATORS.length)
    expect(isOperatorId('sounds_like')).toBe(false)
  })

  it('derives relation cardinality from config and everything else from the type', () => {
    expect(
      isMultiValued('relation', { targetObjectType: 'organization', cardinality: 'many' }),
    ).toBe(true)
    expect(
      isMultiValued('relation', { targetObjectType: 'organization', cardinality: 'one' }),
    ).toBe(false)
    expect(isMultiValued('tags', {})).toBe(true)
    expect(isMultiValued('multi_select', {})).toBe(true)
    expect(isMultiValued('short_text', {})).toBe(false)
  })

  it('refuses a cardinality nobody has taught it about', () => {
    // The compile-time half of this is `assertNever`; this is the runtime half.
    expect(() => isMultiCardinality('quantum' as Cardinality, {})).toThrow(/Unhandled cardinality/)
  })

  it('gives a call site that names its type the precise definition', () => {
    // Compile-time: `typeDef('number')` keeps the number config, so `decimals` is known here.
    const parsed = typeDef('number').configSchema.parse({ decimals: 2 })
    expect(parsed.decimals).toBe(2)
    expect(typeDef('relation').cardinality).toBe('from-config')
  })
})
