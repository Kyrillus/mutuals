/**
 * A staged row's mapped values to `ValueChange[]`.
 *
 * The work is almost entirely reassembly rather than validation, because validation already
 * happened: `mapRow` coerced every cell through its own attribute type when the row was staged, and
 * an invalid row never reaches the commit. What is left is to turn the wizard's flat
 * `targetId -> value` map back into the three shapes the write path takes — system columns, plain
 * attributes, and one relation carrying its link metadata — and then hand the last two to
 * `planAttributeWrites`, which is the same function every create dialog uses.
 *
 * Using that function rather than a second one is the point. It is where "adding an attribute type
 * needs no code change here" is actually true, so the importer inherits it for free.
 */
import { allSystemSlugs, type ObjectType, type Uuid } from '@mutuals/core'
import type { ImportRowRecord, ValueChange } from '@mutuals/db'

import { planAttributeWrites } from '../write/attributes.ts'
import type { Schema } from '../context.ts'

export interface PlanImportValuesInput {
  readonly row: ImportRowRecord
  readonly schema: Schema
  readonly objectType: ObjectType
  /** The organization this row's `Company` column resolved to, if it had one. */
  readonly organizationId?: Uuid
}

export interface PlannedImportValues {
  readonly changes: readonly ValueChange[]
}

export function planImportValues(input: PlanImportValuesInput): PlannedImportValues {
  const mapped = (input.row.mapped ?? {}) as Record<string, unknown>
  const systemSlugs = new Set(allSystemSlugs(input.objectType))

  const attributes: Record<string, unknown> = {}
  /** Link metadata, gathered per relation slug: `organization.title` and friends. */
  const links = new Map<string, Record<string, unknown>>()

  for (const [targetId, value] of Object.entries(mapped)) {
    if (value === undefined || value === null || value === '') continue

    const dot = targetId.indexOf('.')
    if (dot !== -1) {
      const slug = targetId.slice(0, dot)
      const part = targetId.slice(dot + 1)
      const link = links.get(slug) ?? {}
      // `to` is nullable on a link and means "still current"; the others are plain values.
      link[part === 'from' ? 'from' : part === 'to' ? 'to' : part] = value
      links.set(slug, link)
      continue
    }

    // A writable system column is a column on the subtype, not an attribute — `createContact`
    // takes it directly, so it must not be planned as a value write.
    if (systemSlugs.has(targetId)) continue

    attributes[targetId] = value
  }

  /**
   * The relation itself.
   *
   * Only added when the company name actually resolved to a record. A row whose `Company` column
   * held something unresolvable — or whose organization the caller chose not to create — writes no
   * link rather than a link to nothing, and the link metadata goes with it: a job title with no
   * organization to hold it has nowhere to live (§4.3 puts `title` on the link, not the contact).
   */
  if (input.organizationId !== undefined) {
    for (const [slug, metadata] of links) {
      attributes[slug] = [{ id: input.organizationId, ...metadata }]
    }
    if (!links.has('organization') && input.schema.bySlug.has('organization')) {
      attributes['organization'] = [{ id: input.organizationId }]
    }
  }

  const planned = planAttributeWrites(attributes, input.schema, { phoneRegion: 'DE' })
  if (!planned.ok) {
    /**
     * Unreachable by construction, and it throws rather than degrading.
     *
     * Every value here has already been coerced by the same attribute type that is about to
     * validate it, and a row with errors never reaches the commit. So a failure means the two
     * disagree — a real bug in the registry, not bad user input — and ADR-034 is explicit that a
     * programmer error throws. Swallowing it would silently drop a column from an import.
     */
    throw new Error(
      `A staged row failed validation at commit time, which should be impossible: ${planned.issues
        .map((one) => `${one.code} at ${one.path.join('.')}`)
        .join('; ')}`,
    )
  }
  return { changes: planned.value }
}
