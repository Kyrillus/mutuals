/**
 * One option of a `single_select` or `multi_select` attribute.
 *
 * Options live in their own table rather than inside `config`, because every value that uses one
 * points at it with a real foreign key — which is what makes §6.7's "deleting an option that is in
 * use asks whether to clear or remap" a database-enforced question rather than a hope.
 */
import { fail, ok, type Result } from '../result.ts'
import { casefoldForDisplay } from '../text/casefold.ts'
import type { Uuid } from './kinds.ts'

export interface AttributeOption {
  readonly id: Uuid
  /** Stable machine key. The wire format carries this, never the uuid, so a rename is free. */
  readonly key: string
  readonly label: string
  /** A token name from the design system, not a hex value (ADR-056). */
  readonly color?: string
  /** THE sort order for `single_select` — §4.2's "option order". */
  readonly position: number
  /** Set once an option is retired: it still resolves, so old saved views and history render. */
  readonly archivedAt?: string | null
}

/** Live options, in the order §4.2 sorts by. */
export function activeOptions(options: readonly AttributeOption[]): readonly AttributeOption[] {
  return (
    options
      .filter((option) => option.archivedAt === undefined || option.archivedAt === null)
      .slice()
      // Keys are unique per attribute, so the key breaks a position tie without a third case.
      .sort((a, b) => a.position - b.position || (a.key < b.key ? -1 : 1))
  )
}

/** Looks an option up by its stable key, archived ones included. */
export function findOptionByKey(
  options: readonly AttributeOption[],
  key: string,
): AttributeOption | undefined {
  return options.find((option) => option.key === key)
}

export function findOptionById(
  options: readonly AttributeOption[],
  id: Uuid,
): AttributeOption | undefined {
  return options.find((option) => option.id === id)
}

/**
 * Matches an imported cell to an option key: exact key, then exact label, then a label that
 * differs only by case or whitespace. It stops there — fuzzy matching an option is the import
 * wizard's value-mapping step (§6.8), where a person confirms it, and a silent trigram match on
 * `Investor` versus `Investors` is exactly the kind of guess §4.8 forbids.
 */
export function matchOption(raw: string, options: readonly AttributeOption[]): Result<string> {
  const trimmed = raw.trim()
  if (trimmed === '') return fail('required', 'This field is empty.')

  const live = activeOptions(options)
  if (live.length === 0) {
    return fail('invalid_input', 'This attribute has no options to choose from.')
  }

  const byKey = live.find((option) => option.key === trimmed)
  if (byKey !== undefined) return ok(byKey.key)

  const byLabel = live.find((option) => option.label === trimmed)
  if (byLabel !== undefined) return ok(byLabel.key)

  const folded = casefoldForDisplay(trimmed)
  const byFoldedLabel = live.find(
    (option) =>
      casefoldForDisplay(option.label) === folded || casefoldForDisplay(option.key) === folded,
  )
  if (byFoldedLabel !== undefined) return ok(byFoldedLabel.key)

  return fail(
    'unknown_option',
    `"${raw}" is not one of: ${live.map((o) => o.label).join(', ')}.`,
    [],
    {
      value: raw,
    },
  )
}
