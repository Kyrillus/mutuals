import { describe, expect, it } from 'vitest'
import { casefoldForDisplay, dedupeByCasefold } from './casefold.ts'

describe('casefoldForDisplay', () => {
  it('lower-cases, trims and collapses runs of whitespace', () => {
    expect(casefoldForDisplay('  Climate   Tech ')).toBe('climate tech')
    expect(casefoldForDisplay('Climate\tTech\nSeed')).toBe('climate tech seed')
  })

  it('is idempotent', () => {
    const once = casefoldForDisplay(' Deep  Tech ')
    expect(casefoldForDisplay(once)).toBe(once)
  })

  /**
   * The point of the whole module: this is a display convenience, not the filter contract. Text
   * matching is `mutuals_norm()` in SQL and nothing asserts the two agree (ADR-019). Accents
   * surviving here is the *documented* behaviour — pretending to fold them is what would make this
   * look like the filter contract.
   */
  it('does not fold accents, and that is deliberate', () => {
    expect(casefoldForDisplay('Café')).toBe('café')
    expect(casefoldForDisplay('Straßburg')).toBe('straßburg')
    expect(casefoldForDisplay('Łódź')).toBe('łódź')
  })
})

describe('dedupeByCasefold', () => {
  it('keeps the first spelling the user saw', () => {
    expect(dedupeByCasefold(['Climate Tech', 'climate tech', 'CLIMATE  TECH'])).toEqual([
      'Climate Tech',
    ])
  })

  it('keeps genuinely different suggestions', () => {
    expect(dedupeByCasefold(['Seed', 'Series A', 'seed'])).toEqual(['Seed', 'Series A'])
  })

  it('drops blanks', () => {
    expect(dedupeByCasefold(['', '   ', 'Angel'])).toEqual(['Angel'])
  })

  it('leaves an empty list empty', () => {
    expect(dedupeByCasefold([])).toEqual([])
  })
})
