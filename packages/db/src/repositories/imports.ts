/**
 * `import_batch` and `import_row` — the wizard's server-side state (§6.8, ADR-054).
 *
 * Rows are staged rather than held in the browser because three of the wizard's inputs only the
 * server has: the identifier-index duplicate probe, select-option validation, and whole-file
 * statistics. That is also what makes the Review grid's undo, revert and find-and-replace real
 * operations with names (ADR-031) instead of client state that a refresh loses.
 *
 * `mapped`, `errors` and `duplicate_detail` are jsonb read whole and written whole. Nothing filters
 * on their contents; what *is* filtered on — has this row an error, has it a duplicate — is served
 * by the three partial indexes on `import_row`.
 */
import type { ObjectType, Uuid } from '@mutuals/core'
import { sql } from 'kysely'

import type { DB, ImportDecision, ImportStatus, JsonValue } from '../schema.ts'
import type { Executor } from '../write/types.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'

/**
 * A jsonb value, as `pg` needs it.
 *
 * `pg` serialises a JS *array* as a Postgres array literal rather than as JSON, so `errors: []`
 * arrives as `{}` and `errors: [{ code }]` arrives as something that is not JSON at all. Every
 * jsonb write in this package goes through `JSON.stringify` for that reason; `views.ts` does the
 * same. The cast is to `never` because Kysely types these columns by their read shape.
 */
function json(value: JsonValue): never {
  return JSON.stringify(value) as never
}

export interface ImportBatchRow {
  readonly id: Uuid
  readonly fileName: string
  readonly objectType: ObjectType
  readonly rowCount: number
  readonly mapping: JsonValue
  readonly status: ImportStatus
  readonly lastCommittedRow: number
  readonly errorDetail: JsonValue | null
  readonly createdCount: number
  readonly mergedCount: number
  readonly skippedCount: number
  readonly importedAt: Date
}

export interface ImportRowRecord {
  readonly rowNumber: number
  readonly raw: JsonValue
  readonly mapped: JsonValue
  readonly errors: JsonValue
  readonly duplicateOf: Uuid | null
  readonly duplicateOfRow: number | null
  readonly duplicateDetail: JsonValue | null
  readonly decision: ImportDecision | null
}

export interface CreateImportBatchInput {
  readonly fileName: string
  readonly objectType: ObjectType
  readonly mapping?: JsonValue
  readonly workspaceId?: string | null
}

export async function createImportBatch(
  exec: Executor,
  input: CreateImportBatchInput,
): Promise<Uuid> {
  const row = await exec
    .insertInto('import_batch')
    .values({
      workspace_id: await resolveWorkspaceId(exec, input.workspaceId),
      file_name: input.fileName,
      object_type: input.objectType,
      mapping: json(input.mapping ?? {}),
      status: 'parsing',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export interface StagedRow {
  readonly rowNumber: number
  readonly raw: JsonValue
  readonly mapped?: JsonValue
  readonly errors?: JsonValue
}

/**
 * Writes the parsed rows.
 *
 * Chunked because Postgres binds at most 65535 parameters per statement and each row carries four,
 * so a 10k-row export would otherwise fail somewhere past row 16000 with a message about parameter
 * count that says nothing about imports.
 */
const INSERT_CHUNK = 1000

export async function stageImportRows(
  exec: Executor,
  batchId: Uuid,
  rows: readonly StagedRow[],
): Promise<number> {
  if (rows.length === 0) return 0

  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK)
    await exec
      .insertInto('import_row')
      .values(
        chunk.map((row) => ({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw: json(row.raw),
          mapped: json(row.mapped ?? {}),
          errors: json(row.errors ?? []),
        })),
      )
      .execute()
  }

  await exec
    .updateTable('import_batch')
    .set({ row_count: rows.length })
    .where('id', '=', batchId)
    .execute()
  return rows.length
}

export async function getImportBatch(
  exec: Executor,
  id: Uuid,
): Promise<ImportBatchRow | undefined> {
  const row = await exec
    .selectFrom('import_batch')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return row === undefined ? undefined : toBatch(row)
}

function toBatch(row: {
  id: string
  file_name: string
  object_type: ObjectType
  row_count: number
  mapping: unknown
  status: ImportStatus
  last_committed_row: number
  error_detail: unknown
  created_count: number
  merged_count: number
  skipped_count: number
  imported_at: Date | string
}): ImportBatchRow {
  return {
    id: row.id,
    fileName: row.file_name,
    objectType: row.object_type,
    rowCount: row.row_count,
    mapping: row.mapping as JsonValue,
    status: row.status,
    lastCommittedRow: row.last_committed_row,
    errorDetail: (row.error_detail ?? null) as JsonValue | null,
    createdCount: row.created_count,
    mergedCount: row.merged_count,
    skippedCount: row.skipped_count,
    importedAt: typeof row.imported_at === 'string' ? new Date(row.imported_at) : row.imported_at,
  }
}

export interface ListRowsOptions {
  /** §6.8 step 4's `Error rows (n)` tab. */
  readonly onlyErrors?: boolean
  readonly onlyDuplicates?: boolean
  /** 1-based and inclusive, so a resume can ask for "everything after row 400". */
  readonly fromRow?: number
  readonly limit?: number
  readonly offset?: number
}

export async function listImportRows(
  exec: Executor,
  batchId: Uuid,
  options: ListRowsOptions = {},
): Promise<readonly ImportRowRecord[]> {
  let query = exec
    .selectFrom('import_row')
    .selectAll()
    .where('batch_id', '=', batchId)
    .orderBy('row_number')

  if (options.onlyErrors === true) query = query.where(sql<boolean>`errors <> '[]'::jsonb`)
  if (options.onlyDuplicates === true) {
    query = query.where((eb) =>
      eb.or([eb('duplicate_of', 'is not', null), eb('duplicate_of_row', 'is not', null)]),
    )
  }
  if (options.fromRow !== undefined) query = query.where('row_number', '>=', options.fromRow)
  if (options.limit !== undefined) query = query.limit(options.limit)
  if (options.offset !== undefined) query = query.offset(options.offset)

  return (await query.execute()).map(toRow)
}

function toRow(row: {
  row_number: number
  raw: unknown
  mapped: unknown
  errors: unknown
  duplicate_of: string | null
  duplicate_of_row: number | null
  duplicate_detail: unknown
  decision: ImportDecision | null
}): ImportRowRecord {
  return {
    rowNumber: row.row_number,
    raw: row.raw as JsonValue,
    mapped: row.mapped as JsonValue,
    errors: row.errors as JsonValue,
    duplicateOf: row.duplicate_of,
    duplicateOfRow: row.duplicate_of_row,
    duplicateDetail: (row.duplicate_detail ?? null) as JsonValue | null,
    decision: row.decision,
  }
}

export interface ImportCounts {
  readonly total: number
  readonly withErrors: number
  readonly duplicates: number
  readonly undecidedDuplicates: number
}

/** The four numbers §6.8's Review header and its import button are built from, in one statement. */
export async function countImportRows(exec: Executor, batchId: Uuid): Promise<ImportCounts> {
  const row = await exec
    .selectFrom('import_row')
    .where('batch_id', '=', batchId)
    .select((eb) => [
      eb.fn.countAll<string>().as('total'),
      sql<string>`count(*) filter (where errors <> '[]'::jsonb)`.as('with_errors'),
      sql<string>`count(*) filter (where duplicate_of is not null or duplicate_of_row is not null)`.as(
        'duplicates',
      ),
      sql<string>`count(*) filter (where (duplicate_of is not null or duplicate_of_row is not null) and decision is null)`.as(
        'undecided',
      ),
    ])
    .executeTakeFirstOrThrow()

  return {
    total: Number(row.total),
    withErrors: Number(row.with_errors),
    duplicates: Number(row.duplicates),
    undecidedDuplicates: Number(row.undecided),
  }
}

export interface ImportRowPatch {
  readonly mapped?: JsonValue
  readonly errors?: JsonValue
  /** `null` clears the decision, which is what "ask me again" means. */
  readonly decision?: ImportDecision | null
}

export async function updateImportRow(
  exec: Executor,
  batchId: Uuid,
  rowNumber: number,
  patch: ImportRowPatch,
): Promise<boolean> {
  const values: Record<string, unknown> = {}
  if (patch.mapped !== undefined) values['mapped'] = json(patch.mapped)
  if (patch.errors !== undefined) values['errors'] = json(patch.errors)
  if (patch.decision !== undefined) values['decision'] = patch.decision
  if (Object.keys(values).length === 0) return false

  const result = await exec
    .updateTable('import_row')
    .set(values as never)
    .where('batch_id', '=', batchId)
    .where('row_number', '=', rowNumber)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

export interface RowDuplicateUpdate {
  readonly rowNumber: number
  /** Exactly one of these, per `import_row_one_duplicate_kind`. */
  readonly duplicateOf?: Uuid | null
  readonly duplicateOfRow?: number | null
  readonly detail?: JsonValue | null
}

/**
 * Writes the duplicate verdicts for a whole batch.
 *
 * Both pointers are always set — one to a value and one to `null` — because the `CHECK` allows at
 * most one, and a partial update that sets the new pointer without clearing the old one would fail
 * on any row whose verdict changed kind between two runs of detection.
 */
export async function setRowDuplicates(
  exec: Executor,
  batchId: Uuid,
  updates: readonly RowDuplicateUpdate[],
): Promise<number> {
  let written = 0
  for (const update of updates) {
    const result = await exec
      .updateTable('import_row')
      .set({
        duplicate_of: update.duplicateOf ?? null,
        duplicate_of_row: update.duplicateOfRow ?? null,
        duplicate_detail:
          update.detail === null || update.detail === undefined ? null : json(update.detail),
      })
      .where('batch_id', '=', batchId)
      .where('row_number', '=', update.rowNumber)
      .executeTakeFirst()
    written += Number(result.numUpdatedRows)
  }
  return written
}

/** §6.8 step 4's bulk choice: one decision applied to every flagged row. */
export async function setDuplicateDecisions(
  exec: Executor,
  batchId: Uuid,
  decision: ImportDecision,
): Promise<number> {
  const result = await exec
    .updateTable('import_row')
    .set({ decision })
    .where('batch_id', '=', batchId)
    .where((eb) =>
      eb.or([eb('duplicate_of', 'is not', null), eb('duplicate_of_row', 'is not', null)]),
    )
    .executeTakeFirst()
  return Number(result.numUpdatedRows)
}

export interface ReplaceInBatchInput {
  /** The mapped target whose cells are rewritten, e.g. `city` or `organization.title`. */
  readonly targetId: string
  readonly find: string
  readonly replace: string
  readonly caseSensitive?: boolean
}

/**
 * §6.8 step 4's `Find & replace`, over one target's cells.
 *
 * Done in SQL rather than by reading every row into the API and writing it back: on a 10k-row
 * import that is 10k round trips for what is one `UPDATE`. Only string cells are touched — a
 * replacement on a date or a boolean is a category error, and `jsonb_typeof` is what refuses it
 * rather than a coercion that turns `true` into `"true"`.
 *
 * The rewritten cell is *not* re-validated here. The caller re-maps the affected rows, because
 * validation needs the attribute registry and that lives one layer up.
 */
export async function replaceInImportBatch(
  exec: Executor,
  batchId: Uuid,
  input: ReplaceInBatchInput,
): Promise<readonly number[]> {
  if (input.find === '') return []

  const needle = caseFlag(input.find, input.caseSensitive === true)

  const rows = await sql<{ row_number: number }>`
    update import_row
       set mapped = jsonb_set(
             mapped,
             array[${input.targetId}],
             to_jsonb(regexp_replace(mapped ->> ${input.targetId}, ${needle}, ${input.replace}, 'g'))
           )
     where batch_id = ${batchId}
       and jsonb_typeof(mapped -> ${input.targetId}) = 'string'
       and mapped ->> ${input.targetId} ~ ${needle}
    returning row_number
  `.execute(exec)

  return rows.rows.map((row) => row.row_number)
}

/** Neutralises the regex metacharacters, so a search for `a.b` does not match `axb`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The needle, escaped, with case-insensitivity expressed as an inline `(?i)` flag.
 *
 * Inline rather than as `regexp_replace`'s flags argument so that one string serves both the `~`
 * test in the `WHERE` and the replacement — two spellings of the same needle is how a find that
 * matches and a replace that does not get built.
 */
function caseFlag(value: string, caseSensitive: boolean): string {
  const escaped = escapeRegex(value)
  return caseSensitive ? escaped : `(?i)${escaped}`
}

export interface ImportBatchPatch {
  readonly status?: ImportStatus
  readonly lastCommittedRow?: number
  readonly mapping?: JsonValue
  readonly errorDetail?: JsonValue | null
  readonly createdCount?: number
  readonly mergedCount?: number
  readonly skippedCount?: number
}

export async function updateImportBatch(
  exec: Executor,
  id: Uuid,
  patch: ImportBatchPatch,
): Promise<boolean> {
  const values: Record<string, unknown> = {}
  if (patch.status !== undefined) values['status'] = patch.status
  if (patch.lastCommittedRow !== undefined) values['last_committed_row'] = patch.lastCommittedRow
  if (patch.mapping !== undefined) values['mapping'] = patch.mapping
  if (patch.errorDetail !== undefined) {
    values['error_detail'] = patch.errorDetail === null ? null : json(patch.errorDetail)
  }
  if (patch.createdCount !== undefined) values['created_count'] = patch.createdCount
  if (patch.mergedCount !== undefined) values['merged_count'] = patch.mergedCount
  if (patch.skippedCount !== undefined) values['skipped_count'] = patch.skippedCount
  if (Object.keys(values).length === 0) return false

  const result = await exec
    .updateTable('import_batch')
    .set(values as never)
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * Adds to the three result counters without reading them first.
 *
 * ADR-061 commits in chunks and advances `last_committed_row` as it goes, so the counters are
 * incremented per chunk. Reading, adding and writing would lose a chunk's worth on any interleaving,
 * and a failed import's result screen has to state how many rows were applied before it stopped.
 */
export async function addImportCounts(
  exec: Executor,
  id: Uuid,
  counts: { created?: number; merged?: number; skipped?: number; lastCommittedRow?: number },
): Promise<void> {
  await exec
    .updateTable('import_batch')
    .set((eb) => ({
      created_count: eb('created_count', '+', counts.created ?? 0),
      merged_count: eb('merged_count', '+', counts.merged ?? 0),
      skipped_count: eb('skipped_count', '+', counts.skipped ?? 0),
      ...(counts.lastCommittedRow === undefined
        ? {}
        : { last_committed_row: counts.lastCommittedRow }),
    }))
    .where('id', '=', id)
    .execute()
}

export type ImportBatchTable = DB['import_batch']
