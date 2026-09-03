/**
 * The `AttributeDefinition` contract (ADR-037), written down once.
 *
 * Five surfaces iterate this array — the Columns picker, the filter picker, the create dialog, the
 * detail sidebar and CSV export — and before this type existed each of them read a slightly
 * different set of fields under two different names for the discriminator. `type` is the
 * discriminator. `value_kind` is derived from it and lives only on the database row, where the
 * composite foreign key needs it.
 */
import type { ObjectType, Uuid } from './kinds.ts'
import type { AttributeOption } from './option.ts'
import type { OperatorId } from './operators.ts'
import { isMultiValued, isSortableType, operatorsFor, type AttributeType } from './registry.ts'

export interface AttributeDefinition {
  readonly id: Uuid
  readonly objectType: ObjectType
  readonly title: string
  /** Immutable after creation (§4.2); the API refuses to change it. */
  readonly slug: string
  readonly type: AttributeType
  /** Per-type; narrowed by the type's own `configSchema`. */
  readonly config: unknown
  /** Present exactly when `type` is `single_select` or `multi_select`. */
  readonly options?: readonly AttributeOption[]
  /** §4.2's free-text group; drives the detail sidebar's sections. */
  readonly group?: string
  readonly description?: string
  /** System attributes cannot be deleted and cannot change type. */
  readonly isSystem: boolean
  readonly isMulti: boolean
  /** True for computed columns such as `warmth`; they render read-only everywhere. */
  readonly isDerived: boolean
  /** Derived from `type`; the API answers a sort request on a non-sortable field with 400. */
  readonly sortable: boolean
  readonly position: number
  readonly showByDefault: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * `required` is deliberately absent: §4.2 defines no such concept, and required-ness in Phase 1
 * belongs to system fields, which the create dialog marks itself.
 */
export type AttributeDefinitionDraft = Omit<
  AttributeDefinition,
  'isMulti' | 'sortable' | 'isDerived' | 'createdAt' | 'updatedAt'
> & {
  readonly isDerived?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** Fills in the fields that are functions of `type` and `config`, so no caller derives them twice. */
export function completeDefinition(
  draft: AttributeDefinitionDraft,
  timestamps: { readonly createdAt: string; readonly updatedAt: string },
): AttributeDefinition {
  return {
    ...draft,
    isDerived: draft.isDerived ?? false,
    isMulti: isMultiValued(draft.type, draft.config),
    sortable: isSortableType(draft.type),
    createdAt: draft.createdAt ?? timestamps.createdAt,
    updatedAt: draft.updatedAt ?? timestamps.updatedAt,
  }
}

export function definitionOperators(definition: AttributeDefinition): readonly OperatorId[] {
  return operatorsFor(definition.type)
}

/** Options ordered as §4.2's "option order" wants them, or an empty list for a non-select type. */
export function definitionOptions(definition: AttributeDefinition): readonly AttributeOption[] {
  return definition.options ?? []
}
