/**
 * `single_select` — one option from a curated list.
 *
 * The list lives in the `attribute_option` table rather than inside `config`, so a stored value
 * points at its option with a real foreign key and §6.7's clear-or-remap flow is enforceable. That
 * is also why `value` and `coerce` need a {@link TypeContext}: the options are not in the config.
 */
import { z } from 'zod'

import type { Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { activeOptions, findOptionById, findOptionByKey, matchOption } from '../option.ts'
import { expectString, type AttributeTypeDefinition, type TypeContext } from './def.ts'

const configSchema = z.object({})

export type SingleSelectConfig = z.output<typeof configSchema>

/**
 * Verified against zod 4.5.4: `z.enum([])` constructs happily and then rejects every value with
 * "Invalid option: expected one of " — a field nobody can fill, reporting an error that names
 * nothing. ADR-038 makes an empty option list unreachable by refusing to create or empty such an
 * attribute; this branch keeps the failure legible if archiving ever gets there anyway.
 */
export function optionSchema(ctx: TypeContext): z.ZodType {
  const keys = activeOptions(ctx.options).map((option) => option.key)
  const [first, ...rest] = keys
  if (first === undefined) {
    return z.never({ error: 'This attribute has no options to choose from.' })
  }
  return z.enum([first, ...rest])
}

export const singleSelect = {
  type: 'single_select',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.single_select,
  cardinality: 'single',
  ui: 'select',
  configSchema,

  value(_config: unknown, ctx: TypeContext): z.ZodType {
    return optionSchema(ctx)
  },

  normalize(input: unknown, _config: unknown, ctx: TypeContext): readonly SlotValue[] {
    const key = expectString(input, 'single_select')
    const option = findOptionByKey(ctx.options, key)
    if (option === undefined) {
      throw new Error(`single_select.normalize received an unknown option key: ${key}`)
    }
    return [{ kind: 'option', optionId: option.id, optionKey: option.key }]
  },

  coerce(raw: string, _config: unknown, ctx: TypeContext): Result<string> {
    return matchOption(raw, ctx.options)
  },

  format(values: readonly SlotValue[], _config: unknown, ctx: TypeContext): string {
    const first = values.find((value) => value.kind === 'option')
    if (first === undefined) return ''
    return findOptionById(ctx.options, first.optionId)?.label ?? first.optionKey
  },

  operators: ['is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
  sort: { via: 'option-position' },
  hasValueMapping: true,
} as const satisfies AttributeTypeDefinition
