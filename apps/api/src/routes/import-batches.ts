/**
 * §6.8's import wizard, as nine operations.
 *
 * Eight of the names were reserved in `PLANNED_OPERATIONS` from Stage 1 and move to `OPERATIONS`
 * here. The ninth, `updateImportBatch`, is new: ADR-031's list has an operation for editing one row
 * and none for step 3's `Confirm mapping`, which is the wizard's central act. Adding a name is what
 * the handover warns against, so it is recorded in ADR-098 with the reason — the alternative would
 * have been to overload `updateImportRow`, which is exactly the "second name for one thing"
 * `operations.test.ts` exists to prevent.
 */
import {
  CommitImportResultSchema,
  CommitImportSchema,
  ImportBatchDetailSchema,
  ImportErrorReportSchema,
  ImportRowsQuerySchema,
  ImportSourceSchema,
  ObjectTypeSchema,
  ReplaceInImportSchema,
  ReplaceResultSchema,
  UpdateImportMappingSchema,
  UpdateImportRowSchema,
} from '@mutuals/core'
import {
  getImportBatch,
  setDuplicateDecisions,
  updateImportBatch,
  updateImportRow,
} from '@mutuals/db'
import { z } from 'zod'

import { conflict, notFound, payloadTooLarge, validationFailed } from '../errors.ts'
import { created201, ok200WithNotFound } from '../http/schema.ts'
import { csvOf, errorReportCsv } from '../import/export.ts'
import {
  editRow,
  loadBatchDetail,
  remapBatch,
  replaceInBatch,
  revertRow,
  stageUpload,
} from '../import/service.ts'
import { routePlugin } from './shared.ts'

/**
 * The upload cap. §6.8 promises 10k rows, not an arbitrary file.
 *
 * 32 MB is comfortably above a 10k-row export of either shape — the LinkedIn fixture is 4 KB for 31
 * rows, so 10k rows is about 1.3 MB, and an XLSX of the same is smaller still because it is zipped.
 * It is well under what would make the process's memory a question.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

const BatchParamsSchema = z.object({ id: z.uuid() })
const RowParamsSchema = z.object({ id: z.uuid(), rowNumber: z.coerce.number().int().min(1) })

export const importBatchRoutes = routePlugin((app, ctx) => {
  /**
   * Step 1 and 2. `multipart/form-data`, streamed, with the file last so the text fields are
   * already parsed when the bytes arrive.
   *
   * Not JSON with a base64 body: that inflates by a third and holds two copies in memory, and
   * ERRORS.md has said `multipart/form-data` since Stage 1.
   */
  app.post(
    '/import-batches',
    {
      schema: {
        operationId: 'createImportBatch',
        tags: ['imports'],
        summary: 'Upload a CSV or XLSX, auto-map its columns and stage its rows',
        description:
          'Multipart fields: `file` (required), `objectType`, `source`, and `sheetName` for a ' +
          'workbook. Returns the whole wizard state, so step 3 renders with real numbers.',
        consumes: ['multipart/form-data'],
        response: created201(ImportBatchDetailSchema),
      },
    },
    async (request, reply) => {
      const upload = await readUpload(request.parts())
      const batchId = await stageUpload(ctx, upload)
      const detail = await loadBatchDetail(ctx, batchId, { limit: 100, offset: 0 })
      return reply.status(201).send(detail)
    },
  )

  app.get(
    '/import-batches/:id',
    {
      schema: {
        operationId: 'getImportBatch',
        tags: ['imports'],
        summary: "The wizard's state and a page of its rows",
        params: BatchParamsSchema,
        querystring: ImportRowsQuerySchema,
        response: ok200WithNotFound(ImportBatchDetailSchema),
      },
    },
    async (request) => {
      const query = request.query
      return loadBatchDetail(ctx, request.params.id, {
        ...(query.onlyErrors === undefined ? {} : { onlyErrors: query.onlyErrors }),
        ...(query.onlyDuplicates === undefined ? {} : { onlyDuplicates: query.onlyDuplicates }),
        limit: query.limit,
        offset: query.offset,
      })
    },
  )

  /**
   * Step 3's `Confirm mapping`, and step 2's sheet choice for a CSV's header row.
   *
   * Every change re-derives every row, because the mapping decides what a cell *means* — so an edit
   * made under the old mapping has no meaning under the new one. The response says so by simply
   * being the new state.
   */
  app.patch(
    '/import-batches/:id',
    {
      schema: {
        operationId: 'updateImportBatch',
        tags: ['imports'],
        summary: 'Change the mapping, the value map or a date format, and re-derive every row',
        params: BatchParamsSchema,
        body: UpdateImportMappingSchema,
        response: ok200WithNotFound(ImportBatchDetailSchema),
      },
    },
    async (request) => {
      const body = request.body
      if (body.sheetName !== undefined) {
        // Changing the worksheet needs the file again, and the server does not keep it (ADR-054
        // stages rows, not uploads). The browser still holds the file it just picked, so it
        // re-posts; saying so is better than a 500 three functions deeper.
        throw conflict(
          'Changing the worksheet needs the file again. Upload it once more with this sheet selected.',
        )
      }

      await remapBatch(ctx, request.params.id, {
        ...(body.source === undefined ? {} : { source: body.source }),
        ...(body.headerRow === undefined ? {} : { headerRow: body.headerRow }),
        ...(body.columns === undefined ? {} : { columns: body.columns }),
        ...(body.valueMap === undefined ? {} : { valueMap: body.valueMap }),
        ...(body.dateFormats === undefined ? {} : { dateFormats: body.dateFormats }),
      })
      return loadBatchDetail(ctx, request.params.id, { limit: 100, offset: 0 })
    },
  )

  app.patch(
    '/import-batches/:id/rows/:rowNumber',
    {
      schema: {
        operationId: 'updateImportRow',
        tags: ['imports'],
        summary: 'Fix a cell in the Review grid, or decide what to do with a flagged duplicate',
        params: RowParamsSchema,
        body: UpdateImportRowSchema,
        response: ok200WithNotFound(ImportBatchDetailSchema),
      },
    },
    async (request) => {
      const { id, rowNumber } = request.params
      const body = request.body

      if (body.values !== undefined) await editRow(ctx, id, rowNumber, body.values)
      if (body.decision !== undefined) {
        const written = await updateImportRow(ctx.db, id, rowNumber, { decision: body.decision })
        if (!written) throw notFound('import row', String(rowNumber))
      }
      return pageAround(ctx, id, rowNumber)
    },
  )

  app.post(
    '/import-batches/:id/rows/:rowNumber/revert',
    {
      schema: {
        operationId: 'revertImportRow',
        tags: ['imports'],
        summary: 'Throw away this row’s edits and read the file’s own values again',
        params: RowParamsSchema,
        response: ok200WithNotFound(ImportBatchDetailSchema),
      },
    },
    async (request) => {
      const { id, rowNumber } = request.params
      await revertRow(ctx, id, rowNumber)
      return pageAround(ctx, id, rowNumber)
    },
  )

  app.post(
    '/import-batches/:id/replace',
    {
      schema: {
        operationId: 'replaceInImportBatch',
        tags: ['imports'],
        summary: 'Find and replace across one mapped column',
        params: BatchParamsSchema,
        body: ReplaceInImportSchema,
        response: ok200WithNotFound(ReplaceResultSchema),
      },
    },
    async (request) => {
      const { id } = request.params
      if ((await getImportBatch(ctx.db, id)) === undefined) throw notFound('import batch', id)

      const changed = await replaceInBatch(ctx, id, request.body)
      return { changedRows: [...changed], count: changed.length }
    },
  )

  /**
   * Step 4's export.
   *
   * CSV rather than the `.xlsx` §6.8's toolbar names. The export exists so a person can fix data in
   * a spreadsheet and bring it back, and a CSV opens in Excel and re-imports through this same
   * wizard without two more format conversions. It also costs no runtime dependency: ADR-096 keeps
   * the XLSX *writer* as a root devDependency for generating a fixture, and adding it to the API to
   * produce a file the user will immediately re-save is not a good trade. Recorded in ADR-098.
   */
  app.get(
    '/import-batches/:id/export',
    {
      schema: {
        operationId: 'exportImportBatch',
        tags: ['imports'],
        summary: 'The staged rows as CSV, so they can be fixed in a spreadsheet and re-imported',
        params: BatchParamsSchema,
        response: ok200WithNotFound(ImportErrorReportSchema),
      },
    },
    async (request) => {
      const detail = await loadBatchDetail(ctx, request.params.id, { limit: 100_000, offset: 0 })
      return {
        fileName: exportName(detail.batch.fileName, 'rows'),
        csv: csvOf(detail.batch.columns, detail.rows),
        rowCount: detail.rows.length,
      }
    },
  )

  app.get(
    '/import-batches/:id/errors',
    {
      schema: {
        operationId: 'getImportErrorReport',
        tags: ['imports'],
        summary: 'The rows that did not land, and why — §6.8 step 5’s downloadable report',
        params: BatchParamsSchema,
        response: ok200WithNotFound(ImportErrorReportSchema),
      },
    },
    async (request) => {
      const detail = await loadBatchDetail(ctx, request.params.id, {
        limit: 100_000,
        offset: 0,
      })
      const csv = errorReportCsv(detail.batch.columns, detail.rows)
      return {
        fileName: exportName(detail.batch.fileName, 'not-imported'),
        csv,
        rowCount: detail.rows.filter((row) => row.errors.length > 0 || row.duplicate !== null)
          .length,
      }
    },
  )

  app.post(
    '/import-batches/:id/commit',
    {
      schema: {
        operationId: 'commitImportBatch',
        tags: ['imports'],
        summary: 'Start the import. Runs as a background job so the request returns at once.',
        params: BatchParamsSchema,
        body: CommitImportSchema,
        response: ok200WithNotFound(CommitImportResultSchema),
      },
    },
    async (request) => {
      const { id } = request.params
      const batch = await getImportBatch(ctx.db, id)
      if (batch === undefined) throw notFound('import batch', id)

      if (batch.status === 'importing') {
        throw conflict('This import is already running.')
      }
      if (batch.status === 'completed') {
        throw conflict('This import has already run. Upload the file again to import it twice.')
      }
      if (request.body.resume && batch.status !== 'failed') {
        throw conflict('Only a failed import can be resumed.')
      }

      if (request.body.bulkDecision !== undefined) {
        await setDuplicateDecisions(ctx.db, id, request.body.bulkDecision)
      }

      if (ctx.jobs === undefined) {
        throw conflict(
          'No worker is running, so nothing can import. Start the API with the worker on.',
        )
      }

      /**
       * The status change and the enqueue commit together (ADR-058's `db` option, tested in
       * `pg-boss.db.test.ts`). Without that, a crash between them leaves a batch that says it is
       * importing and no job that will ever import it — and the wizard polls that status forever.
       */
      const jobs = ctx.jobs
      const jobId = await ctx.db.transaction().execute(async (trx) => {
        await updateImportBatch(trx, id, { status: 'importing', errorDetail: null })
        return jobs.send(
          'import.run',
          {
            batchId: id,
            ...(request.body.resume ? { resumeFrom: batch.lastCommittedRow + 1 } : {}),
          },
          // The batch id as the key, so a double click cannot start two importers for one file
          // while a different file still imports concurrently.
          { executor: trx, singletonKey: id },
        )
      })

      return { id, status: 'importing' as const, jobId }
    },
  )

  /** The page of rows containing `rowNumber`, so an edit returns the grid the user is looking at. */
  async function pageAround(context: typeof ctx, id: string, rowNumber: number) {
    const pageSize = 100
    const offset = Math.floor((rowNumber - 1) / pageSize) * pageSize
    return loadBatchDetail(context, id, { limit: pageSize, offset })
  }

  /** The shape of a part, as `@fastify/multipart` yields it. Narrowed to what this route reads. */
  interface MultipartPart {
    readonly type: string
    readonly fieldname: string
    readonly filename?: string
    readonly value?: unknown
    readonly toBuffer?: () => Promise<Buffer>
  }

  interface Upload {
    readonly fileName: string
    readonly objectType: z.output<typeof ObjectTypeSchema>
    readonly source: z.output<typeof ImportSourceSchema>
    readonly sheetName?: string
    readonly content: Buffer
  }

  /**
   * Reads the multipart body.
   *
   * Fastify's multipart iterator yields parts in the order the client sent them, and a file part's
   * stream has to be consumed before the next part arrives — so the fields are collected as they
   * come and validated at the end rather than assumed to precede the file.
   */
  async function readUpload(parts: AsyncIterableIterator<MultipartPart>): Promise<Upload> {
    const fields: Record<string, string> = {}
    let fileName: string | undefined
    let content: Buffer | undefined

    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.toBuffer === undefined) continue
        fileName = part.filename ?? 'upload.csv'
        content = await part.toBuffer()
        if (content.byteLength > MAX_UPLOAD_BYTES) {
          throw payloadTooLarge(
            `That file is ${describeBytes(content.byteLength)}. The limit is ${describeBytes(MAX_UPLOAD_BYTES)}.`,
          )
        }
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value
      }
    }

    if (content === undefined || fileName === undefined) {
      throw validationFailed([
        { code: 'required', path: ['file'], message: 'Choose a file to import.' },
      ])
    }

    const objectType = ObjectTypeSchema.safeParse(fields['objectType'] ?? 'contact')
    const source = ImportSourceSchema.safeParse(fields['source'] ?? 'generic')
    if (!objectType.success || !source.success) {
      throw validationFailed([
        {
          code: 'invalid_input',
          path: [objectType.success ? 'source' : 'objectType'],
          message: 'That is not something Mutuals can import.',
        },
      ])
    }

    const sheetName = fields['sheetName']
    return {
      fileName,
      objectType: objectType.data,
      source: source.data,
      content,
      ...(sheetName === undefined || sheetName === '' ? {} : { sheetName }),
    }
  }
})

function describeBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** `linkedin_connections_sample.csv` plus a suffix, keeping the stem the user recognises. */
function exportName(fileName: string, suffix: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot === -1 ? fileName : fileName.slice(0, dot)
  return `${stem}-${suffix}.csv`
}
