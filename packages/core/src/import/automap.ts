/**
 * ADR-044's cascade: source columns to targets, deterministically, with no LLM.
 *
 * Determinism is not taste here — §6.8 requires that re-importing the same export be idempotent,
 * and a mapping that varies between runs breaks that outright. So every step is a total function of
 * the header text, the preset and the workspace's fields, and the fuzzy step is *proposed* rather
 * than confirmed so a guess never lands without someone seeing it.
 *
 * The seven steps, in ADR-044's order: exact header, normalised header, preset knowledge, synonym
 * table, prefix, trigram ≥ 0.72, nothing. Steps 1 to 5 auto-confirm; step 6 does not.
 */
import { normalizeHeader, trigramSimilarity } from './header.ts'
import { inferDateFormat, type DateFormat, type DateFormatInference } from './dates.ts'
import { presetDateFormat, presetTarget, type ImportPreset } from './presets.ts'
import { HEADER_SYNONYMS } from './synonyms.ts'
import { findTarget, type MappingTarget } from './targets.ts'

/** ADR-044's floor. Below it, a trigram match is not offered at all. */
export const FUZZY_THRESHOLD = 0.72

/**
 * ADR-044 fixes the two ends — 0.72 maps to 0.60 and 1.00 to 0.85 — so the auto-confirm boundary is
 * reproducible rather than a feeling. Stated as the line through them.
 */
export function fuzzyConfidence(similarity: number): number {
  const slope = (0.85 - 0.6) / (1 - FUZZY_THRESHOLD)
  return 0.6 + (similarity - FUZZY_THRESHOLD) * slope
}

export const MAPPING_STEPS = [
  'exact',
  'normalized',
  'preset',
  'synonym',
  'prefix',
  'trigram',
  'none',
] as const
export type MappingStep = (typeof MAPPING_STEPS)[number]

/** Only a trigram match arrives unconfirmed; `none` has nothing to confirm. */
const AUTO_CONFIRMED: readonly MappingStep[] = [
  'exact',
  'normalized',
  'preset',
  'synonym',
  'prefix',
]

export interface SourceColumn {
  /** 0-based. The mapping card shows it as a spreadsheet letter. */
  readonly index: number
  readonly header: string
  /** Every cell of this column, in row order. Empty strings included — `fillRate` needs them. */
  readonly cells: readonly string[]
}

export interface ColumnMapping {
  readonly index: number
  readonly header: string
  readonly targetId: string | null
  readonly step: MappingStep
  /** True when the mapping may be applied without asking. False for every trigram match. */
  readonly confirmed: boolean
  readonly confidence: number
  /** §6.8: "% of rows have a value". */
  readonly fillRate: number
  /** Present only for a date target: what the column's cells are read as. */
  readonly dateFormat?: DateFormat
  readonly dateInference?: DateFormatInference
}

interface Proposal {
  readonly column: number
  readonly targetId: string
  readonly step: MappingStep
  readonly confidence: number
}

function stepRank(step: MappingStep): number {
  return MAPPING_STEPS.indexOf(step)
}

/**
 * Every target one column could plausibly mean, best evidence first.
 *
 * A column can produce several proposals — `Email Address` matches `email` by synonym and might
 * also reach `email` by prefix — and the caller keeps the strongest. It never produces two
 * proposals for the same target from the same step.
 */
function proposalsFor(
  column: SourceColumn,
  targets: readonly MappingTarget[],
  preset: ImportPreset,
): Proposal[] {
  const found: Proposal[] = []
  const normalized = normalizeHeader(column.header)
  if (normalized === '') return found

  const push = (targetId: string | undefined, step: MappingStep, confidence: number): void => {
    if (targetId === undefined) return
    if (findTarget(targets, targetId) === undefined) return
    found.push({ column: column.index, targetId, step, confidence })
  }

  // 1. The header is literally the target's slug or its label.
  for (const target of targets) {
    if (column.header === target.id || column.header === target.label) {
      push(target.id, 'exact', 1)
    }
  }

  // 2. The same, once both sides are normalised. This is what turns `First Name` into `first_name`,
  // and `Organization Title` into `organization.title` — the dot normalises to a space too.
  for (const target of targets) {
    if (normalized === normalizeHeader(target.id) || normalized === normalizeHeader(target.label)) {
      push(target.id, 'normalized', 1)
    }
  }

  // 3. What this export is known to call things.
  push(presetTarget(preset, column.header), 'preset', 1)

  // 4. What people call things.
  push(HEADER_SYNONYMS[normalized], 'synonym', 1)

  // 5. `Phone (work)` for `phone`. Word-boundary only, so `Country` never prefixes `County`.
  //
  // Matched on `id` and `label`, never on `slug`: all four parts of a link share one slug, so a
  // slug prefix proposes every part of it. That is how `Organization Department` claimed
  // `organization.from` — it prefixes the shared slug `organization`, and greedy assignment handed
  // it whichever part was still free. Against `id` it prefixes nothing.
  for (const target of targets) {
    for (const candidate of [target.id, target.label]) {
      const stem = normalizeHeader(candidate)
      if (stem.length < 3) continue
      if (normalized === stem) continue
      if (normalized.startsWith(`${stem} `)) push(target.id, 'prefix', 1)
    }
  }

  // 6. Shape, as a last resort — and never confirmed.
  let bestScore = 0
  let bestTarget: string | undefined
  for (const target of targets) {
    for (const candidate of [target.id, target.label]) {
      const score = trigramSimilarity(normalized, normalizeHeader(candidate))
      // Ties keep the earlier target, so the result does not depend on map iteration order.
      if (score > bestScore) {
        bestScore = score
        bestTarget = target.id
      }
    }
  }
  if (bestScore >= FUZZY_THRESHOLD) push(bestTarget, 'trigram', fuzzyConfidence(bestScore))

  return found
}

function fillRate(cells: readonly string[]): number {
  if (cells.length === 0) return 0
  const filled = cells.filter((cell) => cell.trim() !== '').length
  return filled / cells.length
}

/**
 * Maps every source column, with **one target per column and one column per target**.
 *
 * The bijection is the part that matters. Google Contacts has `E-mail 1 - Value` and
 * `E-mail 2 - Value`; without it both map to `email` and the second silently overwrites the first,
 * which is data loss that no error message ever mentions. Proposals are therefore assigned greedily
 * in order of evidence — step first, then column position — so the strongest claim on a target wins
 * and every loser is reported as unmapped rather than as a merge.
 */
export function autoMapColumns(
  columns: readonly SourceColumn[],
  targets: readonly MappingTarget[],
  preset: ImportPreset,
): readonly ColumnMapping[] {
  const proposals = columns
    .flatMap((column) => proposalsFor(column, targets, preset))
    .sort(
      (a, b) =>
        stepRank(a.step) - stepRank(b.step) ||
        b.confidence - a.confidence ||
        a.column - b.column ||
        (a.targetId < b.targetId ? -1 : 1),
    )

  const byColumn = new Map<number, Proposal>()
  const claimed = new Set<string>()
  for (const proposal of proposals) {
    if (byColumn.has(proposal.column) || claimed.has(proposal.targetId)) continue
    byColumn.set(proposal.column, proposal)
    claimed.add(proposal.targetId)
  }

  return Object.freeze(
    columns.map((column) => {
      const chosen = byColumn.get(column.index)
      const base = {
        index: column.index,
        header: column.header,
        fillRate: fillRate(column.cells),
      }
      if (chosen === undefined) {
        return { ...base, targetId: null, step: 'none' as const, confirmed: false, confidence: 0 }
      }

      const target = findTarget(targets, chosen.targetId)
      const mapping: ColumnMapping = {
        ...base,
        targetId: chosen.targetId,
        step: chosen.step,
        confirmed: AUTO_CONFIRMED.includes(chosen.step),
        confidence: chosen.confidence,
      }
      if (target?.valueKind !== 'date') return mapping

      // A date column needs a format before a single cell can be read (ADR-044). The export's own
      // spelling settles it where the preset knows; otherwise the column's cells vote.
      const fromPreset = presetDateFormat(preset, column.header)
      const inference = inferDateFormat(column.cells)
      const format = fromPreset ?? inference.format
      return {
        ...mapping,
        ...(format === null || format === undefined ? {} : { dateFormat: format }),
        /**
         * A preset-declared format is not in question, so it is reported as neither a guess nor a
         * conflict. Cells it cannot read are still wrong — Google writes a birthday with no year as
         * `--09-30` — but they are wrong one row at a time, and the Review grid is where a person
         * fixes a cell. Calling the whole column conflicted would ask them to choose a format when
         * the format is already known and it is the data that is odd.
         */
        dateInference:
          fromPreset === undefined
            ? inference
            : { ...inference, ambiguous: false, conflicting: false },
      }
    }),
  )
}
