import { IDENTIFIER_KINDS, type IdentifierKind } from '../attributes/kinds.ts'
import { assertNever } from '../result.ts'

/**
 * Duplicate matching (brief §4.6, §6.8, §6.9): identifiers first, names only as the fallback,
 * never the other way round.
 *
 * One implementation, three call sites — the import review grid, the quick-capture preview and
 * the merge dialog. The importer deliberately does not get its own "is this the same person"
 * logic; that is how two answers to one question start diverging.
 *
 * Core does no I/O. Candidate generation *and* trigram scoring happen in SQL (ADR-019), so the
 * caller hands over already-scored candidates: `nameKey` is `mutuals_norm(display_label)` on both
 * sides and `nameSimilarity` is `pg_trgm`'s `similarity()`. That is what keeps the threshold used
 * to fetch candidates and the threshold used to score them the same number.
 */

export type { IdentifierKind }

export type DuplicateObjectType = 'contact' | 'organization'

/**
 * Per-kind identity strength. Scoring rather than returning a boolean is the whole point: the
 * import flow offers a bulk Skip/Merge for one band and a per-row question for another.
 *
 * `phone` is 0.80 flat because `/min` cannot tell a mobile from a landline (ADR-035) and landlines
 * are shared by households and switchboards. `other` sits at the same 0.80: an unrecognised handle
 * is usually personal, but "usually" is exactly what 0.80 means here.
 */
export const IDENTIFIER_CONFIDENCE = {
  google_contact_id: 0.99,
  linkedin_url: 0.99,
  email: 0.97,
  telegram: 0.95,
  whatsapp: 0.95,
  website: 0.95,
  phone: 0.8,
  other: 0.8,
} as const satisfies Record<IdentifierKind, number>

/** Noisy-or across many kinds still leaves room for doubt; nothing here is ever 1.0. */
export const MAX_COMBINED_CONFIDENCE = 0.995

export const BAND_THRESHOLDS = { certain: 0.95, probable: 0.8, possible: 0.6 } as const

/**
 * `certain` additionally requires one *single* identifier at 0.95 or better. Without this gate,
 * two colleagues sharing a switchboard and a shared office line (0.80 each — the value chosen
 * precisely because switchboards are shared) combine noisy-or to 0.96 and get auto-classified as
 * certainly the same person, in the band the import flow offers a bulk Merge for. Noisy-or assumes
 * independent evidence, and two numbers on one PBX are the least independent evidence in the
 * dataset.
 */
export const NO_STRONG_IDENTIFIER_CAP = 0.94

/**
 * The similarity `name_fuzzy_org_same` requires — the *scoring* threshold, and 0.65 on measured
 * evidence rather than the 0.75 that stood here unjustified until Stage 5.
 *
 * Measured with `mutuals_norm` and pg_trgm on Postgres 16, over the deliberate collisions in
 * `fixtures/linkedin_connections_sample.csv` and a set of pairs that are *not* the same person:
 *
 * | same person                            |        | different people                  |        |
 * | -------------------------------------- | ------ | --------------------------------- | ------ |
 * | Björn Håkansson / Bjoern Hakansson     | 0.7368 | Rüdiger Weiß / Rudiger Weiss jr   | 0.8235 |
 * | Ekaterina Volkova / Ekatarina Volkova  | 0.7143 | Wei Zhang / Wei Zhao              | 0.5833 |
 * | Lukas Müller / Lukas Mueller           | 0.6875 | Jan Müller / Jan Möller           | 0.5714 |
 * | Jonas Weber / J. Weber                 | 0.5385 | Anna Berger / Anna Bergmann       | 0.5625 |
 *
 * Two things follow. There is an empty gap between 0.5833 and 0.6875, so 0.65 admits three true
 * pairs and no new false one — whereas 0.75 sat *above* two duplicates the fixture was built to
 * contain. And the highest score in the table is a false positive, so no threshold separates these
 * sets on similarity alone: this rule additionally requires the same organisation, and its
 * confidence of 0.74 lands in `possible`, where §14's Q4 has the user asked rather than the row
 * silently skipped. A false positive therefore costs one question; a miss costs a duplicate contact,
 * which is the failure the wizard exists to prevent.
 */
export const FUZZY_NAME_THRESHOLD = 0.65

/**
 * The similarity a record needs to enter the candidate pool at all — the *generation* threshold.
 *
 * Deliberately below every scoring rule, because generation asks "who could this be" and scoring
 * decides. Using one number for both made `name_initial_org_same` unreachable in production: "Jonas
 * Weber" and "J. Weber" score 0.5385, so the candidate never arrived and `isInitialForm` — which
 * exists for exactly that case, and is unit-tested — could never run. Below 0.45 the pool starts
 * filling with people who merely share a first name (0.3889 for two siblings), which costs the
 * scan without ever changing a verdict.
 */
export const NAME_CANDIDATE_THRESHOLD = 0.45

export const MAX_MATCHES = 5

export type MatchBand = 'certain' | 'probable' | 'possible'

export type RuleId =
  | 'identifier'
  | 'name_exact_org_same'
  | 'email_local_match'
  | 'name_fuzzy_org_same'
  | 'name_initial_org_same'
  | 'name_exact_city_same'
  | 'name_exact_org_unknown'
  | 'name_exact_org_diff'

export interface IdentifierRef {
  readonly kind: IdentifierKind
  readonly value: string
}

export interface DuplicateInput {
  readonly objectType: DuplicateObjectType
  /** `mutuals_norm(display_label)`, computed in SQL for both sides. */
  readonly nameKey: string
  readonly identifiers: readonly IdentifierRef[]
  readonly emailMatchKeys: readonly string[]
  /** Current organisation links only — a former employer is not evidence of identity. */
  readonly organizationIds: readonly string[]
  readonly cityKey?: string
}

export interface IdentifierHit {
  readonly recordId: string
  readonly kind: IdentifierKind
  readonly value: string
}

export interface NameCandidate {
  readonly recordId: string
  readonly nameKey: string
  readonly displayName: string
  /** `similarity(label_norm, mutuals_norm($name))`, from the candidate query. */
  readonly nameSimilarity: number
  readonly organizationIds: readonly string[]
  readonly emailMatchKeys: readonly string[]
  readonly cityKey?: string
}

/** What the caller fetched from the database. */
export interface CandidatePool {
  /** Exact hits on `identifier (kind, value)` — one index probe per identifier. */
  readonly identifierHits: readonly IdentifierHit[]
  /** Name-similarity hits. Only consulted when no identifier scored. */
  readonly nameCandidates: readonly NameCandidate[]
}

export interface DuplicateMatch {
  readonly recordId: string
  readonly confidence: number
  readonly band: MatchBand
  readonly rules: readonly RuleId[]
  /** Rendered on the chip, so the user is told *why*: "Same email: anna@northstar.vc". */
  readonly evidence: string
}

export interface DuplicateVerdict {
  readonly best: DuplicateMatch | null
  readonly matches: readonly DuplicateMatch[]
  readonly usedFallback: boolean
}

const KIND_LABELS: Readonly<Record<IdentifierKind, string>> = {
  email: 'email',
  phone: 'phone number',
  linkedin_url: 'LinkedIn profile',
  website: 'website',
  google_contact_id: 'Google contact',
  telegram: 'Telegram handle',
  whatsapp: 'WhatsApp number',
  other: 'handle',
}

/**
 * How much a shared identifier of this kind says about identity.
 *
 * A website is worth nothing on a *contact*: colleagues share one, and treating that as identity
 * would merge whole teams into a single person.
 */
export function identifierConfidence(
  kind: IdentifierKind,
  objectType: DuplicateObjectType,
): number {
  if (kind === 'website' && objectType === 'contact') return 0
  return IDENTIFIER_CONFIDENCE[kind]
}

export function bandFor(confidence: number): MatchBand | null {
  if (confidence >= BAND_THRESHOLDS.certain) return 'certain'
  if (confidence >= BAND_THRESHOLDS.probable) return 'probable'
  if (confidence >= BAND_THRESHOLDS.possible) return 'possible'
  return null
}

function tokens(nameKey: string): string[] {
  return nameKey
    .split(/[\s,]+/u)
    .map((token) => token.replace(/\./gu, ''))
    .filter((token) => token !== '')
}

/**
 * True when one name is the other with a first name abbreviated: "a berger" and "anna berger".
 * Both sides are already normalised, so this is a token comparison and not a fold.
 */
export function isInitialForm(a: string, b: string): boolean {
  const left = tokens(a)
  const right = tokens(b)
  if (left.length < 2 || right.length < 2) return false
  if (left[left.length - 1] !== right[right.length - 1]) return false
  const leftFirst = left[0] ?? ''
  const rightFirst = right[0] ?? ''
  if (leftFirst === rightFirst) return false
  if (leftFirst.length === 1) return rightFirst.startsWith(leftFirst)
  if (rightFirst.length === 1) return leftFirst.startsWith(rightFirst)
  return false
}

function shareAny(a: readonly string[], b: readonly string[]): string | null {
  const known = new Set(a)
  for (const value of b) if (known.has(value)) return value
  return null
}

interface IdentifierScore {
  readonly confidence: number
  readonly strongest: number
  readonly evidence: string
}

function scoreIdentifiers(
  input: DuplicateInput,
  hits: readonly IdentifierHit[],
): IdentifierScore | null {
  // Max within a kind, noisy-or across distinct kinds: two email addresses on one record are one
  // piece of evidence, an email plus a phone number are two.
  const bestByKind = new Map<IdentifierKind, { confidence: number; value: string }>()
  for (const hit of hits) {
    const confidence = identifierConfidence(hit.kind, input.objectType)
    if (confidence <= 0) continue
    const current = bestByKind.get(hit.kind)
    if (current === undefined || confidence > current.confidence) {
      bestByKind.set(hit.kind, { confidence, value: hit.value })
    }
  }
  if (bestByKind.size === 0) return null

  let inverse = 1
  let strongest = 0
  const reasons: string[] = []
  for (const kind of IDENTIFIER_KINDS) {
    const entry = bestByKind.get(kind)
    if (entry === undefined) continue
    inverse *= 1 - entry.confidence
    strongest = Math.max(strongest, entry.confidence)
    reasons.push(`Same ${KIND_LABELS[kind]}: ${entry.value}`)
  }

  let confidence = Math.min(1 - inverse, MAX_COMBINED_CONFIDENCE)
  if (confidence >= BAND_THRESHOLDS.certain && strongest < BAND_THRESHOLDS.certain) {
    confidence = NO_STRONG_IDENTIFIER_CAP
  }
  return { confidence, strongest, evidence: reasons.join('; ') }
}

interface FallbackRule {
  readonly id: RuleId
  readonly confidence: number
  readonly matches: (input: DuplicateInput, candidate: NameCandidate) => boolean
  readonly evidence: (input: DuplicateInput, candidate: NameCandidate) => string
}

function sharedOrg(input: DuplicateInput, candidate: NameCandidate): boolean {
  return shareAny(input.organizationIds, candidate.organizationIds) !== null
}

function sameName(input: DuplicateInput, candidate: NameCandidate): boolean {
  return input.nameKey !== '' && input.nameKey === candidate.nameKey
}

function neitherHasOrg(input: DuplicateInput, candidate: NameCandidate): boolean {
  return input.organizationIds.length === 0 && candidate.organizationIds.length === 0
}

/**
 * The fallback, in order; the first rule that matches wins, so every result has exactly one
 * explainable reason. A weighted score would need labelled data nobody has, and the import chip
 * has to print a *because*.
 *
 * Nothing here can reach 0.95, which is the mechanical form of "identifiers first": a name match
 * is never certain.
 */
const FALLBACK_RULES: readonly FallbackRule[] = [
  {
    id: 'name_exact_org_same',
    confidence: 0.88,
    matches: (input, candidate) => sameName(input, candidate) && sharedOrg(input, candidate),
    evidence: (_input, candidate) => `Same name as ${candidate.displayName}, same organisation`,
  },
  {
    id: 'email_local_match',
    confidence: 0.85,
    matches: (input, candidate) =>
      shareAny(input.emailMatchKeys, candidate.emailMatchKeys) !== null,
    evidence: (input, candidate) =>
      `Email variant of ${candidate.displayName}: ${shareAny(input.emailMatchKeys, candidate.emailMatchKeys) ?? ''}`,
  },
  {
    id: 'name_fuzzy_org_same',
    confidence: 0.74,
    matches: (input, candidate) =>
      candidate.nameSimilarity >= FUZZY_NAME_THRESHOLD && sharedOrg(input, candidate),
    evidence: (_input, candidate) => `Similar name to ${candidate.displayName}, same organisation`,
  },
  {
    id: 'name_initial_org_same',
    confidence: 0.7,
    matches: (input, candidate) =>
      isInitialForm(input.nameKey, candidate.nameKey) && sharedOrg(input, candidate),
    evidence: (_input, candidate) =>
      `Abbreviated name of ${candidate.displayName}, same organisation`,
  },
  {
    id: 'name_exact_city_same',
    confidence: 0.66,
    matches: (input, candidate) =>
      sameName(input, candidate) &&
      neitherHasOrg(input, candidate) &&
      input.cityKey !== undefined &&
      input.cityKey === candidate.cityKey,
    evidence: (input, candidate) =>
      `Same name as ${candidate.displayName}, both in ${input.cityKey ?? ''}`,
  },
  {
    id: 'name_exact_org_unknown',
    confidence: 0.62,
    matches: (input, candidate) => sameName(input, candidate) && neitherHasOrg(input, candidate),
    evidence: (_input, candidate) =>
      `Same name as ${candidate.displayName}, no organisation on either record`,
  },
  {
    id: 'name_exact_org_diff',
    // Two different people who share a name. Scored, so it is visible in a test, and below the
    // surfacing floor, so it never reaches the user.
    confidence: 0.3,
    matches: (input, candidate) =>
      sameName(input, candidate) &&
      input.organizationIds.length > 0 &&
      candidate.organizationIds.length > 0 &&
      !sharedOrg(input, candidate),
    evidence: (_input, candidate) =>
      `Same name as ${candidate.displayName}, different organisation`,
  },
]

export interface FallbackScore {
  readonly rule: RuleId
  readonly confidence: number
  readonly evidence: string
}

/**
 * The fallback score for one candidate, before the surfacing floor is applied. Exported so every
 * row of the rule table can be asserted -- including `name_exact_org_diff`, which exists precisely
 * to be scored and *not* shown.
 */
export function scoreNameFallback(
  input: DuplicateInput,
  candidate: NameCandidate,
): FallbackScore | null {
  const rule = FALLBACK_RULES.find((r) => r.matches(input, candidate))
  if (rule === undefined) return null
  return { rule: rule.id, confidence: rule.confidence, evidence: rule.evidence(input, candidate) }
}

function byConfidenceThenId(a: DuplicateMatch, b: DuplicateMatch): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0
}

/**
 * Decides whether the record described by `input` already exists.
 *
 * Bands: `certain` at 0.95 and above (and only with one identifier that strong), `probable` from
 * 0.80, `possible` from 0.60. Below 0.60 nothing is surfaced at all.
 */
export function matchDuplicates(input: DuplicateInput, pool: CandidatePool): DuplicateVerdict {
  const byRecord = new Map<string, IdentifierHit[]>()
  for (const hit of pool.identifierHits) {
    const bucket = byRecord.get(hit.recordId)
    if (bucket === undefined) byRecord.set(hit.recordId, [hit])
    else bucket.push(hit)
  }

  const identifierMatches: DuplicateMatch[] = []
  for (const [recordId, hits] of byRecord) {
    const scored = scoreIdentifiers(input, hits)
    if (scored === null) continue
    const band = bandFor(scored.confidence)
    if (band === null) continue
    identifierMatches.push({
      recordId,
      confidence: scored.confidence,
      band,
      rules: ['identifier'],
      evidence: scored.evidence,
    })
  }

  if (identifierMatches.length > 0) {
    const matches = identifierMatches.sort(byConfidenceThenId).slice(0, MAX_MATCHES)
    return { best: matches[0] ?? null, matches, usedFallback: false }
  }

  // Only now, and only because no identifier said anything (§4.6: names are never the first
  // check). A shared company website among colleagues scores nothing, so it does not block this.
  const fallbackMatches: DuplicateMatch[] = []
  for (const candidate of pool.nameCandidates) {
    const scored = scoreNameFallback(input, candidate)
    if (scored === null) continue
    const band = bandFor(scored.confidence)
    if (band === null) continue
    fallbackMatches.push({
      recordId: candidate.recordId,
      confidence: scored.confidence,
      band,
      rules: [scored.rule],
      evidence: scored.evidence,
    })
  }

  const matches = fallbackMatches.sort(byConfidenceThenId).slice(0, MAX_MATCHES)
  return { best: matches[0] ?? null, matches, usedFallback: true }
}

/** The chip's wording for a band, so the import grid and the merge dialog say the same thing. */
export function describeBand(band: MatchBand): string {
  switch (band) {
    case 'certain':
      return 'Duplicate of'
    case 'probable':
      return 'Probable duplicate of'
    case 'possible':
      return 'Possible duplicate of'
    default:
      return assertNever(band, 'match band')
  }
}
