/**
 * Reserved attribute slugs — two tiers, one of them derived (ADR-041).
 *
 * Tier 1 is computed from `SYSTEM_FIELDS`, so adding a derived column reserves its name in the
 * same commit and the list can never drift from the code.
 *
 * Tier 2 is the genuine JavaScript hazards only. The ~90 Postgres key words that an earlier draft
 * reserved are gone: attribute slugs never reach SQL as identifiers — the compiler resolves a slug
 * to a definition row and answers an unknown one with 400 before any SQL exists — so reserving
 * `is`, `left`, `order` and `user` was user-hostile for no benefit. The query-string parameter
 * names are gone for the same reason: under ADR-032 a slug lives *inside* the `filter` value and
 * never becomes a parameter name. And `type` is deliberately absent, because §4.1 seeds `type` as
 * a default custom attribute on Organization — reserving it would have failed the seed on day one.
 */
import type { ObjectType } from './kinds.ts'
import { allSystemSlugs } from '../fields/system.ts'

/**
 * Attribute values travel in a nested `{ id, displayName, attributes: { [slug]: … } }` payload, so
 * a slug cannot reach `Object.assign` on a top-level request body. These three still can reach a
 * plain object literal keyed by slug, and `__proto__` there is prototype pollution.
 */
export const HAZARD_SLUGS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
])

const CACHE = new Map<ObjectType, ReadonlySet<string>>()

/** Every slug a new attribute of this object type may not take. */
export function reservedSlugs(objectType: ObjectType): ReadonlySet<string> {
  const cached = CACHE.get(objectType)
  if (cached !== undefined) return cached
  const built: ReadonlySet<string> = new Set([...allSystemSlugs(objectType), ...HAZARD_SLUGS])
  CACHE.set(objectType, built)
  return built
}

export function isReservedSlug(slug: string, objectType: ObjectType): boolean {
  return reservedSlugs(objectType).has(slug)
}

/** Why a slug is reserved, so the error message can say which of the two rules it hit. */
export function reservationReason(
  slug: string,
  objectType: ObjectType,
): 'system_field' | 'hazard' | undefined {
  if (HAZARD_SLUGS.includes(slug)) return 'hazard'
  return allSystemSlugs(objectType).includes(slug) ? 'system_field' : undefined
}
