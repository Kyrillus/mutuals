/**
 * §6.8 step 4's `Export` and step 5's error report, as CSV.
 *
 * Both write the *source* columns rather than the mapped targets, so the file that comes out is the
 * file that went in and can go straight back through the wizard. Exporting the mapped values would
 * produce a file whose headers are internal slugs, which re-imports into a mapping the user never
 * chose.
 */
import type { ColumnMappingDto, ImportRow } from '@mutuals/core'

/** Quotes a field only when it needs it, which keeps a plain export diffable. */
function cell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function toCsv(rows: readonly (readonly string[])[]): string {
  // CRLF, because that is what RFC 4180 says and what Excel expects; the reader handles either.
  return rows.map((row) => row.map(cell).join(',')).join('\r\n')
}

export function csvOf(columns: readonly ColumnMappingDto[], rows: readonly ImportRow[]): string {
  const headers = columns.map((column) => column.header)
  return toCsv([headers, ...rows.map((row) => headers.map((header) => row.raw[header] ?? ''))])
}

/**
 * The rows that did not land, with a column saying why.
 *
 * The reason is the whole value of this file: §6.8 promises "a downloadable error report for
 * skipped rows", and a list of rows with no explanation is a list the user has to diff by hand
 * against the original. A row can be skipped for two quite different reasons — it failed validation,
 * or it was a duplicate they chose not to import — and the wording distinguishes them.
 */
export function errorReportCsv(
  columns: readonly ColumnMappingDto[],
  rows: readonly ImportRow[],
): string {
  const headers = columns.map((column) => column.header)
  const skipped = rows.filter((row) => reasonFor(row) !== null)
  return toCsv([
    [...headers, 'Why it was not imported'],
    ...skipped.map((row) => [
      ...headers.map((header) => row.raw[header] ?? ''),
      reasonFor(row) ?? '',
    ]),
  ])
}

/** `null` for a row that landed. */
function reasonFor(row: ImportRow): string | null {
  if (row.errors.length > 0) {
    return row.errors.map((error) => error.message).join(' ')
  }
  if (row.duplicate !== null && row.decision !== 'create' && row.decision !== 'merge') {
    return row.duplicate.kind === 'row'
      ? `This file lists this person more than once — ${row.duplicate.evidence.toLowerCase()}.`
      : `You already have this contact — ${row.duplicate.evidence.toLowerCase()}.`
  }
  return null
}
