/**
 * `long_text` — markdown prose: `how_we_met`, `notes`, an organization's description.
 *
 * It is the one text type that never sorts, and its sort slot is left NULL on purpose: a btree
 * tuple is capped at ~2704 bytes, so indexing a note would fail at import time on real user data
 * rather than in review.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { expectString, textOf, type AttributeTypeDefinition } from './def.ts'

const configSchema = z.object({})

export type LongTextConfig = z.output<typeof configSchema>

export const longText = {
  type: 'long_text',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.long_text,
  cardinality: 'single',
  ui: 'textarea',
  configSchema,

  value(): z.ZodType {
    return z.string().trim().min(1)
  },

  normalize(input: unknown): readonly SlotValue[] {
    return [{ kind: 'text', text: expectString(input, 'long_text').trim() }]
  },

  coerce(raw: string): Result<string> {
    const trimmed = raw.trim()
    return trimmed === '' ? fail('required', 'This field is empty.') : ok(trimmed)
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values)[0] ?? ''
  },

  operators: ['contains', 'is_empty', 'is_not_empty'],
  sort: null,
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
