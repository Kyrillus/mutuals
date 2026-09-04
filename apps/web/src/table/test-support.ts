/**
 * Fixtures for the table's own tests.
 *
 * They build real `FieldDescriptor`s through `packages/core`'s own constructors rather than
 * hand-rolling the shape: a test that invents its own descriptor stops failing the day the
 * descriptor changes, which is the day it should fail loudest.
 */
import {
  completeDefinition,
  describeAttribute,
  describeSystemField,
  systemFields,
  type AttributeType,
  type FieldDescriptor,
  type ObjectType,
} from '@mutuals/core'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

/**
 * A descriptor for `slug`: the real system field when `packages/core` declares one, otherwise an
 * attribute of the given type.
 */
export function field(
  slug: string,
  options: {
    objectType?: ObjectType
    type?: AttributeType
    showByDefault?: boolean
    position?: number
    label?: string
  } = {},
): FieldDescriptor {
  const objectType = options.objectType ?? 'contact'
  const declared = systemFields(objectType).find((entry) => entry.slug === slug)
  if (declared !== undefined) {
    const base = describeSystemField(declared, options.position ?? 0)
    return options.showByDefault === undefined
      ? base
      : { ...base, showByDefault: options.showByDefault }
  }

  return describeAttribute(
    completeDefinition(
      {
        id: `00000000-0000-4000-8000-${slug.padEnd(12, '0').slice(0, 12)}`,
        objectType,
        title: options.label ?? slug,
        slug,
        type: options.type ?? 'short_text',
        config: {},
        options: [],
        isSystem: false,
        position: options.position ?? 0,
        showByDefault: options.showByDefault ?? true,
      },
      TIMESTAMPS,
    ),
  )
}
