/**
 * `email` — a validated address, rendered as a `mailto:` link and written through to the
 * `identifier` table, where it is the strongest duplicate signal we have (§4.6).
 *
 * Lower-cased on the way in, because §4.6 defines the stored identifier as the lower-cased
 * address. The local part is technically case-sensitive; no mail provider in this decade treats it
 * that way, and two rows differing only in case would defeat the unique index that duplicate
 * detection rests on.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { SLOT_COLUMNS } from '../slots.ts'
import { codePointLength, expectString, textOf, type AttributeTypeDefinition } from './def.ts'

const configSchema = z.object({})

export type EmailConfig = z.output<typeof configSchema>

export const MAX_EMAIL_LENGTH = 254

// Deliberately not RFC 5322. That grammar accepts comments and quoted local parts nobody can send
// mail to, and rejecting a real address is the expensive mistake here, not accepting a strange one.
const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/

/** Trims and lower-cases; returns `undefined` when the value cannot be an address. */
export function canonicalizeEmail(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^mailto:/i, '')
  if (!EMAIL_PATTERN.test(trimmed)) return undefined
  if (codePointLength(trimmed) > MAX_EMAIL_LENGTH) return undefined
  return trimmed.toLowerCase()
}

export const email = {
  type: 'email',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.email,
  cardinality: 'single',
  ui: 'email_input',
  configSchema,

  value(): z.ZodType {
    return z
      .string()
      .transform((raw) => canonicalizeEmail(raw))
      .refine((value): value is string => value !== undefined, {
        error: 'Enter an email address, for example anna@example.com.',
      })
  },

  normalize(input: unknown): readonly SlotValue[] {
    const canonical = canonicalizeEmail(expectString(input, 'email'))
    if (canonical === undefined) {
      throw new Error('email.normalize received a value that is not an email address')
    }
    return [{ kind: 'text', text: canonical }]
  },

  coerce(raw: string): Result<string> {
    if (raw.trim() === '') return fail('required', 'This field is empty.')
    const canonical = canonicalizeEmail(raw)
    return canonical === undefined
      ? fail('invalid_email', `"${raw}" is not an email address.`)
      : ok(canonical)
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values)[0] ?? ''
  },

  operators: ['contains', 'is_empty', 'is_not_empty'],
  sort: { via: 'slot', column: SLOT_COLUMNS.text.sort },
  identifier: 'email',
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
