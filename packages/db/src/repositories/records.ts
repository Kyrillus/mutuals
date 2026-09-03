/**
 * Reading records: the hydration query the list endpoint runs after the filter compiler has
 * decided *which* fifty rows to show (§5.5), the detail page's single-record form of it, and the
 * value-history popover.
 *
 * Hydration is three round trips for a whole page, never one per row: the header (with its subtype
 * and metrics), then every value of every id in one `IN`, then every link. Nothing here filters or
 * sorts — that is the compiler's job, and this repository takes the ids it produced.
 */
import { sql } from 'kysely'
import type { ObjectType, Uuid, ValueKind } from '@mutuals/core'
import type { Executor } from '../write/types.ts'
import { civilOrNull, isoOf, isoOrNull } from './coerce.ts'
import type { FactSource } from '../schema.ts'

export interface RecordValue {
  readonly attributeId: Uuid
  readonly valueKind: ValueKind
  readonly valueKey: string
  readonly position: number
  /** Per-value provenance: the fact this value was projected from. */
  readonly factId: Uuid
  readonly text: string | null
  /** `numeric` as an exact decimal string; never a JavaScript number. */
  readonly num: string | null
  readonly date: string | null
  readonly bool: boolean | null
  readonly optionId: Uuid | null
  readonly optionKey: string | null
  readonly optionLabel: string | null
}

export interface RecordRelation {
  readonly attributeId: Uuid
  readonly toRecordId: Uuid
  readonly toLabel: string
  readonly toObjectType: ObjectType
  readonly title: string | null
  readonly from: string | null
  readonly to: string | null
  readonly isPrimary: boolean
  readonly position: number
  readonly factId: Uuid
}

export interface ContactHeader {
  readonly firstName: string | null
  readonly lastName: string | null
  readonly displayName: string | null
  readonly pinnedImportant: boolean
  readonly notImportant: boolean
  readonly warmth: number
  readonly lastInteractionAt: string | null
  readonly interactionCount12m: number
  readonly openFollowups: number
  readonly nextFollowupAt: string | null
}

export interface OrganizationHeader {
  readonly name: string
  readonly peopleCount: number
  readonly lastInteractionAt: string | null
}

export interface InteractionHeader {
  readonly type: string
  readonly occurredAt: string
  readonly title: string | null
  readonly body: string | null
  readonly source: string
}

export interface RecordHeader {
  readonly id: Uuid
  readonly objectType: ObjectType
  readonly displayLabel: string
  readonly createdVia: string
  readonly importBatchId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly contact?: ContactHeader
  readonly organization?: OrganizationHeader
  readonly interaction?: InteractionHeader
}

export interface HydratedRecord extends RecordHeader {
  readonly values: readonly RecordValue[]
  readonly links: readonly RecordRelation[]
}

export interface ValueHistoryEntry {
  readonly factId: Uuid
  readonly attributeId: Uuid
  readonly valueKey: string
  readonly text: string | null
  readonly num: string | null
  readonly date: string | null
  readonly bool: boolean | null
  readonly optionId: Uuid | null
  readonly optionLabel: string | null
  readonly targetRecordId: Uuid | null
  readonly targetLabel: string | null
  readonly validFrom: string
  readonly observedAt: string
  readonly source: FactSource
  readonly sourceRef: string | null
  readonly confidence: string
  readonly supersededById: Uuid | null
  readonly removedAt: string | null
  /** True for the row the projection currently uses; false for history and for tombstones. */
  readonly isCurrent: boolean
}

async function headers(exec: Executor, ids: readonly Uuid[]): Promise<Map<Uuid, RecordHeader>> {
  const rows = await exec
    .selectFrom('record as r')
    .leftJoin('contact as c', 'c.id', 'r.id')
    .leftJoin('contact_metrics as cm', 'cm.contact_id', 'r.id')
    .leftJoin('organization as o', 'o.id', 'r.id')
    .leftJoin('organization_metrics as om', 'om.organization_id', 'r.id')
    .leftJoin('interaction as i', 'i.id', 'r.id')
    .select([
      'r.id',
      'r.object_type',
      'r.display_label',
      'r.created_via',
      'r.import_batch_id',
      'r.created_at',
      'r.updated_at',
      'c.first_name',
      'c.last_name',
      'c.display_name',
      'c.pinned_important',
      'c.not_important',
      'cm.warmth',
      'cm.last_interaction_at as contact_last_interaction_at',
      'cm.interaction_count_12m',
      'cm.open_followups',
      'cm.next_followup_at',
      'o.name',
      'om.people_count',
      'om.last_interaction_at as org_last_interaction_at',
      'i.type as interaction_type',
      'i.occurred_at',
      'i.title as interaction_title',
      'i.body as interaction_body',
      'i.source as interaction_source',
    ])
    .where('r.id', 'in', ids)
    .execute()

  const byId = new Map<Uuid, RecordHeader>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      objectType: row.object_type,
      displayLabel: row.display_label,
      createdVia: row.created_via,
      importBatchId: row.import_batch_id,
      createdAt: isoOf(row.created_at),
      updatedAt: isoOf(row.updated_at),
      ...(row.object_type === 'contact'
        ? {
            contact: {
              firstName: row.first_name,
              lastName: row.last_name,
              displayName: row.display_name,
              pinnedImportant: row.pinned_important ?? false,
              notImportant: row.not_important ?? false,
              warmth: row.warmth ?? 0,
              lastInteractionAt: isoOrNull(row.contact_last_interaction_at),
              interactionCount12m: row.interaction_count_12m ?? 0,
              openFollowups: row.open_followups ?? 0,
              nextFollowupAt: civilOrNull(row.next_followup_at),
            },
          }
        : {}),
      ...(row.object_type === 'organization'
        ? {
            organization: {
              name: row.name ?? row.display_label,
              peopleCount: row.people_count ?? 0,
              lastInteractionAt: isoOrNull(row.org_last_interaction_at),
            },
          }
        : {}),
      ...(row.object_type === 'interaction' && row.interaction_type !== null
        ? {
            interaction: {
              type: row.interaction_type,
              occurredAt: isoOf(row.occurred_at ?? new Date(0)),
              title: row.interaction_title,
              body: row.interaction_body,
              source: row.interaction_source ?? 'manual',
            },
          }
        : {}),
    })
  }
  return byId
}

async function valuesByRecord(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<Map<Uuid, RecordValue[]>> {
  const rows = await exec
    .selectFrom('attribute_value as v')
    .leftJoin('attribute_option as o', 'o.id', 'v.option_id')
    .select([
      'v.record_id',
      'v.attribute_id',
      'v.value_kind',
      'v.value_key',
      'v.position',
      'v.fact_id',
      'v.text_value',
      'v.num_value',
      'v.date_value',
      'v.bool_value',
      'v.option_id',
      'o.key as option_key',
      'o.label as option_label',
    ])
    .where('v.record_id', 'in', ids)
    .orderBy('v.attribute_id')
    .orderBy('v.position')
    .execute()

  const byRecord = new Map<Uuid, RecordValue[]>()
  for (const row of rows) {
    const list = byRecord.get(row.record_id) ?? []
    list.push({
      attributeId: row.attribute_id,
      valueKind: row.value_kind,
      valueKey: row.value_key,
      position: row.position,
      factId: row.fact_id,
      text: row.text_value,
      num: row.num_value,
      date: civilOrNull(row.date_value),
      bool: row.bool_value,
      optionId: row.option_id,
      optionKey: row.option_key,
      optionLabel: row.option_label,
    })
    byRecord.set(row.record_id, list)
  }
  return byRecord
}

async function linksByRecord(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<Map<Uuid, RecordRelation[]>> {
  const rows = await exec
    .selectFrom('record_link as l')
    .innerJoin('record as t', 't.id', 'l.to_record_id')
    .select([
      'l.from_record_id',
      'l.attribute_id',
      'l.to_record_id',
      'l.title',
      'l.valid_from',
      'l.valid_to',
      'l.is_primary',
      'l.position',
      'l.fact_id',
      't.display_label',
      't.object_type',
    ])
    .where('l.from_record_id', 'in', ids)
    .orderBy('l.attribute_id')
    .orderBy('l.position')
    .execute()

  const byRecord = new Map<Uuid, RecordRelation[]>()
  for (const row of rows) {
    const list = byRecord.get(row.from_record_id) ?? []
    list.push({
      attributeId: row.attribute_id,
      toRecordId: row.to_record_id,
      toLabel: row.display_label,
      toObjectType: row.object_type,
      title: row.title,
      from: civilOrNull(row.valid_from),
      to: civilOrNull(row.valid_to),
      isPrimary: row.is_primary,
      position: row.position,
      factId: row.fact_id,
    })
    byRecord.set(row.from_record_id, list)
  }
  return byRecord
}

/** §5.5 — hydrate a page of ids in the order the caller asked for them. */
export async function hydrateRecords(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<HydratedRecord[]> {
  if (ids.length === 0) return []
  const unique = [...new Set(ids)]
  const [header, values, links] = await Promise.all([
    headers(exec, unique),
    valuesByRecord(exec, unique),
    linksByRecord(exec, unique),
  ])

  const out: HydratedRecord[] = []
  for (const id of ids) {
    const head = header.get(id)
    if (head === undefined) continue
    out.push({ ...head, values: values.get(id) ?? [], links: links.get(id) ?? [] })
  }
  return out
}

export async function getRecord(exec: Executor, id: Uuid): Promise<HydratedRecord | undefined> {
  const [record] = await hydrateRecords(exec, [id])
  return record
}

/**
 * §5.6's history popover: every fact ever written for one attribute on one record, superseded rows
 * and tombstones included. This and `project_record` are the only two places in the codebase that
 * spell out the live predicate.
 */
export async function valueHistory(
  exec: Executor,
  recordId: Uuid,
  attributeId: Uuid,
): Promise<ValueHistoryEntry[]> {
  const rows = await exec
    .selectFrom('fact as f')
    .leftJoin('attribute_option as o', 'o.id', 'f.option_id')
    .leftJoin('record as t', 't.id', 'f.target_record_id')
    .select([
      'f.id',
      'f.attribute_id',
      'f.value_key',
      'f.text_value',
      'f.num_value',
      'f.date_value',
      'f.bool_value',
      'f.option_id',
      'o.label as option_label',
      'f.target_record_id',
      't.display_label as target_label',
      'f.valid_from',
      'f.observed_at',
      'f.source',
      'f.source_ref',
      'f.confidence',
      'f.superseded_by_id',
      'f.removed_at',
    ])
    .where('f.record_id', '=', recordId)
    .where('f.attribute_id', '=', attributeId)
    .orderBy('f.valid_from', 'desc')
    .orderBy('f.observed_at', 'desc')
    .execute()

  return rows.map((row) => ({
    factId: row.id,
    attributeId: row.attribute_id,
    valueKey: row.value_key,
    text: row.text_value,
    num: row.num_value,
    date: civilOrNull(row.date_value),
    bool: row.bool_value,
    optionId: row.option_id,
    optionLabel: row.option_label,
    targetRecordId: row.target_record_id,
    targetLabel: row.target_label,
    validFrom: civilOrNull(row.valid_from) ?? '',
    observedAt: isoOf(row.observed_at),
    source: row.source,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    supersededById: row.superseded_by_id,
    removedAt: isoOrNull(row.removed_at),
    isCurrent: row.superseded_by_id === null && row.removed_at === null,
  }))
}

/**
 * The other half of a relation. "All relations are bidirectional in the UI" is one index lookup on
 * `rl_reverse_idx`, not a second stored row that could fall out of step with the first.
 */
export async function incomingLinks(exec: Executor, recordId: Uuid): Promise<RecordRelation[]> {
  const rows = await exec
    .selectFrom('record_link as l')
    .innerJoin('record as f', 'f.id', 'l.from_record_id')
    .select([
      'l.attribute_id',
      'l.from_record_id',
      'l.title',
      'l.valid_from',
      'l.valid_to',
      'l.is_primary',
      'l.position',
      'l.fact_id',
      'f.display_label',
      'f.object_type',
    ])
    .where('l.to_record_id', '=', recordId)
    .orderBy('l.attribute_id')
    .orderBy('f.display_label')
    .execute()

  return rows.map((row) => ({
    attributeId: row.attribute_id,
    toRecordId: row.from_record_id,
    toLabel: row.display_label,
    toObjectType: row.object_type,
    title: row.title,
    from: civilOrNull(row.valid_from),
    to: civilOrNull(row.valid_to),
    isPrimary: row.is_primary,
    position: row.position,
    factId: row.fact_id,
  }))
}

/** ADR-023: the footer's "Rows: 2,236" is a separate exact count, never `count(*) OVER ()`. */
export async function countRecords(exec: Executor, objectType: ObjectType): Promise<number> {
  const row = await sql<{ total: string }>`
    select count(*)::text as total from record where object_type = ${objectType}
  `.execute(exec)
  return Number(row.rows[0]?.total ?? 0)
}
