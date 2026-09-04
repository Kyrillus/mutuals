import { civil, decimal } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import {
  formatCivilDate,
  formatDateTime,
  formatNumber,
  formatPhone,
  formatRelativeDay,
  mailtoHref,
  phoneHref,
  prettyUrl,
} from './format.ts'

const TODAY = civil('2026-09-04')

describe('formatNumber', () => {
  it('honours the unit and the decimals a number attribute was configured with', () => {
    expect(formatNumber(decimal('250000.5'), { unit: '€', decimals: 2 }, 'en-GB')).toBe(
      '250,000.50 €',
    )
  })

  it('rounds for display only, half away from zero', () => {
    expect(formatNumber(decimal('1.005'), { decimals: 2 }, 'en-GB')).toBe('1.01')
    expect(formatNumber(decimal('1.004'), { decimals: 2 }, 'en-GB')).toBe('1.00')
  })

  it('shows every stored digit when no decimals are configured', () => {
    expect(formatNumber(decimal('1250.7500'), {}, 'en-GB')).toBe('1,250.7500')
  })

  it('groups for the locale rather than for the developer', () => {
    expect(formatNumber(decimal('1234567'), { decimals: 0 }, 'de-DE')).toBe('1.234.567')
  })

  it('never goes through a float', () => {
    // 2^53 + 1. A JS number cannot hold this; the string can.
    expect(formatNumber(decimal('9007199254740993'), { decimals: 0 }, 'en-GB')).toBe(
      '9,007,199,254,740,993',
    )
  })

  it('leaves an empty unit off rather than leaving a trailing space', () => {
    expect(formatNumber(decimal('42'), { unit: '' }, 'en-GB')).toBe('42')
  })
})

describe('formatRelativeDay', () => {
  it('says "3 weeks ago" — §6.2 asks for this exact shape', () => {
    expect(formatRelativeDay(civil('2026-08-14'), TODAY, 'en-GB')).toBe('3 weeks ago')
  })

  it('uses the near words for the near days', () => {
    expect(formatRelativeDay(TODAY, TODAY, 'en-GB')).toBe('today')
    expect(formatRelativeDay(civil('2026-09-03'), TODAY, 'en-GB')).toBe('yesterday')
    expect(formatRelativeDay(civil('2026-09-05'), TODAY, 'en-GB')).toBe('tomorrow')
    expect(formatRelativeDay(civil('2026-08-30'), TODAY, 'en-GB')).toBe('5 days ago')
  })

  it('steps up a unit as the distance grows', () => {
    expect(formatRelativeDay(civil('2026-08-28'), TODAY, 'en-GB')).toBe('last week')
    expect(formatRelativeDay(civil('2026-06-04'), TODAY, 'en-GB')).toBe('3 months ago')
    expect(formatRelativeDay(civil('2023-09-04'), TODAY, 'en-GB')).toBe('3 years ago')
  })

  it('reads forwards too, which is what a follow-up date needs', () => {
    expect(formatRelativeDay(civil('2026-09-25'), TODAY, 'en-GB')).toBe('in 3 weeks')
  })

  it('is stated in the profile language, not in English', () => {
    expect(formatRelativeDay(civil('2026-08-14'), TODAY, 'de-DE')).toBe('vor 3 Wochen')
  })
})

describe('formatCivilDate', () => {
  it('renders the day that was stored, west of Greenwich included', () => {
    expect(formatCivilDate('1991-11-03', 'en-GB')).toBe('3 Nov 1991')
  })

  it('follows the locale', () => {
    expect(formatCivilDate('1991-11-03', 'en-US')).toBe('Nov 3, 1991')
  })
})

describe('formatDateTime', () => {
  it('renders an instant in the profile timezone', () => {
    const iso = '2026-07-25T17:05:00.000Z'
    expect(formatDateTime(iso, 'en-GB', 'UTC')).toContain('17:05')
    expect(formatDateTime(iso, 'en-GB', 'Europe/Berlin')).toContain('19:05')
  })
})

describe('formatPhone', () => {
  it('separates the country calling code and nothing else', () => {
    expect(formatPhone('+49160100462')).toBe('+49 160100462')
    expect(formatPhone('+12125550123')).toBe('+1 2125550123')
    expect(formatPhone('+35812345678')).toBe('+358 12345678')
    expect(formatPhone('+79161234567')).toBe('+7 9161234567')
  })

  it('leaves a number the write path could not normalise exactly as it was typed', () => {
    expect(formatPhone('0160 100 462')).toBe('0160 100 462')
    expect(formatPhone('  (030) 12 34 56 ')).toBe('(030) 12 34 56')
  })
})

describe('phoneHref', () => {
  it('dials the digits, not the punctuation', () => {
    expect(phoneHref('+49 160 100462')).toBe('tel:+49160100462')
    expect(phoneHref('(030) 123456')).toBe('tel:030123456')
  })

  it('refuses something with too few digits to be a number', () => {
    expect(phoneHref('n/a')).toBeUndefined()
    expect(phoneHref('123')).toBeUndefined()
  })
})

describe('prettyUrl', () => {
  it('shows the name rather than the address', () => {
    expect(prettyUrl('https://www.linkedin.com/in/anna')).toBe('linkedin.com/in/anna')
    expect(prettyUrl('http://example.com/')).toBe('example.com')
    expect(prettyUrl('https://sub.example.com/a/b?c=d')).toBe('sub.example.com/a/b?c=d')
  })
})

describe('mailtoHref', () => {
  it('is a mailto link', () => {
    expect(mailtoHref('anna@example.com')).toBe('mailto:anna@example.com')
  })
})
