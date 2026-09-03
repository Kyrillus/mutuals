/**
 * `yes_no` — a nullable boolean, rendered as a tri-state switch.
 *
 * Nullable matters: "we do not know whether this person is an angel" and "this person is not an
 * angel" are different facts, and §4.2 gives the type an `is empty` operator to tell them apart.
 */
import { z } from 'zod'

import { fail, ok, type Result } from '../../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type SlotValue } from '../kinds.ts'
import { SLOT_COLUMNS } from '../slots.ts'
import { expectBoolean, type AttributeTypeDefinition } from './def.ts'

const configSchema = z.object({})

export type YesNoConfig = z.output<typeof configSchema>

const TRUTHY = new Set(['yes', 'y', 'true', 't', '1', 'x', 'ja', 'wahr', '✓', '✔'])
const FALSY = new Set(['no', 'n', 'false', 'f', '0', 'nein', 'falsch', '✗', '✘'])

export const yesNo = {
  type: 'yes_no',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.yes_no,
  cardinality: 'single',
  ui: 'switch',
  configSchema,

  value(): z.ZodType {
    return z.boolean()
  },

  normalize(input: unknown): readonly SlotValue[] {
    return [{ kind: 'bool', bool: expectBoolean(input, 'yes_no') }]
  },

  coerce(raw: string): Result<boolean> {
    const token = raw.trim().toLowerCase()
    if (token === '') return fail('required', 'This field is empty.')
    if (TRUTHY.has(token)) return ok(true)
    if (FALSY.has(token)) return ok(false)
    return fail('invalid_input', `"${raw}" is not a yes or a no.`)
  },

  format(values: readonly SlotValue[]): string {
    const first = values.find((value) => value.kind === 'bool')
    return first === undefined ? '' : first.bool ? 'Yes' : 'No'
  },

  operators: ['is_yes', 'is_no', 'is_empty', 'is_not_empty'],
  // §4.2 sorts "yes first", so an ascending click has to emit DESC. `invert` exists for this one
  // type, which is cheaper than a special case in the sort compiler.
  sort: { via: 'slot', column: SLOT_COLUMNS.bool.sort, invert: true },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition
