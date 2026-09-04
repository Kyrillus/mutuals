/**
 * Turning a rejected write into a message under the input that caused it.
 *
 * §7 and ADR-031 make the API answer a validation failure with RFC 9457 plus a per-field `errors`
 * array whose `field` is a dotted path into the request body — `attributes.city`,
 * `attributes.areas_of_interest.1`, `firstName`. That array exists so a form can mark one control
 * instead of showing one sentence over a dozen of them, and a generic toast throws it away.
 */
import { ApiError } from '@/lib/api.ts'

/** The prefix every user-defined field sits behind in a create or update body. */
export const ATTRIBUTE_FIELD_PREFIX = 'attributes.'

const EMPTY: ReadonlyMap<string, string> = new Map()

/**
 * Every field-level message, keyed by its full path. The first message for a path wins: a control
 * has room for one line, and the first is the one the server ordered first.
 */
export function fieldErrors(error: unknown): ReadonlyMap<string, string> {
  if (!(error instanceof ApiError) || error.errors.length === 0) return EMPTY
  const byField = new Map<string, string>()
  for (const problem of error.errors) {
    if (!byField.has(problem.field)) byField.set(problem.field, problem.message)
  }
  return byField
}

/**
 * The same messages, keyed by attribute slug.
 *
 * A failure inside a multi-valued attribute arrives as `attributes.<slug>.<index>`; the index is
 * dropped, because the tag input and the multi-select render one control for the whole value and
 * have nowhere to put a message about element three.
 */
export function attributeFieldErrors(error: unknown): ReadonlyMap<string, string> {
  const all = fieldErrors(error)
  if (all.size === 0) return EMPTY
  const bySlug = new Map<string, string>()
  for (const [field, message] of all) {
    if (!field.startsWith(ATTRIBUTE_FIELD_PREFIX)) continue
    const slug = field.slice(ATTRIBUTE_FIELD_PREFIX.length).split('.')[0]
    if (slug !== undefined && slug !== '' && !bySlug.has(slug)) bySlug.set(slug, message)
  }
  return bySlug
}

/** The message for one attribute, or undefined when the failure was somewhere else. */
export function attributeFieldError(error: unknown, slug: string): string | undefined {
  return attributeFieldErrors(error).get(slug)
}

/**
 * True when the failure was about the request body rather than about the request.
 *
 * A caller uses it to decide between marking a control and raising §5.2's error toast: a 409 or a
 * 500 has no field to point at, and silently swallowing it under an input nobody is looking at is
 * worse than a toast.
 */
export function isFieldLevelFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.errors.length > 0
}
