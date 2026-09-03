import { describe, expect, it } from 'vitest'

import {
  MAX_FRACTION_DIGITS,
  compareDecimal,
  decimal,
  formatDecimal,
  isDecimalString,
  parseDecimal,
  parseDecimalLoose,
  roundDecimal,
  type DecimalString,
} from './decimal.ts'
import { unwrap } from './result.ts'

const d = (value: string): DecimalString => decimal(value)

describe('the canonical form', () => {
  it('accepts what a numeric column can hold', () => {
    for (const value of ['0', '-1', '250000.50', '1.0000000000', '9'.repeat(30)]) {
      expect(isDecimalString(value), value).toBe(true)
    }
  })

  it('rejects a form that would not round-trip', () => {
    for (const value of [
      '',
      '+1',
      '007',
      '1.',
      '.5',
      '1e9',
      '1,5',
      '9'.repeat(31),
      '1.00000000000',
    ]) {
      expect(isDecimalString(value), value).toBe(false)
    }
  })

  it('throws when a literal is not one', () => {
    expect(() => decimal('1e9')).toThrow(/Not a decimal string/)
  })
})

describe('parseDecimal', () => {
  it('canonicalises the harmless variations', () => {
    expect(unwrap(parseDecimal(' +250000.50 '))).toBe('250000.50')
    expect(unwrap(parseDecimal('007'))).toBe('7')
    expect(unwrap(parseDecimal('-0'))).toBe('0')
    expect(unwrap(parseDecimal('-0.00'))).toBe('0.00')
  })

  it('keeps trailing fractional zeros, because numeric keeps the scale the user typed', () => {
    expect(unwrap(parseDecimal('250000.50'))).toBe('250000.50')
    expect(unwrap(parseDecimal('250000.5'))).toBe('250000.5')
  })

  it('refuses what is not a number at all', () => {
    for (const raw of ['', '   ', 'abc', '1e9', '1,5']) {
      expect(parseDecimal(raw).ok, raw).toBe(false)
    }
  })

  it('refuses more digits than a numeric column is given', () => {
    const result = parseDecimal(`1${'0'.repeat(30)}`)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['out_of_range'])
    expect(parseDecimal(`1.${'0'.repeat(MAX_FRACTION_DIGITS + 1)}`).ok).toBe(false)
  })

  it('enforces bounds', () => {
    const range = { min: d('0'), max: d('100') }
    expect(parseDecimal('-1', range).ok).toBe(false)
    expect(parseDecimal('101', range).ok).toBe(false)
    expect(parseDecimal('100', range).ok).toBe(true)
  })
})

describe('parseDecimalLoose', () => {
  it('reads the German, English and Swiss spellings of the same number', () => {
    expect(unwrap(parseDecimalLoose('1.234.567,89'))).toBe('1234567.89')
    expect(unwrap(parseDecimalLoose('1,234,567.89'))).toBe('1234567.89')
    expect(unwrap(parseDecimalLoose('1 234 567,89'))).toBe('1234567.89')
    expect(unwrap(parseDecimalLoose("1'234'567.89"))).toBe('1234567.89')
    expect(unwrap(parseDecimalLoose('1 234,89'))).toBe('1234.89')
  })

  it('treats a lone separator with other than three trailing digits as a decimal point', () => {
    expect(unwrap(parseDecimalLoose('1,5'))).toBe('1.5')
    expect(unwrap(parseDecimalLoose('1.5'))).toBe('1.5')
    expect(unwrap(parseDecimalLoose('1234,567'))).toBe('1234.567')
    expect(unwrap(parseDecimalLoose('1,2345'))).toBe('1.2345')
  })

  it('refuses the one genuinely ambiguous shape rather than being wrong by a factor of 1000', () => {
    for (const raw of ['1,234', '1.234', '12,345', '123.456']) {
      const result = parseDecimalLoose(raw)
      expect(result.ok, raw).toBe(false)
      expect(result.ok ? undefined : result.issues[0]?.meta?.ambiguous).toBe(true)
    }
  })

  it('refuses anything carrying a symbol or a suffix', () => {
    for (const raw of ['€1.2k', '1.2k', '12%', '', '  ', '1-2', '--5', '1.2.3,4,5']) {
      expect(parseDecimalLoose(raw).ok, raw).toBe(false)
    }
  })

  it('refuses badly grouped digits instead of silently dropping a separator', () => {
    expect(parseDecimalLoose('1,23,456.78').ok).toBe(false)
    expect(parseDecimalLoose('12345,678.9').ok).toBe(false)
  })

  it('reads a leading separator as a fraction', () => {
    expect(unwrap(parseDecimalLoose(',5'))).toBe('0.5')
    expect(unwrap(parseDecimalLoose('-,5'))).toBe('-0.5')
  })

  it('applies the same bounds as the strict parser', () => {
    expect(parseDecimalLoose('1.234,56', { max: d('1000') }).ok).toBe(false)
  })
})

describe('compareDecimal', () => {
  it('orders exactly, without going through a float', () => {
    const big = d('9007199254740993')
    const bigger = d('9007199254740994')
    expect(compareDecimal(big, bigger)).toBe(-1)
    expect(compareDecimal(bigger, big)).toBe(1)
  })

  it('ignores scale when comparing magnitude', () => {
    expect(compareDecimal(d('1.50'), d('1.5'))).toBe(0)
    expect(compareDecimal(d('1.50'), d('1.51'))).toBe(-1)
    expect(compareDecimal(d('10'), d('9'))).toBe(1)
  })

  it('orders negatives the other way round', () => {
    expect(compareDecimal(d('-2'), d('-1'))).toBe(-1)
    expect(compareDecimal(d('-1'), d('-2'))).toBe(1)
    expect(compareDecimal(d('-1'), d('1'))).toBe(-1)
    expect(compareDecimal(d('1'), d('-1'))).toBe(1)
    expect(compareDecimal(d('-1.50'), d('-1.5'))).toBe(0)
  })
})

describe('roundDecimal', () => {
  it('rounds half away from zero', () => {
    expect(roundDecimal(d('250000.50'), 0)).toBe('250001')
    expect(roundDecimal(d('250000.49'), 0)).toBe('250000')
    expect(roundDecimal(d('-2.5'), 0)).toBe('-3')
    expect(roundDecimal(d('9.99'), 1)).toBe('10.0')
    expect(roundDecimal(d('9.99'), 0)).toBe('10')
  })

  it('pads a short value out to the requested scale', () => {
    expect(roundDecimal(d('1'), 2)).toBe('1.00')
    expect(roundDecimal(d('1.5'), 3)).toBe('1.500')
  })

  it('keeps a rounded-away sign from producing a negative zero', () => {
    expect(roundDecimal(d('-0.4'), 0)).toBe('0')
  })

  it('refuses a scale a numeric column cannot hold', () => {
    expect(() => roundDecimal(d('1'), -1)).toThrow(/decimals must be/)
    expect(() => roundDecimal(d('1'), 11)).toThrow(/decimals must be/)
    expect(() => roundDecimal(d('1'), 1.5)).toThrow(/decimals must be/)
  })

  it('refuses to carry past the width of the column', () => {
    expect(() => roundDecimal(d(`${'9'.repeat(30)}.9`), 0)).toThrow(/overflowed/)
  })
})

describe('formatDecimal', () => {
  it('shows every stored digit when no precision is configured', () => {
    expect(formatDecimal(d('250000.50'))).toBe('250000.50')
    expect(formatDecimal(d('100000000000000000000000000001'))).toBe(
      '100000000000000000000000000001',
    )
  })

  it('rounds to a configured precision', () => {
    expect(formatDecimal(d('250000.505'), { decimals: 2 })).toBe('250000.51')
    expect(formatDecimal(d('250000.5'), { decimals: 0 })).toBe('250001')
  })

  it('groups in the requested locale, exactly, without a float in the way', () => {
    expect(formatDecimal(d('250000.50'), { decimals: 2, locale: 'de-DE' })).toBe('250.000,50')
    expect(formatDecimal(d('250000.50'), { decimals: 2, locale: 'en-US' })).toBe('250,000.50')
    expect(formatDecimal(d('9007199254740993'), { locale: 'en-US' })).toBe('9,007,199,254,740,993')
  })

  it('appends a unit, and ignores an empty one', () => {
    expect(formatDecimal(d('1250'), { unit: 'EUR' })).toBe('1250 EUR')
    expect(formatDecimal(d('1250'), { unit: '' })).toBe('1250')
  })
})
