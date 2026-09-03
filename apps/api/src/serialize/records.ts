/**
 * A hydrated record becomes a contact, an organization or an interaction on the wire.
 *
 * The derived columns of §4.7 — warmth, last interaction, the counts — are members of the record
 * rather than a nested object, because the table renders them in the same row as everything else
 * and the filter model already treats them as ordinary fields (ADR-036).
 */
import type { Contact, Interaction, Organization, RecordRef } from '@mutuals/core'
import type { HydratedRecord, InteractionSummary } from '@mutuals/db'

import type { Schema } from '../context.ts'
import { serializeAttributes } from './attributes.ts'

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value)
}

/** Present on every record so a `If-Match` precondition is additive later (ADR-031). */
function provenance(record: HydratedRecord): Contact['provenance'] {
  return {
    createdVia: record.createdVia as Contact['provenance']['createdVia'],
    importBatchId: record.importBatchId,
    createdAt: iso(record.createdAt),
  }
}

export function serializeContact(record: HydratedRecord, schema: Schema): Contact {
  const contact = record.contact
  if (contact === undefined) {
    throw new Error(`record ${record.id} is a ${record.objectType}, not a contact`)
  }
  return {
    id: record.id,
    objectType: 'contact',
    displayName: record.displayLabel,
    firstName: contact.firstName,
    lastName: contact.lastName,
    pinnedImportant: contact.pinnedImportant,
    notImportant: contact.notImportant,
    warmth: contact.warmth,
    lastInteractionAt: isoOrNull(contact.lastInteractionAt),
    interactionCount12m: contact.interactionCount12m,
    openFollowups: contact.openFollowups,
    nextFollowupAt: contact.nextFollowupAt,
    provenance: provenance(record),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    attributes: serializeAttributes(record, schema),
  }
}

export function serializeOrganization(record: HydratedRecord, schema: Schema): Organization {
  const organization = record.organization
  if (organization === undefined) {
    throw new Error(`record ${record.id} is a ${record.objectType}, not an organization`)
  }
  return {
    id: record.id,
    objectType: 'organization',
    displayName: record.displayLabel,
    name: organization.name,
    peopleCount: organization.peopleCount,
    lastInteractionAt: isoOrNull(organization.lastInteractionAt),
    provenance: provenance(record),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    attributes: serializeAttributes(record, schema),
  }
}

export function serializeInteraction(
  summary: InteractionSummary,
  labels: ReadonlyMap<string, RecordRef>,
  updatedAt: string,
): Interaction {
  const ref = (id: string, objectType: RecordRef['objectType']): RecordRef =>
    labels.get(id) ?? { id, displayName: '', objectType }

  return {
    id: summary.id,
    objectType: 'interaction',
    type: summary.type as Interaction['type'],
    occurredAt: iso(summary.occurredAt),
    title: summary.title,
    body: summary.body,
    source: summary.source as Interaction['source'],
    contacts: summary.contactIds.map((id) => ref(id, 'contact')),
    organizations: summary.organizationIds.map((id) => ref(id, 'organization')),
    createdAt: iso(summary.createdAt),
    updatedAt,
  }
}
