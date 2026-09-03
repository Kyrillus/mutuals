/**
 * Creating, editing and deleting the three record subtypes.
 *
 * `record` is written first and the subtype second, because the subtype's `AFTER INSERT` trigger
 * is the sole owner of `record.display_label` and `record.label_norm` — nothing here writes
 * either, and a caller who tries is writing a value the next name edit will silently overwrite.
 */
import { randomUUID } from 'node:crypto'
import type { Uuid } from '@mutuals/core'
import { applyValues, type ValueChange } from './facts.ts'
import type { Executor, Provenance } from './types.ts'
import { WriteError } from './types.ts'
import { resolveWorkspaceId } from './workspace.ts'
import type { CreatedVia, DB, ObjectType } from '../schema.ts'
import { sql, type Insertable } from 'kysely'

/**
 * `search_document` is derived from `record.display_label` and from `interaction.body`, and neither
 * of those is a fact — so the `AFTER STATEMENT` trigger on `fact`, which is what normally keeps the
 * projection current, never fires for them. Without this call a contact created with no attribute
 * values has no search document at all, and renaming one leaves the old name in the index. Found by
 * the projection-equivalence gate: a rebuild produced a row that the incremental path never wrote.
 *
 * It is called on every create and on every write that can change a label or a body. The projector
 * is idempotent, so the second call for a record that also wrote values is a no-op upsert.
 */
async function refreshProjection(exec: Executor, recordId: Uuid): Promise<void> {
  await sql`select project_record(${recordId}, null)`.execute(exec)
}

export interface RecordProvenanceInput {
  readonly workspaceId?: string | null
  readonly createdVia?: CreatedVia
  readonly importBatchId?: string | null
}

export interface ContactInput extends RecordProvenanceInput {
  readonly firstName?: string | null
  readonly lastName?: string | null
  readonly pinnedImportant?: boolean
  readonly notImportant?: boolean
  /** Attribute values to write in the same transaction, so a new contact is never half-created. */
  readonly values?: readonly ValueChange[]
  readonly provenance?: Provenance
}

export interface OrganizationInput extends RecordProvenanceInput {
  readonly name: string
  readonly values?: readonly ValueChange[]
  readonly provenance?: Provenance
}

export interface InteractionInput extends RecordProvenanceInput {
  readonly type: InteractionKind
  readonly occurredAt: string
  readonly title?: string | null
  readonly body?: string | null
  readonly source?: InteractionSource
  readonly contactIds?: readonly Uuid[]
  readonly organizationIds?: readonly Uuid[]
  readonly values?: readonly ValueChange[]
  readonly provenance?: Provenance
}

type InteractionKind = Insertable<DB['interaction']>['type']
type InteractionSource = NonNullable<Insertable<DB['interaction']>['source']>

const DEFAULT_PROVENANCE: Provenance = { source: 'manual' }

async function inTransaction<T>(exec: Executor, fn: (trx: Executor) => Promise<T>): Promise<T> {
  if (exec.isTransaction) return fn(exec)
  return exec.transaction().execute((trx) => fn(trx))
}

async function insertRecord(
  trx: Executor,
  objectType: ObjectType,
  input: RecordProvenanceInput,
): Promise<Uuid> {
  const id = randomUUID()
  await trx
    .insertInto('record')
    .values({
      id,
      workspace_id: await resolveWorkspaceId(trx, input.workspaceId),
      object_type: objectType,
      created_via: input.createdVia ?? 'manual',
      import_batch_id: input.importBatchId ?? null,
    })
    .execute()
  return id
}

export async function createContact(exec: Executor, input: ContactInput): Promise<Uuid> {
  return inTransaction(exec, async (trx) => {
    const id = await insertRecord(trx, 'contact', input)
    await trx
      .insertInto('contact')
      .values({
        id,
        first_name: input.firstName ?? null,
        last_name: input.lastName ?? null,
        pinned_important: input.pinnedImportant ?? false,
        not_important: input.notImportant ?? false,
      })
      .execute()

    // The metrics row exists from the first moment, so `warmth` is 0 rather than NULL and the
    // list query's sort on a derived column needs no coalesce.
    await trx
      .insertInto('contact_metrics')
      .values({ contact_id: id, workspace_id: await resolveWorkspaceId(trx, input.workspaceId) })
      .onConflict((conflict) => conflict.doNothing())
      .execute()

    await refreshProjection(trx, id)
    await writeInitialValues(trx, id, input.values, input.provenance)
    return id
  })
}

export interface ContactPatch {
  readonly firstName?: string | null
  readonly lastName?: string | null
  readonly pinnedImportant?: boolean
  readonly notImportant?: boolean
}

export async function updateContact(
  exec: Executor,
  id: Uuid,
  patch: ContactPatch,
): Promise<boolean> {
  const columns = {
    ...(patch.firstName === undefined ? {} : { first_name: patch.firstName }),
    ...(patch.lastName === undefined ? {} : { last_name: patch.lastName }),
    ...(patch.pinnedImportant === undefined ? {} : { pinned_important: patch.pinnedImportant }),
    ...(patch.notImportant === undefined ? {} : { not_important: patch.notImportant }),
  }
  if (Object.keys(columns).length === 0) return false
  return inTransaction(exec, async (trx) => {
    const result = await trx
      .updateTable('contact')
      .set(columns)
      .where('id', '=', id)
      .executeTakeFirst()
    if (Number(result.numUpdatedRows) === 0) return false
    await refreshProjection(trx, id)
    return true
  })
}

export async function createOrganization(exec: Executor, input: OrganizationInput): Promise<Uuid> {
  return inTransaction(exec, async (trx) => {
    const id = await insertRecord(trx, 'organization', input)
    await trx.insertInto('organization').values({ id, name: input.name }).execute()
    await trx
      .insertInto('organization_metrics')
      .values({
        organization_id: id,
        workspace_id: await resolveWorkspaceId(trx, input.workspaceId),
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
    await refreshProjection(trx, id)
    await writeInitialValues(trx, id, input.values, input.provenance)
    return id
  })
}

export async function renameOrganization(exec: Executor, id: Uuid, name: string): Promise<boolean> {
  return inTransaction(exec, async (trx) => {
    const result = await trx
      .updateTable('organization')
      .set({ name })
      .where('id', '=', id)
      .executeTakeFirst()
    if (Number(result.numUpdatedRows) === 0) return false
    // The name is the label, the label is the search document's title, and a rename that left the
    // old one in the index would make the palette answer with a name nobody uses any more.
    await refreshProjection(trx, id)
    return true
  })
}

export async function createInteraction(exec: Executor, input: InteractionInput): Promise<Uuid> {
  return inTransaction(exec, async (trx) => {
    const id = await insertRecord(trx, 'interaction', input)
    await trx
      .insertInto('interaction')
      .values({
        id,
        type: input.type,
        occurred_at: input.occurredAt,
        title: input.title ?? null,
        body: input.body ?? null,
        source: input.source ?? 'manual',
      })
      .execute()
    await setParticipants(trx, id, input.contactIds ?? [], input.organizationIds ?? [])
    await refreshProjection(trx, id)
    await writeInitialValues(trx, id, input.values, input.provenance)
    return id
  })
}

export interface InteractionPatch {
  readonly type?: InteractionKind
  readonly occurredAt?: string
  readonly title?: string | null
  readonly body?: string | null
  readonly contactIds?: readonly Uuid[]
  readonly organizationIds?: readonly Uuid[]
}

export async function updateInteraction(
  exec: Executor,
  id: Uuid,
  patch: InteractionPatch,
): Promise<boolean> {
  return inTransaction(exec, async (trx) => {
    const columns = {
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.occurredAt === undefined ? {} : { occurred_at: patch.occurredAt }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
    }
    let touched = false
    if (Object.keys(columns).length > 0) {
      const result = await trx
        .updateTable('interaction')
        .set(columns)
        .where('id', '=', id)
        .executeTakeFirst()
      touched = Number(result.numUpdatedRows) > 0
    }
    if (patch.contactIds !== undefined || patch.organizationIds !== undefined) {
      await setParticipants(trx, id, patch.contactIds, patch.organizationIds)
      // The body feeds `search_document`, and participants feed the interaction's own projection.
      await trx.updateTable('record').set({ updated_at: new Date() }).where('id', '=', id).execute()
      touched = true
    }
    if (touched) await refreshProjection(trx, id)
    return touched
  })
}

/** Participants are a set, not a log: the caller sends the whole list and it is made true. */
async function setParticipants(
  trx: Executor,
  interactionId: Uuid,
  contactIds: readonly Uuid[] | undefined,
  organizationIds: readonly Uuid[] | undefined,
): Promise<void> {
  if (contactIds !== undefined) {
    await trx
      .deleteFrom('interaction_contact')
      .where('interaction_id', '=', interactionId)
      .execute()
    if (contactIds.length > 0) {
      await trx
        .insertInto('interaction_contact')
        .values(
          [...new Set(contactIds)].map((contact_id) => ({
            interaction_id: interactionId,
            contact_id,
          })),
        )
        .onConflict((conflict) => conflict.doNothing())
        .execute()
    }
  }
  if (organizationIds !== undefined) {
    await trx
      .deleteFrom('interaction_organization')
      .where('interaction_id', '=', interactionId)
      .execute()
    if (organizationIds.length > 0) {
      await trx
        .insertInto('interaction_organization')
        .values(
          [...new Set(organizationIds)].map((organization_id) => ({
            interaction_id: interactionId,
            organization_id,
          })),
        )
        .onConflict((conflict) => conflict.doNothing())
        .execute()
    }
  }
}

async function writeInitialValues(
  trx: Executor,
  recordId: Uuid,
  values: readonly ValueChange[] | undefined,
  provenance: Provenance | undefined,
): Promise<void> {
  if (values === undefined || values.length === 0) return
  await applyValues(trx, {
    recordId,
    changes: values,
    provenance: provenance ?? DEFAULT_PROVENANCE,
  })
}

/**
 * §6.7's delete. One statement: `record` is the supertype, so `fact`, `attribute_value`,
 * `record_link`, `identifier`, `search_document` and the subtype row all cascade.
 */
export async function deleteRecord(exec: Executor, id: Uuid): Promise<boolean> {
  const result = await exec.deleteFrom('record').where('id', '=', id).executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}

/** Guards a caller that has an id but no idea what it points at. */
export async function requireObjectType(exec: Executor, id: Uuid): Promise<ObjectType> {
  const row = await exec
    .selectFrom('record')
    .select('object_type')
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) throw new WriteError(`no record ${id}`)
  return row.object_type
}
