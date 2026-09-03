/**
 * `multi_select` — any number of options from a curated list.
 *
 * Facts for a multi-valued attribute are added and removed one element at a time (§4.5), so
 * `normalize` returns one slot per option and the write path turns each into its own row.
 */
import { z } from 'zod'

import { fail, failWith, ok, type CoreIssue, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { findOptionById, findOptionByKey, matchOption } from '../option.ts'
import {
  expectArray,
  splitMultiValue,
  type AttributeTypeDefinition,
  type TypeContext,
} from './def.ts'
import { optionSchema } from './single-select.ts'

const configSchema = z.object({})

export type MultiSelectConfig = z.output<typeof configSchema>

export const multiSelect = {
  type: 'multi_select',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.multi_select,
  cardinality: 'multi',
  ui: 'multi_select',
  configSchema,

  value(_config: unknown, ctx: TypeContext): z.ZodType {
    return z.array(optionSchema(ctx)).min(1)
  },

  normalize(input: unknown, _config: unknown, ctx: TypeContext): readonly SlotValue[] {
    const seen = new Set<string>()
    const slots: SlotValue[] = []
    for (const entry of expectArray(input, 'multi_select')) {
      if (typeof entry !== 'string') {
        throw new TypeError('multi_select.normalize expects an array of option keys')
      }
      const option = findOptionByKey(ctx.options, entry)
      if (option === undefined) {
        throw new Error(`multi_select.normalize received an unknown option key: ${entry}`)
      }
      if (seen.has(option.key)) continue
      seen.add(option.key)
      slots.push({ kind: 'option', optionId: option.id, optionKey: option.key })
    }
    return slots
  },

  coerce(raw: string, _config: unknown, ctx: TypeContext): Result<string[]> {
    const parts = splitMultiValue(raw)
    if (parts.length === 0) return fail('required', 'This field is empty.')
    const keys: string[] = []
    const issues: CoreIssue[] = []
    parts.forEach((part, index) => {
      const matched = matchOption(part, ctx.options)
      if (!matched.ok) {
        issues.push(...matched.issues.map((i) => ({ ...i, path: [index, ...i.path] })))
      } else if (!keys.includes(matched.value)) {
        keys.push(matched.value)
      }
    })
    return issues.length > 0 ? failWith(issues) : ok(keys)
  },

  format(values: readonly SlotValue[], _config: unknown, ctx: TypeContext): string {
    return values
      .flatMap((value) =>
        value.kind === 'option'
          ? [findOptionById(ctx.options, value.optionId)?.label ?? value.optionKey]
          : [],
      )
      .join(', ')
  },

  operators: ['contains_any_of', 'contains_all_of', 'is_empty', 'is_not_empty'],
  sort: null,
  hasValueMapping: true,
} as const satisfies AttributeTypeDefinition
