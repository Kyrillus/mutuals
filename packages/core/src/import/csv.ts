/**
 * An RFC 4180 reader, plus the delimiter sniffing ADR-054 moved to the server.
 *
 * Pure text in, rows out: no streams, no file handles, nothing from Node. That is what lets it live
 * in `packages/core` beside the mapper that consumes it, so the API, a future CLI and an MCP
 * adapter read a CSV the same way instead of three ways. The XLSX reader cannot be here — exceljs
 * is a Node library (ADR-096) — so it lives in `apps/api` and produces the same `string[][]`.
 *
 * ADR-054 dropped the 64 KB client-side preview, which means this is the only parser in the
 * product and it has to be right about the awkward cases rather than fast on the easy ones:
 * quoted fields containing the delimiter, doubled quotes, and newlines inside a quoted field —
 * which the LinkedIn fixture has, in a job title.
 */

/** Ordered by how likely a European export is to use them. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number]

const QUOTE = '"'
const BOM = '﻿'

export interface CsvParseResult {
  readonly rows: readonly (readonly string[])[]
  readonly delimiter: CsvDelimiter
}

/**
 * Splits text into rows and cells.
 *
 * A trailing newline does not produce a final empty row, but a genuinely empty line in the middle
 * of a file does produce a one-cell row — callers decide what that means, because in a LinkedIn
 * export it is preamble and in a hand-edited CSV it is a mistake.
 */
export function parseCsvRows(text: string, delimiter: CsvDelimiter): readonly string[][] {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string

    if (quoted) {
      if (char !== QUOTE) {
        field += char
        continue
      }
      // A doubled quote is one literal quote; a single one ends the quoted run.
      if (source[i + 1] === QUOTE) {
        field += QUOTE
        i++
      } else {
        quoted = false
      }
      continue
    }

    if (char === QUOTE && field === '') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      // A CRLF is one line break, not two.
      if (char === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }

  // Whatever is buffered when the text runs out is a final row, unless the text ended on a break.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Which delimiter the file uses.
 *
 * Scored by how *consistent* the row widths are rather than by how many separators appear: a
 * semicolon-delimited file full of English prose contains more commas than semicolons, and counting
 * would pick the comma every time. A delimiter that yields one wide, stable shape wins; one that
 * yields a different width on every line loses however often it occurs.
 */
export function detectDelimiter(text: string, sampleLines = 20): CsvDelimiter {
  const sample = firstLines(text, sampleLines)
  let winner: CsvDelimiter = ','
  let bestScore = -1

  for (const delimiter of CSV_DELIMITERS) {
    const rows = parseCsvRows(sample, delimiter).filter((row) => row.length > 0)
    if (rows.length === 0) continue

    const counts = new Map<number, number>()
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1)

    let modalWidth = 1
    let modalCount = 0
    for (const [width, count] of counts) {
      if (count > modalCount || (count === modalCount && width > modalWidth)) {
        modalWidth = width
        modalCount = count
      }
    }
    if (modalWidth < 2) continue

    // Consistency first, then width: two columns on every line beats nine on one line and two on
    // the rest. The width term breaks ties between delimiters that are equally consistent.
    const score = (modalCount / rows.length) * 100 + modalWidth
    if (score > bestScore) {
      bestScore = score
      winner = delimiter
    }
  }
  return winner
}

/** Sniffs the delimiter and parses in one step. */
export function parseCsv(text: string): CsvParseResult {
  const delimiter = detectDelimiter(text)
  return { rows: parseCsvRows(text, delimiter), delimiter }
}

/**
 * The first `count` line breaks worth of text, respecting quotes.
 *
 * Cutting on the nth `\n` would slice through a quoted field containing a newline and leave an
 * unterminated quote, which makes every subsequent delimiter look wrong.
 */
function firstLines(text: string, count: number): string {
  let quoted = false
  let lines = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === QUOTE) quoted = !quoted
    else if (char === '\n' && !quoted && ++lines >= count) return text.slice(0, i)
  }
  return text
}
