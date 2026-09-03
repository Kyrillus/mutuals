import { describe, expect, it } from 'vitest'
import { civil, type CivilDate } from './time/civil.ts'
import {
  INTERACTION_WEIGHTS,
  WARMTH_HALF_LIFE_DAYS,
  WARMTH_K,
  WARMTH_WINDOW_DAYS,
  computeWarmth,
  type WarmthInteraction,
  type WarmthOverrides,
} from './warmth.ts'

const TODAY = civil('2026-09-03')

const NO_OVERRIDES: WarmthOverrides = { pinnedImportant: false, notImportant: false }

function daysBefore(days: number): CivilDate {
  const millis = Date.UTC(2026, 8, 3) - days * 86_400_000
  const d = new Date(millis)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return civil(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`)
}

/** A cadence of `type` every `everyDays` days, from today backwards to the window edge. */
function cadence(type: string, everyDays: number, limit = WARMTH_WINDOW_DAYS): WarmthInteraction[] {
  const out: WarmthInteraction[] = []
  for (let days = 0; days <= limit; days += everyDays)
    out.push({ type, occurredOn: daysBefore(days) })
  return out
}

function warmthOf(interactions: readonly WarmthInteraction[]): number {
  return computeWarmth(interactions, NO_OVERRIDES, TODAY).warmth
}

describe('the calibration constant', () => {
  /**
   * Derived, never retyped. One meeting a month over 365 days, measured at the moment of a
   * meeting, is thirteen meetings at days_ago = 0, 30, … 360; the decayed sum is a geometric
   * series with ratio e^(-30/90).
   */
  const series = Array.from({ length: 13 }, (_, n) => Math.exp(-n / 3)).reduce((a, b) => a + b, 0)
  const CALIBRATION_SIGNAL = INTERACTION_WEIGHTS.Meeting * series

  it('is ln(4) over the calibration signal', () => {
    expect(CALIBRATION_SIGNAL).toBeCloseTo(10.4442886436, 8)
    expect(WARMTH_K).toBeCloseTo(Math.log(4) / CALIBRATION_SIGNAL, 8)
  })

  it('puts one meeting a month at exactly 75', () => {
    const monthly = Array.from({ length: 13 }, (_, n) => ({
      type: 'Meeting',
      occurredOn: daysBefore(n * 30),
    }))
    const result = computeWarmth(monthly, NO_OVERRIDES, TODAY)
    expect(result.signal).toBeCloseTo(CALIBRATION_SIGNAL, 8)
    expect(result.warmth).toBe(75)
  })
})

describe('the calibration table', () => {
  // These are the numbers the product documentation quotes; if one moves, the docs are wrong.
  it.each([
    ['weekly meetings', cadence('Meeting', 7), 99],
    ['fortnightly meetings', cadence('Meeting', 14), 93],
    ['weekly messages', cadence('Message', 7), 83],
    ['monthly meetings', cadence('Meeting', 30), 75],
    ['quarterly meetings', cadence('Meeting', 90), 47],
    [
      'two meetings a year',
      [
        { type: 'Meeting', occurredOn: daysBefore(0) },
        { type: 'Meeting', occurredOn: daysBefore(182) },
      ],
      36,
    ],
    ['one meeting today', [{ type: 'Meeting', occurredOn: TODAY }], 33],
    ['monthly emails', cadence('Email', 30), 28],
    ['one meeting six months ago', [{ type: 'Meeting', occurredOn: daysBefore(182) }], 5],
    ['nothing at all', [], 0],
  ])('%s reads %i', (_label, interactions, expected) => {
    expect(warmthOf(interactions)).toBe(expected)
  })

  it('drops to 63 at the far end of a monthly cycle, and that swing is deliberate', () => {
    const justBeforeTheNext = Array.from({ length: 12 }, (_, n) => ({
      type: 'Meeting',
      occurredOn: daysBefore(29 + n * 30),
    }))
    expect(warmthOf(justBeforeTheNext)).toBe(63)
  })
})

describe('the window', () => {
  it('includes an interaction exactly 365 days old and excludes one at 366', () => {
    expect(
      computeWarmth([{ type: 'Meeting', occurredOn: daysBefore(365) }], NO_OVERRIDES, TODAY),
    ).toMatchObject({ counted: 1 })
    expect(
      computeWarmth([{ type: 'Meeting', occurredOn: daysBefore(366) }], NO_OVERRIDES, TODAY),
    ).toMatchObject({ counted: 0, signal: 0, warmth: 0 })
  })

  it('uses the half-life the brief states', () => {
    expect(WARMTH_HALF_LIFE_DAYS).toBe(90)
    expect(WARMTH_WINDOW_DAYS).toBe(365)
    const ninetyDaysAgo = computeWarmth(
      [{ type: 'Meeting', occurredOn: daysBefore(90) }],
      NO_OVERRIDES,
      TODAY,
    )
    expect(ninetyDaysAgo.signal).toBeCloseTo(3 * Math.exp(-1), 10)
  })
})

describe('future-dated interactions', () => {
  it('are clamped to today, not dropped', () => {
    const nextWeek = computeWarmth(
      [{ type: 'Meeting', occurredOn: daysBefore(-7) }],
      NO_OVERRIDES,
      TODAY,
    )
    const today = computeWarmth([{ type: 'Meeting', occurredOn: TODAY }], NO_OVERRIDES, TODAY)
    expect(nextWeek).toEqual(today)
    // Booking time with somebody must never make the relationship look colder.
    expect(nextWeek.warmth).toBeGreaterThan(0)
  })
})

describe('weights', () => {
  it('match the brief exactly', () => {
    expect(INTERACTION_WEIGHTS).toEqual({
      Meeting: 3.0,
      Call: 2.5,
      Event: 2.0,
      Intro: 2.0,
      Note: 1.5,
      Message: 1.0,
      Email: 0.7,
    })
  })

  it('gives an unknown type weight 0 instead of throwing', () => {
    const result = computeWarmth([{ type: 'Seance', occurredOn: TODAY }], NO_OVERRIDES, TODAY)
    expect(result).toEqual({ warmth: 0, rawWarmth: 0, signal: 0, counted: 1 })
  })

  it('ignores an inherited property masquerading as a type', () => {
    expect(warmthOf([{ type: 'constructor', occurredOn: TODAY }])).toBe(0)
  })
})

describe('overrides', () => {
  const cold: WarmthInteraction[] = [{ type: 'Email', occurredOn: daysBefore(200) }]
  const warm = cadence('Meeting', 14)

  it('pinned_important is a floor', () => {
    const result = computeWarmth(cold, { pinnedImportant: true, notImportant: false }, TODAY)
    expect(result.rawWarmth).toBeLessThan(60)
    expect(result.warmth).toBe(60)
  })

  it('a floor never lowers an already-warm contact', () => {
    const result = computeWarmth(warm, { pinnedImportant: true, notImportant: false }, TODAY)
    expect(result.warmth).toBe(93)
  })

  it('not_important is a cap', () => {
    expect(computeWarmth(warm, { pinnedImportant: false, notImportant: true }, TODAY).warmth).toBe(
      10,
    )
  })

  it('the cap beats the floor when the API lets both be set', () => {
    const result = computeWarmth(warm, { pinnedImportant: true, notImportant: true }, TODAY)
    // not_important also means "stay quiet"; staying quiet is the safe failure.
    expect(result.warmth).toBe(10)
    expect(result.rawWarmth).toBe(93)
  })
})

describe('shape', () => {
  it('is monotonic: adding an interaction never cools a contact', () => {
    const base = cadence('Meeting', 30)
    for (const type of ['Meeting', 'Call', 'Email', 'Note'] as const) {
      for (const daysAgo of [0, 10, 100, 364]) {
        const added = [...base, { type, occurredOn: daysBefore(daysAgo) }]
        expect(warmthOf(added)).toBeGreaterThanOrEqual(warmthOf(base))
      }
    }
  })

  it('is monotonic in time: the same interaction further back never warms a contact', () => {
    let previous = 101
    for (const daysAgo of [0, 30, 90, 180, 270, 365]) {
      const current = warmthOf([{ type: 'Meeting', occurredOn: daysBefore(daysAgo) }])
      expect(current).toBeLessThanOrEqual(previous)
      previous = current
    }
  })

  it('stays an integer inside 0..100 for arbitrary input', () => {
    const types = ['Meeting', 'Call', 'Email', 'Message', 'Intro', 'Event', 'Note', 'Unknown']
    for (let seed = 0; seed < 300; seed += 1) {
      const count = seed % 40
      const interactions = Array.from({ length: count }, (_, i) => ({
        type: types[(seed * 7 + i * 13) % types.length] ?? 'Note',
        occurredOn: daysBefore(((seed * 29 + i * 11) % 420) - 10),
      }))
      const { warmth } = computeWarmth(interactions, NO_OVERRIDES, TODAY)
      expect(Number.isInteger(warmth)).toBe(true)
      expect(warmth).toBeGreaterThanOrEqual(0)
      expect(warmth).toBeLessThanOrEqual(100)
    }
  })

  it('is deterministic — nothing in it reads a clock', () => {
    const interactions = cadence('Call', 21)
    expect(computeWarmth(interactions, NO_OVERRIDES, TODAY)).toEqual(
      computeWarmth(interactions, NO_OVERRIDES, TODAY),
    )
  })
})
