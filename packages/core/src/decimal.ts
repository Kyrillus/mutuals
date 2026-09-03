/**
 * Decimal numbers as strings (ADR-039).
 *
 * The `number` attribute type lands in a Postgres `numeric`, and a JS `number` cannot round-trip
 * one: `250000.50` comes back as `250000.5`, and a valuation past 2^53 comes back wrong entirely.
 * The canonical in-memory form is therefore the digit string itself, so what the user typed, what
 * the append-only fact log stores and what the API returns are byte-identical.
 */
import { fail, ok, type Result } from './result.ts'

declare const DECIMAL_STRING: unique symbol

export type DecimalString = string & { readonly [DECIMAL_STRING]: true }

/** Up to 30 integer digits and 10 fractional ones — comfortably inside `numeric` and inside a CSV. */
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,10})?$/

const LOOSE_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/

export const MAX_INTEGER_DIGITS = 30
export const MAX_FRACTION_DIGITS = 10

export interface DecimalRange {
  readonly min?: DecimalString
  readonly max?: DecimalString
}

export interface DecimalFormatOptions {
  /** Absent means "show every digit that was stored" — ADR-039: rounding is a display operation. */
  readonly decimals?: number
  readonly unit?: string
  /** BCP-47 tag. Absent means no grouping separators at all, which is what a CSV export wants. */
  readonly locale?: string
}

/** True for the canonical form only: no leading `+`, no redundant leading zeros, no exponent. */
export function isDecimalString(value: string): value is DecimalString {
  return DECIMAL_PATTERN.test(value)
}

/**
 * Decimal from a literal. Throws on malformed input, so it is for code and tests only — user
 * input goes through {@link parseDecimal} or {@link parseDecimalLoose}.
 */
export function decimal(raw: string): DecimalString {
  if (!isDecimalString(raw)) throw new Error(`Not a decimal string: ${JSON.stringify(raw)}`)
  return raw
}

/**
 * Validates a strict decimal literal. A leading `+`, redundant leading zeros and a negative zero
 * are accepted and canonicalised away; trailing fractional zeros are kept, because `250000.50`
 * and `250000.5` are different scales in `numeric` and the user typed one of them.
 */
export function parseDecimal(raw: string, range: DecimalRange = {}): Result<DecimalString> {
  const trimmed = raw.trim()
  if (trimmed === '') return fail('required', 'Enter a number.')

  const match = LOOSE_PATTERN.exec(trimmed)
  if (match === null) return fail('not_a_number', `"${raw}" is not a number.`)

  const canonical = canonicalise(match[1] === '-', match[2] ?? '', match[3])
  if (canonical === undefined) {
    return fail(
      'out_of_range',
      `A number may have at most ${String(MAX_INTEGER_DIGITS)} digits before and ` +
        `${String(MAX_FRACTION_DIGITS)} digits after the decimal point.`,
    )
  }
  return checkRange(canonical, range)
}

/**
 * Free text → decimal, for CSV cells, inline edits and LLM output. The algorithm, numbered so the
 * import wizard's behaviour is reproducible:
 *
 *  1. trim; empty is `required`.
 *  2. reject anything outside digits, `.`, `,`, `'`, sign and spaces — so `€1.2k` and `12%` fail
 *     loudly rather than being guessed at.
 *  3. drop spaces (including NBSP and narrow NBSP) and apostrophes: those are only ever group
 *     separators, in every locale that uses them.
 *  4. take one leading sign; a sign anywhere else is an error.
 *  5. with both `.` and `,` present, the **last** one is the decimal separator and the other must
 *     group correctly — 1–3 digits, then blocks of exactly 3.
 *  6. with one separator character repeated, it is a group separator and must group correctly.
 *  7. with one separator appearing once, exactly three digits after it and 1–3 digits before it,
 *     the value is genuinely ambiguous (`1,234` is 1234 in en and 1.234 in de). That is refused,
 *     never guessed, because either guess is a factor-of-1000 error in a field holding cheque
 *     sizes. The issue carries `meta.ambiguous` so the wizard can offer the two readings.
 *  8. otherwise the single separator is the decimal separator.
 */
export function parseDecimalLoose(raw: string, range: DecimalRange = {}): Result<DecimalString> {
  const trimmed = raw.trim()
  if (trimmed === '') return fail('required', 'Enter a number.')
  if (/[^0-9.,'\s+-]/u.test(trimmed)) return fail('not_a_number', `"${raw}" is not a number.`)

  const stripped = trimmed.replace(/[\s']/gu, '')
  const sign = stripped.startsWith('-') ? '-' : ''
  const body = /^[+-]/.test(stripped) ? stripped.slice(1) : stripped
  if (body === '' || /[+-]/.test(body)) return fail('not_a_number', `"${raw}" is not a number.`)

  const separators = detectSeparators(body)
  if (separators === 'ambiguous') {
    const at = body.search(/[.,]/)
    const before = body.slice(0, at)
    const after = body.slice(at + 1)
    return fail(
      'not_a_number',
      `"${raw}" could mean ${before}${after} or ${before}.${after}. Write it without group ` +
        'separators.',
      [],
      { ambiguous: true },
    )
  }

  let integerText = body
  let fractionText = ''
  if (separators.decimal !== undefined) {
    const at = body.lastIndexOf(separators.decimal)
    integerText = body.slice(0, at)
    fractionText = body.slice(at + 1)
  }
  if (separators.group !== undefined) {
    if (!isCorrectlyGrouped(integerText, separators.group)) {
      return fail('not_a_number', `"${raw}" is not a number.`)
    }
    integerText = integerText.split(separators.group).join('')
  }
  if (integerText === '') integerText = '0'
  if (!/^\d+$/.test(integerText) || !/^\d*$/.test(fractionText)) {
    return fail('not_a_number', `"${raw}" is not a number.`)
  }

  const assembled = `${sign}${integerText}${fractionText === '' ? '' : `.${fractionText}`}`
  return parseDecimal(assembled, range)
}

/** Total order over decimal strings. Exact, and never goes through a float. */
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const aNegative = a.startsWith('-')
  const bNegative = b.startsWith('-')
  if (aNegative !== bNegative) return aNegative ? -1 : 1
  const magnitude = compareMagnitude(aNegative ? a.slice(1) : a, bNegative ? b.slice(1) : b)
  if (magnitude === 0) return 0
  return aNegative ? (magnitude === 1 ? -1 : 1) : magnitude
}

/**
 * Rounds half away from zero to `decimals` places, padding with zeros when the value is shorter.
 * Display only: the fact log keeps whatever the user typed, so a `decimals` setting added later
 * cannot destroy digits that were already stored.
 */
export function roundDecimal(value: DecimalString, decimals: number): DecimalString {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_FRACTION_DIGITS) {
    throw new Error(`decimals must be an integer in 0..${String(MAX_FRACTION_DIGITS)}`)
  }
  const negative = value.startsWith('-')
  const digits = negative ? value.slice(1) : value
  const dot = digits.indexOf('.')
  const integerPart = dot === -1 ? digits : digits.slice(0, dot)
  const fractionPart = dot === -1 ? '' : digits.slice(dot + 1)

  let kept = `${integerPart}${fractionPart.slice(0, decimals)}`.padEnd(
    integerPart.length + decimals,
    '0',
  )
  const nextDigit = fractionPart[decimals]
  if (nextDigit !== undefined && nextDigit >= '5') kept = increment(kept)

  const integerLength = kept.length - decimals
  const canonical = canonicalise(
    negative,
    kept.slice(0, integerLength),
    decimals === 0 ? undefined : kept.slice(integerLength),
  )
  if (canonical === undefined) {
    throw new Error(`Rounding overflowed ${String(MAX_INTEGER_DIGITS)} integer digits: ${value}`)
  }
  return canonical
}

/** Renders a value for a chip, a table cell or a CSV column. */
export function formatDecimal(value: DecimalString, options: DecimalFormatOptions = {}): string {
  const { decimals, unit, locale } = options
  const rounded = decimals === undefined ? value : roundDecimal(value, decimals)
  const fractionDigits = rounded.split('.')[1]?.length ?? 0

  const rendered = locale === undefined ? rounded : group(rounded, locale, fractionDigits)
  return unit === undefined || unit === '' ? rendered : `${rendered} ${unit}`
}

/**
 * `Intl.NumberFormat.format` takes a string and formats it exactly (ES2023), which is what keeps a
 * 30-digit value from going through a double on its way to the screen. The lib type admits only
 * string *literals*, so the call is widened here rather than at every call site.
 */
function group(value: DecimalString, locale: string, fractionDigits: number): string {
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: true,
  })
  return (formatter.format as (input: string) => string)(value)
}

interface Separators {
  readonly decimal?: string
  readonly group?: string
}

function detectSeparators(body: string): Separators | 'ambiguous' {
  const dots = countOf(body, '.')
  const commas = countOf(body, ',')

  if (dots > 0 && commas > 0) {
    const decimalSeparator = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ','
    return { decimal: decimalSeparator, group: decimalSeparator === '.' ? ',' : '.' }
  }
  if (dots + commas > 1) return { group: dots > 0 ? '.' : ',' }
  if (dots + commas === 0) return {}

  const only = dots === 1 ? '.' : ','
  const at = body.indexOf(only)
  const before = body.slice(0, at)
  const after = body.slice(at + 1)
  if (after.length === 3 && before.length >= 1 && before.length <= 3) return 'ambiguous'
  return { decimal: only }
}

function canonicalise(
  negative: boolean,
  integerPart: string,
  fractionPart: string | undefined,
): DecimalString | undefined {
  const integer = integerPart.replace(/^0+(?=\d)/, '')
  if (integer.length > MAX_INTEGER_DIGITS) return undefined
  if (fractionPart !== undefined && fractionPart.length > MAX_FRACTION_DIGITS) return undefined

  const allZero = /^0*$/.test(integer) && (fractionPart === undefined || /^0*$/.test(fractionPart))
  const sign = negative && !allZero ? '-' : ''
  const candidate =
    fractionPart === undefined || fractionPart === ''
      ? `${sign}${integer}`
      : `${sign}${integer}.${fractionPart}`
  return isDecimalString(candidate) ? candidate : undefined
}

function checkRange(value: DecimalString, range: DecimalRange): Result<DecimalString> {
  if (range.min !== undefined && compareDecimal(value, range.min) < 0) {
    return fail('out_of_range', `Must be at least ${range.min}.`)
  }
  if (range.max !== undefined && compareDecimal(value, range.max) > 0) {
    return fail('out_of_range', `Must be at most ${range.max}.`)
  }
  return ok(value)
}

function compareMagnitude(a: string, b: string): -1 | 0 | 1 {
  const [aInteger = '0', aFraction = ''] = a.split('.')
  const [bInteger = '0', bFraction = ''] = b.split('.')
  if (aInteger.length !== bInteger.length) return aInteger.length < bInteger.length ? -1 : 1
  if (aInteger !== bInteger) return aInteger < bInteger ? -1 : 1
  const width = Math.max(aFraction.length, bFraction.length)
  const aPadded = aFraction.padEnd(width, '0')
  const bPadded = bFraction.padEnd(width, '0')
  if (aPadded === bPadded) return 0
  return aPadded < bPadded ? -1 : 1
}

function countOf(text: string, character: string): number {
  let found = 0
  for (const c of text) if (c === character) found += 1
  return found
}

function isCorrectlyGrouped(text: string, separator: string): boolean {
  const [first, ...rest] = text.split(separator)
  if (first === undefined || !/^\d{1,3}$/.test(first)) return false
  return rest.every((part) => /^\d{3}$/.test(part))
}

function increment(digits: string): string {
  const out = [...digits]
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const d = out[i] ?? '0'
    if (d === '9') {
      out[i] = '0'
    } else {
      out[i] = String.fromCharCode(d.charCodeAt(0) + 1)
      return out.join('')
    }
  }
  return `1${out.join('')}`
}
