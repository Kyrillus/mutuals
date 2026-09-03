import { diffDays, type CivilDate } from './time/civil.ts'

/**
 * Warmth (brief §4.7): how alive a relationship is, 0–100.
 *
 * ```
 * signal = Σ over interactions in the last 365 days of weight(type) × exp(−days_ago / 90)
 * warmth = round(100 × (1 − exp(−k × signal)))
 * ```
 *
 * This is the only implementation (ADR-022). There is deliberately no set-based SQL twin: it would
 * drift from this one within two stages and nothing would notice.
 */

export const INTERACTION_TYPES = [
  'Meeting',
  'Call',
  'Email',
  'Message',
  'Intro',
  'Event',
  'Note',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export const INTERACTION_WEIGHTS = {
  Meeting: 3.0,
  Call: 2.5,
  Event: 2.0,
  Intro: 2.0,
  Note: 1.5,
  Message: 1.0,
  Email: 0.7,
} as const satisfies Record<InteractionType, number>

export const WARMTH_HALF_LIFE_DAYS = 90
export const WARMTH_WINDOW_DAYS = 365

/**
 * Calibrated so that one meeting a month reads 75 **at the moment of the meeting** — thirteen
 * meetings at `days_ago = 0, 30, … 360`:
 *
 * ```
 * CALIBRATION_SIGNAL = 3.0 × Σ(n=0..12) e^(−n/3) = 3.0 × 3.48142954787 = 10.4442886436
 * k                  = ln 4 / CALIBRATION_SIGNAL = 0.132732291152
 * ```
 *
 * The calibration point is a real choice: a monthly cadence oscillates between 75 just after a
 * meeting and 63 just before the next one. "At the meeting" is when a user actually looks, and it
 * keeps the scale conservative — warmth will later drive stay-in-touch nudges, where an inflated
 * score means a missed nudge, the worse failure.
 *
 * The test derives this number from the geometric series rather than retyping it, so the constant,
 * its derivation and the docs cannot drift apart.
 */
export const WARMTH_K = 0.13273229

export const WARMTH_PINNED_FLOOR = 60
export const WARMTH_NOT_IMPORTANT_CAP = 10

export interface WarmthInteraction {
  /** Free-form on purpose: an unknown type contributes 0 rather than throwing (see below). */
  readonly type: string
  /** The civil day the interaction happened on, in the profile timezone. */
  readonly occurredOn: CivilDate
}

export interface WarmthOverrides {
  readonly pinnedImportant: boolean
  readonly notImportant: boolean
}

export interface WarmthResult {
  /** 0–100, integer, after the overrides. */
  readonly warmth: number
  /** 0–100, integer, before the overrides — the "why" popover shows both. */
  readonly rawWarmth: number
  readonly signal: number
  /** Interactions that fell inside the 365-day window. */
  readonly counted: number
}

function weightOf(type: string): number {
  return Object.hasOwn(INTERACTION_WEIGHTS, type)
    ? INTERACTION_WEIGHTS[type as InteractionType]
    : /* an unknown type is possible via the API and the Stage-6 LLM path; totality beats a throw */ 0
}

/**
 * Computes a contact's warmth. Pure: `today` is injected, so the nightly sweep and an on-demand
 * recompute agree, and a test asserts an exact integer rather than a range.
 *
 * Decay runs on **whole civil days**, so a contact whose interactions have not changed produces
 * the same number tonight as last night and the sweep's write-back only touches rows that moved.
 * Future-dated interactions are clamped to `days_ago = 0`, not dropped: booking time with somebody
 * is a real signal, and dropping it would make warmth fall when you schedule a meeting.
 */
export function computeWarmth(
  interactions: readonly WarmthInteraction[],
  overrides: WarmthOverrides,
  today: CivilDate,
): WarmthResult {
  let signal = 0
  let counted = 0

  for (const interaction of interactions) {
    const daysAgo = diffDays(today, interaction.occurredOn)
    if (daysAgo > WARMTH_WINDOW_DAYS) continue
    counted += 1
    const decayed = Math.exp(-Math.max(daysAgo, 0) / WARMTH_HALF_LIFE_DAYS)
    signal += weightOf(interaction.type) * decayed
  }

  const rawWarmth = Math.round(100 * (1 - Math.exp(-WARMTH_K * signal)))

  // Cap beats floor: `not_important` also means "stay quiet", and staying quiet is the safe
  // failure when the API lets both flags be set at once.
  const floored = Math.max(overrides.pinnedImportant ? WARMTH_PINNED_FLOOR : 0, rawWarmth)
  const warmth = Math.min(overrides.notImportant ? WARMTH_NOT_IMPORTANT_CAP : 100, floored)

  return { warmth, rawWarmth, signal, counted }
}
