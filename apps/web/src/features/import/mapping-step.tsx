/**
 * §6.8 step 3: one card per source column, and the value-mapping editor for the columns that have
 * one.
 *
 * The status on the right is the honest one: a target the cascade *confirmed* reads as auto-mapped,
 * a trigram guess reads as a suggestion, and an unmapped column says it will be skipped rather than
 * looking merely empty. ADR-044 is explicit that only steps 1–5 auto-confirm, and this is where
 * that distinction becomes visible to a person.
 */
import { AlertTriangle, Check, CircleDashed } from 'lucide-react'
import type { ImportBatchDetail } from '@mutuals/core'

import { Badge } from '@/ui/badge.tsx'
import { cn } from '@/lib/utils.ts'

type Batch = ImportBatchDetail['batch']
type Column = Batch['columns'][number]

/** Spreadsheet letters: A, B, … Z, AA. §6.8's reference screenshot shows the column letter. */
function columnLetter(index: number): string {
  let letter = ''
  let n = index
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return letter
}

export function MappingStep({
  batch,
  onChangeColumn,
  onChangeValueMap,
  busy,
}: {
  batch: Batch
  onChangeColumn: (index: number, targetId: string | null) => void
  onChangeValueMap: (targetId: string, value: string, optionKey: string | null) => void
  busy: boolean
}) {
  // A target already claimed by another column cannot be chosen twice — ADR-044's
  // one-column-one-target rule, enforced in the UI so the server never has to refuse it.
  const claimed = new Map(
    batch.columns
      .filter((column) => column.targetId !== null)
      .map((column) => [column.targetId as string, column.index]),
  )

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        {batch.columns.filter((column) => column.targetId !== null).length} of{' '}
        {batch.columns.length} columns mapped. Unmapped columns are skipped.
      </p>

      <ul className="space-y-2">
        {batch.columns.map((column) => (
          <li
            key={column.index}
            className="bg-card flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <span className="text-muted-foreground w-8 shrink-0 text-center text-xs font-medium">
              {columnLetter(column.index)}
            </span>

            <span className="min-w-40 flex-1 truncate text-sm font-medium" title={column.header}>
              {column.header === '' ? (
                <span className="text-muted-foreground italic">no header</span>
              ) : (
                column.header
              )}
            </span>

            <span className="text-muted-foreground shrink-0" aria-hidden>
              →
            </span>

            <select
              className="border-input bg-background h-9 min-w-52 rounded-md border px-2 text-sm"
              aria-label={`Map ${column.header || `column ${columnLetter(column.index)}`} to`}
              value={column.targetId ?? ''}
              disabled={busy}
              onChange={(event) => {
                onChangeColumn(column.index, event.target.value === '' ? null : event.target.value)
              }}
            >
              <option value="">Skip this column</option>
              {batch.targets.map((target) => {
                const takenBy = claimed.get(target.id)
                return (
                  <option
                    key={target.id}
                    value={target.id}
                    disabled={takenBy !== undefined && takenBy !== column.index}
                  >
                    {target.label}
                    {takenBy !== undefined && takenBy !== column.index ? ' — already used' : ''}
                  </option>
                )
              })}
            </select>

            <ColumnStatus column={column} />
          </li>
        ))}
      </ul>

      {batch.valueMappings.length === 0 ? null : (
        <section className="space-y-3 pt-2">
          <h3 className="text-sm font-medium">Values to match up</h3>
          {batch.valueMappings.map((mapping) => {
            const target = batch.targets.find((one) => one.id === mapping.targetId)
            return (
              <div key={mapping.targetId} className="bg-card rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">{target?.label ?? mapping.targetId}</p>
                <ul className="space-y-1.5">
                  {mapping.values.map((value) => (
                    <li key={value.value} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-32 truncate">{value.value}</span>
                      <span className="text-muted-foreground text-xs">
                        {value.count} {value.count === 1 ? 'row' : 'rows'}
                      </span>
                      {value.matchesExistingOption ? (
                        <Badge variant="secondary">matches an existing option</Badge>
                      ) : (
                        <input
                          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                          placeholder="Leave blank to skip"
                          aria-label={`Map "${value.value}" to`}
                          defaultValue={value.mappedTo ?? ''}
                          onBlur={(event) => {
                            const next = event.target.value.trim()
                            onChangeValueMap(
                              mapping.targetId,
                              value.value,
                              next === '' ? null : next,
                            )
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function ColumnStatus({ column }: { column: Column }) {
  if (column.targetId === null) {
    return (
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
        <CircleDashed className="size-3.5" aria-hidden />
        Not mapped — will be skipped
      </span>
    )
  }

  const percent = Math.round(column.fillRate * 100)

  // A trigram match is a *suggestion*, never applied without being seen (ADR-044).
  if (!column.confirmed) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-3.5" aria-hidden />
        Suggested — please check ({percent}% filled)
      </span>
    )
  }

  const inference = column.dateInference
  if (inference?.conflicting === true) {
    return (
      <span className="text-destructive flex shrink-0 items-center gap-1.5 text-xs">
        <AlertTriangle className="size-3.5" aria-hidden />
        Mixed date formats
      </span>
    )
  }
  if (inference?.ambiguous === true) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-3.5" aria-hidden />
        Read as {column.dateFormat ?? 'day/month/year'} — check
      </span>
    )
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-500',
      )}
    >
      <Check className="size-3.5" aria-hidden />
      Auto-mapped ({percent}% filled)
    </span>
  )
}
