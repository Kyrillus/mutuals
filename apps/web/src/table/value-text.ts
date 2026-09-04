/**
 * Every value in the table as plain text, for the CSV export (§5.2).
 *
 * Deliberately unformatted: a spreadsheet wants `2026-03-01` and `1250.50`, not `1 Mar 2026` and
 * `1,250.50` — the second pair is a string in every column it lands in. What a *cell* looks like
 * is `@/attributes`'s job and reads the profile's locale; what an export says must survive being
 * opened in another country.
 *
 * The switch is over the wire's own discriminator, so a thirteenth attribute type is a compile
 * error here rather than an empty column.
 */
import { assertNever, type AttributeValue, type ValueKind } from '@mutuals/core'

/** Multi-valued cells join with a semicolon, because a comma is the delimiter. */
const JOIN = '; '

export function attributeText(value: AttributeValue): string {
  switch (value.type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
    case 'date':
      return value.value
    case 'number':
      return value.unit === undefined ? value.value : `${value.value} ${value.unit}`
    case 'yes_no':
      return value.value ? 'Yes' : 'No'
    case 'single_select':
      return value.value.label
    case 'multi_select':
      return value.value.map((option) => option.label).join(JOIN)
    case 'tags':
      return value.value.join(JOIN)
    case 'relation':
      return value.value.map((relation) => relation.label).join(JOIN)
    default:
      return assertNever(value, 'attribute value')
  }
}

/**
 * A system or derived column's value. There is no per-type definition behind these, only the
 * `valueKind` `SYSTEM_FIELDS` declares, which is exactly enough to print one.
 */
export function systemText(value: unknown, kind: ValueKind): string {
  if (value === null || value === undefined) return ''
  switch (kind) {
    case 'bool':
      return value === true ? 'Yes' : 'No'
    case 'text':
    case 'date':
    case 'number':
    case 'option':
    case 'relation':
      return scalarText(value)
    default:
      return assertNever(kind, 'value kind')
  }
}

/**
 * Every system column is a JSON scalar by declaration. Anything else would be a wire change, and
 * writing its JSON out is more use in a spreadsheet than `[object Object]`.
 */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value) ?? ''
}
