/**
 * `tags` — free-form labels the user creates as they type (§4.2), which is what makes `asks` and
 * `offers` usable in the moment rather than a trip to Settings.
 *
 * There is no option table behind it, so a tag's identity is its normalised text — and that
 * normalisation happens in SQL, on the way into the fact log (ADR-018, ADR-019). This file only
 * decides what counts as a tag at all.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { casefoldForDisplay } from '../../text/casefold.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import {
  codePointLength,
  expectArray,
  splitMultiValue,
  textOf,
  type AttributeTypeDefinition,
} from './def.ts'

export const MAX_TAG_LENGTH = 255

const configSchema = z.object({})

export type TagsConfig = z.output<typeof configSchema>

const tagSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => codePointLength(value) <= MAX_TAG_LENGTH, {
    error: `Keep a tag under ${String(MAX_TAG_LENGTH)} characters.`,
  })

export const tags = {
  type: 'tags',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.tags,
  cardinality: 'multi',
  ui: 'tag_input',
  configSchema,

  value(): z.ZodType {
    return z.array(tagSchema).min(1)
  },

  normalize(input: unknown): readonly SlotValue[] {
    const seen = new Set<string>()
    const slots: SlotValue[] = []
    for (const entry of expectArray(input, 'tags')) {
      if (typeof entry !== 'string') {
        throw new TypeError('tags.normalize expects an array of strings')
      }
      const text = entry.trim()
      // Only an exact-duplicate guard: two spellings that differ by an accent are two tags here,
      // and SQL decides whether they collide.
      const key = casefoldForDisplay(text)
      if (text === '' || seen.has(key)) continue
      seen.add(key)
      slots.push({ kind: 'text', text })
    }
    return slots
  },

  coerce(raw: string): Result<string[]> {
    const parts = splitMultiValue(raw)
    if (parts.length === 0) return fail('required', 'This field is empty.')
    const tooLong = parts.find((part) => codePointLength(part) > MAX_TAG_LENGTH)
    if (tooLong !== undefined) {
      return fail('too_long', `Tags must be under ${String(MAX_TAG_LENGTH)} characters.`)
    }
    const seen = new Set<string>()
    const kept: string[] = []
    for (const part of parts) {
      const key = casefoldForDisplay(part)
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(part)
    }
    return ok(kept)
  },

  format(values: readonly SlotValue[]): string {
    return textOf(values).join(', ')
  },

  operators: ['contains_any_of', 'is_empty', 'is_not_empty'],
  sort: null,
  hasValueMapping: true,
} as const satisfies AttributeTypeDefinition
