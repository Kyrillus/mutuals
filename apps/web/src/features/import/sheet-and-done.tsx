/**
 * §6.8 step 2 (Sheet) and step 5 (Done).
 *
 * Both are small enough that a file each would be filing rather than structure.
 */
import { CheckCircle2, Download, XCircle } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { ImportBatchDetail } from '@mutuals/core'

import { Button } from '@/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

type Batch = ImportBatchDetail['batch']

/**
 * Step 2. Only ever shown for a workbook with more than one sheet.
 *
 * Choosing a different sheet re-uploads the file: the server stages rows rather than keeping the
 * upload (ADR-054), and the browser still holds the file it just picked. That is why this takes the
 * `File` rather than only the batch.
 */
export function SheetStep({
  batch,
  onChoose,
  busy,
}: {
  batch: Batch
  onChoose: (sheetName: string) => void
  busy: boolean
}) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        That workbook has {batch.sheets.length} sheets. Which one holds the {batch.objectType}s?
      </p>
      <ul className="space-y-2">
        {batch.sheets.map((sheet) => {
          const chosen = sheet.name === batch.sheetName
          return (
            <li key={sheet.name}>
              <button
                type="button"
                disabled={busy}
                aria-pressed={chosen}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors',
                  chosen ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                )}
                onClick={() => {
                  if (!chosen) onChoose(sheet.name)
                }}
              >
                <span className="block text-sm font-medium">{sheet.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {sheet.rowCount} {sheet.rowCount === 1 ? 'row' : 'rows'}, {sheet.columnCount}{' '}
                  columns
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Step 5's result screen: what landed, what did not, and where to go next. */
export function DoneStep({
  batch,
  onDownloadReport,
  busy,
}: {
  batch: Batch
  onDownloadReport: () => void
  busy: boolean
}) {
  const failed = batch.status === 'failed'
  const running = batch.status === 'importing'
  const detail = batch.errorDetail as { message?: string } | null

  /**
   * §6.8's progress bar, from `last_committed_row` — the marker ADR-061 advances per chunk so a
   * failed import can be resumed. It is the honest number: it counts rows that are actually in the
   * database, not rows that have been read.
   */
  if (running) {
    const done =
      batch.rowCount === 0 ? 0 : Math.round((batch.lastCommittedRow / batch.rowCount) * 100)
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Importing…</h2>
        <div
          className="bg-muted h-2 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Import progress"
        >
          <div className="bg-primary h-full transition-all" style={{ width: `${String(done)}%` }} />
        </div>
        <p className="text-muted-foreground text-sm">
          {batch.lastCommittedRow} of {batch.rowCount} rows.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        {failed ? (
          <XCircle className="text-destructive mt-0.5 size-6 shrink-0" aria-hidden />
        ) : (
          <CheckCircle2
            className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-500"
            aria-hidden
          />
        )}
        <div>
          <h2 className="text-lg font-medium">
            {failed ? 'The import stopped part way' : 'Import finished'}
          </h2>
          <p className="text-muted-foreground text-sm">
            {failed
              ? `${String(batch.lastCommittedRow)} of ${String(batch.rowCount)} rows had already been applied. ${detail?.message ?? ''}`
              : `From ${batch.fileName}.`}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {(
          [
            ['Created', batch.createdCount],
            ['Merged', batch.mergedCount],
            ['Skipped', batch.skippedCount],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="bg-card rounded-lg border p-3">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-2xl font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        {/*
          §6.8: the result screen links to the filtered table. `import_batch_id` is a real system
          field (§4.4), so this is the ordinary filter model rather than a special screen.
        */}
        <Button asChild>
          <Link
            to={batch.objectType === 'organization' ? '/organizations' : '/contacts'}
            // A structured array, not a JSON string: the router stringifies it, which is what
            // makes the result `?filter=[{…}]` — ADR-032's shape — rather than a quoted string.
            search={{ filter: [{ field: 'import_batch_id', op: 'equals', value: batch.id }] }}
          >
            See what was imported
          </Link>
        </Button>

        {batch.skippedCount === 0 ? null : (
          <Button variant="outline" onClick={onDownloadReport} disabled={busy}>
            <Download aria-hidden />
            Download the rows that were skipped
          </Button>
        )}
      </div>
    </div>
  )
}
