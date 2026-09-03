import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { civil } from '../time/civil.ts'
import type { RelativeUnit, RelativePreset, ResolvedDateBound } from './relative.ts'
import {
  MAX_RELATIVE_N,
  RELATIVE_PRESETS,
  RELATIVE_UNITS,
  boundContains,
  resolveNewerThan,
  resolveOlderThan,
  resolvePreset,
  resolveRelativeDate,
  subtractUnits,
} from './relative.ts'

const TODAY = civil('2026-09-03')

describe('subtractUnits', () => {
  it('subtracts days', () => {
    expect(subtractUnits(TODAY, 30, 'day')).toBe('2026-08-04')
    expect(subtractUnits(TODAY, 0, 'day')).toBe('2026-09-03')
  })

  it('subtracts months, clamping to the target month', () => {
    expect(subtractUnits(TODAY, 3, 'month')).toBe('2026-06-03')
    expect(subtractUnits(civil('2026-03-31'), 1, 'month')).toBe('2026-02-28')
  })

  it('subtracts years, including across a leap day', () => {
    expect(subtractUnits(TODAY, 1, 'year')).toBe('2025-09-03')
    expect(subtractUnits(civil('2024-02-29'), 1, 'year')).toBe('2023-02-28')
  })

  it('covers every unit in the closed set', () => {
    for (const unit of RELATIVE_UNITS) expect(subtractUnits(TODAY, 1, unit) < TODAY).toBe(true)
  })
})

describe('presets', () => {
  it('resolves "last 30 days" to an inclusive rolling window', () => {
    expect(resolvePreset('last_30_days', TODAY)).toEqual({
      kind: 'range',
      from: '2026-08-04',
      to: '2026-09-03',
    })
  })

  it('resolves "this year" to the calendar year', () => {
    expect(resolvePreset('this_year', TODAY)).toEqual({
      kind: 'range',
      from: '2026-01-01',
      to: '2026-12-31',
    })
  })

  it('anchors "this year" on 1 January and 31 December themselves', () => {
    expect(resolvePreset('this_year', civil('2026-01-01'))).toEqual({
      kind: 'range',
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(resolvePreset('this_year', civil('2024-12-31'))).toEqual({
      kind: 'range',
      from: '2024-01-01',
      to: '2024-12-31',
    })
  })

  it('handles a leap year and a year boundary for the rolling window', () => {
    expect(resolvePreset('last_30_days', civil('2024-03-01'))).toEqual({
      kind: 'range',
      from: '2024-01-31',
      to: '2024-03-01',
    })
    expect(resolvePreset('last_30_days', civil('2026-01-01'))).toEqual({
      kind: 'range',
      from: '2025-12-02',
      to: '2026-01-01',
    })
  })

  it('ships exactly the presets Phase 1 committed to', () => {
    expect([...RELATIVE_PRESETS]).toEqual(['last_30_days', 'this_year'])
  })
})

describe('older_than and newer_than', () => {
  it('cut the timeline at today minus the interval, strictly', () => {
    expect(resolveOlderThan(90, 'day', TODAY)).toEqual({ kind: 'before', cutoff: '2026-06-05' })
    expect(resolveNewerThan(90, 'day', TODAY)).toEqual({ kind: 'after', cutoff: '2026-06-05' })
  })

  it('are complementary around the cutoff', () => {
    const older = resolveOlderThan(90, 'day', TODAY)
    const newer = resolveNewerThan(90, 'day', TODAY)
    const cutoff = civil('2026-06-05')
    expect(boundContains(older, cutoff)).toBe(false)
    expect(boundContains(newer, cutoff)).toBe(false)
    expect(boundContains(older, civil('2026-06-04'))).toBe(true)
    expect(boundContains(newer, civil('2026-06-06'))).toBe(true)
  })

  it('accept months and years too', () => {
    expect(resolveOlderThan(3, 'month', TODAY)).toEqual({ kind: 'before', cutoff: '2026-06-03' })
    expect(resolveNewerThan(1, 'year', TODAY)).toEqual({ kind: 'after', cutoff: '2025-09-03' })
  })

  it('lets newer_than reach into the future, unlike a preset window', () => {
    const newer = resolveNewerThan(0, 'day', TODAY)
    expect(boundContains(newer, civil('2027-01-01'))).toBe(true)
    expect(boundContains(resolvePreset('last_30_days', TODAY), civil('2027-01-01'))).toBe(false)
  })
})

describe('resolveRelativeDate', () => {
  it('dispatches every relative operator', () => {
    expect(unwrap(resolveRelativeDate({ op: 'in_relative', preset: 'this_year' }, TODAY))).toEqual({
      kind: 'range',
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(unwrap(resolveRelativeDate({ op: 'older_than', n: 90, unit: 'day' }, TODAY))).toEqual({
      kind: 'before',
      cutoff: '2026-06-05',
    })
    expect(unwrap(resolveRelativeDate({ op: 'newer_than', n: 7, unit: 'day' }, TODAY))).toEqual({
      kind: 'after',
      cutoff: '2026-08-27',
    })
  })

  it('rejects an n a hand-edited URL could carry', () => {
    for (const n of [-1, 1.5, MAX_RELATIVE_N + 1, Number.NaN]) {
      const result = resolveRelativeDate({ op: 'older_than', n, unit: 'day' }, TODAY)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.issues[0]?.code).toBe('out_of_range')
    }
  })

  /**
   * The regression ADR-040 exists for. Under a compiler that resolved against the database clock
   * this could not fail, because the emitted SQL would be byte-identical for any injected today.
   */
  it('does not freeze: the same saved filter resolves differently 400 days later', () => {
    const spec = { op: 'older_than', n: 90, unit: 'day' } as const
    const now = unwrap(resolveRelativeDate(spec, TODAY))
    const later = unwrap(resolveRelativeDate(spec, civil('2027-10-08')))
    expect(now).not.toEqual(later)
    expect(later).toEqual({ kind: 'before', cutoff: '2027-07-10' })
  })
})

describe('boundContains', () => {
  it('treats a range as inclusive at both ends', () => {
    const range = resolvePreset('last_30_days', TODAY)
    expect(boundContains(range, civil('2026-08-04'))).toBe(true)
    expect(boundContains(range, civil('2026-09-03'))).toBe(true)
    expect(boundContains(range, civil('2026-08-03'))).toBe(false)
    expect(boundContains(range, civil('2026-09-04'))).toBe(false)
  })
})

describe('the exhaustiveness guards', () => {
  /**
   * These branches are unreachable through the type system. They are still asserted, because the
   * value that reaches them comes from a URL through Zod, and a guard that returned `undefined`
   * instead of throwing would put an unfiltered list in front of the user.
   */
  it('throw rather than fall through', () => {
    expect(() => subtractUnits(TODAY, 1, 'fortnight' as RelativeUnit)).toThrow(/relative unit/)
    expect(() => resolvePreset('next_week' as RelativePreset, TODAY)).toThrow(
      /calendar period|relative preset/,
    )
    expect(() =>
      resolveRelativeDate(
        { op: 'in_the_mood' } as unknown as { op: 'in_relative'; preset: RelativePreset },
        TODAY,
      ),
    ).toThrow(/relative date operator/)
    expect(() =>
      boundContains({ kind: 'sideways' } as unknown as ResolvedDateBound, TODAY),
    ).toThrow(/resolved date bound/)
  })
})
