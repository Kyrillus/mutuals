/**
 * The eleven option colours (§5.2, ADR-056) — the names, on their own.
 *
 * `attribute_option.color` stores one of these, never a hex string: a hex picked against a white
 * background is unreadable on a dark one, a user-chosen hex will eventually fail contrast on a
 * chip, and eleven swatches are a faster picker than an eyedropper as well as an impossible one
 * to get wrong.
 *
 * This list is a contract with the database — `0002_records_attributes_facts.sql` calls the set
 * closed and points at the domain package for it. When `packages/core` narrows its option schema
 * from `z.string()` to `z.enum([...])`, that enum and this array must be the same eleven strings.
 *
 * It is a separate module from `chip.tsx` because the colour *picker* in Settings → Attributes and
 * `contrast.test.ts` both need the names without needing React or a class-name table.
 */

export const CHIP_COLORS = [
  'gray',
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const

export type ChipColor = (typeof CHIP_COLORS)[number]

export function isChipColor(value: unknown): value is ChipColor {
  return typeof value === 'string' && (CHIP_COLORS as readonly string[]).includes(value)
}
