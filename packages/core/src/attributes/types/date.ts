/**
 * `date` — a calendar day with no time and no zone (§4.2: "date (no time)").
 *
 * `coerce` accepts only spellings that cannot mean two things. `03/04/2026` is 3 April to a German
 * and 4 March to an American, and there is no way to tell from one cell, so it is refused here and
 * resolved by the import wizard, which infers a format per column over every sample (ADR-044).
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { civil, isCivilDate, type CivilDate } from '../../time/civil.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { SLOT_COLUMNS } from '../slots.ts'
import { expectString, type AttributeTypeDefinition } from './def.ts'

const configSchema = z.object({})

export type DateConfig = z.output<typeof configSchema>

export const civilDateSchema = z
  .string()
  .refine(isCivilDate, { error: 'Enter a date as YYYY-MM-DD.' })
  .transform((value) => civil(value))

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2})[T ]/
const DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/
const SLASHED = /^\d{1,2}\/\d{1,2}\/\d{4}$/

function pad(value: string): string {
  return value.padStart(2, '0')
}

export const date = {
  type: 'date',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.date,
  cardinality: 'single',
  ui: 'date_picker',
  configSchema,

  value(): z.ZodType {
    return civilDateSchema
  },

  normalize(input: unknown): readonly SlotValue[] {
    return [{ kind: 'date', date: civil(expectString(input, 'date')) }]
  },

  coerce(raw: string): Result<CivilDate> {
    const trimmed = raw.trim()
    if (trimmed === '') return fail('required', 'This field is empty.')

    const isoPrefix = ISO_PREFIX.exec(trimmed)
    const candidate = isoPrefix?.[1] ?? trimmed
    if (isCivilDate(candidate)) return ok(civil(candidate))

    // Dotted day-first is the German spelling and is never read the other way round.
    if (DOTTED.test(trimmed)) {
      // The pattern has already proved three dot-separated parts, so the split is total.
      const [day, month, year] = trimmed.split('.') as [string, string, string]
      const assembled = `${year}-${pad(month)}-${pad(day)}`
      return isCivilDate(assembled)
        ? ok(civil(assembled))
        : fail('bad_date', `"${raw}" is not a real date.`)
    }

    if (SLASHED.test(trimmed)) {
      return fail(
        'ambiguous_date',
        `"${raw}" could be day/month or month/day. Import it with a column format, or write it ` +
          'as YYYY-MM-DD.',
      )
    }
    return fail('bad_date', `"${raw}" is not a date.`)
  },

  format(values: readonly SlotValue[]): string {
    return values.find((value) => value.kind === 'date')?.date ?? ''
  },

  operators: [
    'before',
    'after',
    'between',
    'in_relative',
    'older_than',
    'newer_than',
    'is_empty',
    'is_not_empty',
  ],
  sort: { via: 'slot', column: SLOT_COLUMNS.date.sort },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
