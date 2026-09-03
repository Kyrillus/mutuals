/**
 * Slug suggestion and validation.
 *
 * A slug is the machine name of an attribute and is immutable after creation (§4.2), which makes
 * this one of the few places in the product where getting it wrong is not fixable by editing. The
 * dialog suggests one from the title and the user may edit it until the first save.
 *
 * 63 characters, because that is the Postgres identifier limit and the storage decision's
 * column-promotion path (`city` becomes a real column on `contact`) turns a slug into an
 * identifier. A 64-character slug would silently truncate into a collision at exactly the moment
 * someone is optimising under pressure.
 */
import { fail, ok, type Result } from '../result.ts'
import type { ObjectType } from './kinds.ts'
import { isReservedSlug, reservationReason } from './reserved.ts'

declare const SLUG: unique symbol

export type Slug = string & { readonly [SLUG]: true }

export const MAX_SLUG_LENGTH = 63

/** The same shape as the `attribute_definition.slug` CHECK, which is the database's backstop. */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

export interface SlugContext {
  readonly objectType: ObjectType
  readonly taken: ReadonlySet<string>
}

/**
 * Transliteration for slugs only.
 *
 * Not the filter contract (that is `mutuals_norm()` in SQL, ADR-019) and not the display casefold
 * (`text/casefold.ts`, which deliberately folds no accents). A slug is an identifier, and an
 * identifier wants the German reading — `Größe` becomes `groesse`, not `grosse` and certainly not
 * `gr_e` — because that is what a person would have typed by hand.
 */
const TRANSLITERATIONS: readonly (readonly [string, string])[] = [
  ['ä', 'ae'],
  ['ö', 'oe'],
  ['ü', 'ue'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['å', 'a'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
  ['ħ', 'h'],
  ['ı', 'i'],
  ['ŋ', 'n'],
  ['ŧ', 't'],
  ['ƀ', 'b'],
  ['µ', 'u'],
]

export function transliterateForSlug(input: string): string {
  let folded = input.toLowerCase()
  for (const [from, to] of TRANSLITERATIONS) folded = folded.replaceAll(from, to)
  return folded.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

/**
 * Deterministic suggestion from a title. Never throws and always returns a slug that passes
 * {@link validateSlug} for the same context — so the dialog can prefill the field and the user can
 * press Save without reading it.
 */
export function suggestSlug(title: string, ctx: SlugContext): Slug {
  const base = slugify(title)
  if (isAvailable(base, ctx)) return base as Slug

  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `_${String(n)}`
    const candidate = `${truncate(base, MAX_SLUG_LENGTH - suffix.length)}${suffix}`
    if (isAvailable(candidate, ctx)) return candidate as Slug
  }
  // Unreachable with fewer than 10 000 attributes of one name; a throw beats an invalid slug.
  throw new Error(`Could not find a free slug for ${JSON.stringify(title)}`)
}

/** Validates a slug the user edited. The API calls this before writing. */
export function validateSlug(raw: string, ctx: SlugContext): Result<Slug> {
  const candidate = raw.trim()
  if (candidate === '') return fail('required', 'A slug is required.')
  if (!SLUG_PATTERN.test(candidate)) {
    return fail(
      'invalid_input',
      'Use lower-case letters, digits and underscores, starting with a letter, ' +
        `up to ${String(MAX_SLUG_LENGTH)} characters.`,
    )
  }
  if (isReservedSlug(candidate, ctx.objectType)) {
    const reason = reservationReason(candidate, ctx.objectType)
    const detail =
      reason === 'hazard'
        ? 'that name means something else in JavaScript'
        : `${ctx.objectType} already has a built-in field called that`
    return fail('reserved_slug', `"${candidate}" is reserved — ${detail}. Try "${candidate}_1".`)
  }
  if (ctx.taken.has(candidate)) {
    return fail('duplicate_slug', `"${candidate}" is already used by another attribute.`)
  }
  return ok(candidate as Slug)
}

export function isSlug(value: string): value is Slug {
  return SLUG_PATTERN.test(value)
}

/**
 * Title → slug shape, without the availability check:
 * transliterate, replace every run of non-`[a-z0-9]` with `_`, strip the edges, guarantee a
 * leading letter, then truncate.
 */
function slugify(title: string): string {
  const cleaned = transliterateForSlug(title)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (cleaned === '') return 'f_1'
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `f_${cleaned}`
  return truncate(prefixed, MAX_SLUG_LENGTH)
}

/** Cuts at an underscore when that keeps a readable name, and never leaves a trailing underscore. */
function truncate(slug: string, limit: number): string {
  if (slug.length <= limit) return slug
  const hard = slug.slice(0, limit)
  const lastUnderscore = hard.lastIndexOf('_')
  const cut = lastUnderscore >= limit / 3 ? hard.slice(0, lastUnderscore) : hard
  return cut.replace(/_+$/, '')
}

function isAvailable(candidate: string, ctx: SlugContext): boolean {
  return (
    SLUG_PATTERN.test(candidate) &&
    !ctx.taken.has(candidate) &&
    !isReservedSlug(candidate, ctx.objectType)
  )
}
