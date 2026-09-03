import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import {
  addDays,
  addMonths,
  civil,
  civilFromParts,
  civilIn,
  civilParts,
  compareCivil,
  dayOfMonth,
  daysInMonth,
  diffDays,
  endOfYear,
  isCivilDate,
  parseCivil,
  startOfYear,
  todayIn,
} from './civil.ts'

describe('daysInMonth', () => {
  it('knows the ordinary months', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 6)).toBe(30)
    expect(daysInMonth(2026, 9)).toBe(30)
    expect(daysInMonth(2026, 11)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('applies the full Gregorian leap rule', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
  })
})

describe('isCivilDate', () => {
  it('accepts a real day', () => {
    expect(isCivilDate('2026-09-03')).toBe(true)
    expect(isCivilDate('2024-02-29')).toBe(true)
  })

  it('rejects a day that does not exist', () => {
    expect(isCivilDate('2026-02-30')).toBe(false)
    expect(isCivilDate('2026-02-29')).toBe(false)
    expect(isCivilDate('2026-13-01')).toBe(false)
    expect(isCivilDate('2026-00-01')).toBe(false)
    expect(isCivilDate('2026-01-00')).toBe(false)
  })

  it('rejects anything that is not the exact shape', () => {
    expect(isCivilDate('2026-9-3')).toBe(false)
    expect(isCivilDate('03/09/2026')).toBe(false)
    expect(isCivilDate('2026-09-03T00:00:00Z')).toBe(false)
    expect(isCivilDate('')).toBe(false)
  })
})

describe('parseCivil', () => {
  it('accepts and trims a well-formed date', () => {
    expect(unwrap(parseCivil('  2026-09-03 '))).toBe('2026-09-03')
  })

  it('asks for a date when the input is blank', () => {
    const result = parseCivil('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('required')
  })

  it('refuses 30 February rather than rolling it into March', () => {
    const result = parseCivil('2026-02-30')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('bad_date')
  })
})

describe('civil', () => {
  it('accepts a literal', () => {
    expect(civil('2026-09-03')).toBe('2026-09-03')
  })

  it('throws on a bad literal, because that is a programmer error', () => {
    expect(() => civil('nope')).toThrow(/Not a civil date/)
  })
})

describe('civilFromParts', () => {
  it('zero-pads', () => {
    expect(civilFromParts(2026, 9, 3)).toBe('2026-09-03')
  })

  it('clamps the day to the length of the month', () => {
    expect(civilFromParts(2026, 2, 31)).toBe('2026-02-28')
    expect(civilFromParts(2024, 2, 31)).toBe('2024-02-29')
    expect(civilFromParts(2026, 4, 31)).toBe('2026-04-30')
    expect(civilFromParts(2026, 4, 0)).toBe('2026-04-01')
  })

  it('rejects nonsense parts', () => {
    expect(() => civilFromParts(2026, 13, 1)).toThrow(/Month out of range/)
    expect(() => civilFromParts(2026.5, 1, 1)).toThrow(/must be integers/)
  })
})

describe('civilParts and dayOfMonth', () => {
  it('reads the components back', () => {
    expect(civilParts(civil('2026-09-03'))).toEqual({ year: 2026, month: 9, day: 3 })
    expect(dayOfMonth(civil('2026-01-31'))).toBe(31)
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays(civil('2026-01-31'), 1)).toBe('2026-02-01')
  })

  it('crosses a year boundary in both directions', () => {
    expect(addDays(civil('2026-12-31'), 1)).toBe('2027-01-01')
    expect(addDays(civil('2026-01-01'), -1)).toBe('2025-12-31')
  })

  it('crosses a leap day', () => {
    expect(addDays(civil('2024-02-28'), 1)).toBe('2024-02-29')
    expect(addDays(civil('2026-02-28'), 1)).toBe('2026-03-01')
  })

  // Date.UTC maps years 0-99 onto 1900-1999. Nobody has a birthday in year 50, but a mistyped
  // import cell reaches this arithmetic, and silently landing in 1950 is worse than being wrong.
  it('does not fold a two-digit year into the twentieth century', () => {
    expect(civilFromParts(50, 1, 1)).toBe('0050-01-01')
    expect(addDays(civil('0050-01-01'), 1)).toBe('0050-01-02')
    expect(diffDays(civil('0050-01-02'), civil('0050-01-01'))).toBe(1)
  })

  // A DST transition moves an instant, not a calendar day: civil arithmetic must not notice.
  it('is unaffected by a DST transition', () => {
    expect(addDays(civil('2026-03-28'), 1)).toBe('2026-03-29')
    expect(addDays(civil('2026-10-24'), 1)).toBe('2026-10-25')
  })
})

describe('addMonths', () => {
  it('clamps to the length of the target month', () => {
    expect(addMonths(civil('2026-01-31'), 1)).toBe('2026-02-28')
    expect(addMonths(civil('2026-03-31'), -1)).toBe('2026-02-28')
  })

  it('honours the series anchor, so one February does not demote the chain', () => {
    expect(addMonths(civil('2026-02-28'), 1, 31)).toBe('2026-03-31')
  })

  it('crosses year boundaries in both directions', () => {
    expect(addMonths(civil('2026-11-15'), 3)).toBe('2027-02-15')
    expect(addMonths(civil('2026-02-15'), -3)).toBe('2025-11-15')
    expect(addMonths(civil('2026-01-15'), -1)).toBe('2025-12-15')
  })
})

describe('diffDays', () => {
  it('counts whole days, signed', () => {
    expect(diffDays(civil('2026-09-03'), civil('2026-09-03'))).toBe(0)
    expect(diffDays(civil('2026-09-03'), civil('2026-08-04'))).toBe(30)
    expect(diffDays(civil('2026-08-04'), civil('2026-09-03'))).toBe(-30)
  })

  it('counts a leap year correctly', () => {
    expect(diffDays(civil('2025-01-01'), civil('2024-01-01'))).toBe(366)
    expect(diffDays(civil('2027-01-01'), civil('2026-01-01'))).toBe(365)
  })
})

describe('compareCivil', () => {
  it('orders chronologically', () => {
    expect(compareCivil(civil('2026-01-01'), civil('2026-01-02'))).toBe(-1)
    expect(compareCivil(civil('2026-01-02'), civil('2026-01-01'))).toBe(1)
    expect(compareCivil(civil('2026-01-01'), civil('2026-01-01'))).toBe(0)
  })
})

describe('startOfYear and endOfYear', () => {
  it('brackets the calendar year', () => {
    expect(startOfYear(civil('2026-09-03'))).toBe('2026-01-01')
    expect(endOfYear(civil('2026-09-03'))).toBe('2026-12-31')
  })
})

describe('civilIn and todayIn', () => {
  // The whole reason `timeZone` is a parameter: the same instant is two different days depending
  // on where the profile says it lives.
  it('resolves one instant to different days in different zones', () => {
    const instant = new Date('2026-09-03T22:30:00Z')
    expect(civilIn('UTC', instant)).toBe('2026-09-03')
    expect(civilIn('Europe/Berlin', instant)).toBe('2026-09-04')
    expect(civilIn('Pacific/Auckland', instant)).toBe('2026-09-04')
    expect(civilIn('America/Los_Angeles', instant)).toBe('2026-09-03')
  })

  it('crosses midnight westwards', () => {
    const instant = new Date('2026-09-04T02:30:00Z')
    expect(civilIn('UTC', instant)).toBe('2026-09-04')
    expect(civilIn('America/New_York', instant)).toBe('2026-09-03')
  })

  it('todayIn is the same function with the injected now', () => {
    const now = new Date('2026-01-01T00:30:00Z')
    expect(todayIn('Europe/Berlin', now)).toBe('2026-01-01')
    expect(todayIn('America/Los_Angeles', now)).toBe('2025-12-31')
  })
})
