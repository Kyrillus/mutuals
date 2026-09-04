/**
 * The three states of a nullable boolean, and how a key press moves between them.
 *
 * Separated from the component for the same reason as the tag input's model: this is the part
 * with a rule in it, and a rule is worth a test that does not need a browser.
 */

/** `undefined` is a state, not the absence of one — §4.2's `yes_no` is a nullable boolean. */
export type TriState = boolean | undefined

/** Display order, and the order the arrow keys walk. */
export const TRI_STATE_ORDER: readonly TriState[] = [true, false, undefined]

const TRI_STATE_LABELS = new Map<TriState, string>([
  [true, 'Yes'],
  [false, 'No'],
  [undefined, 'Empty'],
])

export function triStateLabel(state: TriState): string {
  return TRI_STATE_LABELS.get(state) ?? 'Empty'
}

/** The next state in the cycle, wrapping in both directions. */
export function cycleTriState(current: TriState, step: 1 | -1 = 1): TriState {
  const at = TRI_STATE_ORDER.indexOf(current)
  const next = (at + step + TRI_STATE_ORDER.length) % TRI_STATE_ORDER.length
  return TRI_STATE_ORDER[next]
}
