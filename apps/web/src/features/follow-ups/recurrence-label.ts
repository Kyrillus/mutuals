import type { Recurrence } from '@mutuals/core'

/**
 * §6.4's recurrence chip. The empty string is "does not repeat", which the table renders as the
 * same subtle placeholder every other empty cell uses rather than as the word "None".
 */
export function recurrenceLabel(recurrence: Recurrence | null): string {
  if (recurrence === null) return ''
  switch (recurrence.kind) {
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'yearly':
      return 'Yearly'
    case 'every_n_days':
      return recurrence.n === 1 ? 'Daily' : `Every ${String(recurrence.n)} days`
    case 'every_n_months':
      return recurrence.n === 1 ? 'Monthly' : `Every ${String(recurrence.n)} months`
  }
}

/** The choices §6.4 lists, plus the two the domain supports that are worth offering. */
export const RECURRENCE_CHOICES: readonly {
  value: string
  label: string
  rule: Recurrence | null
}[] = [
  { value: 'none', label: 'Does not repeat', rule: null },
  { value: 'weekly', label: 'Weekly', rule: { kind: 'weekly' } },
  { value: 'monthly', label: 'Monthly', rule: { kind: 'monthly' } },
  { value: 'every_3_months', label: 'Every 3 months', rule: { kind: 'every_n_months', n: 3 } },
  { value: 'every_6_months', label: 'Every 6 months', rule: { kind: 'every_n_months', n: 6 } },
  { value: 'yearly', label: 'Yearly', rule: { kind: 'yearly' } },
]

export function choiceOf(recurrence: Recurrence | null): string {
  if (recurrence === null) return 'none'
  const match = RECURRENCE_CHOICES.find(
    (choice) => JSON.stringify(choice.rule) === JSON.stringify(recurrence),
  )
  // A custom `every_n_days` rule the picker cannot express still has to round-trip: the dialog
  // shows the nearest choice, and leaving the field alone must not silently rewrite the rule.
  return match?.value ?? 'custom'
}
