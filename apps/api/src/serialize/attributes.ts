/**
 * `attribute_value` rows and `record_link` rows in, ADR-031's `attributes` map out.
 *
 * The switch here is over `AttributeType`, which is *derived* from the registry (ADR-036), so a
 * thirteenth type is a compile error in this file rather than a value that silently serialises as
 * nothing. That is the difference between a switch over types and the hard-coded column CLAUDE.md
 * forbids: no slug is named, no physical column is named, and the arms are exhaustive by proof —
 * `assertNever` is the proof.
 *
 * An attribute with no live value produces **no key** (ADR-017). `null`, `''` and an absent key
 * would be three spellings of "empty" and a client would have to handle all three.
 */
import {
  assertNever,
  decimal,
  type AttributeDefinition,
  type AttributeValue,
  type Attributes,
  type OptionRef,
  type RelationValue,
} from '@mutuals/core'
import type { HydratedRecord, RecordRelation, RecordValue } from '@mutuals/db'

import type { Schema } from '../context.ts'

function unitOf(definition: AttributeDefinition): string | undefined {
  const config: unknown = definition.config
  if (typeof config !== 'object' || config === null) return undefined
  const unit: unknown = (config as { unit?: unknown }).unit
  return typeof unit === 'string' && unit !== '' ? unit : undefined
}

function optionRef(definition: AttributeDefinition, value: RecordValue): OptionRef | null {
  const key = value.optionKey
  if (key === null) return null
  const declared = definition.options?.find((option) => option.id === value.optionId)
  return {
    key,
    label: declared?.label ?? value.optionLabel ?? key,
    color: declared?.color ?? null,
  }
}

function relationValue(link: RecordRelation): RelationValue {
  return {
    id: link.toRecordId,
    label: link.toLabel,
    objectType: link.toObjectType,
    title: link.title,
    from: link.from,
    to: link.to,
    isPrimary: link.isPrimary,
  }
}

/**
 * One attribute's value set, in the wire shape its type declares. Returns `null` where the type
 * has nothing to say — a text attribute whose only row somehow carries no text, which the
 * `av_slot` CHECK makes unreachable, but which would otherwise serialise as `undefined`.
 */
function valueOf(
  definition: AttributeDefinition,
  values: readonly RecordValue[],
  links: readonly RecordRelation[],
): AttributeValue | null {
  const type = definition.type
  switch (type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone': {
      const text = values[0]?.text
      return text == null ? null : { type, value: text }
    }
    case 'tags': {
      const texts = values.flatMap((value) => (value.text === null ? [] : [value.text]))
      return texts.length === 0 ? null : { type, value: texts }
    }
    case 'number': {
      const num = values[0]?.num
      if (num == null) return null
      const unit = unitOf(definition)
      return unit === undefined
        ? { type, value: decimal(num) }
        : { type, value: decimal(num), unit }
    }
    case 'date': {
      const date = values[0]?.date
      return date == null ? null : { type, value: date }
    }
    case 'yes_no': {
      const bool = values[0]?.bool
      return bool == null ? null : { type, value: bool }
    }
    case 'single_select': {
      const first = values[0]
      if (first === undefined) return null
      const option = optionRef(definition, first)
      return option === null ? null : { type, value: option }
    }
    case 'multi_select': {
      const options = values.flatMap((value) => optionRef(definition, value) ?? [])
      return options.length === 0 ? null : { type, value: options }
    }
    case 'relation': {
      return links.length === 0 ? null : { type, value: links.map(relationValue) }
    }
    default:
      return assertNever(type, 'attribute type')
  }
}

/** Groups a record's rows by attribute and renders each through its own type. */
export function serializeAttributes(record: HydratedRecord, schema: Schema): Attributes {
  const valuesByAttribute = new Map<string, RecordValue[]>()
  for (const value of record.values) {
    const list = valuesByAttribute.get(value.attributeId) ?? []
    list.push(value)
    valuesByAttribute.set(value.attributeId, list)
  }

  const linksByAttribute = new Map<string, RecordRelation[]>()
  for (const link of record.links) {
    const list = linksByAttribute.get(link.attributeId) ?? []
    list.push(link)
    linksByAttribute.set(link.attributeId, list)
  }

  const attributes: Record<string, AttributeValue> = {}
  for (const definition of schema.definitions) {
    const rendered = valueOf(
      definition,
      valuesByAttribute.get(definition.id) ?? [],
      linksByAttribute.get(definition.id) ?? [],
    )
    if (rendered !== null) attributes[definition.slug] = rendered
  }
  return attributes
}
