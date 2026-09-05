/**
 * §6.8's import wizard, as a contract.
 *
 * Eight operations, all eight named in ADR-031's `PLANNED_OPERATIONS` since Stage 1. The shapes are
 * here rather than in `apps/api` for ADR-030's reason: these schemas are the single declaration,
 * the API implements them, and `apps/web` imports the inferred types instead of a generated client.
 *
 * The wizard is stateful on the server (ADR-054), so most of these carry a batch id rather than the
 * file. The upload is the one exception and is `multipart/form-data`, which has no Zod shape — its
 * fields are documented on the route.
 */
import { z } from 'zod'

import { IsoDateTimeSchema, ObjectTypeSchema, UuidSchema } from './primitives.ts'
import { DATE_FORMATS } from '../import/dates.ts'
import { IMPORT_SOURCES } from '../import/presets.ts'
import { LINK_PARTS } from '../import/targets.ts'
import { MAPPING_STEPS } from '../import/automap.ts'

export const ImportSourceSchema = z.enum(IMPORT_SOURCES)
export const DateFormatSchema = z.enum(DATE_FORMATS)
export const MappingStepSchema = z.enum(MAPPING_STEPS)
export const ImportDecisionSchema = z.enum(['skip', 'merge', 'create'])
export const ImportStatusSchema = z.enum([
  'parsing',
  'mapping',
  'reviewing',
  'importing',
  'completed',
  'failed',
])
export const MatchBandSchema = z.enum(['certain', 'probable', 'possible'])

/** What a source column may point at (§6.8 step 3's select). */
export const MappingTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['column', 'attribute', 'link']),
  slug: z.string(),
  part: z.enum(LINK_PARTS).optional(),
  valueKind: z.enum(['text', 'number', 'date', 'bool', 'option', 'relation']),
  isMulti: z.boolean(),
  attributeId: UuidSchema.optional(),
  /** §6.8 step 3 offers the per-value mapping editor only for these. */
  hasValueMapping: z.boolean(),
})

export const DateInferenceSchema = z.object({
  format: DateFormatSchema.nullable(),
  ambiguous: z.boolean(),
  conflicting: z.boolean(),
  candidates: z.array(DateFormatSchema),
  samples: z.int(),
})

/** One card in §6.8 step 3, including the status its right-hand side shows. */
export const ColumnMappingSchema = z.object({
  index: z.int(),
  header: z.string(),
  targetId: z.string().nullable(),
  step: MappingStepSchema,
  /** False for every trigram match: a guess is proposed, never applied (ADR-044). */
  confirmed: z.boolean(),
  confidence: z.number(),
  /** §6.8: "% of rows have a value", as a fraction. */
  fillRate: z.number(),
  dateFormat: DateFormatSchema.optional(),
  dateInference: DateInferenceSchema.optional(),
})

/**
 * A distinct source value in a select- or tags-typed column, with how often it appears.
 *
 * §6.8 step 3 expands such a column into a value-mapping editor; the counts are what let the user
 * see that "GP" is 40 rows and "Gp." is one typo.
 */
export const SourceValueSchema = z.object({
  value: z.string(),
  count: z.int(),
  /** The option key it currently maps to, if the user has chosen one. */
  mappedTo: z.string().nullable(),
  /** True when the value already matches an existing option without any mapping. */
  matchesExistingOption: z.boolean(),
})

export const ValueMappingSchema = z.object({
  targetId: z.string(),
  values: z.array(SourceValueSchema),
})

export const SheetSummarySchema = z.object({
  name: z.string(),
  rowCount: z.int(),
  columnCount: z.int(),
  /** Which row the header was found on — 3 for a LinkedIn export, 0 for a plain CSV. */
  headerRow: z.int(),
})

/** Why a row is flagged, as the chip renders it. */
export const DuplicateDetailSchema = z.object({
  band: MatchBandSchema,
  confidence: z.number(),
  rules: z.array(z.string()),
  /** "Same email: anna@…", so the user is told the reason and not only the verdict. */
  evidence: z.string(),
  /** "Possible duplicate of Anna Berger". */
  label: z.string(),
  /** Which kind of duplicate, so the wording can differ (ADR-097). */
  kind: z.enum(['record', 'row']),
  recordId: UuidSchema.nullable(),
  rowNumber: z.int().nullable(),
})

export const ImportRowSchema = z.object({
  rowNumber: z.int(),
  /** The source row verbatim, header to cell, so the grid can show what the file said. */
  raw: z.record(z.string(), z.string()),
  /** Target id to canonical value, after any edits. */
  mapped: z.record(z.string(), z.unknown()),
  errors: z.array(
    z.object({
      code: z.string(),
      path: z.array(z.union([z.string(), z.int()])),
      message: z.string(),
    }),
  ),
  duplicate: DuplicateDetailSchema.nullable(),
  decision: ImportDecisionSchema.nullable(),
})

export const ImportCountsSchema = z.object({
  total: z.int(),
  withErrors: z.int(),
  duplicates: z.int(),
  undecidedDuplicates: z.int(),
  /** What the import button says: total minus errors minus rows a decision will skip. */
  willImport: z.int(),
  willSkip: z.int(),
})

export const ImportBatchSchema = z.object({
  id: UuidSchema,
  fileName: z.string(),
  objectType: ObjectTypeSchema,
  source: ImportSourceSchema,
  status: ImportStatusSchema,
  rowCount: z.int(),
  /** Absent for a CSV; the chosen worksheet for a workbook. */
  sheetName: z.string().nullable(),
  sheets: z.array(SheetSummarySchema),
  headerRow: z.int(),
  delimiter: z.string().nullable(),
  columns: z.array(ColumnMappingSchema),
  targets: z.array(MappingTargetSchema),
  valueMappings: z.array(ValueMappingSchema),
  counts: ImportCountsSchema,
  lastCommittedRow: z.int(),
  createdCount: z.int(),
  mergedCount: z.int(),
  skippedCount: z.int(),
  errorDetail: z.unknown().nullable(),
  importedAt: IsoDateTimeSchema,
})

export type ImportBatch = z.output<typeof ImportBatchSchema>
export type ImportRow = z.output<typeof ImportRowSchema>
export type ColumnMappingDto = z.output<typeof ColumnMappingSchema>

/** `GET /import-batches/:id` — the wizard's whole state, plus a page of rows. */
export const ImportBatchDetailSchema = z.object({
  batch: ImportBatchSchema,
  rows: z.array(ImportRowSchema),
})

export type ImportBatchDetail = z.output<typeof ImportBatchDetailSchema>

export const ImportRowsQuerySchema = z.object({
  /** §6.8 step 4's two tabs. */
  onlyErrors: z.stringbool().optional(),
  onlyDuplicates: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * `PATCH /import-batches/:id` — step 3's `Confirm mapping`, and the sheet choice from step 2.
 *
 * Re-mapping re-derives every row from `raw`, which is why the edits a user makes in step 4 are
 * lost by going back to step 3. That is the honest behaviour: the mapping decides what a cell
 * *means*, so an edit to a value under the old mapping has no meaning under the new one.
 */
export const UpdateImportMappingSchema = z.object({
  sheetName: z.string().min(1).optional(),
  source: ImportSourceSchema.optional(),
  headerRow: z.int().min(0).optional(),
  /** Column index to target id; `null` unmaps a column. */
  columns: z.record(z.string(), z.string().nullable()).optional(),
  /** Target id to (source value to option key). */
  valueMap: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Target id to the format its column is read with, overriding what was inferred. */
  dateFormats: z.record(z.string(), DateFormatSchema).optional(),
})

/** `PATCH /import-batches/:id/rows/:rowNumber` — an edit in the Review grid. */
export const UpdateImportRowSchema = z.object({
  /** Target id to the raw text the user typed. Re-coerced and re-validated server-side. */
  values: z.record(z.string(), z.string()).optional(),
  decision: ImportDecisionSchema.nullable().optional(),
})

/** `POST /import-batches/:id/replace` — step 4's `Find & replace`. */
export const ReplaceInImportSchema = z.object({
  targetId: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  caseSensitive: z.boolean().default(false),
})

export const ReplaceResultSchema = z.object({
  changedRows: z.array(z.int()),
  count: z.int(),
})

/**
 * `POST /import-batches/:id/commit` — step 5.
 *
 * `bulkDecision` is §6.8's "a bulk choice for all duplicates is offered". Applied before the job
 * starts, so the job never has to ask.
 */
export const CommitImportSchema = z.object({
  bulkDecision: ImportDecisionSchema.optional(),
  /** ADR-061's resume: restart from `last_committed_row + 1` rather than from the top. */
  resume: z.boolean().default(false),
})

export const CommitImportResultSchema = z.object({
  id: UuidSchema,
  status: ImportStatusSchema,
  /** `null` when a job for this batch was already queued — a double click, not an error. */
  jobId: z.string().nullable(),
})

/** `GET /import-batches/:id/errors` — the downloadable report for skipped rows (§6.8 step 5). */
export const ImportErrorReportSchema = z.object({
  fileName: z.string(),
  /** CSV text: the source columns, plus one column saying why the row did not land. */
  csv: z.string(),
  rowCount: z.int(),
})
