/**
 * The request boundary for user-defined fields: an `attributes` map in, `ValueChange[]` out.
 *
 * Nothing here knows a field name. Each entry is looked up in the definitions loaded for this
 * object type, validated against the schema *that definition* produces
 * (`typeDef(type).value(config, ctx)`), and normalised by the same type — so adding an attribute
 * at runtime needs no code change, and adding a thirteenth attribute *type* needs none here either.
 *
 * Every failure is collected rather than thrown, so one bad create returns one 400 naming every
 * field that is wrong with it (§7's "validation errors per field").
 */
import {
  failWith,
  issue,
  issuesFromZodError,
  ok,
  typeDef,
  type AttributeDefinition,
  type CoreIssue,
  type ObjectType,
  type Result,
} from '@mutuals/core'
import type { ValueChange } from '@mutuals/db'

import { typeContext, type AppContext, type RequestSettings, type Schema } from '../context.ts'

/** `null` clears the attribute; anything else is the complete new value set. */
export type AttributeInput = Readonly<Record<string, unknown>>

export function planAttributeWrites(
  input: AttributeInput | undefined,
  schema: Schema,
  settings: Pick<RequestSettings, 'phoneRegion'>,
): Result<ValueChange[]> {
  if (input === undefined) return ok([])

  const issues: CoreIssue[] = []
  const changes: ValueChange[] = []

  for (const [slug, raw] of Object.entries(input)) {
    const definition = schema.bySlug.get(slug)
    if (definition === undefined) {
      issues.push(
        issue('unknown_field', `There is no field called "${slug}".`, ['attributes', slug], {
          field: slug,
        }),
      )
      continue
    }
    if (definition.isDerived) {
      issues.push(
        issue('invalid_input', `"${definition.title}" is computed and cannot be set.`, [
          'attributes',
          slug,
        ]),
      )
      continue
    }

    if (raw === null || raw === undefined) {
      changes.push({ attributeId: definition.id, values: null })
      continue
    }

    const type = typeDef(definition.type)
    const ctx = typeContext(definition, settings)
    const parsed = type.value(definition.config, ctx).safeParse(raw)
    if (!parsed.success) {
      issues.push(
        ...issuesFromZodError(parsed.error).map((entry) => ({
          ...entry,
          path: ['attributes', slug, ...entry.path],
        })),
      )
      continue
    }

    // `value()` transforms — an email is lower-cased, a URL gains its scheme, a decimal is
    // branded — so `normalize` gets the parsed output and never the raw input.
    changes.push({
      attributeId: definition.id,
      values: [...type.normalize(parsed.data, definition.config, ctx)],
    })
  }

  return issues.length > 0 ? failWith(issues) : ok(changes)
}

/**
 * Relation targets exist, and are the object type the attribute points at.
 *
 * The composite foreign key on `fact.target_record_id` would catch a missing record anyway, but as
 * an opaque 23503 with no field attached. One `IN` here turns it into "attributes.organization:
 * there is no organization with id …", which is what the record picker can act on. It also catches
 * the case the FK cannot: a *contact* id in an attribute that points at organizations.
 */
export async function assertRelationTargets(
  ctx: AppContext,
  schema: Schema,
  changes: readonly ValueChange[],
): Promise<Result<true>> {
  const wanted = new Map<string, { slug: string; target: ObjectType }>()
  for (const change of changes) {
    const definition = schema.byId.get(change.attributeId)
    if (definition === undefined || definition.type !== 'relation' || change.values === null) {
      continue
    }
    const target = targetObjectType(definition)
    if (target === null) continue
    for (const value of change.values) {
      if (value.kind === 'relation') {
        wanted.set(value.targetRecordId, { slug: definition.slug, target })
      }
    }
  }
  if (wanted.size === 0) return ok(true)

  const rows = await ctx.db
    .selectFrom('record')
    .select(['id', 'object_type'])
    .where('id', 'in', [...wanted.keys()])
    .execute()
  const found = new Map(rows.map((row) => [row.id, row.object_type]))

  const issues: CoreIssue[] = []
  for (const [id, { slug, target }] of wanted) {
    const actual = found.get(id)
    if (actual === undefined) {
      issues.push(
        issue('invalid_input', `There is no record with id ${id}.`, ['attributes', slug], { id }),
      )
    } else if (actual !== target) {
      issues.push(
        issue(
          'invalid_input',
          `"${slug}" links to ${article(target)}, but ${id} is ${article(actual)}.`,
          ['attributes', slug],
          { id },
        ),
      )
    }
  }
  return issues.length > 0 ? failWith(issues) : ok(true)
}

/** "an organization", "a contact" — a message a person reads should read like one. */
function article(objectType: ObjectType): string {
  return /^[aeiou]/.test(objectType) ? `an ${objectType}` : `a ${objectType}`
}

function targetObjectType(definition: AttributeDefinition): ObjectType | null {
  const config: unknown = definition.config
  if (typeof config !== 'object' || config === null) return null
  const target: unknown = (config as { targetObjectType?: unknown }).targetObjectType
  return target === 'contact' || target === 'organization' || target === 'interaction'
    ? target
    : null
}
