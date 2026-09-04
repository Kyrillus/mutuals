/**
 * §5.2's "export selection as CSV".
 *
 * The columns exported are the columns on screen, in the order they are on screen: an export is a
 * copy of what the user is looking at, not a second, differently-shaped report they then have to
 * reconcile with it.
 */
import type { FieldDescriptor } from '@mutuals/core'

import { cellText } from './cell-value.ts'
import type { RecordRow } from './record-row.ts'

/**
 * RFC 4180 quoting, with two additions.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab: a spreadsheet reads those as the start of
 * a formula, so a contact named `-Ana` becomes a live cell in Excel. And the file is written with
 * CRLF and a BOM by {@link toCsvBlob}, because Excel decides the encoding from the BOM alone.
 */
function quote(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value
  return /["\n\r,]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

export function recordsToCsv(
  rows: readonly RecordRow[],
  fields: readonly FieldDescriptor[],
): string {
  const header = fields.map((field) => quote(field.label)).join(',')
  const body = rows.map((row) => fields.map((field) => quote(cellText(row, field))).join(','))
  return [header, ...body].join('\r\n')
}

export function toCsvBlob(csv: string): Blob {
  return new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
}

/** A filename a person can find again: the object type and the day, never a uuid. */
export function csvFileName(objectType: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  return `${objectType}s-${day}.csv`
}

export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(toCsvBlob(csv))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  // Revoking synchronously races the click on Safari; a task boundary is enough and the object
  // is a few hundred kilobytes at most.
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}
