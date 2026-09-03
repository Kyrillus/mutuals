/**
 * The fact write path (storage decision §4.1–§4.3).
 *
 * The order of statements is load-bearing and it is the whole reason this file is not four CTEs.
 * Sibling data-modifying CTEs share one snapshot and one command id, so "insert the new fact and
 * supersede the old one" in a single statement makes `fact_live_uq` see two live rows and the
 * *second* edit of any field fails with a duplicate key. A partial unique index cannot be
 * `DEFERRABLE`, so the constraint cannot be relaxed either. The fix is boring: generate the new
 * fact's id in TypeScript, then run supersede and insert as separate statements in one
 * transaction, supersede first, behind a `SELECT … FOR UPDATE` on the record row (ADR-036).
 */
import { randomUUID } from 'node:crypto'
import { sql, type Insertable, type RawBuilder } from 'kysely'
import { valueColumn, type SlotValue, type Uuid } from '@mutuals/core'
import type { AttributeShape, Executor, Provenance } from './types.ts'
import { WriteError } from './types.ts'
import { SINGLE_VALUE_KEY, valueKeyExpression } from './value-key.ts'
import { writeIdentifiers } from './identifiers.ts'
import type { DB } from '../schema.ts'

export interface ValueWrite {
  readonly recordId: Uuid
  readonly attributeId: Uuid
  readonly value: SlotValue
  readonly provenance: Provenance
}

export interface AttributeWrite {
  readonly recordId: Uuid
  readonly attributeId: Uuid
  readonly provenance: Provenance
}

export interface ValueSetWrite {
  readonly recordId: Uuid
  readonly attributeId: Uuid
  /** The complete set the attribute should end up with; `[]` clears it. */
  readonly values: readonly SlotValue[]
  readonly provenance: Provenance
}

/** One attribute's new value set, or `null` to clear it. The shape a PATCH body maps onto. */
export interface ValueChange {
  readonly attributeId: Uuid
  readonly values: readonly SlotValue[] | null
}

export interface RecordWrite {
  readonly recordId: Uuid
  readonly changes: readonly ValueChange[]
  readonly provenance: Provenance
}

interface LockedRecord {
  readonly workspaceId: string | null
  readonly objectType: string
}

/** Loads the definition rows a write touches. One indexed lookup, so nothing has to be passed in. */
export async function loadAttributeShapes(
  exec: Executor,
  ids: readonly Uuid[],
): Promise<Map<Uuid, AttributeShape>> {
  if (ids.length === 0) return new Map()
  const rows = await exec
    .selectFrom('attribute_definition')
    .select(['id', 'object_type', 'type', 'slug', 'value_kind', 'is_multi', 'workspace_id'])
    .where('id', 'in', [...new Set(ids)])
    .execute()

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        objectType: row.object_type,
        type: row.type,
        slug: row.slug,
        valueKind: row.value_kind,
        isMulti: row.is_multi,
        workspaceId: row.workspace_id,
      },
    ]),
  )
}

async function requireShape(exec: Executor, attributeId: Uuid): Promise<AttributeShape> {
  const shape = (await loadAttributeShapes(exec, [attributeId])).get(attributeId)
  if (shape === undefined) throw new WriteError(`no attribute definition ${attributeId}`)
  return shape
}

/**
 * Step 1 of every write. One row lock, held for microseconds, is what makes the projection safe:
 * two concurrent edits of the same record cannot interleave and lose one.
 */
async function lockRecord(trx: Executor, recordId: Uuid): Promise<LockedRecord> {
  const row = await sql<{ workspace_id: string | null; object_type: string }>`
    select workspace_id, object_type from record where id = ${recordId} for update
  `.execute(trx)

  const first = row.rows[0]
  if (first === undefined) throw new WriteError(`no record ${recordId}`)
  return { workspaceId: first.workspace_id, objectType: first.object_type }
}

/** Step 2. Unconditional: the newest write wins, `valid_from` never orders currency (ADR-021). */
async function supersede(
  trx: Executor,
  input: {
    recordId: Uuid
    attributeId: Uuid
    key: RawBuilder<string>
    supersededBy: Uuid
  },
): Promise<void> {
  await sql`
    update fact
       set superseded_by_id = ${input.supersededBy}
     where record_id = ${input.recordId}
       and attribute_id = ${input.attributeId}
       and value_key = ${input.key}
       and superseded_by_id is null
  `.execute(trx)
}

type FactSlots = Partial<Insertable<DB['fact']>>

/**
 * The slot columns for one value. The column *name* comes from `packages/core`'s slot table, never
 * from a literal here, which is what keeps "never hard-code a column" true on the write side too.
 */
function slotColumns(value: SlotValue): FactSlots {
  switch (value.kind) {
    case 'text':
      return { [valueColumn('text')]: value.text }
    case 'number':
      return { [valueColumn('number')]: value.num }
    case 'date':
      return { [valueColumn('date')]: value.date }
    case 'bool':
      return { [valueColumn('bool')]: value.bool }
    case 'option':
      return { [valueColumn('option')]: value.optionId }
    case 'relation':
      return {
        [valueColumn('relation')]: value.targetRecordId,
        link_title: value.link?.title ?? null,
        link_from: value.link?.from ?? null,
        link_to: value.link?.to ?? null,
        link_is_primary: value.link?.isPrimary ?? null,
      }
  }
}

/** Step 3. Appends the new fact; its id was generated before the supersede that pointed at it. */
async function insertFact(
  trx: Executor,
  input: {
    id: Uuid
    record: LockedRecord
    recordId: Uuid
    attribute: AttributeShape
    value: SlotValue
    key: RawBuilder<string>
    provenance: Provenance
  },
): Promise<void> {
  if (input.record.objectType !== input.attribute.objectType) {
    throw new WriteError(
      `attribute ${input.attribute.slug} belongs to ${input.attribute.objectType}, ` +
        `record ${input.recordId} is a ${input.record.objectType}`,
    )
  }

  await trx
    .insertInto('fact')
    .values({
      id: input.id,
      workspace_id: input.record.workspaceId,
      object_type: input.attribute.objectType,
      record_id: input.recordId,
      attribute_id: input.attribute.id,
      value_kind: input.attribute.valueKind,
      is_multi: input.attribute.isMulti,
      ...slotColumns(input.value),
      value_key: input.key,
      valid_from: input.provenance.validFrom ?? sql<string>`current_date`,
      source: input.provenance.source,
      source_ref: input.provenance.sourceRef ?? null,
      ...(input.provenance.confidence === undefined
        ? {}
        : { confidence: input.provenance.confidence }),
    })
    .execute()
}

/**
 * A removal is a new row with its own provenance, never an in-place `UPDATE` (§4.3): an update to
 * an append-only log loses who removed the value and when we learned it. The tombstone copies the
 * slot columns of the fact it retires, so the history says *which* value went, and it stays live
 * (`superseded_by_id IS NULL`) so it occupies the `fact_live_uq` slot — which is what makes a
 * later re-add a clean supersession rather than a duplicate key.
 */
async function tombstoneLiveFacts(
  trx: Executor,
  input: {
    recordId: Uuid
    attributeId: Uuid
    key?: RawBuilder<string>
    provenance: Provenance
  },
): Promise<number> {
  const live = await sql<{ id: string }>`
    select id from fact
     where record_id = ${input.recordId}
       and attribute_id = ${input.attributeId}
       and superseded_by_id is null
       and removed_at is null
       ${input.key === undefined ? sql`` : sql`and value_key = ${input.key}`}
     order by value_key
  `.execute(trx)

  for (const row of live.rows) {
    const tombstoneId = randomUUID()
    await sql`
      update fact set superseded_by_id = ${tombstoneId} where id = ${row.id}
    `.execute(trx)

    await sql`
      insert into fact (id, workspace_id, object_type, record_id, attribute_id, value_kind,
                        is_multi, text_value, num_value, date_value, bool_value, option_id,
                        target_record_id, link_title, link_from, link_to, link_is_primary,
                        value_key, valid_from, source, source_ref, confidence,
                        removed_at, removed_source)
      select ${tombstoneId}, workspace_id, object_type, record_id, attribute_id, value_kind,
             is_multi, text_value, num_value, date_value, bool_value, option_id,
             target_record_id, link_title, link_from, link_to, link_is_primary,
             value_key,
             ${input.provenance.validFrom ?? sql`current_date`},
             ${input.provenance.source},
             ${input.provenance.sourceRef ?? null},
             ${input.provenance.confidence ?? 1},
             now(), ${input.provenance.source}
        from fact where id = ${row.id}
    `.execute(trx)
  }

  return live.rows.length
}

/**
 * Step 4 and 5. The projector is called explicitly with the narrow `(record, attribute)` scope so
 * the statement-level backstop on `fact` — which runs the whole-record form — has nothing left to
 * do; it is idempotent, so the second run is a no-op upsert.
 */
async function projectAndTouch(trx: Executor, recordId: Uuid, attributeId: Uuid): Promise<void> {
  await sql`select project_record(${recordId}, ${attributeId})`.execute(trx)
  await writeIdentifiers(trx, recordId)
  await sql`update record set updated_at = now() where id = ${recordId}`.execute(trx)
}

/** Runs `fn` inside a transaction, joining the caller's if there already is one. */
async function inTransaction<T>(exec: Executor, fn: (trx: Executor) => Promise<T>): Promise<T> {
  if (exec.isTransaction) return fn(exec)
  return exec.transaction().execute((trx) => fn(trx))
}

/** §4.1 — sets a single-valued attribute, superseding whatever was there. */
export async function setValue(exec: Executor, write: ValueWrite): Promise<Uuid> {
  return inTransaction(exec, async (trx) => {
    const attribute = await requireShape(trx, write.attributeId)
    if (attribute.isMulti) {
      throw new WriteError(
        `${attribute.slug} is multi-valued; use addElement or setValues, not setValue`,
      )
    }
    const record = await lockRecord(trx, write.recordId)
    const factId = randomUUID()
    const key = sql<string>`${SINGLE_VALUE_KEY}`

    await supersede(trx, {
      recordId: write.recordId,
      attributeId: write.attributeId,
      key,
      supersededBy: factId,
    })
    await insertFact(trx, {
      id: factId,
      record,
      recordId: write.recordId,
      attribute,
      value: write.value,
      key,
      provenance: write.provenance,
    })
    await projectAndTouch(trx, write.recordId, write.attributeId)
    return factId
  })
}

/**
 * §4.2 — adds one element to a multi-valued attribute. The supersede is scoped to this element's
 * own key, so a re-add after a removal supersedes the tombstone and the history reads truthfully:
 * added → removed → added again.
 */
export async function addElement(exec: Executor, write: ValueWrite): Promise<Uuid> {
  return inTransaction(exec, async (trx) => {
    const attribute = await requireShape(trx, write.attributeId)
    if (!attribute.isMulti) {
      throw new WriteError(`${attribute.slug} is single-valued; use setValue, not addElement`)
    }
    const record = await lockRecord(trx, write.recordId)
    const factId = randomUUID()
    const key = valueKeyExpression(attribute, write.value)

    await supersede(trx, {
      recordId: write.recordId,
      attributeId: write.attributeId,
      key,
      supersededBy: factId,
    })
    await insertFact(trx, {
      id: factId,
      record,
      recordId: write.recordId,
      attribute,
      value: write.value,
      key,
      provenance: write.provenance,
    })
    await projectAndTouch(trx, write.recordId, write.attributeId)
    return factId
  })
}

/** §4.3 — removes one element of a multi-valued attribute by writing a tombstone. */
export async function removeElement(exec: Executor, write: ValueWrite): Promise<boolean> {
  return inTransaction(exec, async (trx) => {
    const attribute = await requireShape(trx, write.attributeId)
    await lockRecord(trx, write.recordId)
    const removed = await tombstoneLiveFacts(trx, {
      recordId: write.recordId,
      attributeId: write.attributeId,
      key: valueKeyExpression(attribute, write.value),
      provenance: write.provenance,
    })
    await projectAndTouch(trx, write.recordId, write.attributeId)
    return removed > 0
  })
}

/** §4.3 — clears a field: one tombstone per live value, no `DELETE`, no empty string. */
export async function clearAttribute(exec: Executor, write: AttributeWrite): Promise<number> {
  return inTransaction(exec, async (trx) => {
    await lockRecord(trx, write.recordId)
    const removed = await tombstoneLiveFacts(trx, {
      recordId: write.recordId,
      attributeId: write.attributeId,
      provenance: write.provenance,
    })
    await projectAndTouch(trx, write.recordId, write.attributeId)
    return removed
  })
}

/**
 * Replaces the whole value set of a multi-valued attribute, touching only what changed: elements
 * whose key is already live are left alone, so re-saving a form does not fill the history popover
 * with remove/add pairs for values nobody edited.
 */
export async function setValues(exec: Executor, write: ValueSetWrite): Promise<void> {
  await inTransaction(exec, async (trx) => {
    const attribute = await requireShape(trx, write.attributeId)
    if (!attribute.isMulti) {
      if (write.values.length > 1) {
        throw new WriteError(`${attribute.slug} is single-valued but ${write.values.length} values`)
      }
      const only = write.values[0]
      if (only === undefined) {
        await clearAttribute(trx, write)
        return
      }
      await setValue(trx, { ...write, value: only })
      return
    }

    const record = await lockRecord(trx, write.recordId)
    const incoming = await incomingKeys(trx, attribute, write.values)
    const liveRows = await sql<{ value_key: string }>`
      select value_key from fact
       where record_id = ${write.recordId} and attribute_id = ${write.attributeId}
         and superseded_by_id is null and removed_at is null
    `.execute(trx)
    const liveKeys = new Set(liveRows.rows.map((row) => row.value_key))

    for (const entry of incoming) {
      if (liveKeys.has(entry.key)) continue
      const factId = randomUUID()
      const keyExpr = sql<string>`${entry.key}`
      await supersede(trx, {
        recordId: write.recordId,
        attributeId: write.attributeId,
        key: keyExpr,
        supersededBy: factId,
      })
      await insertFact(trx, {
        id: factId,
        record,
        recordId: write.recordId,
        attribute,
        value: entry.value,
        key: keyExpr,
        provenance: write.provenance,
      })
    }

    const wanted = new Set(incoming.map((entry) => entry.key))
    for (const key of liveKeys) {
      if (wanted.has(key)) continue
      await tombstoneLiveFacts(trx, {
        recordId: write.recordId,
        attributeId: write.attributeId,
        key: sql<string>`${key}`,
        provenance: write.provenance,
      })
    }

    await projectAndTouch(trx, write.recordId, write.attributeId)
  })
}

/**
 * The keys of the incoming values, computed by the database in one round trip. They are compared
 * against `fact.value_key`, so SQL has to produce them (ADR-019) — TypeScript only routes them.
 */
async function incomingKeys(
  trx: Executor,
  attribute: AttributeShape,
  values: readonly SlotValue[],
): Promise<{ key: string; value: SlotValue }[]> {
  if (values.length === 0) return []
  const projected = values.map((value, index) =>
    valueKeyExpression(attribute, value).as(`k${index}`),
  )
  const row = (await trx.selectNoFrom(projected).executeTakeFirstOrThrow()) as Record<
    string,
    string
  >

  const seen = new Set<string>()
  const out: { key: string; value: SlotValue }[] = []
  values.forEach((value, index) => {
    const key = row[`k${index}`]
    if (key === undefined) throw new WriteError('the database returned no value_key')
    // A form can submit "Berlin" and "berlin"; they are one value, and the first spelling wins.
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, value })
  })
  return out
}

/**
 * The entry point a PATCH maps onto: several attributes of one record, one transaction, one lock.
 * `values: null` clears the attribute; an array is the complete set it should end up with.
 */
export async function applyValues(exec: Executor, write: RecordWrite): Promise<void> {
  if (write.changes.length === 0) return
  await inTransaction(exec, async (trx) => {
    for (const change of write.changes) {
      if (change.values === null) {
        await clearAttribute(trx, {
          recordId: write.recordId,
          attributeId: change.attributeId,
          provenance: write.provenance,
        })
        continue
      }
      await setValues(trx, {
        recordId: write.recordId,
        attributeId: change.attributeId,
        values: change.values,
        provenance: write.provenance,
      })
    }
  })
}
