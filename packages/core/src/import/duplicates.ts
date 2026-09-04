/**
 * Duplicate detection across a whole import batch (ADR-097).
 *
 * There are two kinds of duplicate in an import and the user should be told them apart, because
 * they read differently: *"you already have this contact"* and *"this file lists this person
 * twice"*. `import_row` therefore carries two pointers, and this module decides which one a row
 * gets.
 *
 * The record kind is easy: `packages/db` probes the identifier index and the trigram index, and
 * `matchDuplicates` scores the pool. The row kind cannot work that way, because at Review time the
 * earlier row has not been committed and has no id to point at. So the earlier rows of the same
 * batch are turned into a synthetic candidate pool and scored by the same function — no second
 * matcher, no second set of thresholds.
 *
 * The two are scored separately rather than in one pool, because their organisation ids are not the
 * same kind of thing. A committed candidate's organisation is a record id; an uncommitted row's is
 * a company *name* that no record exists for yet. Mixing them would make `sharedOrg` compare a uuid
 * against "Northstar Ventures" and quietly always be false, which is the sort of bug that looks
 * like a tuning problem.
 */
import {
  matchDuplicates,
  type CandidatePool,
  type DuplicateMatch,
  type DuplicateObjectType,
  type IdentifierRef,
  type NameCandidate,
} from '../identity/duplicates.ts'
import { NAME_CANDIDATE_THRESHOLD } from '../identity/duplicates.ts'
import { trigramSimilarity } from './header.ts'

export interface BatchRowProbe {
  /** 1-based, matching `import_row.row_number`. */
  readonly rowNumber: number
  readonly objectType: DuplicateObjectType
  /** What the row would be called. Shown on the chip for a row-to-row match. */
  readonly displayName: string
  /** `mutuals_norm(displayName)`, computed by the database. Never produced in TypeScript. */
  readonly nameKey: string
  readonly identifiers: readonly IdentifierRef[]
  readonly emailMatchKeys: readonly string[]
  /** Organisation *records* this row already resolves to, for comparing against committed data. */
  readonly organizationIds: readonly string[]
  /**
   * The organisation as the file spells it, normalised. Used only to compare two uncommitted rows,
   * which is the one case where no record id exists on either side.
   */
  readonly organizationKeys: readonly string[]
}

/** Which of `import_row`'s two mutually exclusive pointers this row gets. */
export type DuplicateTarget =
  | { readonly kind: 'record'; readonly recordId: string }
  | { readonly kind: 'row'; readonly rowNumber: number }

export interface RowDuplicate {
  readonly rowNumber: number
  readonly target: DuplicateTarget
  readonly band: DuplicateMatch['band']
  readonly confidence: number
  readonly rules: readonly DuplicateMatch['rules'][number][]
  /** Rendered on the chip, so the user is told why. */
  readonly evidence: string
  /** The name of the thing it matched, for "Possible duplicate of Anna Berger". */
  readonly label: string
}

const EMPTY_POOL: CandidatePool = { identifierHits: [], nameCandidates: [] }

/**
 * Every row's best duplicate, or `null` where it has none.
 *
 * `recordPools` is indexed by position in `probes`, so the caller can pass what `probeDuplicates`
 * returned straight through.
 */
export function matchBatchRows(
  probes: readonly BatchRowProbe[],
  recordPools: readonly CandidatePool[],
): readonly (RowDuplicate | null)[] {
  return probes.map((probe, index) => {
    const againstRecords = matchDuplicates(
      {
        objectType: probe.objectType,
        nameKey: probe.nameKey,
        identifiers: probe.identifiers,
        emailMatchKeys: probe.emailMatchKeys,
        organizationIds: probe.organizationIds,
      },
      recordPools[index] ?? EMPTY_POOL,
    )

    const earlier = probes.slice(0, index)
    const againstRows = matchDuplicates(
      {
        objectType: probe.objectType,
        nameKey: probe.nameKey,
        identifiers: probe.identifiers,
        emailMatchKeys: probe.emailMatchKeys,
        organizationIds: probe.organizationKeys,
      },
      batchPool(probe, earlier),
    )

    const record = againstRecords.best
    const row = againstRows.best

    // A committed record wins an exact tie: pointing at a real contact tells the user more than
    // pointing at another line of their own file, and it is the pointer that makes a re-import a
    // no-op (§6.8's idempotency requirement).
    if (record !== null && (row === null || record.confidence >= row.confidence)) {
      return {
        rowNumber: probe.rowNumber,
        target: { kind: 'record', recordId: record.recordId },
        band: record.band,
        confidence: record.confidence,
        rules: [...record.rules],
        evidence: record.evidence,
        label: labelFromEvidence(record.evidence),
      }
    }
    if (row === null) return null

    const matchedRow = Number(row.recordId.slice(ROW_ID_PREFIX.length))
    const matched = earlier.find((one) => one.rowNumber === matchedRow)
    return {
      rowNumber: probe.rowNumber,
      target: { kind: 'row', rowNumber: matchedRow },
      band: row.band,
      confidence: row.confidence,
      rules: [...row.rules],
      evidence: row.evidence,
      label: matched?.displayName ?? `row ${String(matchedRow)}`,
    }
  })
}

/**
 * The rows before this one, as a candidate pool.
 *
 * Synthetic ids of the form `row:12` stand in for record ids. `matchDuplicates` never dereferences
 * a candidate's id — it only carries it through to the verdict — so this is a legal use of the same
 * scorer rather than a trick.
 */
const ROW_ID_PREFIX = 'row:'

function batchPool(probe: BatchRowProbe, earlier: readonly BatchRowProbe[]): CandidatePool {
  const identifierHits = []
  const nameCandidates: NameCandidate[] = []

  for (const candidate of earlier) {
    if (candidate.objectType !== probe.objectType) continue
    const id = `${ROW_ID_PREFIX}${String(candidate.rowNumber)}`

    for (const ref of probe.identifiers) {
      if (candidate.identifiers.some((one) => one.kind === ref.kind && one.value === ref.value)) {
        identifierHits.push({ recordId: id, kind: ref.kind, value: ref.value })
      }
    }

    if (probe.nameKey === '' || candidate.nameKey === '') continue
    /**
     * Both sides are already `mutuals_norm` output, so this compares two normalised strings rather
     * than producing one — ADR-019 governs the latter. The implementation is pg_trgm's own and is
     * pinned against Postgres 16 in `header.test.ts`, which is what makes a row-to-row score
     * comparable with the record-to-row scores the database computed.
     */
    const similarity = trigramSimilarity(probe.nameKey, candidate.nameKey)
    if (similarity < NAME_CANDIDATE_THRESHOLD) continue
    nameCandidates.push({
      recordId: id,
      nameKey: candidate.nameKey,
      displayName: candidate.displayName,
      nameSimilarity: similarity,
      organizationIds: candidate.organizationKeys,
      emailMatchKeys: candidate.emailMatchKeys,
    })
  }

  // Names are the fallback and nothing else (§4.6): an identifier hit empties the name pool.
  return identifierHits.length > 0
    ? { identifierHits, nameCandidates: [] }
    : { identifierHits: [], nameCandidates }
}

/**
 * The matched record's name, pulled back out of the evidence string.
 *
 * `DuplicateMatch` carries the rendered evidence but not the candidate's own label, and the name
 * rules all render it as "… of <name>, …" or "… as <name>, …". An identifier match renders no name
 * at all, so the evidence stands in — which is right for a chip that says why.
 */
function labelFromEvidence(evidence: string): string {
  const match = /(?:of|as|to) ([^,:]+)/u.exec(evidence)
  return match?.[1]?.trim() ?? evidence
}

/**
 * Resolves a chain of row-to-row duplicates to the row that will actually land (ADR-097).
 *
 * Pointing at an uncommitted row makes that row's own decision load-bearing: if row 1 is skipped,
 * row 2's "duplicate of row 1" is stale, and a naive implementation imports neither. Three rows for
 * one person with the first two skipped means the third lands.
 *
 * `decisionOf` returns what the user chose for a row, or `undefined` where they have not chosen.
 * A row whose whole chain is skipped resolves to `null` — there is nothing left to merge into.
 */
export function firstKeptRow(
  rowNumber: number,
  duplicateOfRow: (row: number) => number | undefined,
  decisionOf: (row: number) => 'skip' | 'merge' | 'create' | undefined,
): number | null {
  const seen = new Set<number>([rowNumber])
  let current: number | undefined = duplicateOfRow(rowNumber)

  while (current !== undefined) {
    // The `duplicate_of_row < row_number` check makes a cycle impossible in the database; this
    // guard is here so a caller passing hand-built data cannot spin.
    if (seen.has(current)) return null
    seen.add(current)
    if (decisionOf(current) !== 'skip') return current
    current = duplicateOfRow(current)
  }
  return null
}
