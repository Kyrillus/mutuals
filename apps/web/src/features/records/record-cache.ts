/**
 * The two cache edits an optimistic write needs, as pure functions.
 *
 * ADR-049's first defect was that the rollback restored only half the cache: the patch touched
 * both the list pages and the detail entry, but the snapshot captured only the lists, so a failed
 * write left the sidebar showing a value the table had already reverted. Keeping the edit itself
 * pure is what makes the symmetric snapshot-and-restore easy to write and easy to test.
 */
import type { AttributeValue } from '@mutuals/core'
import type { InfiniteData } from '@tanstack/react-query'

import type { RecordRow } from '@/table/record-row.ts'

import type { RecordListPage } from './record-api.ts'

export type RecordListData = InfiniteData<RecordListPage, string | null>

/** ADR-031: an empty attribute is an **absent key**, so clearing deletes rather than writes null. */
export function withAttribute(
  row: RecordRow,
  slug: string,
  value: AttributeValue | undefined,
): RecordRow {
  const attributes = { ...row.attributes }
  if (value === undefined) delete attributes[slug]
  else attributes[slug] = value
  return { ...row, attributes }
}

export function patchRowInPages(
  data: RecordListData | undefined,
  id: string,
  patch: (row: RecordRow) => RecordRow,
): RecordListData | undefined {
  if (data === undefined) return data
  let touched = false
  const pages = data.pages.map((page) => {
    if (!page.data.some((row) => row.id === id)) return page
    touched = true
    return { ...page, data: page.data.map((row) => (row.id === id ? patch(row) : row)) }
  })
  // Returning the same object when nothing changed keeps React Query from waking every observer
  // of every other page of every other filter.
  return touched ? { ...data, pages } : data
}

export function patchRecord(
  record: RecordRow | undefined,
  id: string,
  patch: (row: RecordRow) => RecordRow,
): RecordRow | undefined {
  return record === undefined || record.id !== id ? record : patch(record)
}

export function cellKey(recordId: string, slug: string): string {
  return `${recordId}:${slug}`
}
