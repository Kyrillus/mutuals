/**
 * What a source column is allowed to point at (§6.8 step 3).
 *
 * Derived from the `FieldResolver`, never listed: the whole point of the attribute registry is that
 * a field invented in Settings five minutes ago is a legal import target with no code change. The
 * only thing hard-coded here is which *parts* of a link carry metadata, and those come from
 * `relation`'s own config rather than from a slug.
 */
import { anyTypeDef } from '../attributes/registry.ts'
import type { Uuid, ValueKind } from '../attributes/kinds.ts'
import type { FieldDescriptor, FieldResolver } from '../fields/resolve.ts'

/**
 * The four things a link column can carry, from §4.3. `target` is the other record — for an
 * organization link, the company name, which the importer finds or creates.
 */
export const LINK_PARTS = ['target', 'title', 'from', 'to'] as const
export type LinkPart = (typeof LINK_PARTS)[number]

const LINK_PART_LABELS: Readonly<Record<LinkPart, string>> = {
  target: '',
  title: 'job title',
  from: 'since',
  to: 'until',
}

export interface MappingTarget {
  /** The wire form: a slug, or `slug.part` for a link's metadata. Stable, so a saved mapping keeps. */
  readonly id: string
  /** What the mapping card shows: "Email", "Organization — job title". */
  readonly label: string
  readonly kind: 'column' | 'attribute' | 'link'
  readonly slug: string
  readonly part?: LinkPart
  readonly valueKind: ValueKind
  /** A `tags` column takes several values from one cell; a `short_text` one does not. */
  readonly isMulti: boolean
  /** Absent for a system column. */
  readonly attributeId?: Uuid
  /** §6.8 step 3 offers the per-value mapping editor only for these. */
  readonly hasValueMapping: boolean
}

interface RelationShape {
  readonly targetObjectType: string
  readonly hasLinkMetadata: boolean
}

/**
 * Reads the two config keys this module needs without running the whole schema.
 *
 * `relation.configSchema` would reject the seeded config, which has no `cardinality` — the
 * repository fills that in on the way out, but a caller holding a raw definition may not have gone
 * through it. Being lenient here is right: a relation whose config cannot be read offers no link
 * parts, which is a smaller failure than refusing to build the target list at all.
 */
function relationShape(config: unknown): RelationShape | undefined {
  if (config === null || typeof config !== 'object') return undefined
  const record = config as Record<string, unknown>
  const target = record['targetObjectType'] ?? record['target_object_type']
  if (typeof target !== 'string') return undefined
  const metadata = record['hasLinkMetadata'] ?? record['has_link_metadata']
  return { targetObjectType: target, hasLinkMetadata: metadata === true }
}

function targetsForField(field: FieldDescriptor): MappingTarget[] {
  // Derived and generated columns render read-only everywhere, and an import is a write.
  if (field.readOnly) return []

  if (field.source.kind !== 'attribute') {
    return [
      {
        id: field.slug,
        label: field.label,
        kind: 'column',
        slug: field.slug,
        valueKind: field.source.valueKind,
        isMulti: false,
        hasValueMapping: false,
      },
    ]
  }

  const definition = field.source.def
  const typeDefinition = anyTypeDef(definition.type)

  if (definition.type !== 'relation') {
    return [
      {
        id: field.slug,
        label: field.label,
        kind: 'attribute',
        slug: field.slug,
        valueKind: typeDefinition.valueKind,
        isMulti: field.isMulti,
        attributeId: definition.id,
        hasValueMapping: typeDefinition.hasValueMapping,
      },
    ]
  }

  const shape = relationShape(definition.config)
  if (shape === undefined) return []

  // The relation itself, then its metadata — but only if the link is declared to carry any.
  const parts: LinkPart[] = shape.hasLinkMetadata ? [...LINK_PARTS] : ['target']
  return parts.map((part) => ({
    id: part === 'target' ? field.slug : `${field.slug}.${part}`,
    label: part === 'target' ? field.label : `${field.label} — ${LINK_PART_LABELS[part]}`,
    kind: 'link' as const,
    slug: field.slug,
    part,
    // `target` arrives as a name to find-or-create; the metadata parts are text and dates.
    valueKind: (part === 'from' || part === 'to' ? 'date' : 'text') satisfies ValueKind,
    isMulti: false,
    attributeId: definition.id,
    hasValueMapping: false,
  }))
}

/** Every legal target for one object type, in the order §6.8's select should offer them. */
export function importTargets(resolver: FieldResolver): readonly MappingTarget[] {
  return Object.freeze(resolver.list().flatMap(targetsForField))
}

export function findTarget(
  targets: readonly MappingTarget[],
  id: string,
): MappingTarget | undefined {
  return targets.find((target) => target.id === id)
}
