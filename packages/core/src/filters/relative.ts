import { assertNever, fail, ok, type Result } from '../result.ts'
import {
  addDays,
  addMonths,
  compareCivil,
  endOfYear,
  startOfYear,
  type CivilDate,
} from '../time/civil.ts'

/**
 * Relative date filters are stored relative and resolved to absolute civil bounds **here**, in
 * TypeScript, from an injected `today` (ADR-040).
 *
 * Two things follow, and both are the point:
 *
 * 1. A saved view called "No interaction in 90 days" still means that next year. Resolving to an
 *    absolute date when the view is saved would freeze it on the day it was created.
 * 2. `now()` never reaches the emitted SQL, so one `WHERE` clause can never contain two clocks —
 *    otherwise "last 30 days" and "no interaction in 90 days" would flip at different moments.
 *    It also removes the untyped `$n * interval '1 day'` expression a golden SQL test would
 *    otherwise freeze.
 */

/**
 * Phase 1 ships the two presets the brief names in §4.2 ("last 30 days", "this year"). The
 * forward-facing shortcuts of §6.4 (in 1 week / 1 month / 3 months) are follow-up *creation and
 * snooze* affordances, not filter presets, and arrive in Stage 4. Adding a preset is one string
 * here and one branch in {@link resolvePreset}.
 */
export const RELATIVE_PRESETS = ['last_30_days', 'this_year'] as const

export type RelativePreset = (typeof RELATIVE_PRESETS)[number]

export const RELATIVE_UNITS = ['day', 'month', 'year'] as const

export type RelativeUnit = (typeof RELATIVE_UNITS)[number]

export const MAX_RELATIVE_N = 3650

/**
 * The absolute bound a relative operator resolves to. The compiler binds these civil dates as
 * parameters and emits no interval arithmetic.
 *
 * - `range`  — `from <= value <= to`, both ends inclusive
 * - `before` — `value < cutoff`, strictly
 * - `after`  — `value > cutoff`, strictly
 *
 * `before` and `after` are strict and complementary, so `older_than 90` and `newer_than 90`
 * partition the timeline around one instant instead of overlapping on it. A NULL derived column —
 * somebody you have never spoken to — matches **none** of the three: "last interaction more than
 * 90 days ago" is not true of a person you have never interacted with.
 */
export type ResolvedDateBound =
  | { readonly kind: 'range'; readonly from: CivilDate; readonly to: CivilDate }
  | { readonly kind: 'before'; readonly cutoff: CivilDate }
  | { readonly kind: 'after'; readonly cutoff: CivilDate }

/** The relative operators' payloads, without the field they apply to. */
export type RelativeDateSpec =
  | { readonly op: 'in_relative'; readonly preset: RelativePreset }
  | { readonly op: 'older_than' | 'newer_than'; readonly n: number; readonly unit: RelativeUnit }

/**
 * `today` minus `n` units. Month and year steps clamp to the length of the target month, so
 * 31 March minus one month is 28 February rather than 3 March.
 */
export function subtractUnits(today: CivilDate, n: number, unit: RelativeUnit): CivilDate {
  switch (unit) {
    case 'day':
      return addDays(today, -n)
    case 'month':
      return addMonths(today, -n)
    case 'year':
      return addMonths(today, -n * 12)
    default:
      return assertNever(unit, 'relative unit')
  }
}

/**
 * A named window.
 *
 * `last_30_days` is `today − 30 days … today`, both ends inclusive — the "subtract the interval"
 * reading, which is the one that stays consistent when a month or a year preset is added.
 * `this_year` is calendar-anchored: 1 January to 31 December of the year `today` falls in.
 */
export function resolvePreset(preset: RelativePreset, today: CivilDate): ResolvedDateBound {
  switch (preset) {
    case 'last_30_days':
      return { kind: 'range', from: subtractUnits(today, 30, 'day'), to: today }
    case 'this_year':
      return { kind: 'range', from: startOfYear(today), to: endOfYear(today) }
    default:
      return assertNever(preset, 'relative preset')
  }
}

/** Everything strictly before `today − n units`. */
export function resolveOlderThan(
  n: number,
  unit: RelativeUnit,
  today: CivilDate,
): ResolvedDateBound {
  return { kind: 'before', cutoff: subtractUnits(today, n, unit) }
}

/**
 * Everything strictly after `today − n units`. Unlike a preset window this has no upper bound, so
 * a future-dated row matches — which is what `next_followup_at newer_than 0 days` is for.
 */
export function resolveNewerThan(
  n: number,
  unit: RelativeUnit,
  today: CivilDate,
): ResolvedDateBound {
  return { kind: 'after', cutoff: subtractUnits(today, n, unit) }
}

/**
 * Resolves any relative filter payload against the injected `today`.
 *
 * Returns a `Result` because `n` arrives from a URL: a hand-edited `older_than` of ten million
 * days is user input, not a programmer error.
 */
export function resolveRelativeDate(
  spec: RelativeDateSpec,
  today: CivilDate,
): Result<ResolvedDateBound> {
  switch (spec.op) {
    case 'in_relative':
      return ok(resolvePreset(spec.preset, today))
    case 'older_than':
    case 'newer_than': {
      if (!Number.isInteger(spec.n) || spec.n < 0 || spec.n > MAX_RELATIVE_N) {
        return fail(
          'out_of_range',
          `Use a whole number of ${spec.unit}s between 0 and ${MAX_RELATIVE_N}.`,
          ['n'],
          { n: spec.n },
        )
      }
      return ok(
        spec.op === 'older_than'
          ? resolveOlderThan(spec.n, spec.unit, today)
          : resolveNewerThan(spec.n, spec.unit, today),
      )
    }
    default:
      return assertNever(spec, 'relative date operator')
  }
}

/** Whether a civil date satisfies a resolved bound. Used by the import preview and by tests. */
export function boundContains(bound: ResolvedDateBound, value: CivilDate): boolean {
  switch (bound.kind) {
    case 'range':
      return compareCivil(value, bound.from) >= 0 && compareCivil(value, bound.to) <= 0
    case 'before':
      return compareCivil(value, bound.cutoff) < 0
    case 'after':
      return compareCivil(value, bound.cutoff) > 0
    default:
      return assertNever(bound, 'resolved date bound')
  }
}
