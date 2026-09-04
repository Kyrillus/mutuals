/**
 * Display formatting, as pure functions.
 *
 * Every rule the table renders a value by lives here rather than inside a cell component, because
 * Stage 3's detail page, the CSV export and the LLM's context all have to agree with the table —
 * and three copies of "3 weeks ago" would agree for about a week. Nothing here reads the wall
 * clock: `today`, `now`, `timeZone` and `locale` are parameters (CLAUDE.md, ADR-081), so a value
 * rendered on one machine renders identically on another.
 *
 * The number path delegates to `@mutuals/core`'s `formatDecimal`, which is the only thing allowed
 * to touch a decimal — a `numeric` never becomes a JS `number` on its way to the screen (ADR-039).
 */
import { diffDays, formatDecimal, type CivilDate, type DecimalString } from '@mutuals/core'

/** The unit and rounding a `number` attribute's config asks for; both are optional there. */
export interface NumberDisplay {
  readonly unit?: string
  readonly decimals?: number
}

/**
 * Renders a decimal for a cell: grouped for the locale, rounded to the configured places and
 * suffixed with the unit. Rounding is a display operation only — the stored value keeps every
 * digit the user typed.
 */
export function formatNumber(
  value: DecimalString | string,
  display: NumberDisplay,
  locale: string,
): string {
  return formatDecimal(value as DecimalString, {
    locale,
    ...(display.decimals === undefined ? {} : { decimals: display.decimals }),
    ...(display.unit === undefined || display.unit === '' ? {} : { unit: display.unit }),
  })
}

const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(locale: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATTERS.get(locale)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    // The value is a calendar day, not an instant. Pinning UTC is what stops "1991-11-03" being
    // shown as the 2nd to anyone west of Greenwich.
    timeZone: 'UTC',
  })
  DATE_FORMATTERS.set(locale, created)
  return created
}

/** A civil date as a person reads it: `3 Nov 1991`. */
export function formatCivilDate(date: string, locale: string): string {
  return dayFormatter(locale).format(new Date(`${date}T00:00:00Z`))
}

const DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/** An instant, in the profile's timezone: `3 Nov 1991, 14:20`. */
export function formatDateTime(iso: string, locale: string, timeZone: string): string {
  const key = `${locale}|${timeZone}`
  let formatter = DATE_TIME_FORMATTERS.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    })
    DATE_TIME_FORMATTERS.set(key, formatter)
  }
  return formatter.format(new Date(iso))
}

const RELATIVE_FORMATTERS = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = RELATIVE_FORMATTERS.get(locale)
  if (cached !== undefined) return cached
  // `numeric: 'auto'` is what turns -1 day into "yesterday" and -1 week into "last week" instead
  // of "1 day ago", in every language, for free.
  const created = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  RELATIVE_FORMATTERS.set(locale, created)
  return created
}

/** Day granularity, in whole units, so the answer is stable for a whole day. */
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30.436875
const DAYS_PER_YEAR = 365.2425

/**
 * §6.2's `Last interaction` column: "3 weeks ago", "last month", "today".
 *
 * The unit is chosen by magnitude — days up to a week, weeks up to six, then months, then years —
 * so the phrase stays short and its precision matches how much precision is left in it. A future
 * date reads "in 3 weeks"; follow-ups need that and it costs nothing.
 */
export function formatRelativeDay(date: CivilDate, today: CivilDate, locale: string): string {
  const days = diffDays(date, today)
  const magnitude = Math.abs(days)
  const format = relativeFormatter(locale)

  if (magnitude < DAYS_PER_WEEK) return format.format(days, 'day')
  if (magnitude <= 45) return format.format(Math.round(days / DAYS_PER_WEEK), 'week')
  if (magnitude < DAYS_PER_YEAR) return format.format(Math.round(days / DAYS_PER_MONTH), 'month')
  return format.format(Math.round(days / DAYS_PER_YEAR), 'year')
}

/**
 * Strips the scheme and a leading `www.` so a link reads as a name rather than as a URL. The href
 * keeps the value verbatim — this is what is shown, never what is followed.
 */
export function prettyUrl(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
}

/**
 * The complete set of two-digit ITU country calling codes. Zones 1 and 7 are one digit and every
 * code outside this list is three, which makes the set below the whole rule rather than a sample.
 */
// prettier-ignore
const TWO_DIGIT_CALLING_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47',
  '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65',
  '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
])

const E164 = /^\+\d{6,17}$/

function callingCodeLength(digits: string): number {
  const zone = digits[0]
  if (zone === '1' || zone === '7') return 1
  return TWO_DIGIT_CALLING_CODES.has(digits.slice(0, 2)) ? 2 : 3
}

/**
 * A stored phone number, made readable: one space after the country calling code and nothing else.
 *
 * National grouping differs per country and `libphonenumber-js` is deliberately absent from the
 * browser bundle (ADR-035), so guessing it here would be inventing a format. A value that is not
 * E.164 is shown exactly as it was typed — which is also exactly what the write path stored when
 * it could not normalise it.
 */
export function formatPhone(raw: string): string {
  const trimmed = raw.trim()
  if (!E164.test(trimmed)) return trimmed
  const digits = trimmed.slice(1)
  const code = callingCodeLength(digits)
  return `+${digits.slice(0, code)} ${digits.slice(code)}`
}

/** `tel:` target for a phone value, or undefined when there is nothing dialable in it. */
export function phoneHref(raw: string): string | undefined {
  const compact = raw.replace(/[^\d+]/gu, '')
  return compact.replace(/\D/gu, '').length >= 5 ? `tel:${compact}` : undefined
}

/** `mailto:` target. The address is already lower-cased and validated by the write path. */
export function mailtoHref(address: string): string {
  return `mailto:${address}`
}
