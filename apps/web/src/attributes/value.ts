/**
 * The bridge between the three shapes one attribute value has.
 *
 * The API **reads** a value as a tagged union (`AttributeValue`), **writes** it as whatever that
 * attribute's own schema accepts, and a control has to **edit** something in between — a select
 * reads an option with a label and a colour, writes a bare key, and edits the key while still
 * needing the label to draw. Those three are not the same type and pretending they are is how a
 * field name ends up hard-coded in a component.
 *
 * So: `AttributeDraft` is what a control holds, `toDraft` converts a read value into one, and
 * `toWriteValue` converts it back. `null` from `toWriteValue` clears the attribute, which is
 * ADR-017's single definition of empty — an empty attribute is an absent key, never `''` or `[]`.
 */
import {
  anyTypeDef,
  isAttributeType,
  typeDef,
  type AttributeOption,
  type CivilDate,
  type DecimalString,
  type AttributeType,
  type AttributeValue,
  type ObjectType,
  type RelationValue,
  type TypeContext,
} from '@mutuals/core'

import type { NumberDisplay } from './format.ts'

/**
 * One select option, spelled either way.
 *
 * `AttributeOptionSchema` on the wire says `color: string | null`; `packages/core`'s
 * `AttributeOption` says `color?: string`. They are the same fact, and admitting both here means no
 * caller has to translate between them before it can draw a chip.
 */
export interface AttributeOptionLike {
  readonly id: string
  readonly key: string
  readonly label: string
  readonly color?: string | null
  readonly position: number
  readonly archivedAt?: string | null
}

/**
 * Everything the two registries need from an attribute definition, and nothing else.
 *
 * Deliberately structural rather than one of the two named types. `AttributeDefinition` is the
 * domain object the field resolver carries (ADR-037); `AttributeDefinitionDto` is the wire object
 * the API answers with. They differ in two places — `type` is `AttributeType` on one and `string`
 * on the other, because `AttributeTypeSchema` casts its enum to `[string, ...string[]]` and erases
 * the union — and a cell has no business caring which of them it was handed. Depending on the
 * intersection means both work and nobody converts.
 */
export interface AttributeSpec {
  readonly slug: string
  readonly title: string
  readonly objectType: ObjectType
  readonly type: string
  readonly config: unknown
  readonly options?: readonly AttributeOptionLike[]
  readonly description?: string | null
  readonly isDerived?: boolean
}

/** The read value for one type, unwrapped from its tagged-union member. */
export type AttributeReadValue<T extends AttributeType = AttributeType> = Extract<
  AttributeValue,
  { type: T }
>['value']

/**
 * What a control edits, per type.
 *
 * Text-shaped types edit their own string. A select edits option **keys**, because keys are what
 * the wire carries and a rename must not invalidate an open editor. A relation edits the full read
 * value: the picker has to draw a chip for a record it has not fetched, and only the read shape
 * carries the label.
 */
export interface AttributeDraftByType {
  short_text: string
  long_text: string
  /** Branded, like the read value: a control emits a canonical decimal, never the text being
   *  typed into it, so a `numeric` never round-trips through a JS number (ADR-039). */
  number: DecimalString
  date: CivilDate
  yes_no: boolean
  single_select: string
  multi_select: readonly string[]
  tags: readonly string[]
  url: string
  email: string
  phone: string
  relation: readonly RelationValue[]
}

/**
 * Proof that the map above covers the registry. It is not decoration: the two registries index
 * `AttributeDraftByType` by `AttributeType`, so a thirteenth type breaks here first and with a
 * message that names the missing key.
 */
type MissingDraft = Exclude<AttributeType, keyof AttributeDraftByType>
const _draftsAreExhaustive: MissingDraft extends never ? true : MissingDraft = true
void _draftsAreExhaustive

export type AttributeDraft<T extends AttributeType = AttributeType> = AttributeDraftByType[T]

/**
 * The definition's type, narrowed to the registry.
 *
 * `AttributeTypeSchema` is `z.enum([...ATTRIBUTE_TYPES] as [string, ...string[]])`, and that cast
 * erases the union, so a definition that came off the wire carries a plain `string` even though the
 * values are closed. `isAttributeType` is the guard `packages/core` publishes for exactly this, and
 * this is the one place the frontend crosses back. A definition carrying a type the registry has
 * never heard of cannot be rendered by anything, so it throws — a programmer error is not user
 * input and does not get a `Result` (ADR-034).
 */
export function attributeTypeOf(definition: AttributeSpec): AttributeType {
  if (isAttributeType(definition.type)) return definition.type
  throw new Error(`Attribute "${definition.slug}" has an unknown type: ${definition.type}`)
}

/** The definition's options as `packages/core` wants them: an absent colour, not a null one. */
export function coreOptions(definition: AttributeSpec): readonly AttributeOption[] {
  return (definition.options ?? []).map((option) => ({
    id: option.id,
    key: option.key,
    label: option.label,
    position: option.position,
    archivedAt: option.archivedAt ?? null,
    ...(option.color === null || option.color === undefined ? {} : { color: option.color }),
  }))
}

/**
 * The context a type definition needs to validate. `normalizePhone` is deliberately absent: its
 * metadata is 145 kB and this bundle ships to a browser, so the browser validates the shape and
 * the API does the E.164 normalisation (ADR-035).
 */
export function typeContextFor(definition: AttributeSpec): TypeContext {
  return { options: coreOptions(definition) }
}

/** ADR-017: an absent key is the only empty. The rest is belt and braces against a stray `''`. */
export function isEmptyDraft(type: AttributeType, draft: AttributeDraft | undefined): boolean {
  if (draft === undefined) return true
  if (typeof draft === 'boolean') return false
  if (typeof draft === 'string') return draft.trim() === ''
  return draft.length === 0
}

/**
 * A read value as the control that edits it wants to see it.
 *
 * The value's own `type` discriminates, so nothing here consults the definition's — a row whose
 * value predates a (forbidden) type change renders as what it actually is rather than throwing.
 */
export function toDraft(value: AttributeValue | undefined): AttributeDraft | undefined {
  if (value === undefined) return undefined
  switch (value.type) {
    case 'single_select':
      return value.value.key
    case 'multi_select':
      return value.value.map((option) => option.key)
    default:
      return value.value
  }
}

/** The write payload for one draft, or `null` to clear the attribute. */
export function toWriteValue(type: AttributeType, draft: AttributeDraft | undefined): unknown {
  if (isEmptyDraft(type, draft)) return null
  if (type === 'relation') {
    return (draft as readonly RelationValue[]).map((record) => ({
      id: record.id,
      // Link metadata is preserved rather than edited: §4.3's title/from/to/primary editor is the
      // detail page's job, and dropping it here would silently erase a job history on every save.
      ...(record.title === null ? {} : { title: record.title }),
      ...(record.from === null ? {} : { from: record.from }),
      to: record.to,
      isPrimary: record.isPrimary,
    }))
  }
  return typeof draft === 'string' ? draft.trim() : draft
}

/**
 * A write value — what the API takes, and what an inline editor is opened with — as a draft.
 *
 * Everything but `relation` writes exactly what it edits, so this is the identity function eleven
 * times out of twelve. A relation is the exception: it writes ids and edits records, so the ids it
 * is handed are widened back into something a chip can draw, filling in whatever the caller knew.
 * Nothing is dropped — a link whose label was not passed renders by its id rather than disappearing
 * from the value on the next save.
 */
export function draftFromWriteValue(
  definition: AttributeSpec,
  value: unknown,
): AttributeDraft | undefined {
  if (value === null || value === undefined) return undefined
  if (attributeTypeOf(definition) !== 'relation') return value as AttributeDraft
  if (!Array.isArray(value)) return undefined
  const target = relationConfigOf(definition).targetObjectType
  return (value as readonly unknown[]).flatMap((entry): RelationValue[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Partial<RelationValue>
    if (typeof record.id !== 'string') return []
    return [
      {
        id: record.id,
        label: record.label ?? record.id,
        objectType: record.objectType ?? target,
        title: record.title ?? null,
        from: record.from ?? null,
        to: record.to ?? null,
        isPrimary: record.isPrimary ?? false,
      },
    ]
  })
}

/**
 * Runs the attribute's own schema over a draft and returns the first message, or undefined.
 *
 * The schema comes from `typeDef(type).value(config, ctx)` — the very object the API validates
 * with — so a message shown next to the input is the message the server would have sent, and the
 * two cannot drift apart into "looked fine, server said no".
 */
export function validateDraft(
  definition: AttributeSpec,
  draft: AttributeDraft | undefined,
): string | undefined {
  const type = attributeTypeOf(definition)
  const write = toWriteValue(type, draft)
  if (write === null) return undefined
  const result = anyTypeDef(type)
    .value(definition.config, typeContextFor(definition))
    .safeParse(write)
  return result.success ? undefined : result.error.issues[0]?.message
}

/**
 * The unit and rounding a `number` attribute was configured with.
 *
 * `typeDef('number')` hands back the concrete definition object rather than the erased interface,
 * so its `configSchema` still knows the config's shape and this returns a typed object instead of
 * `unknown` — which is the whole reason ADR-036 kept the registry non-generic.
 */
export function numberDisplayOf(definition: AttributeSpec): NumberDisplay {
  const config = typeDef('number').configSchema.parse(definition.config)
  return { unit: config.unit, decimals: config.decimals }
}

/** A `relation` attribute's target object type, cardinality and link-metadata flag. */
export function relationConfigOf(definition: AttributeSpec) {
  return typeDef('relation').configSchema.parse(definition.config)
}
