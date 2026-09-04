/**
 * Reading one cell out of one row.
 *
 * A field is either an attribute — its value lives under `attributes[slug]` and carries its own
 * type — or a system/derived column, whose value is a bare JSON scalar described by the
 * `valueKind` `SYSTEM_FIELDS` declares. Those two shapes are the whole reason cells need a
 * lookup rather than an accessor key, and this file is where the branch lives.
 */
import type { FieldDescriptor } from '@mutuals/core'
import { fieldValueKind } from '@mutuals/core'

import { systemValue, type RecordRow } from './record-row.ts'
import { attributeText, systemText } from './value-text.ts'

/** What the accessor hands TanStack: only used for identity and sorting hints, never for display. */
export function cellValue(row: RecordRow, field: FieldDescriptor): unknown {
  return field.source.kind === 'attribute'
    ? row.attributes[field.slug]
    : systemValue(row, field.slug)
}

/** The cell as text: CSV, the `title` of a truncated cell, the value a test asserts on. */
export function cellText(row: RecordRow, field: FieldDescriptor): string {
  if (field.source.kind === 'attribute') {
    const value = row.attributes[field.slug]
    return value === undefined ? '' : attributeText(value)
  }
  return systemText(systemValue(row, field.slug), fieldValueKind(field))
}
