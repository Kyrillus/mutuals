import { isSupportedCountry, parsePhoneNumberWithError } from 'libphonenumber-js/min'
import { fail, ok, type Result } from '../result.ts'

/**
 * E.164 phone normalisation (brief §4.2, §4.6).
 *
 * This module is the package's `./phone` subpath export and the **only** file that imports
 * `libphonenumber-js`, so a browser bundle that needs the filter model and the attribute registry
 * never pulls the metadata (ADR-035). The API and the importer inject this function; in the
 * browser the attribute type degrades to shape validation.
 *
 * The `/min` metadata build is deliberate. `/max` adds ~74 kB to split mobile from landline, and
 * the split was only ever wanted for a duplicate confidence — but `getType()` returns
 * `FIXED_LINE_OR_MOBILE` for the US and every other merged numbering plan and `undefined` for
 * Germany on `/min`, so the distinction is a no-op exactly where it matters. If a written test
 * ever shows the German split changing a merge outcome, `/max` is a one-line swap.
 */

export interface NormalizedPhone {
  /** `+49891234567` — what goes into `identifier.value`. */
  readonly e164: string
  /** `089 1234567` — the readable form for the UI. */
  readonly national: string
  /** ISO-3166 alpha-2, when the library could infer one. */
  readonly region: string | null
  /** False for a well-formed but implausible number; the caller still stores it. */
  readonly valid: boolean
}

export interface PhoneOptions {
  /**
   * From `profile.phone_region` (ADR-045). Without it `'089 1234567'` cannot be normalised at all
   * — there is no such thing as a national number without a country.
   */
  readonly defaultRegion?: string
}

/**
 * Normalises a phone number.
 *
 * A failure is never a reason to lose the number: the caller stores the raw text as the attribute
 * value regardless and simply writes no `identifier` row. A CRM that drops a phone number because
 * it could not classify it is worse than one that cannot deduplicate on it.
 */
export function normalizePhone(raw: string, options: PhoneOptions = {}): Result<NormalizedPhone> {
  const text = raw.trim()
  if (text === '') return fail('required', 'Enter a phone number.')

  const region = options.defaultRegion
  if (region !== undefined && !isSupportedCountry(region)) {
    return fail('invalid_phone', `"${region}" is not a country code.`, [], { region })
  }

  try {
    const parsed =
      region === undefined
        ? parsePhoneNumberWithError(text)
        : parsePhoneNumberWithError(text, region)
    return ok({
      e164: parsed.number,
      national: parsed.formatNational(),
      region: parsed.country ?? null,
      valid: parsed.isValid(),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'NOT_A_NUMBER'
    if (reason === 'INVALID_COUNTRY') {
      return fail(
        'ambiguous_national_number',
        `"${raw}" has no country code. Add one (like +49), or set a default region in Settings.`,
      )
    }
    return fail('invalid_phone', `"${raw}" is not a phone number.`)
  }
}
