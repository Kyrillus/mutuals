/**
 * An uploaded file to a grid of cells (ADR-054, ADR-096).
 *
 * The only place in the product that knows about XLSX. `read-excel-file` is a Node library and
 * `packages/core` ships to the browser, so the CSV reader lives in core and this adapter produces
 * the same `string[][]` from a workbook — after which nothing downstream can tell which it was.
 *
 * Everything becomes a string. A spreadsheet's own types are not the product's types: a phone
 * number stored as a number has lost its leading zero before this code ever runs, and an attribute
 * type's `coerce` is the one thing that decides what a cell means (ADR-036). Handing it a `Date`
 * for one column and a string for the next would give the registry two paths to test instead of
 * one.
 */
import readXlsxFile from 'read-excel-file/node'
import { parseCsv, type CsvDelimiter } from '@mutuals/core'

import { unsupportedMediaType } from '../errors.ts'

export interface SheetGrid {
  readonly name: string
  readonly rows: readonly (readonly string[])[]
}

export interface ReadFileResult {
  readonly kind: 'csv' | 'xlsx'
  /** One entry for a CSV; one per worksheet for a workbook, in the file's own order. */
  readonly sheets: readonly SheetGrid[]
  /** Only for a CSV, so the wizard can say what it detected. */
  readonly delimiter?: CsvDelimiter
}

const CSV_EXTENSIONS = ['.csv', '.tsv', '.txt']
const XLSX_EXTENSIONS = ['.xlsx', '.xlsm']

/**
 * Chooses a reader from the file name rather than the browser's `Content-Type`.
 *
 * The type a browser reports for a CSV depends on the operating system and on what is installed:
 * macOS with Excel present sends `application/vnd.ms-excel` for a `.csv`, and Windows sometimes
 * sends `application/octet-stream` for both. The extension is what the user chose.
 */
export async function readImportFile(fileName: string, content: Buffer): Promise<ReadFileResult> {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()

  if (CSV_EXTENSIONS.includes(extension)) {
    // `utf8` decoding replaces an invalid byte rather than throwing, which is right: a Latin-1
    // export should import with a mangled character the user can fix in the grid, not fail wholesale.
    const parsed = parseCsv(content.toString('utf8'))
    return {
      kind: 'csv',
      delimiter: parsed.delimiter,
      sheets: [{ name: fileName, rows: parsed.rows }],
    }
  }

  if (XLSX_EXTENSIONS.includes(extension)) {
    // The default export returns *every* worksheet with its name, which is exactly what §6.8's
    // Sheet step needs. `readSheet` is the one that takes a `sheet` option and returns one grid.
    const sheets = await readXlsxFile(content)
    return { kind: 'xlsx', sheets: sheets.map(toGrid) }
  }

  throw unsupportedMediaType(`Mutuals reads .csv and .xlsx files. "${fileName}" is neither.`, [
    ...CSV_EXTENSIONS,
    ...XLSX_EXTENSIONS,
  ])
}

interface RawSheet {
  readonly sheet?: string
  readonly data: readonly (readonly unknown[])[]
}

function toGrid(sheet: RawSheet, index: number): SheetGrid {
  return {
    name: sheet.sheet ?? `Sheet ${String(index + 1)}`,
    rows: sheet.data.map((row) => row.map(toCell)),
  }
}

/**
 * One cell as text.
 *
 * A `Date` is rendered as an ISO day rather than through `toISOString`: the latter is a UTC instant,
 * and a birthday typed into a spreadsheet in Berlin comes back as the previous day for anyone
 * running the import west of Greenwich. `read-excel-file` builds its dates at UTC midnight, so the
 * date parts are the ones the user typed.
 */
function toCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    return [
      String(value.getUTCFullYear()).padStart(4, '0'),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0'),
    ].join('-')
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return value
  // A cell that is none of the above is a shape read-excel-file does not document; rendering it as
  // "[object Object]" would put that string in the grid as if it were data.
  return ''
}
