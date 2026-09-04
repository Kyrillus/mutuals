/**
 * The fourteen contact attributes migration 0002 seeds, as `AttributeDefinition`s.
 *
 * Test-only, and not re-exported from `index.ts`. It exists so the auto-mapper's tests run against
 * the vocabulary a real workspace has on its first day rather than against a convenient invention —
 * `job_role` really is a `single_select` of six categories, and `organization` really is a relation
 * carrying link metadata, and both of those shape what a column is allowed to map to.
 */
import { completeDefinition, type AttributeDefinition } from '../attributes/definition.ts'
import { makeFieldResolver, type FieldResolver } from '../fields/resolve.ts'
import type { AttributeType } from '../attributes/registry.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

interface Seed {
  readonly title: string
  readonly slug: string
  readonly type: AttributeType
  readonly config?: unknown
}

/** Verbatim from migration 0002, in its `position` order. */
const SEEDED_CONTACT_FIELDS: readonly Seed[] = [
  { title: 'Email', slug: 'email', type: 'email' },
  { title: 'Phone', slug: 'phone', type: 'phone' },
  { title: 'Job role', slug: 'job_role', type: 'single_select' },
  {
    title: 'Organization',
    slug: 'organization',
    type: 'relation',
    config: { targetObjectType: 'organization', cardinality: 'many', hasLinkMetadata: true },
  },
  { title: 'City', slug: 'city', type: 'short_text' },
  { title: 'Country', slug: 'country', type: 'short_text' },
  { title: 'Birthday', slug: 'birthday', type: 'date' },
  { title: 'Areas of interest', slug: 'areas_of_interest', type: 'tags' },
  { title: 'Asks', slug: 'asks', type: 'tags' },
  { title: 'Offers', slug: 'offers', type: 'tags' },
  { title: 'LinkedIn', slug: 'linkedin_url', type: 'url' },
  { title: 'Website', slug: 'website', type: 'url' },
  { title: 'How we met', slug: 'how_we_met', type: 'long_text' },
  { title: 'Notes', slug: 'notes', type: 'long_text' },
]

export function seededContactDefinitions(): readonly AttributeDefinition[] {
  return SEEDED_CONTACT_FIELDS.map((seed, position) =>
    completeDefinition(
      {
        id: `attr-${seed.slug}`,
        objectType: 'contact',
        title: seed.title,
        slug: seed.slug,
        type: seed.type,
        config: seed.config ?? {},
        isSystem: false,
        position,
        showByDefault: true,
      },
      TIMESTAMPS,
    ),
  )
}

export function seededContactResolver(): FieldResolver {
  return makeFieldResolver('contact', seededContactDefinitions())
}
