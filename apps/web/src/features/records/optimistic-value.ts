/**
 * From the draft an editor produced to the value a cell renders, without waiting for the server.
 *
 * `@/attributes` owns both ends of this already — `toDraft` turns a read value into what a control
 * edits, `toWriteValue` turns a draft into the API payload — but optimism needs the third edge:
 * draft back to the *read* value, so the cell repaints before the round trip. A select edits an
 * option key and renders a coloured chip, so the projection has to look the option up.
 *
 * The switch is over `AttributeType`, which means a thirteenth type is a compile error here rather
 * than a cell that goes blank for the half second before the response lands.
 */
import {
  activeOptions,
  assertNever,
  findOptionByKey,
  isDecimalString,
  type AttributeDefinitionDto,
  type AttributeOption,
  type AttributeValue,
  type OptionRef,
  type RelationValue,
} from '@mutuals/core'

import {
  attributeTypeOf,
  coreOptions,
  draftFromWriteValue,
  isEmptyDraft,
  numberDisplayOf,
  type AttributeDraft,
} from '@/attributes/value.ts'

/** Every text-shaped draft is a string by construction; the guard is what proves it to the linter. */
function asText(draft: AttributeDraft | undefined): string {
  return typeof draft === 'string' ? draft : ''
}

function optionRef(option: AttributeOption): OptionRef {
  return { key: option.key, label: option.label, color: option.color ?? null }
}

/** An option the picker offered but this build has not cached: shown by its key until the refetch. */
function refFor(options: readonly AttributeOption[], key: string): OptionRef {
  const option = findOptionByKey(activeOptions(options), key)
  return option === undefined ? { key, label: key, color: null } : optionRef(option)
}

/** `undefined` means "the attribute is now empty" — ADR-031's absent key, not `null` and not `''`. */
export function optimisticValue(
  definition: AttributeDefinitionDto,
  write: unknown,
): AttributeValue | undefined {
  const type = attributeTypeOf(definition)
  const draft = draftFromWriteValue(definition, write)
  if (isEmptyDraft(type, draft)) return undefined

  switch (type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
    case 'date':
      return { type, value: asText(draft) }
    case 'number': {
      const text = asText(draft)
      // A malformed number is the server's to reject. Painting nothing for the one round trip is
      // better than painting a value that will not survive it.
      if (!isDecimalString(text)) return undefined
      const unit = numberDisplayOf(definition).unit
      return unit === undefined || unit === '' ? { type, value: text } : { type, value: text, unit }
    }
    case 'yes_no':
      return { type, value: draft === true }
    case 'single_select':
      return { type, value: refFor(coreOptions(definition), asText(draft)) }
    case 'multi_select': {
      const options = coreOptions(definition)
      return { type, value: (draft as readonly string[]).map((key) => refFor(options, key)) }
    }
    case 'tags':
      return { type, value: [...(draft as readonly string[])] }
    case 'relation':
      // The relation draft *is* the read value: a picker has to draw a chip for a record it has
      // not fetched, so the draft already carries the label (`@/attributes/value.ts`).
      return { type, value: [...(draft as readonly RelationValue[])] }
    default:
      return assertNever(type, 'attribute type')
  }
}
