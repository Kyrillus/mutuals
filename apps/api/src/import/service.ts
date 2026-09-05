/**
 * The import wizard's server-side logic (§6.8) — everything the eight routes share.
 *
 * The wizard's whole configuration lives in `import_batch.mapping` as one opaque jsonb blob:
 * the source preset, the chosen worksheet, the header row, the column-to-target map, the per-value
 * option map and the date formats. Opaque is the point — nothing filters on it, it is read whole and
 * written whole, and keeping it in one place means re-deriving the rows is a pure function of
 * `(raw cells, config)`.
 *
 * That purity is what §6.8's idempotency requirement rests on: re-importing the same export with
 * the same mapping produces the same mapped values, so the duplicate detection reaches the same
 * verdicts and a `Skip` really is a no-op.
 */
import {
  applyDateFormat,
  autoMapColumns,
  detectHeaderRow,
  importPreset,
  importTargets,
  mapRow,
  matchBatchRows,
  normalizeEmail,
  normalizeLinkedIn,
  emailMatchKey,
  type BatchRowProbe,
  type ColumnMapping,
  type DateFormat,
  type IdentifierRef,
  type ImportSource,
  type MappingTarget,
  ImportBatchDetailSchema,
  type SourceColumn,
  type ValueMap,
} from '@mutuals/core'
import {
  countImportRows,
  createImportBatch,
  findOrganizationsByName,
  getImportBatch,
  listImportRows,
  probeDuplicates,
  replaceInImportBatch,
  setRowDuplicates,
  stageImportRows,
  updateImportBatch,
  updateImportRow,
  type CandidateProbe,
  type ImportRowRecord,
} from '@mutuals/db'
import type { ObjectType, Uuid } from '@mutuals/core'

import { loadSchema, typeContext, workspaceId, type AppContext, type Schema } from '../context.ts'
import { notFound, validationFailed } from '../errors.ts'
import { readImportFile, type SheetGrid } from './read-file.ts'

/** What `import_batch.mapping` holds. Versioned by shape, not by a number: it is scratch space. */
export interface WizardConfig {
  readonly source: ImportSource
  /** `null` for a CSV. */
  readonly sheetName: string | null
  readonly sheets: readonly {
    name: string
    rowCount: number
    columnCount: number
    headerRow: number
  }[]
  readonly headerRow: number
  readonly delimiter: string | null
  /** The header row's cells, so a column keeps its name after the grid is gone. */
  readonly header: readonly string[]
  /** Column index as a string (jsonb keys are strings) to target id, or `null` for unmapped. */
  readonly columns: Readonly<Record<string, string | null>>
  readonly valueMap: ValueMap
  readonly dateFormats: Readonly<Record<string, DateFormat>>
}

/**
 * `import_row.raw`.
 *
 * An array rather than a header-keyed object, because two columns may share a header — Google
 * Contacts has `E-mail 1 - Label` and `E-mail 2 - Label`, and a real hand-made CSV has worse.
 *
 * `cells` is the file, verbatim, and is **never** written to. An edit in the Review grid goes into
 * `edits`, keyed by column index. That is what makes `revertImportRow` a real operation rather than
 * a hopeful one: reverting is deleting a key, and the original is still there to re-derive from.
 * Storing the edit *into* `cells` would lose what the file said the moment anyone fixed a typo, and
 * the whole point of staging `raw` is that the file is recoverable.
 */
interface RawRow {
  readonly cells: readonly string[]
  readonly edits?: Readonly<Record<string, string>>
}

export interface StageUploadInput {
  readonly fileName: string
  readonly objectType: ObjectType
  readonly source: ImportSource
  /** Only meaningful for a workbook. Absent means "pick the sheet with the most content". */
  readonly sheetName?: string
  readonly content: Buffer
}

/**
 * Step 1 and step 2: read the file, choose a worksheet, auto-map, stage the rows, detect duplicates.
 *
 * The whole wizard is prepared in one request rather than one per step, because every later step is
 * a *change* to what this produced. It also means the client can render step 3 with real numbers
 * instead of a spinner.
 *
 * A workbook's rows are staged for one sheet only. Changing the sheet re-posts the file — the
 * browser still holds it, having just picked it — rather than the server keeping the upload around
 * between requests. `supersedes` is how the client discards the batch it is replacing.
 */
export async function stageUpload(ctx: AppContext, input: StageUploadInput): Promise<Uuid> {
  const file = await readImportFile(input.fileName, input.content)
  const sheet = chooseSheet(file.sheets, input.sheetName)
  const headerRow = detectHeaderRow(sheet.rows)
  const header = [...(sheet.rows[headerRow] ?? [])]
  const data = sheet.rows
    .slice(headerRow + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))

  const schema = await loadSchema(ctx, input.objectType)
  const targets = importTargets(schema.resolver)
  const columns = header.map<SourceColumn>((text, index) => ({
    index,
    header: text,
    cells: data.map((row) => row[index] ?? ''),
  }))
  const mappings = autoMapColumns(columns, targets, importPreset(input.source))

  const config: WizardConfig = {
    source: input.source,
    sheetName: file.kind === 'xlsx' ? sheet.name : null,
    sheets: file.sheets.map((one) => ({
      name: one.name,
      rowCount: Math.max(one.rows.length - 1, 0),
      columnCount: one.rows[detectHeaderRow(one.rows)]?.length ?? 0,
      headerRow: detectHeaderRow(one.rows),
    })),
    headerRow,
    delimiter: file.delimiter ?? null,
    header,
    columns: Object.fromEntries(mappings.map((one) => [String(one.index), one.targetId])),
    valueMap: {},
    dateFormats: Object.fromEntries(
      mappings.flatMap((one) =>
        one.targetId !== null && one.dateFormat !== undefined
          ? [[one.targetId, one.dateFormat]]
          : [],
      ),
    ),
  }

  const batchId = await createImportBatch(ctx.db, {
    fileName: input.fileName,
    objectType: input.objectType,
    mapping: config as never,
    workspaceId: await workspaceId(ctx),
  })

  await stageImportRows(
    ctx.db,
    batchId,
    data.map((cells, index) => ({
      rowNumber: index + 1,
      raw: { cells: [...cells] } satisfies RawRow as never,
    })),
  )

  await remapBatch(ctx, batchId)
  return batchId
}

/**
 * Picks the worksheet to work on.
 *
 * Named wins. Otherwise the one with the most cells, which is a better default than the first: a
 * workbook's first sheet is very often a `Notes` or `README` tab, and the fixture is built that way
 * on purpose so this cannot be passed by taking `sheets[0]`.
 */
function chooseSheet(sheets: readonly SheetGrid[], wanted: string | undefined): SheetGrid {
  if (sheets.length === 0) {
    throw validationFailed([
      { code: 'invalid_input', path: ['file'], message: 'That file has no sheets in it.' },
    ])
  }
  if (wanted !== undefined) {
    const named = sheets.find((sheet) => sheet.name === wanted)
    if (named === undefined) {
      throw validationFailed([
        {
          code: 'invalid_input',
          path: ['sheetName'],
          message: `That file has no sheet called "${wanted}".`,
        },
      ])
    }
    return named
  }

  let best = sheets[0] as SheetGrid
  let bestCells = 0
  for (const sheet of sheets) {
    const cells = sheet.rows.reduce((total, row) => total + row.length, 0)
    if (cells > bestCells) {
      bestCells = cells
      best = sheet
    }
  }
  return best
}

export interface RemapPatch {
  readonly source?: ImportSource
  readonly headerRow?: number
  readonly columns?: Readonly<Record<string, string | null>>
  readonly valueMap?: ValueMap
  readonly dateFormats?: Readonly<Record<string, DateFormat>>
}

/**
 * Re-derives every row's mapped values and errors from `raw` and the config, then re-runs duplicate
 * detection.
 *
 * Called on upload and on every mapping change. It is deliberately a full recompute rather than an
 * incremental patch: the mapping decides what a cell *means*, so an edit made under the old mapping
 * has no meaning under the new one, and a partial update would leave rows derived from two
 * different mappings in one grid.
 */
export async function remapBatch(
  ctx: AppContext,
  batchId: Uuid,
  patch: RemapPatch = {},
): Promise<void> {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw notFound('import batch', batchId)

  const previous = batch.mapping as unknown as WizardConfig
  const config: WizardConfig = {
    ...previous,
    ...(patch.source === undefined ? {} : { source: patch.source }),
    ...(patch.headerRow === undefined ? {} : { headerRow: patch.headerRow }),
    ...(patch.columns === undefined ? {} : { columns: { ...previous.columns, ...patch.columns } }),
    ...(patch.valueMap === undefined ? {} : { valueMap: patch.valueMap }),
    ...(patch.dateFormats === undefined
      ? {}
      : { dateFormats: { ...previous.dateFormats, ...patch.dateFormats } }),
  }

  const schema = await loadSchema(ctx, batch.objectType)
  const targets = importTargets(schema.resolver)
  const rows = await listImportRows(ctx.db, batchId)
  const mappings = mappingsFrom(config, targets, rows)

  await updateImportBatch(ctx.db, batchId, { mapping: config as never, status: 'reviewing' })

  const definitions = schema.bySlug
  for (const row of rows) {
    const cells = cellsOf(row)
    const mapped = mapRow(cells, {
      objectType: batch.objectType,
      mappings,
      targets,
      definitions,
      typeContext: (definition) => typeContext(definition, { phoneRegion: 'DE' }),
      valueMap: config.valueMap,
    })
    await updateImportRow(ctx.db, batchId, row.rowNumber, {
      mapped: mapped.values as never,
      errors: mapped.errors as never,
    })
  }

  await detectDuplicates(ctx, batchId)
}

/**
 * The column mappings the config implies.
 *
 * Rebuilt rather than stored because a `ColumnMapping` carries derived things — the fill rate, the
 * date inference — that depend on the rows, and storing them would put two sources of truth in one
 * jsonb blob. The user's explicit choices are the only thing `config.columns` keeps.
 */
function mappingsFrom(
  config: WizardConfig,
  targets: readonly MappingTarget[],
  rows: readonly ImportRowRecord[],
): readonly ColumnMapping[] {
  const cells = rows.map(cellsOf)
  const columns = config.header.map<SourceColumn>((header, index) => ({
    index,
    header,
    cells: cells.map((row) => row[index] ?? ''),
  }))

  // Start from the cascade so the derived fields are computed the same way everywhere, then apply
  // the user's overrides on top.
  const automapped = autoMapColumns(columns, targets, importPreset(config.source))
  return automapped.map((mapping) => {
    const chosen = config.columns[String(mapping.index)]
    const targetId = chosen === undefined ? mapping.targetId : chosen
    const format = targetId === null ? undefined : config.dateFormats[targetId]
    return {
      ...mapping,
      targetId,
      // A choice the user made is confirmed by definition; the cascade's own verdict only applies
      // where they have not touched it.
      confirmed: chosen === undefined ? mapping.confirmed : true,
      ...(format === undefined ? {} : { dateFormat: format }),
    }
  })
}

/** The row as it is now: the file's cells with any edits laid over them. */
function cellsOf(row: ImportRowRecord): readonly string[] {
  const raw = row.raw as unknown as RawRow | null
  const cells = [...(raw?.cells ?? [])]
  for (const [index, value] of Object.entries(raw?.edits ?? {})) cells[Number(index)] = value
  return cells
}

/** The row as the file had it, ignoring every edit. What a revert goes back to. */
function originalCellsOf(row: ImportRowRecord): readonly string[] {
  return (row.raw as unknown as RawRow | null)?.cells ?? []
}

function editsOf(row: ImportRowRecord): Readonly<Record<string, string>> {
  return (row.raw as unknown as RawRow | null)?.edits ?? {}
}

/**
 * Re-runs §4.6's matching over the whole batch and writes the verdicts (ADR-097).
 *
 * Two probes per row, one against committed records and one against the earlier rows of this batch,
 * scored by the same function. The database half is batched — ADR-042 is explicit that one probe per
 * identifier per row is 20k+ round trips on a 10k export.
 */
export async function detectDuplicates(ctx: AppContext, batchId: Uuid): Promise<void> {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw notFound('import batch', batchId)
  if (batch.objectType === 'interaction') return

  const rows = await listImportRows(ctx.db, batchId)
  if (rows.length === 0) return

  const objectType = batch.objectType
  const identities = rows.map((row) => identityOf(row, objectType))

  /**
   * The organizations these rows name, where one already exists.
   *
   * Load-bearing, and it was empty in the first version — which quietly disabled every name-based
   * rule against committed records. `name_exact_org_same` and `name_fuzzy_org_same` both require
   * the same organisation, so with no ids on the incoming side `sharedOrg` was always false and the
   * only thing that could ever match an existing contact was a shared identifier. Re-importing a
   * file then found its diacritic and typo pairs *within* the file and missed the contacts they had
   * already become. A lookup, never a create: probing is a read.
   */
  const organizations = await findOrganizationsByName(
    ctx.db,
    identities.map((identity) => identity.organizationName ?? ''),
  )
  const organizationIdsFor = (index: number): readonly string[] => {
    const key = organizations.keys[index]
    const id = key === undefined || key === '' ? undefined : organizations.byKey.get(key)
    return id === undefined ? [] : [id]
  }

  const pools = await probeDuplicates(
    ctx.db,
    identities.map<CandidateProbe>((identity, index) => ({
      objectType: identity.objectType,
      displayName: identity.displayName,
      identifiers: identity.identifiers,
      emailMatchKeys: identity.emailMatchKeys,
      organizationIds: organizationIdsFor(index),
    })),
  )

  const probes = identities.map<BatchRowProbe>((identity, index) => ({
    rowNumber: rows[index]?.rowNumber ?? index + 1,
    objectType: identity.objectType,
    displayName: identity.displayName,
    nameKey: pools[index]?.nameKey ?? '',
    identifiers: identity.identifiers,
    emailMatchKeys: identity.emailMatchKeys,
    organizationIds: organizationIdsFor(index),
    organizationKeys: identity.organizationKeys,
  }))

  const verdicts = matchBatchRows(
    probes,
    pools.map((pool) => pool.pool),
  )

  await setRowDuplicates(
    ctx.db,
    batchId,
    verdicts.map((verdict, index) => {
      const rowNumber = probes[index]?.rowNumber ?? index + 1
      if (verdict === null) return { rowNumber, duplicateOf: null, duplicateOfRow: null }
      const isRecord = verdict.target.kind === 'record'
      return {
        rowNumber,
        duplicateOf: isRecord ? (verdict.target as { recordId: string }).recordId : null,
        duplicateOfRow: isRecord ? null : (verdict.target as { rowNumber: number }).rowNumber,
        detail: {
          band: verdict.band,
          confidence: verdict.confidence,
          rules: [...verdict.rules],
          evidence: verdict.evidence,
          label: verdict.label,
          kind: verdict.target.kind,
        } as never,
      }
    }),
  )
}

interface RowIdentity {
  readonly objectType: 'contact' | 'organization'
  readonly displayName: string
  readonly identifiers: readonly IdentifierRef[]
  readonly emailMatchKeys: readonly string[]
  readonly organizationKeys: readonly string[]
  /** As the file spells it, for looking up an organization that already exists. */
  readonly organizationName?: string
}

/**
 * What a staged row claims about who it is.
 *
 * The identifiers go through `packages/core`'s normalisers rather than being taken as typed, because
 * `identifier.value` is canonical by definition and a probe against it has to be canonical too.
 * A value that will not normalise contributes no identifier — it is still a perfectly good
 * attribute value, it just is not an identity claim.
 */
function identityOf(row: ImportRowRecord, objectType: ObjectType): RowIdentity {
  const mapped = (row.mapped ?? {}) as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = mapped[key]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  const identifiers: IdentifierRef[] = []
  const emailMatchKeys: string[] = []

  const email = text('email')
  if (email !== undefined) {
    const normalized = normalizeEmail(email)
    if (normalized.ok) {
      identifiers.push({ kind: 'email', value: normalized.value.identifier })
      emailMatchKeys.push(emailMatchKey(normalized.value.identifier))
    }
  }

  const linkedin = text('linkedin_url')
  if (linkedin !== undefined) {
    const normalized = normalizeLinkedIn(linkedin)
    if (normalized.ok) {
      identifiers.push({ kind: 'linkedin_url', value: normalized.value.identifier })
    }
  }

  const organization = text('organization')
  const displayName =
    objectType === 'organization'
      ? (text('name') ?? '')
      : [text('first_name') ?? '', text('last_name') ?? ''].join(' ').trim()

  return {
    objectType: objectType === 'organization' ? 'organization' : 'contact',
    displayName,
    identifiers,
    emailMatchKeys,
    // Lower-cased rather than `mutuals_norm`-ed: this key is only ever compared against another
    // row of the same batch, never against a column, so ADR-019 does not apply. It has to agree
    // with itself and nothing else.
    organizationKeys: organization === undefined ? [] : [organization.trim().toLowerCase()],
    ...(organization === undefined ? {} : { organizationName: organization }),
  }
}

/** Re-coerces the cells the user typed in the Review grid, and re-validates the whole row. */
export async function editRow(
  ctx: AppContext,
  batchId: Uuid,
  rowNumber: number,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  await rewriteRow(ctx, batchId, rowNumber, (row, mappings) => {
    const edits = { ...editsOf(row) }
    for (const [targetId, text] of Object.entries(values)) {
      const mapping = mappings.find((one) => one.targetId === targetId)
      if (mapping === undefined) {
        throw validationFailed([
          {
            code: 'unknown_field',
            path: [targetId],
            message: `No column of this import maps to "${targetId}".`,
          },
        ])
      }
      edits[String(mapping.index)] = text
    }
    return edits
  })
}

/** §6.8 step 4's undo, at row granularity: throw away every edit and re-read the file's own cells. */
export async function revertRow(ctx: AppContext, batchId: Uuid, rowNumber: number): Promise<void> {
  await rewriteRow(ctx, batchId, rowNumber, () => ({}))
}

/**
 * The one path from raw text to canonical value, used by both an edit and a revert.
 *
 * Everything goes through `mapRow` rather than writing `mapped` directly, so an edited cell is
 * coerced, validated and date-formatted exactly like one that came out of the file. Writing
 * `mapped` straight would be a second, subtly different coercion — and it is the one place a
 * "fixed" cell could land in a shape nothing else in the product can produce.
 */
async function rewriteRow(
  ctx: AppContext,
  batchId: Uuid,
  rowNumber: number,
  nextEdits: (
    row: ImportRowRecord,
    mappings: readonly ColumnMapping[],
  ) => Readonly<Record<string, string>>,
): Promise<void> {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw notFound('import batch', batchId)

  const config = batch.mapping as unknown as WizardConfig
  const schema = await loadSchema(ctx, batch.objectType)
  const targets = importTargets(schema.resolver)
  const rows = await listImportRows(ctx.db, batchId, { fromRow: rowNumber, limit: 1 })
  const row = rows[0]
  if (row === undefined || row.rowNumber !== rowNumber) {
    throw notFound('import row', String(rowNumber))
  }

  const mappings = mappingsFrom(config, targets, rows)
  const edits = nextEdits(row, mappings)

  const cells = [...originalCellsOf(row)]
  for (const [index, value] of Object.entries(edits)) cells[Number(index)] = value

  const mapped = mapRow(cells, {
    objectType: batch.objectType,
    mappings,
    targets,
    definitions: schema.bySlug,
    typeContext: (definition) => typeContext(definition, { phoneRegion: 'DE' }),
    valueMap: config.valueMap,
  })

  await ctx.db
    .updateTable('import_row')
    .set({
      raw: JSON.stringify({
        cells: originalCellsOf(row),
        ...(Object.keys(edits).length === 0 ? {} : { edits }),
      } satisfies RawRow) as never,
    })
    .where('batch_id', '=', batchId)
    .where('row_number', '=', rowNumber)
    .execute()

  await updateImportRow(ctx.db, batchId, rowNumber, {
    mapped: mapped.values as never,
    errors: mapped.errors as never,
  })
}

/**
 * §6.8 step 4's `Find & replace`, translated from a target to the column that feeds it.
 *
 * The wizard speaks targets — the user is replacing "Munich" in the City *field* — while the
 * replacement has to land on the source cell, because `mapped` is derived and any re-map would
 * throw it away. This is the translation, and it is also where the affected rows are re-validated:
 * a find-and-replace that leaves an invalid email still marked valid would be worse than no
 * find-and-replace at all.
 */
export async function replaceInBatch(
  ctx: AppContext,
  batchId: Uuid,
  input: { targetId: string; find: string; replace: string; caseSensitive?: boolean },
): Promise<readonly number[]> {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw notFound('import batch', batchId)

  const config = batch.mapping as unknown as WizardConfig
  const schema = await loadSchema(ctx, batch.objectType)
  const targets = importTargets(schema.resolver)
  const rows = await listImportRows(ctx.db, batchId)
  const mapping = mappingsFrom(config, targets, rows).find((one) => one.targetId === input.targetId)

  if (mapping === undefined) {
    throw validationFailed([
      {
        code: 'unknown_field',
        path: ['targetId'],
        message: `No column of this import maps to "${input.targetId}".`,
      },
    ])
  }

  const changed = await replaceInImportBatch(ctx.db, batchId, {
    columnIndex: mapping.index,
    find: input.find,
    replace: input.replace,
    ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
  })
  if (changed.length > 0) await remapBatch(ctx, batchId)
  return changed
}

/** The four counters, plus the two the import button needs (§6.8 step 4). */
export async function importCounts(ctx: AppContext, batchId: Uuid) {
  const base = await countImportRows(ctx.db, batchId)
  const rows = await listImportRows(ctx.db, batchId)

  let willSkip = 0
  for (const row of rows) {
    const hasErrors = Array.isArray(row.errors) && row.errors.length > 0
    const flagged = row.duplicateOf !== null || row.duplicateOfRow !== null
    // Q4: a flagged row with no decision does not land. Not importing is the default.
    if (hasErrors || (flagged && row.decision !== 'create' && row.decision !== 'merge')) willSkip++
  }

  return { ...base, willSkip, willImport: base.total - willSkip }
}

/**
 * Everything the wizard renders, in one object.
 *
 * The result is parsed through its own contract schema on the way out. That is not belt-and-braces:
 * `packages/core` types its arrays `readonly` and the schemas produce mutable ones, so a cast would
 * be needed somewhere — and parsing is the version of that cast which fails loudly if the shape is
 * wrong. `views.ts` does the same thing with a view's stored filters.
 */
export async function loadBatchDetail(
  ctx: AppContext,
  batchId: Uuid,
  rowQuery: { onlyErrors?: boolean; onlyDuplicates?: boolean; limit: number; offset: number },
) {
  const batch = await getImportBatch(ctx.db, batchId)
  if (batch === undefined) throw notFound('import batch', batchId)

  const config = batch.mapping as unknown as WizardConfig
  const schema = await loadSchema(ctx, batch.objectType)
  const targets = importTargets(schema.resolver)
  const allRows = await listImportRows(ctx.db, batchId)
  const mappings = mappingsFrom(config, targets, allRows)

  const page = await listImportRows(ctx.db, batchId, {
    ...(rowQuery.onlyErrors === undefined ? {} : { onlyErrors: rowQuery.onlyErrors }),
    ...(rowQuery.onlyDuplicates === undefined ? {} : { onlyDuplicates: rowQuery.onlyDuplicates }),
    limit: rowQuery.limit,
    offset: rowQuery.offset,
  })

  return ImportBatchDetailSchema.parse({
    batch: {
      id: batch.id,
      fileName: batch.fileName,
      objectType: batch.objectType,
      source: config.source,
      status: batch.status,
      rowCount: batch.rowCount,
      sheetName: config.sheetName,
      sheets: config.sheets.map((sheet) => ({ ...sheet })),
      headerRow: config.headerRow,
      delimiter: config.delimiter,
      columns: mappings.map((one) => ({ ...one })),
      targets: targets.map((one) => ({ ...one })),
      valueMappings: valueMappingsFor(config, mappings, targets, allRows, schema),
      counts: await importCounts(ctx, batchId),
      lastCommittedRow: batch.lastCommittedRow,
      createdCount: batch.createdCount,
      mergedCount: batch.mergedCount,
      skippedCount: batch.skippedCount,
      errorDetail: batch.errorDetail,
      importedAt: batch.importedAt.toISOString(),
    },
    rows: page.map((row) => toRowDto(row, config)),
  })
}

function toRowDto(row: ImportRowRecord, config: WizardConfig) {
  const cells = cellsOf(row)
  const detail = row.duplicateDetail as Record<string, unknown> | null
  return {
    rowNumber: row.rowNumber,
    raw: Object.fromEntries(config.header.map((header, index) => [header, cells[index] ?? ''])),
    mapped: (row.mapped ?? {}) as Record<string, unknown>,
    errors: (Array.isArray(row.errors) ? row.errors : []) as {
      code: string
      path: (string | number)[]
      message: string
    }[],
    duplicate:
      detail === null
        ? null
        : {
            band: detail['band'] as 'certain' | 'probable' | 'possible',
            confidence: detail['confidence'] as number,
            rules: (detail['rules'] ?? []) as string[],
            evidence: (detail['evidence'] ?? '') as string,
            label: (detail['label'] ?? '') as string,
            kind: (detail['kind'] ?? 'record') as 'record' | 'row',
            recordId: row.duplicateOf,
            rowNumber: row.duplicateOfRow,
          },
    decision: row.decision,
  }
}

/**
 * §6.8 step 3's value-mapping editor: the distinct source values of every select- or tags-typed
 * column, with how often each appears.
 *
 * The counts are the useful part. They are what lets someone see that "GP" is forty rows and "Gp."
 * is one typo, which is a different decision from mapping both.
 */
function valueMappingsFor(
  config: WizardConfig,
  mappings: readonly ColumnMapping[],
  targets: readonly MappingTarget[],
  rows: readonly ImportRowRecord[],
  schema: Schema,
) {
  const out: {
    targetId: string
    values: {
      value: string
      count: number
      mappedTo: string | null
      matchesExistingOption: boolean
    }[]
  }[] = []

  for (const mapping of mappings) {
    if (mapping.targetId === null) continue
    const target = targets.find((one) => one.id === mapping.targetId)
    if (target === undefined || !target.hasValueMapping) continue

    const definition = schema.bySlug.get(target.slug)
    const optionKeys = new Set((definition?.options ?? []).map((option) => option.key))
    const optionLabels = new Set(
      (definition?.options ?? []).map((option) => option.label.toLowerCase()),
    )

    const counts = new Map<string, number>()
    for (const row of rows) {
      const value = (cellsOf(row)[mapping.index] ?? '').trim()
      if (value !== '') counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    out.push({
      targetId: target.id,
      values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([value, count]) => ({
          value,
          count,
          mappedTo: config.valueMap[target.id]?.[value] ?? null,
          matchesExistingOption: optionKeys.has(value) || optionLabels.has(value.toLowerCase()),
        })),
    })
  }
  return out
}

/** Re-reads one date cell under a new column format, for the wizard's format switcher. */
export function reformatDate(raw: string, format: DateFormat): string | null {
  const parsed = applyDateFormat(raw, format)
  return parsed.ok ? parsed.value : null
}
