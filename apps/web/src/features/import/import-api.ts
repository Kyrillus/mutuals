/**
 * The nine import operations, from the browser.
 *
 * Every call parses its response through the contract schema the API implements (ADR-030), so a
 * shape that drifted is a throw here rather than `undefined` three components deep.
 *
 * The upload is the one call that does not go through `lib/api.ts`: that wrapper JSON-encodes its
 * body, and §6.8's upload is `multipart/form-data`. It is a `fetch` with the same error handling
 * rather than a second client.
 */
import {
  ImportBatchDetailSchema,
  ImportErrorReportSchema,
  ProblemSchema,
  ReplaceResultSchema,
  CommitImportResultSchema,
  type ImportBatchDetail,
  type ImportSource,
  type ObjectType,
} from '@mutuals/core'

import { API_BASE, ApiError, api } from '@/lib/api.ts'

export type { ImportBatchDetail }

export interface UploadInput {
  readonly file: File
  readonly objectType: ObjectType
  readonly source: ImportSource
  /** Only for a workbook, and only once the user has picked a different sheet. */
  readonly sheetName?: string
}

/**
 * Step 1 and 2.
 *
 * The `File` is sent again when the sheet changes, because the server stages rows rather than
 * keeping the upload (ADR-054) — and the browser still holds the file it just picked, so re-posting
 * costs nothing and means no upload sits on the server waiting to be abandoned.
 */
export async function uploadImport(input: UploadInput): Promise<ImportBatchDetail> {
  const form = new FormData()
  form.set('objectType', input.objectType)
  form.set('source', input.source)
  if (input.sheetName !== undefined) form.set('sheetName', input.sheetName)
  // Last, so the text fields are parsed before the bytes arrive.
  form.set('file', input.file, input.file.name)

  const response = await fetch(`${API_BASE}/import-batches`, { method: 'POST', body: form })
  const text = await response.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const problem = ProblemSchema.safeParse(body)
    throw new ApiError(
      response.status,
      problem.success ? problem.data.detail : `${String(response.status)} ${response.statusText}`,
      problem.success ? problem.data : null,
    )
  }
  return ImportBatchDetailSchema.parse(body)
}

export interface RowsQuery {
  readonly onlyErrors?: boolean
  readonly onlyDuplicates?: boolean
  readonly limit?: number
  readonly offset?: number
}

export function getImportBatch(
  id: string,
  query: RowsQuery = {},
  signal?: AbortSignal,
): Promise<ImportBatchDetail> {
  return api.get(ImportBatchDetailSchema, `/import-batches/${id}`, {
    search: {
      ...(query.onlyErrors === true ? { onlyErrors: 'true' } : {}),
      ...(query.onlyDuplicates === true ? { onlyDuplicates: 'true' } : {}),
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    },
    ...(signal === undefined ? {} : { signal }),
  })
}

export interface MappingPatch {
  /** Column index as a string, to a target id — or `null` to unmap it. */
  readonly columns?: Readonly<Record<string, string | null>>
  readonly source?: ImportSource
  readonly valueMap?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly dateFormats?: Readonly<Record<string, string>>
}

export function updateImportMapping(id: string, patch: MappingPatch): Promise<ImportBatchDetail> {
  return api.patch(ImportBatchDetailSchema, `/import-batches/${id}`, patch)
}

export function updateImportRow(
  id: string,
  rowNumber: number,
  patch: { values?: Readonly<Record<string, string>>; decision?: string | null },
): Promise<ImportBatchDetail> {
  return api.patch(
    ImportBatchDetailSchema,
    `/import-batches/${id}/rows/${String(rowNumber)}`,
    patch,
  )
}

export function revertImportRow(id: string, rowNumber: number): Promise<ImportBatchDetail> {
  return api.post(
    ImportBatchDetailSchema,
    `/import-batches/${id}/rows/${String(rowNumber)}/revert`,
    {},
  )
}

export function replaceInImport(
  id: string,
  input: { targetId: string; find: string; replace: string; caseSensitive?: boolean },
) {
  return api.post(ReplaceResultSchema, `/import-batches/${id}/replace`, input)
}

export function commitImport(id: string, input: { bulkDecision?: string; resume?: boolean } = {}) {
  return api.post(CommitImportResultSchema, `/import-batches/${id}/commit`, input)
}

export function getImportErrorReport(id: string) {
  return api.get(ImportErrorReportSchema, `/import-batches/${id}/errors`)
}

export function exportImportBatch(id: string) {
  return api.get(ImportErrorReportSchema, `/import-batches/${id}/export`)
}

/**
 * Hands the browser a file it never downloaded from anywhere.
 *
 * The CSV arrives as a string in a JSON response rather than as a file download, because it is the
 * same request shape as everything else and needs no second auth story. A Blob URL is what turns it
 * back into something a person can save.
 */
export function downloadCsv(fileName: string, csv: string): void {
  // A BOM, so Excel opens a UTF-8 CSV as UTF-8. Without it "Håkansson" arrives mangled, which for a
  // file whose whole purpose is fixing data would be a cruel joke.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
