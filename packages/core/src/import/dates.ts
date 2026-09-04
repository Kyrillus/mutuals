/**
 * Per-column date-format inference (ADR-044).
 *
 * `date.coerce` refuses `03/04/2026` outright, because one cell cannot say whether it is 3 April or
 * 4 March. The wizard resolves it with evidence the cell does not have: **every other cell in the
 * same column**. A column holding `03/04/2026` and `17/06/2026` can only be day-first, because no
 * month is 17.
 *
 * Inference runs over all samples rather than the first, and produces three distinguishable states
 * so the wizard can render three different things: a confident format, a guess the user should
 * check, and mixed data — which is an error, never a guess.
 *
 * Once a format is known, `applyDateFormat` rewrites the cell as `YYYY-MM-DD` and the ordinary
 * `date.coerce` validates it. Nothing downstream learns that a format was ever involved.
 */
import { fail, ok, type Result } from '../result.ts'
import { civilFromParts, daysInMonth, isCivilDate, type CivilDate } from '../time/civil.ts'

/**
 * The spellings an export actually uses. Ordered by how much a match tells you: `iso` and the two
 * month-name shapes are self-describing, the three positional ones are not.
 */
export const DATE_FORMATS = ['iso', 'd_mon_y', 'mon_d_y', 'dmy', 'mdy', 'ymd'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const DATE_FORMAT_LABELS: Readonly<Record<DateFormat, string>> = {
  iso: 'YYYY-MM-DD',
  d_mon_y: '14 Mar 2023',
  mon_d_y: 'Mar 14, 2023',
  dmy: 'day/month/year',
  mdy: 'month/day/year',
  ymd: 'year/month/day',
}

/** ADR-044: two German users, so a genuine coin-flip lands day-first. Reversible in one click. */
export const DEFAULT_AMBIGUOUS_FORMAT: DateFormat = 'dmy'

export interface DateFormatInference {
  /** `null` only when the samples conflict — no format reads all of them. */
  readonly format: DateFormat | null
  /** The fitting formats disagree about at least one cell. The wizard asks rather than assumes. */
  readonly ambiguous: boolean
  /** Mixed data. An error, not something to guess at. */
  readonly conflicting: boolean
  /** Every format that reads every sample, best-evidence first. */
  readonly candidates: readonly DateFormat[]
  /** Non-empty cells considered. */
  readonly samples: number
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/
/** Separator is `/`, `.` or `-`; the parts are read according to the format, never guessed here. */
const POSITIONAL_PARTS = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/
const DAY_MONTH_YEAR = /^(\d{1,2})[ .-]+([A-Za-z]{3,})\.?,?[ .-]+(\d{4})$/
const MONTH_DAY_YEAR = /^([A-Za-z]{3,})\.?[ .-]+(\d{1,2})(?:st|nd|rd|th)?,?[ .-]+(\d{4})$/

function monthNumber(name: string): number | undefined {
  return MONTHS[name.slice(0, 3).toLowerCase()]
}

interface Ymd {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Reads one cell in one format. `undefined` means "this format cannot read this cell". */
function read(raw: string, format: DateFormat): Ymd | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  if (format === 'iso') {
    const match = ISO_LIKE.exec(trimmed)
    if (match === null) return undefined
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  }

  if (format === 'd_mon_y') {
    const match = DAY_MONTH_YEAR.exec(trimmed)
    const month = match === null ? undefined : monthNumber(match[2] as string)
    if (match === null || month === undefined) return undefined
    return { year: Number(match[3]), month, day: Number(match[1]) }
  }

  if (format === 'mon_d_y') {
    const match = MONTH_DAY_YEAR.exec(trimmed)
    const month = match === null ? undefined : monthNumber(match[1] as string)
    if (match === null || month === undefined) return undefined
    return { year: Number(match[3]), month, day: Number(match[2]) }
  }

  const match = POSITIONAL_PARTS.exec(trimmed)
  if (match === null) return undefined
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // A four-digit first part is a year whatever the format claims, and a four-digit last part is
  // never a day — so `ymd` and the two day/month readings stay mutually exclusive on real data.
  if (format === 'ymd')
    return (match[1] as string).length === 4 ? { year: a, month: b, day: c } : undefined
  if ((match[3] as string).length !== 4) return undefined
  return format === 'dmy' ? { year: c, month: b, day: a } : { year: c, month: a, day: b }
}

function isRealDate(parts: Ymd): boolean {
  return (
    parts.year >= 1000 &&
    parts.year <= 9999 &&
    parts.month >= 1 &&
    parts.month <= 12 &&
    parts.day >= 1 &&
    parts.day <= daysInMonth(parts.year, parts.month)
  )
}

/**
 * Which formats read every non-empty sample, and how sure that makes us.
 *
 * A format that reads all samples is a candidate; one that fails a single cell is out, which is
 * what makes 17/06 decisive. Ambiguity and conflict are then just the two ways the candidate set
 * can be the wrong size.
 */
export function inferDateFormat(samples: readonly string[]): DateFormatInference {
  const values = samples.map((sample) => sample.trim()).filter((sample) => sample !== '')

  if (values.length === 0) {
    return { format: null, ambiguous: true, conflicting: false, candidates: [], samples: 0 }
  }

  const candidates = DATE_FORMATS.filter((format) =>
    values.every((value) => {
      const parts = read(value, format)
      return parts !== undefined && isRealDate(parts)
    }),
  )

  // Destructured rather than length-checked: it proves non-emptiness to the compiler without a
  // type assertion, which the lint rule and `tsc` disagree about under `noUncheckedIndexedAccess`.
  const [first] = candidates
  if (first === undefined) {
    return { format: null, ambiguous: false, conflicting: true, candidates, samples: values.length }
  }

  const preferred = candidates.includes(DEFAULT_AMBIGUOUS_FORMAT) ? DEFAULT_AMBIGUOUS_FORMAT : first

  return {
    format: preferred,
    ambiguous: disagree(values, candidates),
    conflicting: false,
    candidates,
    samples: values.length,
  }
}

/**
 * Whether the fitting formats actually produce different dates.
 *
 * This replaces two cruder rules that were both wrong. Counting candidates flags `2026-03-04`,
 * which `iso` and `ymd` both read and read *identically* — a warning about a cell with one possible
 * meaning. And ADR-044's "a single-sample column is always reported ambiguous" flags `17/06/2026`,
 * where day-first is the only arithmetic possibility because no month is 17. What the user needs to
 * be asked about is disagreement, and the number of rows is only ever a proxy for it: one row of
 * `03/04/2026` disagrees, one row of `17/06/2026` does not.
 */
function disagree(values: readonly string[], candidates: readonly DateFormat[]): boolean {
  if (candidates.length < 2) return false
  const first = candidates[0] as DateFormat
  return values.some((value) => {
    const reference = read(value, first)
    return candidates.some((format) => {
      const other = read(value, format)
      return (
        other === undefined ||
        reference === undefined ||
        other.year !== reference.year ||
        other.month !== reference.month ||
        other.day !== reference.day
      )
    })
  })
}

/** Rewrites one cell as `YYYY-MM-DD`, which is the only shape anything downstream sees. */
export function applyDateFormat(raw: string, format: DateFormat): Result<CivilDate> {
  const parts = read(raw, format)
  if (parts === undefined) {
    return fail('bad_date', `"${raw}" is not a ${DATE_FORMAT_LABELS[format]} date.`)
  }
  if (!isRealDate(parts)) return fail('bad_date', `"${raw}" is not a real date.`)
  const assembled = civilFromParts(parts.year, parts.month, parts.day)
  return isCivilDate(assembled) ? ok(assembled) : fail('bad_date', `"${raw}" is not a real date.`)
}
