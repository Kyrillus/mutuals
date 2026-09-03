/**
 * The attribute-type registry.
 *
 * `AttributeType` is **derived** from {@link DEFINITIONS}, never declared beside it. That is the
 * whole point: a thirteenth type is one new file plus one array entry, and every `switch` that has
 * become non-exhaustive is a compile error rather than a runtime surprise. Nothing here knows a
 * column name, an operator's SQL or a React component — those read the registry.
 */
import { assertNever } from '../result.ts'
import { VALUE_KIND_BY_ATTRIBUTE_TYPE, type ValueKind } from './kinds.ts'
import type { OperatorId } from './operators.ts'
import { date } from './types/date.ts'
import type { AttributeTypeDefinition, Cardinality, SortSpec } from './types/def.ts'
import { email } from './types/email.ts'
import { longText } from './types/long-text.ts'
import { multiSelect } from './types/multi-select.ts'
import { number } from './types/number.ts'
import { phone } from './types/phone.ts'
import { relation } from './types/relation.ts'
import { shortText } from './types/short-text.ts'
import { singleSelect } from './types/single-select.ts'
import { tags } from './types/tags.ts'
import { url } from './types/url.ts'
import { yesNo } from './types/yes-no.ts'

const DEFINITIONS = [
  shortText,
  longText,
  number,
  date,
  yesNo,
  singleSelect,
  multiSelect,
  tags,
  url,
  email,
  phone,
  relation,
] as const

export type AttributeType = (typeof DEFINITIONS)[number]['type']

/** The precise definition object for one type, so a call site that knows the type keeps its types. */
export type TypeDefinitionFor<T extends AttributeType> = Extract<
  (typeof DEFINITIONS)[number],
  { readonly type: T }
>

/** The union of every type's parsed config. */
export type AttributeConfig = {
  [T in AttributeType]: ReturnType<TypeDefinitionFor<T>['configSchema']['parse']>
}[AttributeType]

export const ATTRIBUTE_TYPES: readonly AttributeType[] = Object.freeze(
  DEFINITIONS.map((definition) => definition.type),
)

export const REGISTRY: { readonly [T in AttributeType]: TypeDefinitionFor<T> } = Object.freeze(
  Object.fromEntries(DEFINITIONS.map((definition) => [definition.type, definition])),
) as { readonly [T in AttributeType]: TypeDefinitionFor<T> }

export function isAttributeType(value: string): value is AttributeType {
  return (ATTRIBUTE_TYPES as readonly string[]).includes(value)
}

/** The registry entry for a type, with its concrete config and value types preserved. */
export function typeDef<T extends AttributeType>(type: T): TypeDefinitionFor<T> {
  return REGISTRY[type]
}

/** Erased to the shared interface, for the loops that iterate every type. */
export function anyTypeDef(type: AttributeType): AttributeTypeDefinition {
  return REGISTRY[type]
}

/** Mirrors the `ad_kind_matches_type` CHECK; the CHECK is the backstop, this is the source. */
export function valueKindOf(type: AttributeType): ValueKind {
  return VALUE_KIND_BY_ATTRIBUTE_TYPE[type]
}

export function operatorsFor(type: AttributeType): readonly OperatorId[] {
  return REGISTRY[type].operators
}

export function sortSpecFor(type: AttributeType): SortSpec | null {
  return REGISTRY[type].sort
}

/** §4.2's dash column: a type with no sort semantics makes its header unclickable. */
export function isSortableType(type: AttributeType): boolean {
  return REGISTRY[type].sort !== null
}

/**
 * Whether one attribute holds several values. It decides the value's identity key and therefore
 * how the unique indexes behave (ADR-018); `relation` is the only type that consults its config.
 */
export function isMultiValued(type: AttributeType, config: unknown): boolean {
  return isMultiCardinality(REGISTRY[type].cardinality, config)
}

/**
 * Split out from {@link isMultiValued} so the exhaustiveness guard is reachable from a test: a
 * thirteenth cardinality would be a compile error here, and this is where that is proved.
 */
export function isMultiCardinality(cardinality: Cardinality, config: unknown): boolean {
  switch (cardinality) {
    case 'single':
      return false
    case 'multi':
      return true
    case 'from-config':
      return relation.configSchema.parse(config).cardinality === 'many'
    default:
      return assertNever(cardinality, 'cardinality')
  }
}
