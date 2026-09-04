import { ATTRIBUTE_TYPES } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { ATTRIBUTE_TYPE_CHOICES, typeIcon, typeLabel, typeMeta } from './type-meta.ts'

describe('the type picker is the registry', () => {
  it('offers exactly the types the registry declares, in its order', () => {
    expect(ATTRIBUTE_TYPE_CHOICES.map((choice) => choice.type)).toEqual([...ATTRIBUTE_TYPES])
  })

  it('gives every type a label, a description and an icon', () => {
    for (const type of ATTRIBUTE_TYPES) {
      const meta = typeMeta(type)
      expect(meta.label).not.toBe('')
      expect(meta.description).not.toBe('')
      expect(meta.icon).toBeDefined()
    }
  })

  it('describes short_text and long_text differently enough to choose between them', () => {
    expect(typeMeta('short_text').description).not.toBe(typeMeta('long_text').description)
  })

  it('gives no two types the same label', () => {
    const labels = ATTRIBUTE_TYPES.map((type) => typeMeta(type).label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('the wire types `type` as a plain string', () => {
  it('labels a known type', () => {
    expect(typeLabel('single_select')).toBe('Single select')
  })

  it('passes an unknown one through rather than rendering nothing', () => {
    expect(typeLabel('rich_text')).toBe('rich_text')
    expect(typeIcon('rich_text')).toBeUndefined()
  })
})
