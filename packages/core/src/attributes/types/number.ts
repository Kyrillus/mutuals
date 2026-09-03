/**
 * `number` — a decimal, stored as a string all the way to Postgres `numeric` (ADR-039).
 *
 * `decimals` has no default. A number attribute created without touching that field stores exactly
 * what was typed; rounding only ever happens on the way to the screen. The alternative — rounding
 * on write — silently turned `250000.50` into `250001` in an append-only log, which is
 * unrecoverable.
 */
import { z } from 'zod'

import {
  compareDecimal,
  decimal,
  formatDecimal,
  isDecimalString,
  parseDecimalLoose,
  type DecimalString,
} from '../../decimal.ts'
import { type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { SLOT_COLUMNS } from '../slots.ts'
import { expectString, type AttributeTypeDefinition } from './def.ts'

/** A canonical decimal literal. Exported because the number config's bounds are decimals too. */
export const decimalStringSchema = z
  .string()
  .refine(isDecimalString, { error: 'Enter a number like 1250 or 1250.50.' })
  .transform((value) => decimal(value))

const configSchema = z.object({
  unit: z.string().max(16).optional(),
  decimals: z.int().min(0).max(10).optional(),
  min: decimalStringSchema.optional(),
  max: decimalStringSchema.optional(),
})

export type NumberConfig = z.output<typeof configSchema>

function inRange(value: DecimalString, config: NumberConfig): boolean {
  if (config.min !== undefined && compareDecimal(value, config.min) < 0) return false
  return config.max === undefined || compareDecimal(value, config.max) <= 0
}

function boundsMessage(config: NumberConfig): string {
  if (config.min !== undefined && config.max !== undefined) {
    return `Must be between ${config.min} and ${config.max}.`
  }
  if (config.min !== undefined) return `Must be at least ${config.min}.`
  return `Must be at most ${config.max ?? ''}.`
}

export const number = {
  type: 'number',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.number,
  cardinality: 'single',
  ui: 'number_input',
  configSchema,

  value(config: unknown): z.ZodType {
    const parsed = configSchema.parse(config)
    return decimalStringSchema.refine((value) => inRange(value, parsed), {
      error: boundsMessage(parsed),
    })
  },

  normalize(input: unknown): readonly SlotValue[] {
    return [{ kind: 'number', num: decimal(expectString(input, 'number')) }]
  },

  coerce(raw: string, config: unknown): Result<DecimalString> {
    const parsed = configSchema.parse(config)
    return parseDecimalLoose(raw, { min: parsed.min, max: parsed.max })
  },

  format(values: readonly SlotValue[], config: unknown): string {
    const first = values.find((value) => value.kind === 'number')
    if (first === undefined) return ''
    const parsed = configSchema.parse(config)
    return formatDecimal(first.num, { decimals: parsed.decimals, unit: parsed.unit })
  },

  operators: ['eq', 'neq', 'lt', 'gt', 'between', 'is_empty', 'is_not_empty'],
  sort: { via: 'slot', column: SLOT_COLUMNS.number.sort },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
