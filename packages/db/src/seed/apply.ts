/**
 * Writing a {@link SeedPlan} into the database — through the **real write path**.
 *
 * `createOrganization`, `createContact` and `createInteraction` are the same
 * functions the API calls, so the seed exercises the fact log, the SQL projector, the identifier
 * write-through and the label trigger exactly as a user would. Raw inserts would be an order of
 * magnitude faster and would let the seed look perfect while the projector was broken, which is
 * the one thing a demo dataset must not do.
 *
 * The whole seed runs in one transaction: a failed seed leaves the database as it was, rather than
 * half a network with no interactions.
 */
import { sql } from 'kysely'
import type { Uuid } from '@mutuals/core'

import type { Executor, Provenance } from '../write/types.ts'
import { WriteError } from '../write/types.ts'
import { createContact, createInteraction, createOrganization } from '../write/records.ts'
import type { ValueChange } from '../write/facts.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'
import type { ContactPlan, SeedPlan } from './plan.ts'

/** The provenance every seeded value carries. `import` would be a lie; this is a manual dataset. */
const SEED_PROVENANCE: Provenance = { source: 'manual', sourceRef: 'seed' }

export interface SeedIds {
  readonly organizations: readonly Uuid[]
  readonly contacts: readonly Uuid[]
  readonly interactions: readonly Uuid[]
  readonly followUps: readonly Uuid[]
}

/**
 * The attribute ids the seed writes, resolved by slug at run time.
 *
 * Migration 0002's uuids are fixed literals and could be pasted here, but the seed is the one
 * place that has to survive a user renaming or reordering the default attributes — so it looks
 * them up, and fails loudly if one is gone rather than writing into whatever id happens to match.
 */
interface AttributeIds {
  readonly byContactSlug: ReadonlyMap<string, Uuid>
  readonly byOrganizationSlug: ReadonlyMap<string, Uuid>
  /** `attribute_id → (option key → option id)`, for the two seeded single-selects. */
  readonly options: ReadonlyMap<string, ReadonlyMap<string, Uuid>>
}

const REQUIRED_CONTACT_SLUGS = [
  'email',
  'phone',
  'job_role',
  'organization',
  'city',
  'country',
  'birthday',
  'areas_of_interest',
  'asks',
  'offers',
  'linkedin_url',
  'website',
  'how_we_met',
  'notes',
] as const

const REQUIRED_ORGANIZATION_SLUGS = [
  'type',
  'industry',
  'city',
  'country',
  'website',
  'linkedin_url',
  'description',
  'stage',
] as const

async function loadAttributeIds(exec: Executor): Promise<AttributeIds> {
  const definitions = await exec
    .selectFrom('attribute_definition')
    .select(['id', 'object_type', 'slug'])
    .where('object_type', 'in', ['contact', 'organization'])
    .execute()

  const byContactSlug = new Map<string, Uuid>()
  const byOrganizationSlug = new Map<string, Uuid>()
  for (const row of definitions) {
    const target = row.object_type === 'contact' ? byContactSlug : byOrganizationSlug
    target.set(row.slug, row.id)
  }

  const missing = [
    ...REQUIRED_CONTACT_SLUGS.filter((slug) => !byContactSlug.has(slug)).map((s) => `contact.${s}`),
    ...REQUIRED_ORGANIZATION_SLUGS.filter((slug) => !byOrganizationSlug.has(slug)).map(
      (s) => `organization.${s}`,
    ),
  ]
  if (missing.length > 0) {
    throw new WriteError(
      `the demo seed needs the default attributes of migration 0002; missing: ${missing.join(', ')}`,
    )
  }

  const optionRows = await exec
    .selectFrom('attribute_option')
    .select(['id', 'attribute_id', 'key'])
    .execute()
  const options = new Map<string, Map<string, Uuid>>()
  for (const row of optionRows) {
    const forAttribute = options.get(row.attribute_id) ?? new Map<string, Uuid>()
    forAttribute.set(row.key, row.id)
    options.set(row.attribute_id, forAttribute)
  }

  return { byContactSlug, byOrganizationSlug, options }
}

function requireOption(ids: AttributeIds, attributeId: Uuid, key: string): Uuid {
  const option = ids.options.get(attributeId)?.get(key)
  if (option === undefined) {
    throw new WriteError(`attribute ${attributeId} has no option "${key}"`)
  }
  return option
}

/** `undefined`/`null` values are simply not written — an absent attribute, not an empty string. */
function textChange(attributeId: Uuid, value: string | null): ValueChange | null {
  return value === null ? null : { attributeId, values: [{ kind: 'text', text: value }] }
}

function tagsChange(attributeId: Uuid, values: readonly string[]): ValueChange | null {
  return values.length === 0
    ? null
    : { attributeId, values: values.map((text) => ({ kind: 'text', text }) as const) }
}

function present(changes: readonly (ValueChange | null)[]): ValueChange[] {
  return changes.filter((change): change is ValueChange => change !== null)
}

async function writeOrganizations(
  exec: Executor,
  plan: SeedPlan,
  ids: AttributeIds,
): Promise<Uuid[]> {
  const slug = (name: (typeof REQUIRED_ORGANIZATION_SLUGS)[number]): Uuid => {
    const id = ids.byOrganizationSlug.get(name)
    if (id === undefined) throw new WriteError(`organization.${name} vanished mid-seed`)
    return id
  }

  const typeId = slug('type')
  const stageId = slug('stage')

  const created: Uuid[] = []
  for (const org of plan.organizations) {
    const values = present([
      { attributeId: typeId, values: [optionValue(ids, typeId, org.type)] },
      { attributeId: stageId, values: [optionValue(ids, stageId, org.stage)] },
      tagsChange(slug('industry'), org.industry),
      textChange(slug('city'), org.place.city),
      textChange(slug('country'), org.place.country),
      textChange(slug('website'), org.website),
      textChange(slug('linkedin_url'), org.linkedinUrl),
      textChange(slug('description'), org.description),
    ])
    created.push(
      await createOrganization(exec, { name: org.name, values, provenance: SEED_PROVENANCE }),
    )
  }
  return created
}

function optionValue(ids: AttributeIds, attributeId: Uuid, key: string) {
  return { kind: 'option', optionId: requireOption(ids, attributeId, key), optionKey: key } as const
}

async function writeContacts(
  exec: Executor,
  plan: SeedPlan,
  ids: AttributeIds,
  organizationIds: readonly Uuid[],
): Promise<Uuid[]> {
  const slug = (name: (typeof REQUIRED_CONTACT_SLUGS)[number]): Uuid => {
    const id = ids.byContactSlug.get(name)
    if (id === undefined) throw new WriteError(`contact.${name} vanished mid-seed`)
    return id
  }

  const roleId = slug('job_role')
  const organizationId = slug('organization')

  const created: Uuid[] = []
  for (const contact of plan.contacts) {
    const values = present([
      { attributeId: roleId, values: [optionValue(ids, roleId, contact.role)] },
      textChange(slug('email'), contact.email),
      textChange(slug('phone'), contact.phone),
      textChange(slug('city'), contact.place.city),
      textChange(slug('country'), contact.place.country),
      contact.birthday === null
        ? null
        : { attributeId: slug('birthday'), values: [{ kind: 'date', date: contact.birthday }] },
      tagsChange(slug('areas_of_interest'), contact.areasOfInterest),
      tagsChange(slug('asks'), contact.asks),
      tagsChange(slug('offers'), contact.offers),
      textChange(slug('linkedin_url'), contact.linkedinUrl),
      textChange(slug('website'), contact.website),
      textChange(slug('how_we_met'), contact.howWeMet),
      textChange(slug('notes'), contact.notes),
      relationChange(organizationId, contact, organizationIds),
    ])

    created.push(
      await createContact(exec, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        pinnedImportant: contact.pinnedImportant,
        notImportant: contact.notImportant,
        values,
        provenance: SEED_PROVENANCE,
      }),
    )
  }
  return created
}

/**
 * The contact→organization relation, with the link metadata §4.3 asks for: a job title, a start
 * date, an end date for a past role and exactly one primary.
 */
function relationChange(
  attributeId: Uuid,
  contact: ContactPlan,
  organizationIds: readonly Uuid[],
): ValueChange | null {
  if (contact.employment.length === 0) return null
  const values = contact.employment.flatMap((job) => {
    const target = organizationIds[job.organizationIndex]
    if (target === undefined) return []
    return [
      {
        kind: 'relation',
        targetRecordId: target,
        link: {
          title: job.title,
          from: job.from,
          to: job.until,
          isPrimary: job.isPrimary,
        },
      } as const,
    ]
  })
  return values.length === 0 ? null : { attributeId, values }
}

async function writeInteractions(
  exec: Executor,
  plan: SeedPlan,
  contactIds: readonly Uuid[],
  organizationIds: readonly Uuid[],
): Promise<Uuid[]> {
  const created: Uuid[] = []
  for (const interaction of plan.interactions) {
    created.push(
      await createInteraction(exec, {
        type: interaction.type,
        occurredAt: interaction.occurredAt,
        title: interaction.title,
        body: interaction.body,
        source: interaction.source,
        createdVia: interaction.source === 'import' ? 'import' : 'manual',
        contactIds: interaction.contactIndexes.flatMap((index) => contactIds[index] ?? []),
        organizationIds: interaction.organizationIndexes.flatMap(
          (index) => organizationIds[index] ?? [],
        ),
      }),
    )
  }
  return created
}

/**
 * Follow-ups are plain rows: they are not records, carry no custom attributes in Phase 1 and have
 * no repository yet (§10 puts them in Stage 4). One multi-row insert.
 */
async function writeFollowUps(
  exec: Executor,
  plan: SeedPlan,
  contactIds: readonly Uuid[],
  workspaceId: string,
): Promise<Uuid[]> {
  const rows = plan.followUps.flatMap((followUp) => {
    const contactId = contactIds[followUp.contactIndex]
    if (contactId === undefined) return []
    return [
      {
        workspace_id: workspaceId,
        contact_id: contactId,
        title: followUp.title,
        due_at: followUp.dueAt,
        status: followUp.status,
        recurrence: followUp.recurrence === null ? null : JSON.stringify(followUp.recurrence),
        origin: 'manual' as const,
        notes: followUp.notes,
        completed_at: followUp.completedAt,
      },
    ]
  })
  if (rows.length === 0) return []

  const inserted = await exec.insertInto('follow_up').values(rows).returning('id').execute()
  return inserted.map((row) => row.id)
}

export interface ApplyOptions {
  readonly workspaceId?: string | null
}

/** Writes a whole plan. The caller owns the transaction; `seedDatabase` opens one. */
export async function applySeedPlan(
  exec: Executor,
  plan: SeedPlan,
  options: ApplyOptions = {},
): Promise<SeedIds> {
  const workspaceId = await resolveWorkspaceId(exec, options.workspaceId)
  const ids = await loadAttributeIds(exec)

  const organizations = await writeOrganizations(exec, plan, ids)
  const contacts = await writeContacts(exec, plan, ids, organizations)
  const interactions = await writeInteractions(exec, plan, contacts, organizations)
  const followUps = await writeFollowUps(exec, plan, contacts, workspaceId)

  // `record.created_at` drives the default ordering and the keyset cursor, and a seed written in
  // one transaction gives all 760 records the same instant — so the "recently added" list would be
  // arbitrary. Contacts are aged backwards from their first interaction instead.
  await ageRecords(exec, plan, contacts, organizations)

  return { organizations, contacts, interactions, followUps }
}

/**
 * Backdates `record.created_at` so the dashboard's "added in the last 30 days" card and the
 * default `created_at DESC` ordering have something real to show. A record is created shortly
 * before its first interaction, or — for someone never contacted — at a random point in the past
 * two years.
 */
async function ageRecords(
  exec: Executor,
  plan: SeedPlan,
  contactIds: readonly Uuid[],
  organizationIds: readonly Uuid[],
): Promise<void> {
  const firstTouch = new Map<number, string>()
  for (const interaction of plan.interactions) {
    for (const index of interaction.contactIndexes) {
      const known = firstTouch.get(index)
      if (known === undefined || interaction.occurredAt < known) {
        firstTouch.set(index, interaction.occurredAt)
      }
    }
  }

  const updates: { id: Uuid; createdAt: string }[] = []
  plan.contacts.forEach((contact, index) => {
    const id = contactIds[index]
    if (id === undefined) return
    const touch = firstTouch.get(index)
    // Deterministic without a second faker: the index spreads never-contacted people evenly over
    // the last two years instead of clustering them on one day.
    const fallbackDaysAgo = 20 + ((index * 37) % 700)
    const createdAt =
      touch === undefined
        ? `${offsetDay(plan.today, -fallbackDaysAgo)}T09:00:00+01:00`
        : `${offsetDay(touch.slice(0, 10), -(3 + (index % 25)))}T09:00:00+01:00`
    updates.push({ id, createdAt })
  })

  plan.organizations.forEach((org, index) => {
    const id = organizationIds[index]
    if (id === undefined) return
    updates.push({
      id,
      createdAt: `${offsetDay(plan.today, -(30 + ((index * 53) % 900)))}T08:30:00+01:00`,
    })
  })

  for (let start = 0; start < updates.length; start += 200) {
    const chunk = updates.slice(start, start + 200)
    await sql`
      update record set created_at = v.created_at::timestamptz, updated_at = v.created_at::timestamptz
        from (values ${sql.join(
          chunk.map((row) => sql`(${row.id}::uuid, ${row.createdAt})`),
        )}) as v(id, created_at)
       where record.id = v.id
    `.execute(exec)
  }
}

/** `addDays` on a plain ISO day string, without asking the caller to brand it first. */
function offsetDay(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}
