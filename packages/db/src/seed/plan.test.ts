/**
 * The demo seed's generator, tested without a database.
 *
 * Splitting the plan from the write is what makes this possible, and these are the properties that
 * actually matter: the counts §8.1 asks for, reproducibility, and the two things that make the seed
 * *plausible* rather than merely large — a founder works at a startup, and somebody's `asks` are
 * somebody else's `offers`.
 */
import { describe, expect, it } from 'vitest'
import { civil } from '@mutuals/core'

import { ORGANIZATIONS, ORG_TYPES_BY_ROLE, ROLE_COUNTS } from './data.ts'
import { askOfferMatches, buildSeedPlan, SEED_DEFAULTS, type SeedPlan } from './plan.ts'

const TODAY = civil('2026-09-03')

function plan(seed: number = SEED_DEFAULTS.seed): SeedPlan {
  return buildSeedPlan({ seed, today: TODAY })
}

describe('the seeded counts', () => {
  const built = plan()

  it('matches the brief §8.1 exactly', () => {
    expect(built.contacts).toHaveLength(200)
    expect(built.organizations).toHaveLength(60)
    expect(built.interactions).toHaveLength(500)
    expect(built.followUps).toHaveLength(40)
  })

  it('spends the whole role budget', () => {
    const byRole = new Map<string, number>()
    for (const contact of built.contacts) {
      byRole.set(contact.role, (byRole.get(contact.role) ?? 0) + 1)
    }
    expect(Object.fromEntries(byRole)).toEqual(ROLE_COUNTS)
  })

  it('covers all six organization types', () => {
    const types = new Set(ORGANIZATIONS.map((org) => org.type))
    expect([...types].sort()).toEqual([
      'angel',
      'community',
      'corporate',
      'startup',
      'university',
      'vc_fund',
    ])
  })
})

describe('reproducibility', () => {
  it('is a function of the seed and today, and nothing else', () => {
    expect(plan()).toEqual(plan())
  })

  it('produces a different network for a different seed', () => {
    expect(plan(7).contacts[0]).not.toEqual(plan(8).contacts[0])
  })

  it('moves every date when today moves', () => {
    const later = buildSeedPlan({ seed: SEED_DEFAULTS.seed, today: civil('2026-12-01') })
    expect(later.interactions[0]?.occurredAt).not.toEqual(plan().interactions[0]?.occurredAt)
  })
})

describe('plausibility', () => {
  const built = plan()
  const orgOf = (index: number) => built.organizations[index]

  it('puts every person in an organization their role could plausibly be in', () => {
    for (const contact of built.contacts) {
      const current = contact.employment.find((job) => job.until === null)
      if (current === undefined) continue
      const org = orgOf(current.organizationIndex)
      expect(org).toBeDefined()
      const allowed: readonly string[] = ORG_TYPES_BY_ROLE[contact.role]
      expect(allowed).toContain(org?.type)
    }
  })

  it('gives every current position a title and a start date, and at most one primary', () => {
    for (const contact of built.contacts) {
      const primary = contact.employment.filter((job) => job.isPrimary)
      expect(primary.length).toBeLessThanOrEqual(1)
      for (const job of contact.employment) {
        expect(job.title.length).toBeGreaterThan(0)
        expect(job.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        if (job.until !== null) expect(job.until >= job.from).toBe(true)
      }
    }
  })

  it('leaves some people without an organization, an email or a phone', () => {
    const noOrg = built.contacts.filter((one) => one.employment.length === 0)
    const noEmail = built.contacts.filter((one) => one.email === null)
    const noPhone = built.contacts.filter((one) => one.phone === null)
    expect(noOrg.length).toBeGreaterThan(0)
    expect(noEmail.length).toBeGreaterThan(0)
    expect(noPhone.length).toBeGreaterThan(0)
  })

  it('never reuses an email or a LinkedIn URL, because both become unique identifiers', () => {
    const emails = built.contacts.flatMap((one) => one.email ?? [])
    const linkedin = built.contacts.flatMap((one) => one.linkedinUrl ?? [])
    expect(new Set(emails).size).toBe(emails.length)
    expect(new Set(linkedin).size).toBe(linkedin.length)
  })
})

describe('asks and offers', () => {
  const built = plan()

  it('plants at least a dozen tags one person asks for and another offers', () => {
    const matches = askOfferMatches(built)
    expect(matches.length).toBeGreaterThanOrEqual(12)
    for (const match of matches) {
      expect(match.askedBy.length).toBeGreaterThan(0)
      expect(match.offeredBy.length).toBeGreaterThan(0)
      // The whole point (§9): a match is an exact value match, never a similarity score, so the
      // two sides have to carry the identical string.
      expect(match.askedBy.some((index) => match.offeredBy.includes(index))).toBe(false)
    }
  })

  it('leaves asks that nothing answers, so not every ask is a match', () => {
    const matched = new Set(askOfferMatches(built).map((match) => match.tag))
    const unmatched = built.contacts.flatMap((one) => one.asks.filter((tag) => !matched.has(tag)))
    expect(unmatched.length).toBeGreaterThan(0)
  })
})

describe('the interaction history', () => {
  const built = plan()

  it('is skewed, not uniform — a few people carry most of it', () => {
    const perContact = new Map<number, number>()
    for (const interaction of built.interactions) {
      for (const index of interaction.contactIndexes) {
        perContact.set(index, (perContact.get(index) ?? 0) + 1)
      }
    }
    const counts = [...perContact.values()].sort((a, b) => b - a)
    // The top ten per cent of contacts hold more than a third of the touches.
    const topTenth = counts.slice(0, 20).reduce((sum, n) => sum + n, 0)
    const total = counts.reduce((sum, n) => sum + n, 0)
    expect(topTenth / total).toBeGreaterThan(0.33)
    expect(built.contacts.length - perContact.size).toBeGreaterThan(20)
  })

  it('only ever happened in the past, relative to the injected today', () => {
    for (const interaction of built.interactions) {
      expect(interaction.occurredAt.slice(0, 10) <= TODAY).toBe(true)
    }
  })

  it('names every participant as a real contact index', () => {
    for (const interaction of built.interactions) {
      expect(interaction.contactIndexes.length).toBeGreaterThan(0)
      for (const index of interaction.contactIndexes) {
        expect(built.contacts[index]).toBeDefined()
      }
    }
  })
})

describe('follow-ups', () => {
  const built = plan()

  it('covers every §6.4 tab: overdue, due this week, upcoming, snoozed and done', () => {
    const open = built.followUps.filter((one) => one.status === 'Open')
    expect(open.filter((one) => one.dueAt < TODAY).length).toBe(12)
    expect(open.filter((one) => one.dueAt >= TODAY).length).toBe(16)
    expect(built.followUps.filter((one) => one.status === 'Snoozed')).toHaveLength(4)
    expect(built.followUps.filter((one) => one.status === 'Done')).toHaveLength(8)
  })

  it('marks every done follow-up with a completion instant and no open one', () => {
    for (const followUp of built.followUps) {
      expect(followUp.completedAt === null).toBe(followUp.status !== 'Done')
    }
  })

  it('makes a good share of them recur', () => {
    const recurring = built.followUps.filter((one) => one.recurrence !== null)
    expect(recurring.length).toBeGreaterThanOrEqual(8)
    expect(new Set(recurring.map((one) => one.recurrence?.kind)).size).toBeGreaterThan(1)
  })
})
