/**
 * One namespace over three kinds of field.
 *
 * The DataTable, the filter picker, the Columns menu and the query compiler must not know whether
 * `warmth` is a custom attribute, a column on `contact` or a column on `contact_metrics`. They ask
 * the resolver for a slug and get a descriptor; only the compiler in `packages/db` looks at
 * `source.kind`, and it does so in exactly one place.
 */
import type { ObjectType, ValueKind } from '../attributes/kinds.ts'
import type { OperatorId } from '../attributes/operators.ts'
import type { AttributeDefinition } from '../attributes/definition.ts'
import { operatorsFor, valueKindOf } from '../attributes/registry.ts'
import {
  fieldGroup,
  isMetricTable,
  systemFields,
  type MetricColumn,
  type MetricTable,
  type SystemColumn,
  type SystemField,
  type SystemTable,
} from './system.ts'

/** `gin_trgm_ops` cannot extract a trigram from fewer than three characters. */
export const MIN_SUBSTRING_LENGTH = 3

export type FieldSource =
  | { readonly kind: 'attribute'; readonly def: AttributeDefinition }
  | {
      readonly kind: 'column'
      readonly table: SystemTable
      readonly column: SystemColumn
      readonly valueKind: ValueKind
    }
  | {
      readonly kind: 'metric'
      readonly table: MetricTable
      readonly column: MetricColumn
      readonly valueKind: ValueKind
    }

export interface FieldDescriptor {
  readonly slug: string
  readonly label: string
  readonly source: FieldSource
  readonly operators: readonly OperatorId[]
  readonly sortable: boolean
  /** Derived columns and generated columns render as text, never as an editable cell. */
  readonly readOnly: boolean
  readonly isMulti: boolean
  readonly showByDefault: boolean
  /** System fields sort before attributes; attributes keep their own `position`. */
  readonly position: number
  /** §4.2's group, which §6.5's sidebar sections are built from. */
  readonly group?: string
  /** Present only where `contains` is offered, so the UI can wait for the third keystroke. */
  readonly minSubstringLength?: number
}

export interface FieldResolver {
  readonly objectType: ObjectType
  get(slug: string): FieldDescriptor | undefined
  list(): readonly FieldDescriptor[]
}

/** The value kind a filter value must be coerced to, whatever the field's source. */
export function fieldValueKind(field: FieldDescriptor): ValueKind {
  return field.source.kind === 'attribute'
    ? valueKindOf(field.source.def.type)
    : field.source.valueKind
}

export function describeSystemField(field: SystemField, position: number): FieldDescriptor {
  const group = fieldGroup(field)
  const source: FieldSource = isMetricTable(field.table)
    ? {
        kind: 'metric',
        table: field.table,
        column: field.column as MetricColumn,
        valueKind: field.valueKind,
      }
    : {
        kind: 'column',
        table: field.table,
        column: field.column as SystemColumn,
        valueKind: field.valueKind,
      }

  return withSubstringHint({
    slug: field.slug,
    label: field.label,
    source,
    operators: field.operators,
    sortable: field.sortable,
    readOnly: field.readOnly,
    isMulti: false,
    showByDefault: field.showByDefault,
    position,
    ...(group === undefined ? {} : { group }),
  })
}

export function describeAttribute(definition: AttributeDefinition): FieldDescriptor {
  return withSubstringHint({
    slug: definition.slug,
    label: definition.title,
    source: { kind: 'attribute', def: definition },
    operators: operatorsFor(definition.type),
    sortable: definition.sortable,
    readOnly: definition.isDerived,
    isMulti: definition.isMulti,
    showByDefault: definition.showByDefault,
    position: definition.position,
    ...(definition.group === undefined ? {} : { group: definition.group }),
  })
}

/**
 * Builds the resolver for one object type. A slug that is both a system field and an attribute
 * throws here rather than silently shadowing a column: slug reservation (ADR-041) already makes it
 * impossible, and an impossible state that happens anyway should stop the process, not the query.
 */
export function makeFieldResolver(
  objectType: ObjectType,
  attributes: readonly AttributeDefinition[],
): FieldResolver {
  const system = systemFields(objectType)
  const descriptors: FieldDescriptor[] = system.map((field, index) =>
    describeSystemField(field, index - system.length),
  )

  const wrongObject = attributes.find((attribute) => attribute.objectType !== objectType)
  if (wrongObject !== undefined) {
    throw new Error(
      `Attribute "${wrongObject.slug}" belongs to ${wrongObject.objectType}, not ${objectType}`,
    )
  }

  const bySlug = new Map<string, FieldDescriptor>()
  for (const descriptor of descriptors) bySlug.set(descriptor.slug, descriptor)

  const sorted = attributes
    .slice()
    // Slugs are unique per object type, so the slug breaks a position tie outright.
    .sort((a, b) => a.position - b.position || (a.slug < b.slug ? -1 : 1))

  for (const attribute of sorted) {
    if (bySlug.has(attribute.slug)) {
      throw new Error(
        `Attribute slug "${attribute.slug}" collides with an existing ${objectType} field`,
      )
    }
    const descriptor = describeAttribute(attribute)
    bySlug.set(descriptor.slug, descriptor)
    descriptors.push(descriptor)
  }

  const list = Object.freeze(descriptors)
  return {
    objectType,
    get: (slug) => bySlug.get(slug),
    list: () => list,
  }
}

function withSubstringHint(descriptor: FieldDescriptor): FieldDescriptor {
  return descriptor.operators.includes('contains')
    ? { ...descriptor, minSubstringLength: MIN_SUBSTRING_LENGTH }
    : descriptor
}
