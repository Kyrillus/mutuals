import { describe, expect, it } from 'vitest'

import { normalizeHeader, trigramSimilarity, trigrams } from './header.ts'

describe('normalizeHeader', () => {
  it('folds accents, unlike the display casefold', () => {
    expect(normalizeHeader('Prénom')).toBe('prenom')
    expect(normalizeHeader('Vorname / Prénom')).toBe('vorname prenom')
  })

  it('treats underscores, hyphens and dots as spaces (ADR-044s pre-step)', () => {
    expect(normalizeHeader('first_name')).toBe('first name')
    expect(normalizeHeader('E-Mail')).toBe('e mail')
    expect(normalizeHeader('Address 1 - Value')).toBe('address 1 value')
  })

  it('is idempotent, so a normalised header can be normalised again', () => {
    const once = normalizeHeader('  Organization__Name  ')
    expect(normalizeHeader(once)).toBe(once)
    expect(once).toBe('organization name')
  })

  it('reduces a header of pure punctuation to the empty string', () => {
    expect(normalizeHeader('---')).toBe('')
    expect(normalizeHeader('')).toBe('')
  })
})

describe('trigrams', () => {
  it('pads each word with two leading spaces and one trailing, like pg_trgm', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'])
  })

  it('is a set: a repeated trigram is counted once', () => {
    expect(trigrams('aaaa').size).toBe(4) // "  a", " aa", "aaa", "aa "
  })
})

/**
 * Measured against Postgres 16's `similarity()`, not derived from this implementation. ADR-044
 * makes 0.72 part of the contract, so the function has to be pg_trgm's and not merely similar —
 * and the day someone "optimises" this, these numbers are what tells them they changed the
 * contract. Postgres returns `real`, so the comparison is to float32 precision.
 */
describe('trigramSimilarity agrees with Postgres 16', () => {
  const measured: readonly [string, string, number][] = [
    ['word', 'two words', 0.36363637],
    ['email address', 'email', 0.42857143],
    ['first name', 'first name', 1],
    ['connected on', 'created at', 0.14285715],
    ['e mail', 'email', 0.44444445],
    ['telephone', 'phone', 0.33333334],
    ['birthday', 'birth date', 0.33333334],
    ['linked in', 'linkedin', 0.5833333],
    ['notes', 'note', 0.5714286],
    ['web site', 'website', 0.54545456],
    ['nachname', 'name', 0.5555556],
  ]

  for (const [left, right, expected] of measured) {
    it(`similarity('${left}', '${right}') = ${expected}`, () => {
      expect(trigramSimilarity(left, right)).toBeCloseTo(expected, 6)
    })
  }

  it('is symmetric', () => {
    expect(trigramSimilarity('email address', 'email')).toBe(
      trigramSimilarity('email', 'email address'),
    )
  })

  it('scores an empty header 0 rather than dividing by zero', () => {
    expect(trigramSimilarity('---', 'email')).toBe(0)
    expect(trigramSimilarity('email', '')).toBe(0)
  })

  /**
   * The two pairs the import most needs to get right share **no trigram at all**. Trigram matching
   * cannot find either, at any threshold — which is why steps 3 and 4 of ADR-044's cascade (preset
   * knowledge and the synonym table) are load-bearing rather than a nicety, and why lowering 0.72
   * would not help.
   */
  it('scores the two most important header pairs at exactly zero', () => {
    expect(trigramSimilarity('company', 'organization')).toBe(0)
    expect(trigramSimilarity('position', 'job role')).toBe(0)
  })
})
