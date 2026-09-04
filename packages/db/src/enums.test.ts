/**
 * The closed sets exist twice — once in `packages/core` because the wire contract needs them in the
 * browser, once here because the Kysely interface needs them — and nothing made them agree.
 *
 * `schema.db.test.ts` already compares this file against `pg_enum`, so the database end is honest.
 * This is the other end: core's transcription against the same list. Without it, adding a value in
 * one place produces a 500 with a constraint name at runtime instead of a red test.
 *
 * The two lists are compared as *sets*, not arrays: `pg_enum` has an order and these do not have to
 * match it, and a spurious failure over ordering is how a test gets deleted.
 */
import { CREATED_VIA_VALUES, FACT_SOURCE_VALUES } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import { CREATED_VIA, FACT_SOURCES } from './schema.ts'

describe('the closed sets core and db each declare', () => {
  it('agree on where a fact came from', () => {
    expect(new Set(FACT_SOURCE_VALUES)).toEqual(new Set(FACT_SOURCES))
  })

  it('agree on how a record came to exist', () => {
    expect(new Set(CREATED_VIA_VALUES)).toEqual(new Set(CREATED_VIA))
  })
})
