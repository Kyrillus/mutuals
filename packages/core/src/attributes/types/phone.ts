/**
 * `phone` — normalised to E.164 "where possible" (§4.2).
 *
 * The normaliser is injected rather than imported. `libphonenumber-js` carries its metadata with
 * it, and `packages/core` ships to the browser: importing it here would pull that metadata into
 * the web bundle through the registry barrel, for a job only the API and the importer do. The
 * browser therefore gets shape validation and keeps what the user typed (ADR-035).
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { expectString, textOf, type AttributeTypeDefinition, type TypeContext } from './def.ts'

const configSchema = z.object({})

export type PhoneConfig = z.output<typeof configSchema>

const ALLOWED_CHARACTERS = /^[+()\-./\s\d]+$/u
const MIN_DIGITS = 5
const MAX_DIGITS = 17

export function digitsOf(raw: string): string {
  return raw.replace(/\D/gu, '')
}

/** True for something that could be a phone number in any format. */
export function looksLikePhone(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === '' || !ALLOWED_CHARACTERS.test(trimmed)) return false
  const digits = digitsOf(trimmed)
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS
}

/** E.164 when the normaliser is available and the number parses; otherwise the trimmed input. */
export function canonicalizePhone(raw: string, ctx: TypeContext): string {
  const trimmed = raw.trim()
  return ctx.normalizePhone?.(trimmed, ctx.phoneRegion) ?? trimmed
}

export const phone = {
  type: 'phone',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.phone,
  cardinality: 'single',
  ui: 'phone_input',
  configSchema,

  value(): z.ZodType {
    return z.string().refine(looksLikePhone, { error: 'Enter a phone number.' })
  },

  normalize(input: unknown, _config: unknown, ctx: TypeContext): readonly SlotValue[] {
    return [{ kind: 'text', text: canonicalizePhone(expectString(input, 'phone'), ctx) }]
  },

  coerce(raw: string, _config: unknown, ctx: TypeContext): Result<string> {
    if (raw.trim() === '') return fail('required', 'This field is empty.')
    if (!looksLikePhone(raw)) return fail('invalid_phone', `"${raw}" is not a phone number.`)
    return ok(canonicalizePhone(raw, ctx))
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values)[0] ?? ''
  },

  operators: ['contains', 'is_empty', 'is_not_empty'],
  sort: null,
  identifier: 'phone',
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
