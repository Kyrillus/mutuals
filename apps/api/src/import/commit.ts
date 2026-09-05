/**
 * The `import.run` job handler (ADR-061): one job per batch, committing in chunks.
 *
 * Every design choice here is about what happens when it stops half way, because on a laptop it
 * will: the lid closes, the database restarts, the process is killed. So:
 *
 *   - rows are applied in chunks, each in its own transaction, and `last_committed_row` advances
 *     with the chunk. A resume restarts at `last_committed_row + 1` and does not revisit what
 *     landed.
 *   - the counters are incremented per chunk rather than written at the end, so a failed import's
 *     result screen can say how many rows were applied before it stopped.
 *   - the handler's `catch` writes `status = 'failed'` plus the error detail in its *own* committed
 *     transaction. That row is the only place a user-visible failure can surface — ADR-061 deleted
 *     the dead-letter queue precisely because nothing read it.
 *
 * There is no automatic retry (`retryLimit: 0`). Replaying a half-applied import from the top would
 * re-apply every row the first attempt already committed.
 */
import { firstKeptRow, type Uuid } from '@mutuals/core'
import {
  addImportCounts,
  createContact,
  createOrganization,
  getImportBatch,
  listImportRows,
  resolveOrganizations,
  applyValues,
  updateImportBatch,
  writeIdentifiersForRecords,
  type ImportRowRecord,
  type Provenance,
  type ValueChange,
} from '@mutuals/db'

import { loadSchema, workspaceId, type AppContext } from '../context.ts'
import { planImportValues } from './values.ts'

/**
 * Rows per transaction.
 *
 * Big enough that the per-transaction overhead is not the cost, small enough that a crash loses at
 * most this many rows' worth of progress and that one transaction never holds locks for long. At
 * 200 a 10k import is 50 transactions.
 */
const CHUNK = 200

export interface CommitResult {
  readonly created: number
  readonly merged: number
  readonly skipped: number
}

export async function runImport(
  ctx: AppContext,
  batchId: Uuid,
  resumeFrom = 1,
): Promise<CommitResult> {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw new Error(`No import batch ${batchId}`)

  const schema = await loadSchema(ctx, batch.objectType)
  const provenance: Provenance = { source: 'import', sourceRef: batchId }
  const workspace = await workspaceId(ctx)

  const allRows = await listImportRows(ctx.db, batchId)
  const byRowNumber = new Map(allRows.map((row) => [row.rowNumber, row]))

  /**
   * Which row of a chain of intra-batch duplicates actually lands (ADR-097).
   *
   * Resolved once over the whole batch rather than per chunk, because a chain can cross a chunk
   * boundary and "the first kept row" is a property of the batch. `landedAs` then remembers what
   * each row became, so a later row that merges into an earlier one has a record to merge into.
   */
  const keptFor = new Map<number, number | null>()
  for (const row of allRows) {
    if (row.duplicateOfRow === null) continue
    keptFor.set(
      row.rowNumber,
      firstKeptRow(
        row.rowNumber,
        (candidate) => byRowNumber.get(candidate)?.duplicateOfRow ?? undefined,
        (candidate) => byRowNumber.get(candidate)?.decision ?? undefined,
      ),
    )
  }

  const landedAs = new Map<number, Uuid>()
  let created = 0
  let merged = 0
  let skipped = 0

  const pending = allRows.filter((row) => row.rowNumber >= resumeFrom)

  for (let start = 0; start < pending.length; start += CHUNK) {
    const chunk = pending.slice(start, start + CHUNK)

    // One transaction per chunk. `last_committed_row` is advanced inside it, so the progress marker
    // and the rows it describes commit together or not at all.
    const outcome = await ctx.db.transaction().execute(async (trx) => {
      const local = { created: 0, merged: 0, skipped: 0 }
      const touched: Uuid[] = []

      // Organizations first, for the whole chunk: find-or-create is batched, and doing it per row
      // is one round trip per row for the company thirty of them share.
      const organizationNames = chunk
        .map((row) => stringValue(row, 'organization'))
        .filter((name): name is string => name !== undefined)
      const organizations = await resolveOrganizations(trx, {
        names: organizationNames,
        workspaceId: workspace,
        importBatchId: batchId,
        provenance,
      })
      const organizationIdFor = (name: string | undefined): Uuid | undefined => {
        if (name === undefined) return undefined
        const index = organizationNames.indexOf(name)
        const key = index === -1 ? undefined : organizations.keys[index]
        return key === undefined ? undefined : organizations.byKey.get(key)
      }

      for (const row of chunk) {
        const skip = skipReason(row, keptFor, landedAs)
        if (skip !== null) {
          local.skipped++
          continue
        }

        const values = planImportValues({
          row,
          schema,
          objectType: batch.objectType,
          organizationId: organizationIdFor(stringValue(row, 'organization')),
        })

        if (batch.objectType === 'organization') {
          const id = await createOrganization(trx, {
            name: stringValue(row, 'name') ?? '',
            createdVia: 'import',
            workspaceId: workspace,
            importBatchId: batchId,
            provenance,
            values: values.changes,
          })
          landedAs.set(row.rowNumber, id)
          touched.push(id)
          local.created++
          continue
        }

        const target = mergeTargetFor(row, keptFor, landedAs)
        if (target !== undefined) {
          // "Merge into existing" is fill-empty-only (§6.8): the fact log supersedes rather than
          // overwrites, so writing a value the survivor already has would create a spurious
          // history entry that says the import changed something it did not.
          await writeMissingValues(trx, target, values.changes, provenance)
          landedAs.set(row.rowNumber, target)
          touched.push(target)
          local.merged++
          continue
        }

        const id = await createContact(trx, {
          firstName: stringValue(row, 'first_name') ?? null,
          lastName: stringValue(row, 'last_name') ?? null,
          createdVia: 'import',
          workspaceId: workspace,
          importBatchId: batchId,
          provenance,
          values: values.changes,
        })
        landedAs.set(row.rowNumber, id)
        touched.push(id)
        local.created++
      }

      // §4.6's write-through, batched: one probe per record would be one round trip per row, which
      // ADR-042 names as the thing not to do.
      if (touched.length > 0) await writeIdentifiersForRecords(trx, touched)

      await addImportCounts(trx, batchId, {
        created: local.created,
        merged: local.merged,
        skipped: local.skipped,
        lastCommittedRow: chunk[chunk.length - 1]?.rowNumber ?? 0,
      })
      return local
    })

    created += outcome.created
    merged += outcome.merged
    skipped += outcome.skipped
  }

  await updateImportBatch(ctx.db, batchId, { status: 'completed' })
  return { created, merged, skipped }
}

/**
 * Why this row does not land, or `null` if it does.
 *
 * Q4's answer in code: a flagged duplicate with no decision is **not** imported. The user was asked
 * and has not answered, and not importing is the default — so the row is skipped and appears in the
 * error report with the reason, rather than being created quietly.
 */
function skipReason(
  row: ImportRowRecord,
  keptFor: ReadonlyMap<number, number | null>,
  landedAs: ReadonlyMap<number, Uuid>,
): string | null {
  if (Array.isArray(row.errors) && row.errors.length > 0) return 'invalid'
  if (row.decision === 'skip') return 'skipped'

  const flagged = row.duplicateOf !== null || row.duplicateOfRow !== null
  if (!flagged) return null
  if (row.decision === 'create') return null
  if (row.decision === 'merge') {
    return mergeTargetFor(row, keptFor, landedAs) === undefined ? 'nothing to merge into' : null
  }
  // Flagged, and undecided.
  return 'undecided duplicate'
}

/** The record a `merge` decision fills into: an existing one, or whatever its chain's first kept row became. */
function mergeTargetFor(
  row: ImportRowRecord,
  keptFor: ReadonlyMap<number, number | null>,
  landedAs: ReadonlyMap<number, Uuid>,
): Uuid | undefined {
  if (row.decision !== 'merge') return undefined
  if (row.duplicateOf !== null) return row.duplicateOf
  const kept = keptFor.get(row.rowNumber)
  return kept === null || kept === undefined ? undefined : landedAs.get(kept)
}

function stringValue(row: ImportRowRecord, key: string): string | undefined {
  const mapped = (row.mapped ?? {}) as Record<string, unknown>
  const value = mapped[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Writes only the values the survivor does not already have.
 *
 * §6.8's `Merge into existing` is explicitly "fill empty fields only". Implemented as a read of the
 * current values followed by a write of the difference, rather than as a blind write, because the
 * fact log records every write as an observation — a blind write would put "Company: Stripe,
 * superseded Company: Stripe" in the history popover and make the import look like it changed
 * something.
 */
async function writeMissingValues(
  trx: Parameters<typeof writeIdentifiersForRecords>[0],
  recordId: Uuid,
  changes: readonly ValueChange[],
  provenance: Provenance,
): Promise<void> {
  if (changes.length === 0) return

  const existing = await trx
    .selectFrom('attribute_value')
    .select('attribute_id')
    .where('record_id', '=', recordId)
    .execute()
  const linked = await trx
    .selectFrom('record_link')
    .select('attribute_id')
    .where('from_record_id', '=', recordId)
    .execute()

  const filled = new Set([
    ...existing.map((row) => row.attribute_id),
    ...linked.map((row) => row.attribute_id),
  ])
  const missing = changes.filter((change) => !filled.has(change.attributeId))
  if (missing.length === 0) return

  await applyValues(trx, { recordId, changes: missing, provenance })
}
