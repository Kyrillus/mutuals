import { describe, expect, it } from 'vitest'
import { unwrap } from '../result.ts'
import { civil, type CivilDate } from '../time/civil.ts'
import {
  MAX_RECURRENCE_DAYS,
  MAX_RECURRENCE_MONTHS,
  canonicalizeRecurrence,
  describeRecurrence,
  nextOccurrence,
  nullableRecurrenceSchema,
  parseRecurrence,
  recurrenceSchema,
  snooze,
  type Recurrence,
  type SnoozePreset,
} from './recurrence.ts'

function nextOf(rule: Recurrence, dueAt: string, today: string, anchor = dueAt): CivilDate {
  return unwrap(
    nextOccurrence({ rule, anchor: civil(anchor) }, { dueAt: civil(dueAt), today: civil(today) }),
  )
}

/** Walks a series forward, ticking each occurrence off on the day it is due. */
function chain(rule: Recurrence, anchor: string, steps: number): string[] {
  const dates: string[] = [anchor]
  let due = anchor
  for (let i = 0; i < steps; i += 1) {
    due = nextOf(rule, due, due, anchor)
    dates.push(due)
  }
  return dates
}

describe('parseRecurrence', () => {
  it('accepts every variant', () => {
    expect(unwrap(parseRecurrence({ kind: 'weekly' }))).toEqual({ kind: 'weekly' })
    expect(unwrap(parseRecurrence({ kind: 'every_n_months', n: 3 }))).toEqual({
      kind: 'every_n_months',
      n: 3,
    })
  })

  it('refuses an unknown kind, a missing n and an out-of-range n', () => {
    expect(parseRecurrence({ kind: 'fortnightly' }).ok).toBe(false)
    expect(parseRecurrence({ kind: 'every_n_days' }).ok).toBe(false)
    expect(parseRecurrence({ kind: 'every_n_days', n: 0 }).ok).toBe(false)
    expect(parseRecurrence({ kind: 'every_n_days', n: MAX_RECURRENCE_DAYS + 1 }).ok).toBe(false)
    expect(parseRecurrence({ kind: 'every_n_months', n: MAX_RECURRENCE_MONTHS + 1 }).ok).toBe(false)
    expect(parseRecurrence({ kind: 'weekly', n: 2 }).ok).toBe(false)
  })

  it('models "does not repeat" as null, matching the nullable jsonb column', () => {
    expect(nullableRecurrenceSchema.safeParse(null).success).toBe(true)
    expect(recurrenceSchema.safeParse(null).success).toBe(false)
  })
})

describe('canonicalizeRecurrence', () => {
  it('collapses the aliases so the chip label and equality are stable', () => {
    expect(canonicalizeRecurrence({ kind: 'every_n_days', n: 7 })).toEqual({ kind: 'weekly' })
    expect(canonicalizeRecurrence({ kind: 'every_n_months', n: 1 })).toEqual({ kind: 'monthly' })
    expect(canonicalizeRecurrence({ kind: 'every_n_months', n: 12 })).toEqual({ kind: 'yearly' })
  })

  it('leaves 30 days alone, because a month is not 30 days', () => {
    expect(canonicalizeRecurrence({ kind: 'every_n_days', n: 30 })).toEqual({
      kind: 'every_n_days',
      n: 30,
    })
  })

  it('is a no-op on an already-canonical rule', () => {
    for (const rule of [{ kind: 'weekly' }, { kind: 'monthly' }, { kind: 'yearly' }] as const) {
      expect(canonicalizeRecurrence(rule)).toEqual(rule)
    }
    expect(canonicalizeRecurrence({ kind: 'every_n_months', n: 3 })).toEqual({
      kind: 'every_n_months',
      n: 3,
    })
  })
})

describe('nextOccurrence', () => {
  it('moves one period on when the follow-up is ticked off on the day', () => {
    expect(nextOf({ kind: 'weekly' }, '2026-03-02', '2026-03-02')).toBe('2026-03-09')
  })

  it('moves one period on when it is ticked off early', () => {
    expect(nextOf({ kind: 'monthly' }, '2026-03-20', '2026-03-01')).toBe('2026-04-20')
  })

  /**
   * The decision, spelled out: the cadence stays on the 15th, and one late tick produces one
   * successor rather than a backlog. Completion-anchored arithmetic would give 20 September and
   * quietly turn a quarterly cadence into a five-monthly one for anyone who is ever late.
   */
  it('rolls a late quarterly follow-up forward to the next date in the series', () => {
    expect(nextOf({ kind: 'every_n_months', n: 3 }, '2026-01-15', '2026-06-20')).toBe('2026-07-15')
  })

  it('skips every missed occurrence in one step, however late', () => {
    expect(nextOf({ kind: 'weekly' }, '2020-01-01', '2026-09-03')).toBe('2026-09-09')
    expect(nextOf({ kind: 'monthly' }, '2016-01-31', '2026-09-03')).toBe('2026-09-30')
  })

  it('computes an every-N-days series by division, not by looping', () => {
    expect(nextOf({ kind: 'every_n_days', n: 45 }, '2026-01-01', '2026-05-01')).toBe('2026-05-16')
  })

  it('returns in bounded time for a daily follow-up abandoned for ten years', () => {
    expect(nextOf({ kind: 'every_n_days', n: 1 }, '2016-09-03', '2026-09-03')).toBe('2026-09-04')
  })

  /** Anchoring on the series' first due date is what stops one February demoting the chain. */
  it('keeps a month-end series on the last day of the month', () => {
    expect(chain({ kind: 'monthly' }, '2026-01-31', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ])
  })

  it('keeps a 29 February series returning to 29 February in leap years', () => {
    expect(chain({ kind: 'yearly' }, '2024-02-29', 4)).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ])
  })

  it('always lands strictly after today', () => {
    for (const rule of [
      { kind: 'weekly' },
      { kind: 'monthly' },
      { kind: 'yearly' },
      { kind: 'every_n_days', n: 45 },
      { kind: 'every_n_months', n: 3 },
    ] as const) {
      for (const today of ['2026-01-01', '2026-02-28', '2026-06-20', '2026-12-31']) {
        expect(nextOf(rule, '2026-01-31', today) > today).toBe(true)
      }
    }
  })

  it('is unaffected by a DST boundary, because civil dates carry no time', () => {
    expect(nextOf({ kind: 'weekly' }, '2026-03-22', '2026-03-22')).toBe('2026-03-29')
    expect(nextOf({ kind: 'weekly' }, '2026-10-18', '2026-10-18')).toBe('2026-10-25')
  })

  it('refuses an n outside the supported range', () => {
    const result = nextOccurrence(
      { rule: { kind: 'every_n_days', n: 0 }, anchor: civil('2026-01-01') },
      { dueAt: civil('2026-01-01'), today: civil('2026-01-01') },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('out_of_range')

    const months = nextOccurrence(
      { rule: { kind: 'every_n_months', n: 99 }, anchor: civil('2026-01-01') },
      { dueAt: civil('2026-01-01'), today: civil('2026-01-01') },
    )
    expect(months.ok).toBe(false)
  })
})

describe('describeRecurrence', () => {
  it('produces the labels §6.4 offers', () => {
    expect(describeRecurrence({ kind: 'weekly' })).toBe('Weekly')
    expect(describeRecurrence({ kind: 'monthly' })).toBe('Monthly')
    expect(describeRecurrence({ kind: 'yearly' })).toBe('Yearly')
    expect(describeRecurrence({ kind: 'every_n_months', n: 3 })).toBe('Quarterly')
    expect(describeRecurrence({ kind: 'every_n_months', n: 6 })).toBe('Every 6 months')
    expect(describeRecurrence({ kind: 'every_n_days', n: 45 })).toBe('Every 45 days')
  })

  it('labels an alias by its canonical form', () => {
    expect(describeRecurrence({ kind: 'every_n_days', n: 7 })).toBe('Weekly')
    expect(describeRecurrence({ kind: 'every_n_months', n: 12 })).toBe('Yearly')
  })
})

describe('snooze', () => {
  it('moves a future due date on by the preset', () => {
    expect(unwrap(snooze(civil('2026-03-10'), '1d', civil('2026-03-01')))).toBe('2026-03-11')
    expect(unwrap(snooze(civil('2026-03-10'), '1w', civil('2026-03-01')))).toBe('2026-03-17')
    expect(unwrap(snooze(civil('2026-03-31'), '1m', civil('2026-03-01')))).toBe('2026-04-30')
  })

  it('snoozes an overdue follow-up from today, not from a date already past', () => {
    expect(unwrap(snooze(civil('2026-01-01'), '1w', civil('2026-03-01')))).toBe('2026-03-08')
  })

  it('accepts an explicit date from today onwards', () => {
    expect(
      unwrap(snooze(civil('2026-03-10'), { date: civil('2026-05-01') }, civil('2026-03-01'))),
    ).toBe('2026-05-01')
    expect(
      unwrap(snooze(civil('2026-03-10'), { date: civil('2026-03-01') }, civil('2026-03-01'))),
    ).toBe('2026-03-01')
  })

  it('refuses an explicit date in the past', () => {
    const result = snooze(civil('2026-03-10'), { date: civil('2026-02-01') }, civil('2026-03-01'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.code).toBe('bad_date')
  })
})

describe('the exhaustiveness guards', () => {
  it('throw on a rule or a preset the union does not know', () => {
    const alien = { kind: 'lunar' } as unknown as Recurrence
    expect(() => canonicalizeRecurrence(alien)).toThrow(/recurrence rule/)
    expect(() => describeRecurrence(alien)).toThrow(/recurrence rule/)
    expect(() =>
      nextOccurrence(
        { rule: alien, anchor: civil('2026-01-01') },
        { dueAt: civil('2026-01-01'), today: civil('2026-01-01') },
      ),
    ).toThrow(/recurrence rule/)
    expect(() => snooze(civil('2026-01-01'), '1y' as SnoozePreset, civil('2026-01-01'))).toThrow(
      /snooze preset/,
    )
  })
})
