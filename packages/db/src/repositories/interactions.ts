/**
 * Reading interactions — the timeline on the contact detail page (§6.5) and the flat list.
 *
 * An interaction is a record like any other, so it has attributes and a `display_label`; what is
 * special is the participant junction, which is why the timeline query joins it rather than
 * filtering on an attribute.
 */
import type { InteractionType } from '../schema.ts'
import type { ObjectType, Uuid } from '@mutuals/core'
import type { Executor } from '../write/types.ts'
import { isoOf } from './coerce.ts'

export interface InteractionSummary {
  readonly id: Uuid
  readonly type: string
  readonly occurredAt: string
  readonly title: string | null
  readonly body: string | null
  readonly source: string
  readonly createdAt: string
  readonly contactIds: readonly Uuid[]
  readonly organizationIds: readonly Uuid[]
}

export interface InteractionQuery {
  /** Only interactions this contact took part in. */
  readonly contactId?: Uuid
  /** Only interactions this organization took part in. */
  readonly organizationId?: Uuid
  readonly types?: readonly InteractionType[]
  /** Keyset cursor: strictly older than this instant. */
  readonly before?: Date
  readonly limit?: number
}

const DEFAULT_LIMIT = 50

async function participants(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<{ contacts: Map<Uuid, Uuid[]>; organizations: Map<Uuid, Uuid[]> }> {
  const contacts = new Map<Uuid, Uuid[]>()
  const organizations = new Map<Uuid, Uuid[]>()
  if (ids.length === 0) return { contacts, organizations }

  const contactRows = await exec
    .selectFrom('interaction_contact')
    .select(['interaction_id', 'contact_id'])
    .where('interaction_id', 'in', ids)
    .execute()
  for (const row of contactRows) {
    contacts.set(row.interaction_id, [...(contacts.get(row.interaction_id) ?? []), row.contact_id])
  }

  const organizationRows = await exec
    .selectFrom('interaction_organization')
    .select(['interaction_id', 'organization_id'])
    .where('interaction_id', 'in', ids)
    .execute()
  for (const row of organizationRows) {
    organizations.set(row.interaction_id, [
      ...(organizations.get(row.interaction_id) ?? []),
      row.organization_id,
    ])
  }

  return { contacts, organizations }
}

export async function listInteractions(
  exec: Executor,
  query: InteractionQuery = {},
): Promise<InteractionSummary[]> {
  let builder = exec
    .selectFrom('interaction as i')
    .innerJoin('record as r', 'r.id', 'i.id')
    .select(['i.id', 'i.type', 'i.occurred_at', 'i.title', 'i.body', 'i.source', 'r.created_at'])

  if (query.contactId !== undefined) {
    builder = builder
      .innerJoin('interaction_contact as ic', 'ic.interaction_id', 'i.id')
      .where('ic.contact_id', '=', query.contactId)
  }
  if (query.organizationId !== undefined) {
    builder = builder
      .innerJoin('interaction_organization as io', 'io.interaction_id', 'i.id')
      .where('io.organization_id', '=', query.organizationId)
  }
  if (query.types !== undefined && query.types.length > 0) {
    builder = builder.where('i.type', 'in', query.types)
  }
  if (query.before !== undefined) {
    builder = builder.where('i.occurred_at', '<', query.before)
  }

  // `(occurred_at DESC, id)` is `interaction_occurred_idx`, so the timeline reads straight off it.
  const rows = await builder
    .orderBy('i.occurred_at', 'desc')
    .orderBy('i.id', 'desc')
    .limit(query.limit ?? DEFAULT_LIMIT)
    .execute()

  const links = await participants(
    exec,
    rows.map((row) => row.id),
  )

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    occurredAt: isoOf(row.occurred_at),
    title: row.title,
    body: row.body,
    source: row.source,
    createdAt: isoOf(row.created_at),
    contactIds: links.contacts.get(row.id) ?? [],
    organizationIds: links.organizations.get(row.id) ?? [],
  }))
}

export async function getInteraction(
  exec: Executor,
  id: Uuid,
): Promise<InteractionSummary | undefined> {
  const rows = await listInteractionsByIds(exec, [id])
  return rows[0]
}

export async function listInteractionsByIds(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<InteractionSummary[]> {
  if (ids.length === 0) return []
  const rows = await exec
    .selectFrom('interaction as i')
    .innerJoin('record as r', 'r.id', 'i.id')
    .select(['i.id', 'i.type', 'i.occurred_at', 'i.title', 'i.body', 'i.source', 'r.created_at'])
    .where('i.id', 'in', [...ids])
    .execute()

  const links = await participants(
    exec,
    rows.map((row) => row.id),
  )

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    occurredAt: isoOf(row.occurred_at),
    title: row.title,
    body: row.body,
    source: row.source,
    createdAt: isoOf(row.created_at),
    contactIds: links.contacts.get(row.id) ?? [],
    organizationIds: links.organizations.get(row.id) ?? [],
  }))
}

/** The participants of one interaction, resolved to labels for the timeline's chips. */
export async function interactionParticipants(
  exec: Executor,
  interactionId: Uuid,
): Promise<{ id: Uuid; label: string; objectType: ObjectType }[]> {
  const rows = await exec
    .selectFrom('interaction_contact as ic')
    .innerJoin('record as r', 'r.id', 'ic.contact_id')
    .select(['r.id', 'r.display_label', 'r.object_type'])
    .where('ic.interaction_id', '=', interactionId)
    .unionAll(
      exec
        .selectFrom('interaction_organization as io')
        .innerJoin('record as r', 'r.id', 'io.organization_id')
        .select(['r.id', 'r.display_label', 'r.object_type'])
        .where('io.interaction_id', '=', interactionId),
    )
    .execute()

  return rows.map((row) => ({
    id: row.id,
    label: row.display_label,
    objectType: row.object_type,
  }))
}
