import { describe, expect, it } from 'vitest'

import { completeDefinition } from '../attributes/definition.ts'
import { makeFieldResolver } from '../fields/resolve.ts'
import { findTarget, importTargets } from './targets.ts'
import { seededContactResolver } from './test-support.ts'

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

describe('importTargets', () => {
  const targets = importTargets(seededContactResolver())
  const ids = targets.map((target) => target.id)

  it('offers the writable system columns and every attribute', () => {
    expect(ids).toContain('first_name')
    expect(ids).toContain('last_name')
    expect(ids).toContain('email')
    expect(ids).toContain('notes')
  })

  /** An import is a write, and a derived column has nowhere to write to. */
  it('offers no derived or read-only column', () => {
    for (const slug of ['warmth', 'created_at', 'updated_at', 'created_via', 'import_batch_id']) {
      expect(ids, slug).not.toContain(slug)
    }
  })

  /** §4.3: the contact↔organization link is the one that carries metadata, and §6.8 maps into it. */
  it('expands a link that carries metadata into its parts', () => {
    expect(ids).toContain('organization')
    expect(ids).toContain('organization.title')
    expect(ids).toContain('organization.from')
    expect(ids).toContain('organization.to')
    expect(findTarget(targets, 'organization.from')?.valueKind).toBe('date')
    expect(findTarget(targets, 'organization.title')?.valueKind).toBe('text')
  })

  it('offers only the target itself for a link that carries none', () => {
    const plain = completeDefinition(
      {
        id: 'attr-mentor',
        objectType: 'contact',
        title: 'Mentor',
        slug: 'mentor',
        type: 'relation',
        config: { targetObjectType: 'contact', cardinality: 'one', hasLinkMetadata: false },
        isSystem: false,
        position: 40,
        showByDefault: false,
      },
      TIMESTAMPS,
    )
    const expanded = importTargets(makeFieldResolver('contact', [plain])).map((one) => one.id)
    expect(expanded).toContain('mentor')
    expect(expanded).not.toContain('mentor.title')
  })

  it('marks the types that get §6.8 step 3s per-value mapping editor', () => {
    expect(findTarget(targets, 'job_role')?.hasValueMapping).toBe(true)
    expect(findTarget(targets, 'asks')?.hasValueMapping).toBe(true)
    expect(findTarget(targets, 'email')?.hasValueMapping).toBe(false)
  })

  it('carries the cardinality, so a tags cell knows it may hold several values', () => {
    expect(findTarget(targets, 'asks')?.isMulti).toBe(true)
    expect(findTarget(targets, 'city')?.isMulti).toBe(false)
  })

  /**
   * The one rule: a field invented in Settings five minutes ago is a legal import target with no
   * code change, because the list is derived from definitions rather than written down.
   */
  it('includes an attribute that did not exist when this code was written', () => {
    const invented = completeDefinition(
      {
        id: 'attr-favourite-cheese',
        objectType: 'contact',
        title: 'Favourite cheese',
        slug: 'favourite_cheese',
        type: 'short_text',
        config: {},
        isSystem: false,
        position: 99,
        showByDefault: false,
      },
      TIMESTAMPS,
    )
    const grown = importTargets(makeFieldResolver('contact', [invented]))
    expect(findTarget(grown, 'favourite_cheese')?.label).toBe('Favourite cheese')
  })
})
