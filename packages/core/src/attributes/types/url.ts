/**
 * `url` — a link, rendered as one.
 *
 * A missing scheme is added (people paste `linkedin.com/in/anna`) but nothing else is rewritten:
 * `new URL(…).href` would append a trailing slash and re-encode the path, so the value the user
 * sees would stop being the value they typed, and §4.5's fact log would record our edit as theirs.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { expectString, textOf, type AttributeTypeDefinition } from './def.ts'

const configSchema = z.object({})

export type UrlConfig = z.output<typeof configSchema>

/** Adds `https://` when no scheme is present. Returns `undefined` when the result is not a URL. */
export function canonicalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '' || /\s/u.test(trimmed)) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return undefined
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? withScheme : undefined
}

export const url = {
  type: 'url',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.url,
  cardinality: 'single',
  ui: 'url_input',
  configSchema,

  value(): z.ZodType {
    return z
      .string()
      .trim()
      .min(1)
      .transform((raw) => canonicalizeUrl(raw))
      .refine((value): value is string => value !== undefined, {
        error: 'Enter a web address, for example https://example.com.',
      })
  },

  normalize(input: unknown): readonly SlotValue[] {
    const canonical = canonicalizeUrl(expectString(input, 'url'))
    if (canonical === undefined) throw new Error('url.normalize received a value that is not a URL')
    return [{ kind: 'text', text: canonical }]
  },

  coerce(raw: string): Result<string> {
    if (raw.trim() === '') return fail('required', 'This field is empty.')
    const canonical = canonicalizeUrl(raw)
    return canonical === undefined
      ? fail('invalid_input', `"${raw}" is not a web address.`)
      : ok(canonical)
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values)[0] ?? ''
  },

  operators: ['contains', 'is_empty', 'is_not_empty'],
  sort: null,
  // §4.6: whether this is a `linkedin_url` or a `website` identifier depends on the slug, which a
  // type definition cannot see.
  identifier: 'by-slug',
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
