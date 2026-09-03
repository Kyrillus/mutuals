/**
 * The generated half of the demo seed: a plain object graph, built from a seeded
 * `@faker-js/faker` and an injected `today`, with no database anywhere near it.
 *
 * Two reasons it is a separate step rather than a loop that writes as it goes. First,
 * reproducibility is then something you can assert: the same `seed` and the same `today` produce
 * the same plan, and a unit test can say so without a Postgres. Second, the interesting decisions
 * — who is warm, who asks for what somebody else offers — are decisions about the *shape* of the
 * network, and they are much easier to get right when the whole network is in front of you.
 *
 * `today` is injected because ADR-081 forbids reading the wall clock inside domain logic, and
 * because a seed whose "3 weeks ago" is genuinely three weeks ago is the only kind Simon can judge.
 */
import { Faker, de, en } from '@faker-js/faker'
import { addDays, type CivilDate, type InteractionType, type Recurrence } from '@mutuals/core'

import {
  AREAS_OF_INTEREST,
  ASK_OFFER_PAIRS,
  INTEREST_BY_INDUSTRY,
  FOLLOW_UP_NOTES,
  FOLLOW_UP_TITLES,
  HOW_WE_MET,
  INTERACTION_BODIES,
  INTERACTION_TITLES,
  JOB_TITLES,
  NOTES,
  ORGANIZATIONS,
  ORG_TYPES_BY_ROLE,
  PLACES,
  ROLE_COUNTS,
  UNMATCHED_ASKS,
  UNMATCHED_OFFERS,
  handleOf,
  type OrganizationSeed,
  type Place,
  type RoleKey,
} from './data.ts'

export const SEED_DEFAULTS = {
  /** Any integer; it is printed by `pnpm seed` so a surprising row can be reproduced. */
  seed: 20260101,
  contacts: 200,
  organizations: ORGANIZATIONS.length,
  interactions: 500,
  followUps: 40,
} as const

/**
 * How alive each relationship is, decided before any interaction exists. Warmth is then *computed*
 * from the interactions these cohorts produce (ADR-022) rather than written down — otherwise the
 * seed would prove nothing about the warmth function.
 */
export const COHORTS = ['inner', 'active', 'warm', 'dormant'] as const
export type Cohort = (typeof COHORTS)[number]

/** Contacts per cohort, and interactions per cohort. Both columns sum to the totals above. */
const COHORT_PLAN = {
  inner: { contacts: 18, interactions: 198 },
  active: { contacts: 45, interactions: 180 },
  warm: { contacts: 60, interactions: 90 },
  dormant: { contacts: 77, interactions: 32 },
} as const satisfies Record<Cohort, { contacts: number; interactions: number }>

export interface OrganizationPlan extends OrganizationSeed {
  readonly index: number
  readonly website: string
  readonly linkedinUrl: string
}

/** One position in a work history: current when `until` is null (§4.3). */
export interface EmploymentPlan {
  readonly organizationIndex: number
  readonly title: string
  readonly from: CivilDate
  readonly until: CivilDate | null
  readonly isPrimary: boolean
}

export interface ContactPlan {
  readonly index: number
  readonly firstName: string
  readonly lastName: string
  readonly role: RoleKey
  readonly cohort: Cohort
  readonly place: Place
  readonly employment: readonly EmploymentPlan[]
  readonly email: string | null
  readonly phone: string | null
  readonly birthday: CivilDate | null
  readonly areasOfInterest: readonly string[]
  readonly asks: readonly string[]
  readonly offers: readonly string[]
  readonly linkedinUrl: string | null
  readonly website: string | null
  readonly howWeMet: string | null
  readonly notes: string | null
  readonly pinnedImportant: boolean
  readonly notImportant: boolean
}

export interface InteractionPlan {
  readonly type: InteractionType
  /** An ISO instant, so the write path stores a `timestamptz` and nothing guesses a zone. */
  readonly occurredAt: string
  readonly title: string
  readonly body: string | null
  readonly contactIndexes: readonly number[]
  readonly organizationIndexes: readonly number[]
  readonly source: 'manual' | 'import'
}

export interface FollowUpPlan {
  readonly contactIndex: number
  readonly title: string
  readonly dueAt: CivilDate
  readonly status: 'Open' | 'Done' | 'Snoozed'
  readonly recurrence: Recurrence | null
  readonly notes: string | null
  readonly completedAt: string | null
}

export interface SeedPlan {
  readonly seed: number
  readonly today: CivilDate
  readonly organizations: readonly OrganizationPlan[]
  readonly contacts: readonly ContactPlan[]
  readonly interactions: readonly InteractionPlan[]
  readonly followUps: readonly FollowUpPlan[]
}

export interface SeedPlanOptions {
  readonly seed?: number
  readonly today: CivilDate
}

const INTERACTION_TYPE_WEIGHTS: readonly (readonly [InteractionType, number])[] = [
  ['Meeting', 26],
  ['Call', 22],
  ['Email', 20],
  ['Message', 12],
  ['Note', 9],
  ['Event', 7],
  ['Intro', 4],
]

/** An instant on `day`, at a plausible working hour, so the timeline does not read as midnight. */
function instantOn(faker: Faker, day: CivilDate): string {
  const hour = faker.number.int({ min: 8, max: 19 })
  const minute = faker.helpers.arrayElement([0, 5, 10, 15, 20, 30, 40, 45, 50])
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  // Europe/Berlin is +01:00/+02:00; the fixed offset keeps the plan a pure function of its inputs
  // and the exact minute of a demo interaction carries no meaning.
  return `${day}T${hh}:${mm}:00+01:00`
}

function weightedType(faker: Faker, allowed: readonly InteractionType[]): InteractionType {
  const pool = INTERACTION_TYPE_WEIGHTS.filter(([type]) => allowed.includes(type))
  const total = pool.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = faker.number.float({ min: 0, max: total })
  for (const [type, weight] of pool) {
    roll -= weight
    if (roll <= 0) return type
  }
  return pool[pool.length - 1]?.[0] ?? 'Note'
}

// -------------------------------------------------------------------------------------------
// Organizations
// -------------------------------------------------------------------------------------------

function planOrganizations(): OrganizationPlan[] {
  return ORGANIZATIONS.map((org, index) => {
    const handle = handleOf(org.name)
    const tld = org.type === 'university' ? 'edu' : org.type === 'community' ? 'org' : 'com'
    return {
      ...org,
      index,
      website: `https://${handle}.${tld}`,
      linkedinUrl: `https://www.linkedin.com/company/${handle}`,
    }
  })
}

// -------------------------------------------------------------------------------------------
// Contacts
// -------------------------------------------------------------------------------------------

/** Role order is fixed so the cohort assignment below is a function of the counts, not of chance. */
const ROLE_ORDER: readonly RoleKey[] = [
  'founder',
  'investor',
  'operator',
  'student',
  'community_builder',
  'other',
]

function roleSequence(): RoleKey[] {
  return ROLE_ORDER.flatMap((role) => Array.from({ length: ROLE_COUNTS[role] }, () => role))
}

function cohortSequence(faker: Faker, size: number): Cohort[] {
  const pool = COHORTS.flatMap((cohort) =>
    Array.from({ length: COHORT_PLAN[cohort].contacts }, () => cohort),
  )
  if (pool.length !== size) {
    throw new Error(`cohort plan covers ${pool.length} contacts, not ${size}`)
  }
  return faker.helpers.shuffle(pool)
}

/**
 * Emails, phones and LinkedIn URLs are identifiers, and `identifier` is unique on
 * `(workspace, kind, value)` — so a second `anna.berger@…` would abort the seed halfway through.
 * The counter is the boring fix, and it also makes the collision visible in the data instead of
 * hiding it behind a random suffix.
 */
class UniqueStrings {
  private readonly seen = new Map<string, number>()

  take(candidate: string, disambiguate: (base: string, n: number) => string): string {
    const used = this.seen.get(candidate)
    if (used === undefined) {
      this.seen.set(candidate, 1)
      return candidate
    }
    this.seen.set(candidate, used + 1)
    const next = disambiguate(candidate, used + 1)
    return this.take(next, disambiguate)
  }
}

function emailDomainFor(org: OrganizationPlan | undefined, faker: Faker): string {
  if (org === undefined) {
    return faker.helpers.arrayElement(['gmail.com', 'posteo.de', 'proton.me', 'fastmail.com'])
  }
  return new URL(org.website).hostname
}

function asciiHandle(value: string): string {
  const handle = handleOf(value)
  return handle.length > 0 ? handle : 'x'
}

/** A German or Dutch mobile number in E.164, unique by construction. */
function phoneNumber(faker: Faker, index: number): string {
  const prefix = faker.helpers.arrayElement(['+4915', '+4916', '+4917', '+316', '+417', '+337'])
  const body = String(100000 + index * 7).padStart(7, '0')
  return `${prefix}${body}`
}

interface AskOfferAssignment {
  readonly asks: Map<number, string[]>
  readonly offers: Map<number, string[]>
  readonly matchedTags: readonly string[]
}

/**
 * Plants the ask↔offer matches (§4.1, §9).
 *
 * The tag string is written **verbatim on both sides**, because a future introduction suggestion
 * is only ever allowed to fire on an ask↔offer match and never on topic similarity — so the seed
 * has to contain matches a strict equality join can find. Everything else in `UNMATCHED_ASKS` and
 * `UNMATCHED_OFFERS` exists so that not every ask is a match, which would flatter the feature.
 */
function assignAsksAndOffers(faker: Faker, contacts: readonly ContactDraft[]): AskOfferAssignment {
  const asks = new Map<number, string[]>()
  const offers = new Map<number, string[]>()
  const byRole = new Map<RoleKey, number[]>()
  for (const contact of contacts) {
    const list = byRole.get(contact.role) ?? []
    list.push(contact.index)
    byRole.set(contact.role, list)
  }

  const pick = (roles: readonly RoleKey[], count: number, taken: Set<number>): number[] => {
    const candidates = faker.helpers.shuffle(
      roles.flatMap((role) => byRole.get(role) ?? []).filter((index) => !taken.has(index)),
    )
    const chosen = candidates.slice(0, count)
    for (const index of chosen) taken.add(index)
    return chosen
  }

  const matchedTags: string[] = []
  for (const pair of ASK_OFFER_PAIRS) {
    const claimed = new Set<number>()
    for (const index of pick(pair.askRoles, pair.asks, claimed)) {
      asks.set(index, [...(asks.get(index) ?? []), pair.tag])
    }
    for (const index of pick(pair.offerRoles, pair.offers, claimed)) {
      offers.set(index, [...(offers.get(index) ?? []), pair.tag])
    }
    matchedTags.push(pair.tag)
  }

  // The decoys. Roughly a third of everyone carries one, which keeps the tag cloud honest.
  for (const contact of contacts) {
    if (faker.number.float() < 0.22) {
      const tag = faker.helpers.arrayElement(UNMATCHED_ASKS)
      asks.set(contact.index, [...(asks.get(contact.index) ?? []), tag])
    }
    if (faker.number.float() < 0.2) {
      const tag = faker.helpers.arrayElement(UNMATCHED_OFFERS)
      offers.set(contact.index, [...(offers.get(contact.index) ?? []), tag])
    }
  }

  return { asks, offers, matchedTags }
}

interface ContactDraft {
  readonly index: number
  readonly firstName: string
  readonly lastName: string
  readonly role: RoleKey
  readonly cohort: Cohort
  readonly place: Place
  readonly employment: EmploymentPlan[]
}

function planEmployment(
  faker: Faker,
  role: RoleKey,
  organizations: readonly OrganizationPlan[],
  today: CivilDate,
): EmploymentPlan[] {
  const allowed: readonly string[] = ORG_TYPES_BY_ROLE[role]
  const candidates = organizations.filter((org) => allowed.includes(org.type))
  if (candidates.length === 0) return []

  // Roughly one in twelve people has no current organization: angels between funds, founders
  // between companies, and freelancers. A CRM where everybody has an employer is not a real one.
  if (faker.number.float() < 0.08) return []

  const current = faker.helpers.arrayElement(candidates)
  const startedDaysAgo = faker.number.int({ min: 60, max: 2600 })
  const employment: EmploymentPlan[] = [
    {
      organizationIndex: current.index,
      title: faker.helpers.arrayElement(JOB_TITLES[role]),
      from: addDays(today, -startedDaysAgo),
      until: null,
      isPrimary: true,
    },
  ]

  // A previous position for about a quarter of people, so the Connections tab reads as a CV.
  if (faker.number.float() < 0.26) {
    const previous = faker.helpers.arrayElement(
      organizations.filter((org) => org.index !== current.index),
    )
    const endedDaysAgo = startedDaysAgo + faker.number.int({ min: 15, max: 120 })
    employment.push({
      organizationIndex: previous.index,
      title: faker.helpers.arrayElement(JOB_TITLES[role]),
      from: addDays(today, -(endedDaysAgo + faker.number.int({ min: 400, max: 2200 }))),
      until: addDays(today, -endedDaysAgo),
      isPrimary: false,
    })
  }

  return employment
}

/**
 * What somebody is interested in: mostly what their employer does, plus one or two of their own.
 * A network where interests are uniform noise makes every filter over them meaningless.
 */
function interestsFor(faker: Faker, org: OrganizationPlan | undefined): string[] {
  const inherited =
    org === undefined
      ? []
      : org.industry.flatMap((industry) => {
          const interest = INTEREST_BY_INDUSTRY[industry]
          return interest === undefined || faker.number.float() > 0.8 ? [] : [interest]
        })
  const own = faker.helpers.arrayElements([...AREAS_OF_INTEREST], { min: 0, max: 2 })
  const merged = [...new Set([...inherited, ...own])]
  return merged.length > 0 ? merged.slice(0, 3) : [faker.helpers.arrayElement(AREAS_OF_INTEREST)]
}

function planContacts(
  faker: Faker,
  organizations: readonly OrganizationPlan[],
  today: CivilDate,
): ContactPlan[] {
  const roles = roleSequence()
  const cohorts = cohortSequence(faker, roles.length)
  // The network belongs to somebody who lives in Munich, so Munich and Berlin are over-represented
  // among the people who do not simply live where they work.
  const cityPool: Place[] = [
    ...Array.from({ length: 5 }, () => PLACES.munich),
    ...Array.from({ length: 3 }, () => PLACES.berlin),
    ...Object.values(PLACES),
  ]

  const drafts: ContactDraft[] = roles.map((role, index) => {
    const employment = planEmployment(faker, role, organizations, today)
    const employer = employment.find((one) => one.until === null)
    const org = employer === undefined ? undefined : organizations[employer.organizationIndex]
    // Somebody usually lives where they work, but not always: remote is normal now.
    const place =
      org !== undefined && faker.number.float() < 0.78
        ? org.place
        : faker.helpers.arrayElement(cityPool)
    return {
      index,
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      role,
      cohort: cohorts[index] ?? 'dormant',
      place,
      employment,
    }
  })

  const { asks, offers } = assignAsksAndOffers(faker, drafts)

  const emails = new UniqueStrings()
  const linkedin = new UniqueStrings()
  // Three of the pins sit on people who are barely in touch. That is what the override is for
  // (§4.7): "this one matters even though we have not spoken", and the floor of 60 is only visible
  // in the seeded data if somebody cold carries it.
  const pinned = new Set([
    ...faker.helpers
      .shuffle(drafts.filter((one) => one.cohort === 'inner').map((one) => one.index))
      .slice(0, 3),
    ...faker.helpers
      .shuffle(
        drafts
          .filter((one) => one.cohort === 'warm' || one.cohort === 'dormant')
          .map((o) => o.index),
      )
      .slice(0, 3),
  ])
  const muted = new Set(
    faker.helpers
      .shuffle(drafts.filter((one) => one.cohort === 'dormant').map((one) => one.index))
      .slice(0, 4),
  )

  return drafts.map((draft) => {
    const employer = draft.employment.find((one) => one.until === null)
    const org = employer === undefined ? undefined : organizations[employer.organizationIndex]
    const stem = `${asciiHandle(draft.firstName)}.${asciiHandle(draft.lastName)}`

    const email =
      faker.number.float() < 0.09
        ? null
        : emails.take(
            `${stem}@${emailDomainFor(org, faker)}`,
            (base, n) => `${base.split('@')[0] ?? stem}${n}@${base.split('@')[1] ?? 'example.com'}`,
          )

    const linkedinUrl =
      faker.number.float() < 0.2
        ? null
        : linkedin.take(
            `https://www.linkedin.com/in/${asciiHandle(`${draft.firstName} ${draft.lastName}`)}`,
            (base, n) => `${base}-${n}`,
          )

    return {
      index: draft.index,
      firstName: draft.firstName,
      lastName: draft.lastName,
      role: draft.role,
      cohort: draft.cohort,
      place: draft.place,
      employment: draft.employment,
      email,
      phone: faker.number.float() < 0.62 ? phoneNumber(faker, draft.index) : null,
      birthday:
        faker.number.float() < 0.42
          ? addDays(today, -faker.number.int({ min: 8000, max: 21000 }))
          : null,
      areasOfInterest: interestsFor(faker, org),
      asks: asks.get(draft.index) ?? [],
      offers: offers.get(draft.index) ?? [],
      linkedinUrl,
      website: faker.number.float() < 0.12 ? `https://${asciiHandle(stem)}.dev` : null,
      howWeMet: faker.number.float() < 0.72 ? faker.helpers.arrayElement(HOW_WE_MET) : null,
      notes: faker.number.float() < 0.34 ? faker.helpers.arrayElement(NOTES) : null,
      pinnedImportant: pinned.has(draft.index),
      notImportant: muted.has(draft.index),
    }
  })
}

// -------------------------------------------------------------------------------------------
// Interactions
// -------------------------------------------------------------------------------------------

/**
 * The days each cohort's interactions land on, counted back from `today`.
 *
 * This is the whole reason warmth looks like a distribution rather than a constant. The cadences
 * are chosen against ADR-022's calibration — one meeting a month reads 75 — so the four cohorts
 * land roughly at 70+, 35, 15 and 0, which is what a real address book looks like once a few
 * hundred LinkedIn connections are in it.
 */
function daysAgoFor(faker: Faker, cohort: Cohort, ordinal: number): number {
  switch (cohort) {
    case 'inner':
      return Math.max(1, ordinal * 24 + faker.number.int({ min: -6, max: 6 }))
    case 'active':
      return Math.max(3, 12 + ordinal * 60 + faker.number.int({ min: -14, max: 14 }))
    case 'warm':
      return faker.number.int({ min: 40, max: 200 })
    case 'dormant':
      return faker.number.int({ min: 120, max: 760 })
  }
}

const TYPES_BY_COHORT = {
  inner: ['Meeting', 'Call', 'Message', 'Note', 'Event', 'Intro'],
  active: ['Meeting', 'Call', 'Email', 'Message', 'Event', 'Intro', 'Note'],
  warm: ['Email', 'Message', 'Call', 'Event', 'Note'],
  dormant: ['Email', 'Message', 'Event', 'Note'],
} as const satisfies Record<Cohort, readonly InteractionType[]>

/** Which contact each interaction belongs to, laid out so the totals per cohort come out exact. */
function interactionOwners(faker: Faker, contacts: readonly ContactPlan[]): number[][] {
  const owners: number[][] = contacts.map(() => [])

  for (const cohort of COHORTS) {
    const members = faker.helpers.shuffle(
      contacts.filter((one) => one.cohort === cohort).map((one) => one.index),
    )
    const budget = COHORT_PLAN[cohort].interactions
    // Round-robin rather than a random draw: it keeps the per-cohort totals exact and makes the
    // remainder (`budget % members.length` people with one extra) the only source of variation.
    for (let n = 0; n < budget; n += 1) {
      const owner = members[n % members.length]
      if (owner === undefined) break
      owners[owner]?.push(n)
    }
  }
  return owners
}

function planInteractions(
  faker: Faker,
  contacts: readonly ContactPlan[],
  today: CivilDate,
): InteractionPlan[] {
  const owners = interactionOwners(faker, contacts)
  const plans: InteractionPlan[] = []

  contacts.forEach((contact, index) => {
    const ordinals = owners[index] ?? []
    ordinals.forEach((_, ordinal) => {
      const day = addDays(today, -daysAgoFor(faker, contact.cohort, ordinal))
      const type = weightedType(faker, TYPES_BY_COHORT[contact.cohort])
      const employer = contact.employment.find((one) => one.until === null)

      // A second participant about one time in six: a meeting with two people from the same
      // company, which is what makes the interaction→contact table a real many-to-many.
      const others =
        faker.number.float() < 0.17
          ? contacts
              .filter(
                (other) =>
                  other.index !== contact.index &&
                  employer !== undefined &&
                  other.employment.some(
                    (job) =>
                      job.until === null && job.organizationIndex === employer.organizationIndex,
                  ),
              )
              .slice(0, faker.number.int({ min: 1, max: 2 }))
              .map((other) => other.index)
          : []

      plans.push({
        type,
        occurredAt: instantOn(faker, day),
        title: faker.helpers.arrayElement(INTERACTION_TITLES[type]),
        body: faker.number.float() < 0.66 ? faker.helpers.arrayElement(INTERACTION_BODIES) : null,
        contactIndexes: [contact.index, ...others],
        organizationIndexes:
          employer !== undefined && faker.number.float() < 0.55 ? [employer.organizationIndex] : [],
        // A tenth arrived with an import, so the source badge on the timeline has two states and
        // the provenance marker of §4.4 has something to show.
        source: faker.number.float() < 0.1 ? 'import' : 'manual',
      })
    })
  })

  return plans.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
}

// -------------------------------------------------------------------------------------------
// Follow-ups
// -------------------------------------------------------------------------------------------

const RECURRENCES: readonly Recurrence[] = [
  { kind: 'weekly' },
  { kind: 'monthly' },
  { kind: 'every_n_months', n: 3 },
  { kind: 'every_n_months', n: 6 },
  { kind: 'yearly' },
]

/** 12 overdue, 8 due this week, 8 upcoming, 4 snoozed, 8 done — the mix §6.4's tabs need. */
const FOLLOW_UP_MIX = [
  { status: 'Open', count: 12, minDays: -45, maxDays: -1 },
  { status: 'Open', count: 8, minDays: 0, maxDays: 7 },
  { status: 'Open', count: 8, minDays: 8, maxDays: 120 },
  { status: 'Snoozed', count: 4, minDays: 3, maxDays: 30 },
  { status: 'Done', count: 8, minDays: -180, maxDays: -10 },
] as const satisfies readonly {
  status: FollowUpPlan['status']
  count: number
  minDays: number
  maxDays: number
}[]

function planFollowUps(faker: Faker, contacts: readonly ContactPlan[], today: CivilDate) {
  // Follow-ups sit on the people you actually work with, so the dormant cohort mostly has none.
  const pool = faker.helpers.shuffle(
    contacts.filter((one) => one.cohort !== 'dormant' && !one.notImportant).map((one) => one.index),
  )

  const plans: FollowUpPlan[] = []
  let cursor = 0
  for (const bucket of FOLLOW_UP_MIX) {
    for (let n = 0; n < bucket.count; n += 1) {
      const contactIndex = pool[cursor % pool.length] ?? 0
      cursor += 1
      const dueAt = addDays(today, faker.number.int({ min: bucket.minDays, max: bucket.maxDays }))
      const recurring = faker.number.float() < 0.33
      plans.push({
        contactIndex,
        title: faker.helpers.arrayElement(FOLLOW_UP_TITLES),
        dueAt,
        status: bucket.status,
        recurrence: recurring ? faker.helpers.arrayElement(RECURRENCES) : null,
        notes: faker.number.float() < 0.4 ? faker.helpers.arrayElement(FOLLOW_UP_NOTES) : null,
        completedAt:
          bucket.status === 'Done'
            ? instantOn(faker, addDays(dueAt, faker.number.int({ min: 0, max: 4 })))
            : null,
      })
    }
  }
  return plans
}

// -------------------------------------------------------------------------------------------

/**
 * Builds the whole demo network. Pure: same `seed` and same `today` in, same plan out.
 */
export function buildSeedPlan(options: SeedPlanOptions): SeedPlan {
  const seed = options.seed ?? SEED_DEFAULTS.seed
  const faker = new Faker({ locale: [de, en] })
  faker.seed(seed)

  const today = options.today
  const organizations = planOrganizations()
  const contacts = planContacts(faker, organizations, today)
  const interactions = planInteractions(faker, contacts, today)
  const followUps = planFollowUps(faker, contacts, today)

  return { seed, today, organizations, contacts, interactions, followUps }
}

/** The ask↔offer matches a plan actually contains, which is the property worth asserting. */
export interface AskOfferMatch {
  readonly tag: string
  readonly askedBy: readonly number[]
  readonly offeredBy: readonly number[]
}

export function askOfferMatches(plan: SeedPlan): AskOfferMatch[] {
  const asked = new Map<string, number[]>()
  const offered = new Map<string, number[]>()
  for (const contact of plan.contacts) {
    for (const tag of contact.asks) asked.set(tag, [...(asked.get(tag) ?? []), contact.index])
    for (const tag of contact.offers) offered.set(tag, [...(offered.get(tag) ?? []), contact.index])
  }

  return [...asked.entries()]
    .filter(([tag]) => offered.has(tag))
    .map(([tag, askedBy]) => ({ tag, askedBy, offeredBy: offered.get(tag) ?? [] }))
    .sort((a, b) => (a.tag < b.tag ? -1 : 1))
}
