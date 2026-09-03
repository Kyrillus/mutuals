import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { normalizePhone } from './phone.ts'

describe('normalizePhone', () => {
  it('normalises an international number with no region set', () => {
    expect(unwrap(normalizePhone('+49 89 1234567'))).toEqual({
      e164: '+49891234567',
      national: '089 1234567',
      region: 'DE',
      valid: true,
    })
  })

  it('normalises a national number using the profile region', () => {
    expect(unwrap(normalizePhone('089 1234567', { defaultRegion: 'DE' })).e164).toBe('+49891234567')
    expect(unwrap(normalizePhone('(213) 373-4253', { defaultRegion: 'US' })).e164).toBe(
      '+12133734253',
    )
    expect(unwrap(normalizePhone('0176 12345678', { defaultRegion: 'DE' })).e164).toBe(
      '+4917612345678',
    )
  })

  it('ignores the region when the number carries its own country code', () => {
    expect(unwrap(normalizePhone('+1 213 373 4253', { defaultRegion: 'DE' })).region).toBe('US')
  })

  /**
   * ADR-045: there is no such thing as a national number without a country, so this is a distinct
   * issue code — the UI can offer to set a default region, which "not a phone number" cannot.
   */
  it('says a national number is ambiguous when no region is configured', () => {
    const result = normalizePhone('089 1234567')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('ambiguous_national_number')
      expect(result.issues[0]?.message).toMatch(/country code/i)
    }
  })

  it('rejects text that is not a number', () => {
    const result = normalizePhone('call me maybe', { defaultRegion: 'DE' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('invalid_phone')
  })

  it('rejects a number that is too short to be real', () => {
    expect(normalizePhone('+49 1', { defaultRegion: 'DE' }).ok).toBe(false)
  })

  it('rejects a region that is not a country', () => {
    const result = normalizePhone('089 1234567', { defaultRegion: 'XX' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('invalid_phone')
  })

  it('asks for input when the field is blank', () => {
    const result = normalizePhone('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('required')
  })

  it('is idempotent on its own E.164 output', () => {
    const once = unwrap(normalizePhone('089 1234567', { defaultRegion: 'DE' }))
    expect(unwrap(normalizePhone(once.e164))).toEqual(once)
  })

  /**
   * The `/min` metadata cannot separate a German mobile from a landline, and returns
   * FIXED_LINE_OR_MOBILE for the US (ADR-035). The duplicate scorer is built on that fact rather
   * than on a distinction that only exists in some numbering plans.
   */
  it('does not expose a line type, because /min has none to expose', () => {
    const parsed = unwrap(normalizePhone('0176 12345678', { defaultRegion: 'DE' }))
    expect(Object.keys(parsed).sort()).toEqual(['e164', 'national', 'region', 'valid'])
  })
})
