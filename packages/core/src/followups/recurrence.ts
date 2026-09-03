import { z } from 'zod'
import { assertNever, fail, failWith, issuesFromZodError, ok, type Result } from '../result.ts'
import {
  addDays,
  addMonths,
  compareCivil,
  dayOfMonth,
  diffDays,
  civilParts,
  type CivilDate,
} from '../time/civil.ts'

/**
 * Follow-up recurrence (brief §4.1, §6.4).
 *
 * The brief contradicts itself — §4.1 says "every N months", §6.4's dialog offers "custom every N
 * days" — so both units exist. §12's acceptance criterion ("a follow-up that repeats every
 * quarter") is `every_n_months` with `n = 3`.
 *
 * A closed union, not `rrule`: the entire UI is a six-item dropdown, and RRULE brings BYSETPOS,
 * BYDAY, COUNT, UNTIL, EXDATE and a `Date`-based API for 3 % of which we would use. The persisted
 * shape is a tagged object, so `{ kind: 'rrule', rrule: string }` is an additive sixth variant the
 * day a real calendar rule is wanted.
 *
 * "No recurrence" is `null` — the `follow_up.recurrence` column is nullable jsonb, and a
 * `{ kind: 'none' }` object next to a nullable column would be two spellings of one fact.
 */

export const MIN_RECURRENCE_N = 1
export const MAX_RECURRENCE_DAYS = 365
export const MAX_RECURRENCE_MONTHS = 60

export type Recurrence =
  | { readonly kind: 'weekly' }
  | { readonly kind: 'monthly' }
  | { readonly kind: 'yearly' }
  | { readonly kind: 'every_n_days'; readonly n: number }
  | { readonly kind: 'every_n_months'; readonly n: number }

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('weekly') }),
  z.strictObject({ kind: z.literal('monthly') }),
  z.strictObject({ kind: z.literal('yearly') }),
  z.strictObject({
    kind: z.literal('every_n_days'),
    n: z.int().min(MIN_RECURRENCE_N).max(MAX_RECURRENCE_DAYS),
  }),
  z.strictObject({
    kind: z.literal('every_n_months'),
    n: z.int().min(MIN_RECURRENCE_N).max(MAX_RECURRENCE_MONTHS),
  }),
])

/** `null` is "does not repeat" — the shape of the nullable jsonb column. */
export const nullableRecurrenceSchema = recurrenceSchema.nullable()

export interface RecurrenceState {
  readonly rule: Recurrence
  /**
   * The **first** due date of the series, copied unchanged into every successor. This is what
   * stops a chain from drifting: anchored on 31 January, monthly gives 31 Jan → 28 Feb → 31 Mar;
   * clamping from the previous date instead would demote the whole series to the 28th after one
   * February.
   */
  readonly anchor: CivilDate
}

export function parseRecurrence(input: unknown): Result<Recurrence> {
  const parsed = recurrenceSchema.safeParse(input)
  if (!parsed.success) return failWith(issuesFromZodError(parsed.error, 'invalid_input'))
  return ok(parsed.data)
}

/**
 * Collapses the aliases so the chip label and equality are stable. A month is not 30 days, so
 * `every_n_days: 30` is deliberately left alone.
 */
export function canonicalizeRecurrence(rule: Recurrence): Recurrence {
  switch (rule.kind) {
    case 'every_n_days':
      return rule.n === 7 ? { kind: 'weekly' } : rule
    case 'every_n_months':
      if (rule.n === 1) return { kind: 'monthly' }
      if (rule.n === 12) return { kind: 'yearly' }
      return rule
    case 'weekly':
    case 'monthly':
    case 'yearly':
      return rule
    default:
      return assertNever(rule, 'recurrence rule')
  }
}

type Step = { readonly unit: 'day' | 'month'; readonly size: number }

function stepOf(rule: Recurrence): Step {
  switch (rule.kind) {
    case 'weekly':
      return { unit: 'day', size: 7 }
    case 'every_n_days':
      return { unit: 'day', size: rule.n }
    case 'monthly':
      return { unit: 'month', size: 1 }
    case 'every_n_months':
      return { unit: 'month', size: rule.n }
    case 'yearly':
      return { unit: 'month', size: 12 }
    default:
      return assertNever(rule, 'recurrence rule')
  }
}

function outOfRange(rule: Recurrence): Result<never> | null {
  if (rule.kind === 'every_n_days' && (rule.n < MIN_RECURRENCE_N || rule.n > MAX_RECURRENCE_DAYS)) {
    return fail('out_of_range', `Repeat every 1 to ${MAX_RECURRENCE_DAYS} days.`, ['n'])
  }
  if (
    rule.kind === 'every_n_months' &&
    (rule.n < MIN_RECURRENCE_N || rule.n > MAX_RECURRENCE_MONTHS)
  ) {
    return fail('out_of_range', `Repeat every 1 to ${MAX_RECURRENCE_MONTHS} months.`, ['n'])
  }
  return null
}

/**
 * The next occurrence after a recurring follow-up is marked done.
 *
 * Computed **from the due date**, then rolled forward past today — not from the completion date.
 * A quarterly check-in due 15 January and ticked off late on 20 June lands on 15 July: the
 * cadence stays on the 15th, and there is exactly one successor rather than a backlog of ghosts.
 * Completion-anchored arithmetic is right for habits ("water the plants every 3 days") and wrong
 * for relationships, where it silently converts a monthly cadence into a five-weekly one for
 * anyone who is ever a few days late.
 *
 * In plain words, for the product owner: *a repeating reminder always lands on the same day of
 * the month, even if you were late — and you never get two overdue copies of the same reminder.*
 */
export function nextOccurrence(
  state: RecurrenceState,
  ctx: { readonly dueAt: CivilDate; readonly today: CivilDate },
): Result<CivilDate> {
  const invalid = outOfRange(state.rule)
  if (invalid !== null) return invalid

  const rule = canonicalizeRecurrence(state.rule)
  const step = stepOf(rule)
  const { dueAt, today } = ctx

  // The number of whole periods is computed by division, not by a loop, so a follow-up left
  // untouched for ten years costs the same as one left untouched for a week.
  let periods: number
  if (step.unit === 'day') {
    const elapsed = diffDays(today, dueAt)
    periods = elapsed < 0 ? 1 : Math.max(1, Math.floor(elapsed / step.size))
  } else {
    const due = civilParts(dueAt)
    const now = civilParts(today)
    // Whole months between the two, ignoring the day: the estimate lands in today's month or
    // earlier, and the loop below decides whether that month's occurrence has already passed.
    const elapsed = (now.year - due.year) * 12 + (now.month - due.month)
    periods = elapsed < 0 ? 1 : Math.max(1, Math.floor(elapsed / step.size))
  }

  const anchorDay = dayOfMonth(state.anchor)
  const advance = (count: number): CivilDate =>
    step.unit === 'day'
      ? addDays(dueAt, count * step.size)
      : addMonths(dueAt, count * step.size, anchorDay)

  // The divided estimate lands on or before today; each extra turn advances by at least a day for
  // an every-N-days rule and at least 28 for a monthly one, so this terminates immediately.
  let next = advance(periods)
  while (compareCivil(next, today) <= 0) {
    periods += 1
    next = advance(periods)
  }
  return ok(next)
}

export type SnoozePreset = '1d' | '1w' | '1m' | { readonly date: CivilDate }

/** Snooze (§6.4): +1 day, +1 week, or a date the user picks — which must not be in the past. */
export function snooze(
  dueAt: CivilDate,
  preset: SnoozePreset,
  today: CivilDate,
): Result<CivilDate> {
  if (typeof preset !== 'string') {
    if (compareCivil(preset.date, today) < 0) {
      return fail('bad_date', 'Pick a date from today onwards.', ['date'])
    }
    return ok(preset.date)
  }
  // Snoozing is relative to the later of the due date and today: snoozing an overdue follow-up
  // "by a week" means a week from now, not a week from a date that has already passed.
  const base = compareCivil(dueAt, today) > 0 ? dueAt : today
  switch (preset) {
    case '1d':
      return ok(addDays(base, 1))
    case '1w':
      return ok(addDays(base, 7))
    case '1m':
      return ok(addMonths(base, 1))
    default:
      return assertNever(preset, 'snooze preset')
  }
}

/** The chip label §6.4 shows next to a follow-up. */
export function describeRecurrence(rule: Recurrence): string {
  const canonical = canonicalizeRecurrence(rule)
  switch (canonical.kind) {
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'yearly':
      return 'Yearly'
    case 'every_n_days':
      return `Every ${canonical.n} days`
    case 'every_n_months':
      return canonical.n === 3 ? 'Quarterly' : `Every ${canonical.n} months`
    default:
      return assertNever(canonical, 'recurrence rule')
  }
}
