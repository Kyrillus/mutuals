/**
 * From the wire's attribute definitions to `packages/core`'s field descriptors.
 *
 * The API answers with `AttributeDefinitionDto` (nulls, because JSON has no `undefined`); the
 * domain's `AttributeDefinition` uses optional properties. This is the one place the two meet, so
 * the table, the Columns picker, the filter picker and the create dialog all read the *same*
 * `FieldDescriptor[]` that `packages/db`'s query compiler is written against — system columns,
 * derived columns and user-defined attributes in one namespace (ADR-052).
 */
import {
  completeDefinition,
  isAttributeType,
  makeFieldResolver,
  type AttributeDefinition,
  type AttributeDefinitionDto,
  type AttributeOption,
  type FieldDescriptor,
  type FieldResolver,
  type ObjectType,
} from '@mutuals/core'

/** JSON's `null` is the domain's "absent". Converting in one direction, in one function. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}

function toOption(option: AttributeDefinitionDto['options'][number]): AttributeOption {
  return {
    id: option.id,
    key: option.key,
    label: option.label,
    position: option.position,
    color: optional(option.color),
    archivedAt: option.archivedAt,
  }
}

/**
 * `isMulti` and `sortable` are recomputed by `completeDefinition` rather than copied from the
 * response: they are functions of `type` and `config`, and a client that trusts two derived
 * booleans over the registry that derives them is a client that can disagree with the API about
 * whether a column may be sorted.
 */
export function toAttributeDefinition(dto: AttributeDefinitionDto): AttributeDefinition {
  // `AttributeTypeSchema` widens to `string` on the wire because the enum is built from the
  // registry at runtime. Narrowing it here — rather than casting — means an attribute type this
  // build has never heard of fails loudly at the boundary instead of rendering a blank column.
  if (!isAttributeType(dto.type)) {
    throw new Error(`Unknown attribute type "${dto.type}" on "${dto.slug}"`)
  }
  return completeDefinition(
    {
      id: dto.id,
      objectType: dto.objectType,
      title: dto.title,
      slug: dto.slug,
      type: dto.type,
      config: dto.config,
      options: dto.options.map(toOption),
      isSystem: dto.isSystem,
      isDerived: dto.isDerived,
      position: dto.position,
      showByDefault: dto.showByDefault,
      group: optional(dto.group),
      description: optional(dto.description),
    },
    { createdAt: dto.createdAt, updatedAt: dto.updatedAt },
  )
}

export function recordFieldResolver(
  objectType: ObjectType,
  definitions: readonly AttributeDefinitionDto[],
): FieldResolver {
  return makeFieldResolver(objectType, definitions.map(toAttributeDefinition))
}

/**
 * The definition behind a field, or `undefined` for a system column.
 *
 * Cells and inline editors take the definition, so this is what turns a `FieldDescriptor` into an
 * argument for `AttributeCell` — and its `undefined` is exactly the branch that says "render this
 * by value kind instead".
 */
export function definitionOf(field: FieldDescriptor): AttributeDefinition | undefined {
  return field.source.kind === 'attribute' ? field.source.def : undefined
}

/**
 * §5.2 lists the types that get an inline editor: text, number, date, select, tags, yes/no.
 *
 * `relation` and `long_text` are excluded because neither fits a 40px row — a searchable record
 * picker and a markdown textarea both need the detail page or the dialog. This is a rule about
 * control size, not about any particular field, so a new attribute of an existing type is
 * editable the moment it is created.
 */
const NOT_INLINE_EDITABLE = new Set(['relation', 'long_text'])

export function isInlineEditable(field: FieldDescriptor): boolean {
  if (field.readOnly) return false
  const definition = definitionOf(field)
  // A writable *system* column (`first_name`, `pinned_important`) has no definition, and every
  // editor in `@/attributes` is written against one. They are edited in the record dialog and on
  // the detail page instead of being given a second, definition-free editor here.
  return definition !== undefined && !NOT_INLINE_EDITABLE.has(definition.type)
}

/** The slug of the column that carries the record's label — always the first system field. */
export function labelSlug(resolver: FieldResolver): string {
  const first = resolver.list()[0]
  if (first === undefined) throw new Error(`No fields declared for ${resolver.objectType}`)
  return first.slug
}
