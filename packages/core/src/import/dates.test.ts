import { describe, expect, it } from 'vitest'

import { applyDateFormat, inferDateFormat } from './dates.ts'
import { unwrap } from '../result.ts'

describe('inferDateFormat', () => {
  it('reads an unambiguous ISO column with no warning', () => {
    const result = inferDateFormat(['2024-03-14', '1985-04-17'])
    expect(result).toMatchObject({ format: 'iso', ambiguous: false, conflicting: false })
  })

  it("reads LinkedIn's own spelling", () => {
    const result = inferDateFormat(['14 Mar 2023', '02 Apr 2023', '19 Jan 2022'])
    expect(result).toMatchObject({ format: 'd_mon_y', ambiguous: false })
  })

  /** The whole reason inference looks at every sample rather than the first. */
  it('lets one decisive cell settle a column the first cell could not', () => {
    expect(inferDateFormat(['03/04/2026'])).toMatchObject({ ambiguous: true })
    expect(inferDateFormat(['03/04/2026', '17/06/2026'])).toMatchObject({
      format: 'dmy',
      ambiguous: false,
    })
    expect(inferDateFormat(['03/04/2026', '06/17/2026'])).toMatchObject({
      format: 'mdy',
      ambiguous: false,
    })
  })

  it('defaults a genuine coin-flip to day-first, and says it is a guess', () => {
    const result = inferDateFormat(['03/04/2026', '05/06/2026'])
    expect(result.format).toBe('dmy')
    expect(result.ambiguous).toBe(true)
    expect(result.candidates).toEqual(['dmy', 'mdy'])
  })

  it('calls mixed data conflicting rather than picking a winner', () => {
    const result = inferDateFormat(['2024-03-14', '14 Mar 2023'])
    expect(result).toMatchObject({ format: null, conflicting: true, ambiguous: false })
    expect(result.candidates).toEqual([])
  })

  it('treats a day that does not exist as conflicting, not as another format', () => {
    expect(inferDateFormat(['31/02/2026'])).toMatchObject({ conflicting: true })
  })

  /**
   * ADR-044 asks for a single-sample column to be reported ambiguous. That rule is wrong, and this
   * is the case that shows it: one row of `17/06/2026` has exactly one arithmetic reading, because
   * no month is 17. What matters is whether the fitting formats *disagree*, not how many rows there
   * are — and `iso` and `ymd` both read `2026-03-04`, identically, so two candidates is not
   * ambiguity either.
   */
  it('asks only when the fitting formats actually disagree', () => {
    expect(inferDateFormat(['04/03/2026']).ambiguous).toBe(true)
    expect(inferDateFormat(['17/06/2026']).ambiguous).toBe(false)
    expect(inferDateFormat(['2026-03-04']).ambiguous).toBe(false)
    expect(inferDateFormat(['2026-03-04']).candidates).toEqual(['iso', 'ymd'])
    expect(inferDateFormat(['14 Mar 2023']).ambiguous).toBe(false)
  })

  it('ignores empty cells when counting evidence', () => {
    const result = inferDateFormat(['', '  ', '14 Mar 2023', ''])
    expect(result.samples).toBe(1)
    expect(result.format).toBe('d_mon_y')
  })

  it('has nothing to say about a column with no dates in it at all', () => {
    expect(inferDateFormat([])).toMatchObject({ format: null, samples: 0, conflicting: false })
    expect(inferDateFormat(['', ''])).toMatchObject({ format: null, samples: 0 })
  })
})

describe('applyDateFormat', () => {
  it('rewrites every supported spelling as YYYY-MM-DD', () => {
    expect(unwrap(applyDateFormat('14 Mar 2023', 'd_mon_y'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('Mar 14, 2023', 'mon_d_y'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('14.03.2023', 'dmy'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('03/14/2023', 'mdy'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('2023/03/14', 'ymd'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('2023-03-14T09:30:00Z', 'iso'))).toBe('2023-03-14')
  })

  it('accepts the long month name and a trailing full stop', () => {
    expect(unwrap(applyDateFormat('14 March 2023', 'd_mon_y'))).toBe('2023-03-14')
    expect(unwrap(applyDateFormat('Sept. 14, 2023', 'mon_d_y'))).toBe('2023-09-14')
  })

  it('refuses a cell the column format cannot read', () => {
    const result = applyDateFormat('14 Mar 2023', 'dmy')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('bad_date')
  })

  it('refuses a date that does not exist', () => {
    const result = applyDateFormat('31/02/2026', 'dmy')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('bad_date')
  })
})
