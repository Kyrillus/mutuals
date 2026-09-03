/**
 * The contract every attribute type implements.
 *
 * It is deliberately non-generic (ADR-036). The generic version was contravariant in its config
 * parameter, so the heterogeneous registry could only be built with a cast and every call site got
 * `unknown` back anyway. Instead each method takes `config: unknown` and narrows it with its own
 * `configSchema` on the way in, and `typeDef('number')` hands a call site that *does* know which
 * type it wants the precise definition object back.
 */
import type { z } from 'zod'

import type { Result } from '../../result.ts'
import type { IdentifierKind, SlotValue, ValueKind } from '../kinds.ts'
import type { OperatorId } from '../operators.ts'
import type { AttributeOption } from '../option.ts'
import type { SlotColumn } from '../slots.ts'

/**
 * Turns a national phone number into E.164. Injected rather than imported: the metadata is 145 kB
 * and `packages/core` ships to the browser, so the API and the importer supply this from
 * `@mutuals/core/phone` and the web bundle leaves it `undefined` (ADR-035).
 */
export type PhoneNormalizer = (raw: string, region: string | undefined) => string | undefined

export interface TypeContext {
  /** Options for this attribute, archived ones included. Empty for every non-select type. */
  readonly options: readonly AttributeOption[]
  /** Profile default for numbers typed without a country code (ADR-045). */
  readonly phoneRegion?: string
  readonly normalizePhone?: PhoneNormalizer
}

/**
 * How a type sorts. `null` is §4.2's "—": the column header is not clickable and the API answers
 * a sort request on it with 400 rather than silently falling back to insertion order.
 */
export type SortSpec =
  | { readonly via: 'slot'; readonly column: SlotColumn; readonly invert?: boolean }
  | { readonly via: 'option-position' }

/** Cardinality. `from-config` is `relation` alone, which is one-or-many per §4.2. */
export type Cardinality = 'single' | 'multi' | 'from-config'

/**
 * §4.2's UI column, as data. `apps/web`'s cell and editor registries (ADR-052) key off this, so a
 * new attribute type reaching the frontend is a new entry in two maps and no new `switch`.
 */
export type AttributeUi =
  | 'text_input'
  | 'textarea'
  | 'number_input'
  | 'date_picker'
  | 'switch'
  | 'select'
  | 'multi_select'
  | 'tag_input'
  | 'url_input'
  | 'email_input'
  | 'phone_input'
  | 'record_picker'

export interface AttributeTypeDefinition {
  /** Machine name; also a member of the database's `attribute_type` enum. */
  readonly type: string
  readonly valueKind: ValueKind
  readonly cardinality: Cardinality
  readonly ui: AttributeUi

  /** §6.7's create-attribute dialog and the API's validation both read this. */
  readonly configSchema: z.ZodType

  /**
   * The value schema for one concrete attribute definition. Always the schema for the *whole*
   * value, so a multi-valued type returns an array schema and callers need no cardinality branch.
   */
  value(config: unknown, ctx: TypeContext): z.ZodType

  /**
   * Canonical database form, one entry per fact row. Called only with a value that has already
   * passed {@link value}; a value that has not is a programmer error and throws.
   */
  normalize(input: unknown, config: unknown, ctx: TypeContext): readonly SlotValue[]

  /** Free text — a CSV cell, an inline edit, LLM output — to something {@link value} accepts. */
  coerce(raw: string, config: unknown, ctx: TypeContext): Result<unknown>

  /** Display string for chips, CSV export and the LLM's context. */
  format(values: readonly SlotValue[], config: unknown, ctx: TypeContext): string

  /** §4.2's operators, in the order the operator dropdown offers them. */
  readonly operators: readonly OperatorId[]
  readonly sort: SortSpec | null

  /**
   * §4.6 write-through to the `identifier` table. `'by-slug'` means the kind depends on the
   * attribute's slug — a `url` is a LinkedIn profile or a website depending on what it is called.
   */
  readonly identifier?: IdentifierKind | 'by-slug'

  /** Whether §6.8 step 3 offers the per-value mapping editor for this type. */
  readonly hasValueMapping: boolean
}

/** The separator a multi-valued type splits a single CSV cell on. */
export const MULTI_VALUE_SEPARATOR = /\s*[;,|]\s*/

export function expectString(input: unknown, type: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`${type}.normalize expects a string, received ${typeof input}`)
  }
  return input
}

export function expectBoolean(input: unknown, type: string): boolean {
  if (typeof input !== 'boolean') {
    throw new TypeError(`${type}.normalize expects a boolean, received ${typeof input}`)
  }
  return input
}

export function expectArray(input: unknown, type: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${type}.normalize expects an array, received ${typeof input}`)
  }
  return input as readonly unknown[]
}

/** Splits one imported cell into the elements of a multi-valued attribute. */
export function splitMultiValue(raw: string): string[] {
  return raw
    .split(MULTI_VALUE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Length in code points, not UTF-16 units, so an emoji or an astral-plane name counts as one
 * character everywhere — in the schema, in the coercion error and in the character counter.
 */
export function codePointLength(value: string): number {
  return [...value].length
}

/** The text carried by text-kind slots, in order. Slots of another kind are ignored. */
export function textOf(values: readonly SlotValue[]): string[] {
  return values.flatMap((value) => (value.kind === 'text' ? [value.text] : []))
}
