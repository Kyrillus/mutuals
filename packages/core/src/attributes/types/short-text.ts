/**
 * `short_text` — a single-line string, §4.2's most ordinary type and the default for a new
 * attribute.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { SLOT_COLUMNS } from '../slots.ts'
import { codePointLength, expectString, textOf, type AttributeTypeDefinition } from './def.ts'

export const DEFAULT_MAX_LENGTH = 255

const configSchema = z.object({
  maxLength: z.int().min(1).max(DEFAULT_MAX_LENGTH).optional(),
})

export type ShortTextConfig = z.output<typeof configSchema>

function limitOf(config: unknown): number {
  return configSchema.parse(config).maxLength ?? DEFAULT_MAX_LENGTH
}

export const shortText = {
  type: 'short_text',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.short_text,
  cardinality: 'single',
  ui: 'text_input',
  configSchema,

  value(config: unknown): z.ZodType {
    const limit = limitOf(config)
    return z
      .string()
      .trim()
      .min(1)
      .refine((value) => codePointLength(value) <= limit, {
        error: `Keep this under ${String(limit)} characters.`,
      })
  },

  normalize(input: unknown): readonly SlotValue[] {
    return [{ kind: 'text', text: expectString(input, 'short_text').trim() }]
  },

  coerce(raw: string, config: unknown): Result<string> {
    const trimmed = raw.trim()
    if (trimmed === '') return fail('required', 'This field is empty.')
    const limit = limitOf(config)
    if (codePointLength(trimmed) > limit) {
      return fail('too_long', `Longer than ${String(limit)} characters.`)
    }
    return ok(trimmed)
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values)[0] ?? ''
  },

  operators: ['contains', 'equals', 'is_empty', 'is_not_empty'],
  sort: { via: 'slot', column: SLOT_COLUMNS.text.sort },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
