/**
 * The two conversions every repository needs on the way out of the driver.
 *
 * `client.ts` installs a `date` parser that hands the string through, and leaves `timestamptz` as
 * node-pg's `Date`. Both are accepted here so a repository still returns the right thing if a
 * caller builds its own pool without that parser — an integration test, or the bulk `COPY` path.
 */

/** An instant, as the ISO-8601 string the API contract puts on the wire. */
export function isoOf(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString()
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoOf(value)
}

/**
 * A calendar day with no time and no zone. A `Date` is read in local time on purpose: node-pg's
 * default `date` parser builds it at *local* midnight, so reading it back in UTC would move a
 * birthday a day west of Greenwich.
 */
export function civilOf(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10)
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

export function civilOrNull(value: Date | string | null): string | null {
  return value === null ? null : civilOf(value)
}
