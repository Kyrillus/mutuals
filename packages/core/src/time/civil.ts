import { fail, ok, type Result } from '../result.ts'

/**
 * Civil dates: a calendar day with no time and no zone, proleptic Gregorian, `'YYYY-MM-DD'`.
 *
 * A JS `Date` is an instant pretending to be a day, and every bug this module exists to prevent
 * comes from that confusion. `now`, `today` and `timeZone` are always injected (ADR-081): nothing
 * here reads the wall clock, so a warmth score or a follow-up date computed on one machine is the
 * same on every other one.
 */

declare const CIVIL_DATE: unique symbol

export type CivilDate = string & { readonly [CIVIL_DATE]: true }

const CIVIL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const MS_PER_DAY = 86_400_000

export interface CivilParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Days in a proleptic Gregorian month. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** True when `raw` is a well-formed civil date that names a real day. */
export function isCivilDate(raw: string): raw is CivilDate {
  const m = CIVIL_PATTERN.exec(raw)
  if (m === null) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** Parses user input. `'2026-02-30'` is rejected, not rolled over into March. */
export function parseCivil(raw: string): Result<CivilDate> {
  const trimmed = raw.trim()
  if (trimmed === '') return fail('required', 'Enter a date.')
  if (!isCivilDate(trimmed)) {
    return fail('bad_date', `"${raw}" is not a date in YYYY-MM-DD form.`)
  }
  return ok(trimmed)
}

/**
 * Civil date from a literal. Throws on malformed input, so it is for code and tests only —
 * user input goes through {@link parseCivil}.
 */
export function civil(raw: string): CivilDate {
  if (!isCivilDate(raw)) throw new Error(`Not a civil date: ${JSON.stringify(raw)}`)
  return raw
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Builds a civil date from parts, clamping the day to the length of the month. */
export function civilFromParts(year: number, month: number, day: number): CivilDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Civil date parts must be integers: ${year}-${month}-${day}`)
  }
  if (month < 1 || month > 12) throw new Error(`Month out of range: ${month}`)
  const clamped = Math.min(Math.max(day, 1), daysInMonth(year, month))
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(clamped, 2)}` as CivilDate
}

export function civilParts(date: CivilDate): CivilParts {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  }
}

export function dayOfMonth(date: CivilDate): number {
  return Number(date.slice(8, 10))
}

// Date.UTC maps years 0-99 onto 1900-1999, which would silently corrupt a year like 0050.
function utcMillis(year: number, month: number, day: number): number {
  const millis = Date.UTC(year, month - 1, day)
  if (year >= 0 && year < 100) {
    const shifted = new Date(millis)
    shifted.setUTCFullYear(year)
    return shifted.getTime()
  }
  return millis
}

function toMillis(date: CivilDate): number {
  const { year, month, day } = civilParts(date)
  return utcMillis(year, month, day)
}

function fromMillis(millis: number): CivilDate {
  const d = new Date(millis)
  return civilFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromMillis(toMillis(date) + days * MS_PER_DAY)
}

/**
 * Adds whole months, clamping to the length of the target month. `anchorDay` is the day of the
 * month the *series* started on: without it a chain that once passed through February would be
 * demoted to the 28th forever (ADR-043).
 */
export function addMonths(date: CivilDate, months: number, anchorDay?: number): CivilDate {
  const { year, month, day } = civilParts(date)
  const total = year * 12 + (month - 1) + months
  const targetYear = Math.floor(total / 12)
  const targetMonth = (total % 12) + 1
  return civilFromParts(targetYear, targetMonth, anchorDay ?? day)
}

/** `a - b`, in whole days. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((toMillis(a) - toMillis(b)) / MS_PER_DAY)
}

export function compareCivil(a: CivilDate, b: CivilDate): -1 | 0 | 1 {
  // Zero-padded ISO order is lexicographic order, so no parsing is needed.
  return a < b ? -1 : a > b ? 1 : 0
}

export function startOfYear(date: CivilDate): CivilDate {
  return civilFromParts(civilParts(date).year, 1, 1)
}

export function endOfYear(date: CivilDate): CivilDate {
  return civilFromParts(civilParts(date).year, 12, 31)
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = PART_FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  PART_FORMATTERS.set(timeZone, created)
  return created
}

/**
 * The civil date `instant` falls on in `timeZone`. Assembled from `formatToParts`, not from a
 * locale string, because a locale that happens to print ISO today is a coincidence, not a contract.
 */
export function civilIn(timeZone: string, instant: Date): CivilDate {
  const parts = formatterFor(timeZone).formatToParts(instant)
  let year = 0
  let month = 0
  let day = 0
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
  }
  return civilFromParts(year, month, day)
}

/** Today, in the profile's timezone, from the injected `now`. Never reads the wall clock. */
export function todayIn(timeZone: string, now: Date): CivilDate {
  return civilIn(timeZone, now)
}
