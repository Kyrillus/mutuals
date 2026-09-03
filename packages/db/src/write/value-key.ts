/**
 * `value_key` — the identity of one value inside one attribute on one record (ADR-018).
 *
 * Three mechanisms read this column and they must all agree: `fact_live_uq`, `av_record_attr_uq`
 * and the sort join's `sv.value_key = ''`. So it is derived in exactly one place, from `is_multi`
 * alone, and it is derived as a *SQL expression* rather than a string: the `tags` key is
 * `mutuals_norm()`-folded, and ADR-019's house rule is that TypeScript never produces a value that
 * is compared against a normalised column.
 */
import { sql, type RawBuilder } from 'kysely'
import { assertNever, type SlotValue } from '@mutuals/core'
import { WriteError, type AttributeShape } from './types.ts'

/** The key every single-valued attribute shares, which is what makes one unique index express both cardinalities. */
export const SINGLE_VALUE_KEY = ''

/**
 * The SQL expression for one value's key. Bind it into the `INSERT` and into the superseding
 * `UPDATE`'s `WHERE` so the two can never disagree about which slot is being replaced.
 */
export function valueKeyExpression(
  attribute: AttributeShape,
  value: SlotValue,
): RawBuilder<string> {
  if (!attribute.isMulti) return sql<string>`${SINGLE_VALUE_KEY}`

  switch (value.kind) {
    case 'text':
      // 512 is the CHECK on the column; the fold is SQL's, never TypeScript's.
      return sql<string>`left(mutuals_norm(${value.text}), 512)`
    case 'option':
      // Read back from the row rather than trusting the caller's copy of it: the option's `key` is
      // its stable identity and a stale copy would split one value into two live facts.
      return sql<string>`(select o.key from attribute_option o where o.id = ${value.optionId})`
    case 'relation':
      // ADR-018 calls this "not applicable", but `fact_live_uq` is on (record, attribute,
      // value_key) and a contact may have two live organizations, so the target id is the only
      // key that keeps two relations from colliding. See the deviations note.
      return sql<string>`${value.targetRecordId}`
    case 'number':
    case 'date':
    case 'bool':
      throw new WriteError(
        `attribute ${attribute.slug} is multi-valued but carries a ${value.kind} value; ` +
          'only tags, multi_select and relation may be multi-valued',
      )
    default:
      return assertNever(value, 'slot value')
  }
}

/**
 * The key of a value that is being removed, for the tombstone and for the `UPDATE` that supersedes
 * whatever occupied the slot. Identical to {@link valueKeyExpression} by construction — a removal
 * has to land on exactly the slot the addition made.
 */
export function removalKeyExpression(
  attribute: AttributeShape,
  value: SlotValue,
): RawBuilder<string> {
  return valueKeyExpression(attribute, value)
}
