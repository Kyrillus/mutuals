import { describe, expect, it } from 'vitest'

import { IDENTIFIER_KINDS, OBJECT_TYPES, VALUE_KINDS, isObjectType, isValueKind } from './kinds.ts'

describe('database enums, mirrored in code', () => {
  it('lists the object types the schema declares', () => {
    expect([...OBJECT_TYPES]).toEqual(['contact', 'organization', 'interaction'])
    expect(isObjectType('contact')).toBe(true)
    expect(isObjectType('follow_up')).toBe(false)
  })

  it('lists the value kinds the schema declares', () => {
    expect([...VALUE_KINDS]).toEqual(['text', 'number', 'date', 'bool', 'option', 'relation'])
    expect(isValueKind('option')).toBe(true)
    expect(isValueKind('geo')).toBe(false)
  })

  it('lists §4.6 identifier kinds', () => {
    expect(IDENTIFIER_KINDS).toContain('email')
    expect(IDENTIFIER_KINDS).toContain('linkedin_url')
    expect(new Set(IDENTIFIER_KINDS).size).toBe(IDENTIFIER_KINDS.length)
  })
})
