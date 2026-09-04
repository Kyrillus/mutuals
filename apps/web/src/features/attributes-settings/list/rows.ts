/**
 * One attribute definition, as a row of the table that lists them.
 *
 * The DataTable reads `RecordRow`, so this is the adapter — and it is the whole adapter. Every
 * value carries its own type tag, exactly as a record's attributes do on the wire, which is what
 * lets the cell registry, the CSV export and the filter evaluator treat this page like any other.
 *
 * ADR-017's rule holds here too: an empty value is an **absent key**, never `null` and never `''`.
 * That is what makes "Group is empty" mean ungrouped, in one place, for both the filter and the
 * cell.
 */
import { civilIn, decimal, type AttributeDefinitionDto, type Attributes } from '@mutuals/core'

import type { RecordRow } from '../../../table/record-row.ts'

import { typeLabel } from '../editor/type-meta.ts'

/**
 * `created_at` and `updated_at` arrive as instants and are shown as the calendar day they fell on
 * where the user is (ADR-045). The day is what the column means — §6.7 asks for Created, not for
 * Created at 20:30 — and it is also what `date`'s filter operators are written against.
 */
export function attributeRow(dto: AttributeDefinitionDto, timeZone: string): RecordRow {
  const attributes: Attributes = {
    title: { type: 'short_text', value: dto.title },
    slug: { type: 'short_text', value: dto.slug },
    type: {
      type: 'single_select',
      value: { key: dto.type, label: typeLabel(dto.type), color: null },
    },
    ...(dto.group === null || dto.group === ''
      ? {}
      : { group: { type: 'short_text', value: dto.group } }),
    used_in: { type: 'number', value: decimal(String(dto.recordCount)) },
    created_at: { type: 'date', value: civilIn(timeZone, new Date(dto.createdAt)) },
    updated_at: { type: 'date', value: civilIn(timeZone, new Date(dto.updatedAt)) },
  }

  return {
    id: dto.id,
    objectType: dto.objectType,
    displayName: dto.title,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    attributes,
  }
}

export function attributeRows(
  definitions: readonly AttributeDefinitionDto[],
  timeZone: string,
): readonly RecordRow[] {
  return definitions.map((definition) => attributeRow(definition, timeZone))
}
