/**
 * The columns of the attributes list, written as attribute definitions.
 *
 * §5.2 promises one DataTable, and §6.7 asks it to render the attribute definitions themselves.
 * The table takes `FieldDescriptor[]`, and a descriptor's `source` is one of three things: a
 * user-defined attribute, a system column or a metric. The last two carry a **closed union** of
 * physical column names from `SYSTEM_FIELDS`, so `slug` and `used_in` cannot be spelled as either
 * without lying about where they come from. They can be spelled as attributes, because that is
 * what they are: `Used in` is a number, `Type` is a choice from a fixed list, `Created` is a date.
 *
 * Writing them this way is what buys the reuse. The column factory, the Columns menu, the filter
 * picker and the cell registry all read a `FieldDescriptor` and none of them needs a settings
 * branch — "Type is one of Single select, Multi select" is offered by `FilterBar` because the
 * descriptor below carries the twelve registry types as its options, not because anything in the
 * filter bar has heard of attribute types.
 *
 * The definitions are synthetic and are never written anywhere: this file is the schema of a
 * settings screen, not of an object a user owns.
 */
import {
  ATTRIBUTE_TYPES,
  completeDefinition,
  describeAttribute,
  type AttributeDefinition,
  type AttributeOption,
  type AttributeType,
  type FieldDescriptor,
  type ObjectType,
  type OperatorId,
} from '@mutuals/core'

import { typeLabel } from '../editor/type-meta.ts'

interface ColumnSpec {
  readonly slug: string
  readonly label: string
  readonly type: AttributeType
  /**
   * Whether the column can actually be absent. Only a nullable column keeps `is empty` and
   * `is not empty`: "Title is empty" would be an operator that can never match, offered on a page
   * whose whole job is to make filtering feel trustworthy.
   */
  readonly nullable: boolean
}

/**
 * §6.7's column list, in its order. The label column is the first entry — the DataTable pins it
 * and never lets it be hidden, which is what makes every row identifiable.
 */
export const ATTRIBUTE_LIST_COLUMNS = [
  { slug: 'title', label: 'Title', type: 'short_text', nullable: false },
  { slug: 'slug', label: 'Slug', type: 'short_text', nullable: false },
  { slug: 'type', label: 'Type', type: 'single_select', nullable: false },
  { slug: 'group', label: 'Group', type: 'short_text', nullable: true },
  { slug: 'used_in', label: 'Used in', type: 'number', nullable: false },
  { slug: 'created_at', label: 'Created', type: 'date', nullable: false },
  { slug: 'updated_at', label: 'Updated', type: 'date', nullable: false },
] as const satisfies readonly ColumnSpec[]

export type AttributeListSlug = (typeof ATTRIBUTE_LIST_COLUMNS)[number]['slug']

/** The row label: the sticky first column, and the one that opens the edit dialog. */
export const LABEL_SLUG: AttributeListSlug = 'title'

const EMPTINESS: readonly OperatorId[] = ['is_empty', 'is_not_empty']

/**
 * The options behind the `Type` column, derived from the registry rather than listed here — the
 * membership *and* the order of the twelve types are decided in `packages/core`, and a thirteenth
 * one appears in this filter with no edit to this file.
 */
const TYPE_OPTIONS: readonly AttributeOption[] = ATTRIBUTE_TYPES.map((type, position) => ({
  id: `attribute-type:${type}`,
  key: type,
  label: typeLabel(type),
  position,
  archivedAt: null,
}))

/** Nothing reads these, and a real timestamp here would only invite someone to display it. */
const NEVER = '1970-01-01T00:00:00.000Z'

function definitionFor(
  spec: ColumnSpec,
  objectType: ObjectType,
  position: number,
): AttributeDefinition {
  return completeDefinition(
    {
      id: `attribute-list:${spec.slug}`,
      objectType,
      title: spec.label,
      slug: spec.slug,
      type: spec.type,
      config: {},
      ...(spec.type === 'single_select' ? { options: TYPE_OPTIONS } : {}),
      // Not a user's field: it cannot be renamed, retyped or deleted, which is exactly what this
      // flag means everywhere else.
      isSystem: true,
      position,
      showByDefault: true,
    },
    { createdAt: NEVER, updatedAt: NEVER },
  )
}

export interface AttributeListSchema {
  /** What the DataTable, the Columns menu and the FilterBar are driven by. */
  readonly fields: readonly FieldDescriptor[]
  /** The definition behind each column, for the cells that render through the cell registry. */
  readonly definitions: ReadonlyMap<string, AttributeDefinition>
}

/**
 * Not memoised here: the result is new objects on every call and the table's column factory keys
 * off their identity, so the caller holds it in a `useMemo` for as long as the object type is the
 * same.
 */
export function attributeListSchema(objectType: ObjectType): AttributeListSchema {
  const definitions = ATTRIBUTE_LIST_COLUMNS.map((spec, position) => ({
    spec,
    definition: definitionFor(spec, objectType, position),
  }))

  return {
    fields: definitions.map(({ spec, definition }) => {
      const field = describeAttribute(definition)
      if (spec.nullable) return field
      return { ...field, operators: field.operators.filter((op) => !EMPTINESS.includes(op)) }
    }),
    definitions: new Map(definitions.map(({ spec, definition }) => [spec.slug, definition])),
  }
}
