import { describe, expect, it } from 'vitest'

import {
  addTags,
  containsTag,
  isNewTag,
  parseTagInput,
  removeTag,
  suggestTags,
} from './tag-input-model.ts'

const KNOWN = ['Energy', 'Biotech', 'Open source', 'Health tech']

describe('creating a tag inline', () => {
  it('adds a value nobody has used before — §4.2 without a trip to Settings', () => {
    const result = addTags(['Energy'], 'Climate', KNOWN)
    expect(result.tags).toEqual(['Energy', 'Climate'])
    expect(result.added).toEqual(['Climate'])
    expect(result.created).toEqual(['Climate'])
  })

  it('reuses an existing value rather than reporting it as new', () => {
    const result = addTags(['Energy'], 'Biotech', KNOWN)
    expect(result.tags).toEqual(['Energy', 'Biotech'])
    expect(result.added).toEqual(['Biotech'])
    expect(result.created).toEqual([])
  })

  it('does not add the same tag twice, whatever the case', () => {
    const result = addTags(['Energy'], 'energy', KNOWN)
    expect(result.tags).toEqual(['Energy'])
    expect(result.added).toEqual([])
  })

  it('splits a pasted cell into several tags', () => {
    const result = addTags([], 'Energy, Biotech; Open source', KNOWN)
    expect(result.tags).toEqual(['Energy', 'Biotech', 'Open source'])
    expect(result.created).toEqual([])
  })

  it('ignores empty fragments and surrounding space', () => {
    expect(parseTagInput('  Energy ,, ; Biotech ')).toEqual(['Energy', 'Biotech'])
    expect(addTags([], '   ', KNOWN).tags).toEqual([])
  })

  it('leaves the list untouched when everything typed is already on the record', () => {
    const current = ['Energy', 'Biotech']
    const result = addTags(current, 'energy; BIOTECH', KNOWN)
    expect(result.tags).toEqual(current)
    expect(result.added).toEqual([])
  })
})

describe('isNewTag', () => {
  it('is true only for something in neither list', () => {
    expect(isNewTag(KNOWN, ['Energy'], 'Climate')).toBe(true)
    expect(isNewTag(KNOWN, ['Energy'], 'biotech')).toBe(false)
    expect(isNewTag(KNOWN, ['Energy'], 'ENERGY')).toBe(false)
    expect(isNewTag(KNOWN, [], '   ')).toBe(false)
  })
})

describe('suggestTags', () => {
  it('offers existing values that match, best prefix first', () => {
    expect(suggestTags(KNOWN, [], 'e')).toEqual(['Energy', 'Health tech', 'Open source', 'Biotech'])
  })

  it('never offers something the record already has', () => {
    expect(suggestTags(KNOWN, ['Energy'], 'e')).toEqual(['Health tech', 'Open source', 'Biotech'])
  })

  it('offers everything when nothing has been typed', () => {
    expect(suggestTags(KNOWN, [], '')).toEqual(KNOWN.slice().sort((a, b) => a.localeCompare(b)))
  })

  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, index) => `tag-${String(index)}`)
    expect(suggestTags(many, [], 'tag')).toHaveLength(8)
    expect(suggestTags(many, [], 'tag', 3)).toHaveLength(3)
  })
})

describe('removeTag', () => {
  it('removes by identity, not by exact spelling', () => {
    expect(removeTag(['Energy', 'Biotech'], 'energy')).toEqual(['Biotech'])
  })

  it('is a no-op for something that is not there', () => {
    expect(removeTag(['Energy'], 'Climate')).toEqual(['Energy'])
  })
})

describe('containsTag', () => {
  it('ignores case and surrounding space', () => {
    expect(containsTag(['Open source'], '  open SOURCE ')).toBe(true)
    expect(containsTag(['Open source'], 'opensource')).toBe(false)
  })
})
