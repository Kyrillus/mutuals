/**
 * §6.8 step 4: the editable grid, the error tabs, find-and-replace, and the duplicate decisions.
 *
 * The duplicate wording is Q4's answer made visible. A flagged row is not silently skipped and not
 * silently merged: it is asked about, in as many words, with **not importing** as what happens if
 * the question goes unanswered. The two kinds of duplicate get different sentences, because "you
 * already have this contact" and "this file lists this person twice" are different problems with
 * different right answers (ADR-097).
 */
import { useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type { ImportBatchDetail } from '@mutuals/core'

import { Badge } from '@/ui/badge.tsx'
import { Button } from '@/ui/button.tsx'
import { Input } from '@/ui/input.tsx'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs.tsx'
import { cn } from '@/lib/utils.ts'

type Batch = ImportBatchDetail['batch']
type Row = ImportBatchDetail['rows'][number]

export type ReviewTab = 'all' | 'errors' | 'duplicates'

export function ReviewStep({
  batch,
  rows,
  tab,
  onTabChange,
  onEdit,
  onRevert,
  onDecide,
  onBulkDecide,
  onReplace,
  busy,
}: {
  batch: Batch
  rows: readonly Row[]
  tab: ReviewTab
  onTabChange: (next: ReviewTab) => void
  onEdit: (rowNumber: number, targetId: string, value: string) => void
  onRevert: (rowNumber: number) => void
  onDecide: (rowNumber: number, decision: string | null) => void
  onBulkDecide: (decision: string) => void
  onReplace: (input: { targetId: string; find: string; replace: string }) => void
  busy: boolean
}) {
  const mapped = batch.columns.filter((column) => column.targetId !== null)
  const labelFor = (targetId: string): string =>
    batch.targets.find((target) => target.id === targetId)?.label ?? targetId

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onValueChange={(next) => {
          onTabChange(next as ReviewTab)
        }}
      >
        <TabsList>
          <TabsTrigger value="all">All rows ({batch.counts.total})</TabsTrigger>
          <TabsTrigger value="errors">Error rows ({batch.counts.withErrors})</TabsTrigger>
          <TabsTrigger value="duplicates">
            Possible duplicates ({batch.counts.duplicates})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <FindAndReplace batch={batch} onReplace={onReplace} busy={busy} labelFor={labelFor} />

      {batch.counts.duplicates === 0 ? null : (
        <div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-3">
          {/*
            Deliberately not "people you already have". A batch can hold both kinds of duplicate at
            once (ADR-097), and on a first import into an empty workspace *every* one of them is a
            repeat inside the file — so a banner that says "already have" would be plainly wrong on
            the commonest path. The per-row question says which kind it is; the banner only counts.
          */}
          <p className="flex-1 text-sm">
            <strong>
              {batch.counts.duplicates}{' '}
              {batch.counts.duplicates === 1
                ? 'row looks like a duplicate'
                : 'rows look like duplicates'}
            </strong>{' '}
            — decide row by row, or choose for all of them at once. Rows you do not decide are{' '}
            <strong>not imported</strong>.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onBulkDecide('skip')
              }}
            >
              Skip all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onBulkDecide('merge')
              }}
            >
              Merge all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onBulkDecide('create')
              }}
            >
              Import all anyway
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-max text-sm" aria-label="Rows to review">
          <thead className="bg-muted/50">
            <tr>
              <th
                scope="col"
                className="text-muted-foreground w-12 px-3 py-2 text-left font-medium"
              >
                #
              </th>
              {mapped.map((column) => (
                <th
                  key={column.index}
                  scope="col"
                  className="min-w-40 px-3 py-2 text-left font-medium"
                >
                  {labelFor(column.targetId as string)}
                </th>
              ))}
              <th scope="col" className="min-w-64 px-3 py-2 text-left font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ReviewRow
                key={row.rowNumber}
                row={row}
                columns={mapped}
                onEdit={onEdit}
                onRevert={onRevert}
                onDecide={onDecide}
                busy={busy}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">Nothing here.</p>
        ) : null}
      </div>
    </div>
  )
}

function ReviewRow({
  row,
  columns,
  onEdit,
  onRevert,
  onDecide,
  busy,
}: {
  row: Row
  columns: readonly Batch['columns'][number][]
  onEdit: (rowNumber: number, targetId: string, value: string) => void
  onRevert: (rowNumber: number) => void
  onDecide: (rowNumber: number, decision: string | null) => void
  busy: boolean
}) {
  const errorFor = (targetId: string): string | undefined =>
    row.errors.find((error) => error.path[0] === targetId)?.message

  // Q4: undecided means it does not land, so the row is dimmed rather than looking ready.
  const willSkip =
    row.errors.length > 0 ||
    (row.duplicate !== null && row.decision !== 'create' && row.decision !== 'merge')

  return (
    <tr
      className={cn('border-t align-top', willSkip && 'bg-muted/20')}
      // The row's own name, so `getByRole('row', { name: /Berger/ })` finds it.
      aria-label={displayNameOf(row)}
    >
      <td className="text-muted-foreground px-3 py-2 tabular-nums">{row.rowNumber}</td>

      {columns.map((column) => {
        const targetId = column.targetId as string
        const error = errorFor(targetId)
        const value = row.mapped[targetId]
        return (
          <td key={column.index} className="px-1.5 py-1.5">
            <Input
              className={cn('h-8', error !== undefined && 'border-destructive')}
              aria-label={`Row ${String(row.rowNumber)} ${targetId}`}
              aria-invalid={error !== undefined}
              defaultValue={typeof value === 'string' ? value : stringify(value)}
              disabled={busy}
              onBlur={(event) => {
                const next = event.target.value
                const before = typeof value === 'string' ? value : stringify(value)
                if (next !== before) onEdit(row.rowNumber, targetId, next)
              }}
            />
            {error === undefined ? null : (
              <span className="text-destructive mt-0.5 block text-xs">{error}</span>
            )}
          </td>
        )
      })}

      <td className="px-3 py-2">
        <div className="flex flex-col gap-1.5">
          {row.errors.length > 0 ? (
            <span className="text-destructive flex items-center gap-1.5 text-xs">
              <AlertTriangle className="size-3.5" aria-hidden />
              Fix this row or it will be skipped
            </span>
          ) : null}

          {row.duplicate === null ? null : (
            <DuplicateChoice row={row} onDecide={onDecide} busy={busy} />
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-fit gap-1 px-1.5 text-xs"
            disabled={busy}
            onClick={() => {
              onRevert(row.rowNumber)
            }}
          >
            <RotateCcw className="size-3" aria-hidden />
            Undo edits
          </Button>
        </div>
      </td>
    </tr>
  )
}

/**
 * The question Q4 asks, in as many words.
 *
 * "Do you really want to import it?" rather than a silent skip, so the person sees *why* a row did
 * not land — and the default, if they never answer, is that it does not.
 */
function DuplicateChoice({
  row,
  onDecide,
  busy,
}: {
  row: Row
  onDecide: (rowNumber: number, decision: string | null) => void
  busy: boolean
}) {
  const duplicate = row.duplicate
  if (duplicate === null) return null

  const question =
    duplicate.kind === 'record'
      ? `This looks like a contact you already have — ${duplicate.label}. Do you really want to import it?`
      : `This file lists this person more than once — see row ${String(duplicate.rowNumber ?? '')}. Do you really want to import it again?`

  return (
    <div className="space-y-1">
      <Badge variant={duplicate.band === 'certain' ? 'destructive' : 'secondary'}>
        {duplicate.band === 'certain'
          ? 'Almost certainly a duplicate'
          : duplicate.band === 'probable'
            ? 'Probably a duplicate'
            : 'Possible duplicate'}
      </Badge>
      <p className="text-xs">{question}</p>
      <p className="text-muted-foreground text-xs">{duplicate.evidence}</p>
      <div className="flex flex-wrap gap-1 pt-0.5">
        {(
          [
            ['skip', "Don't import"],
            ['merge', 'Fill in blanks'],
            ['create', 'Import anyway'],
          ] as const
        ).map(([decision, label]) => (
          <Button
            key={decision}
            size="sm"
            variant={row.decision === decision ? 'default' : 'outline'}
            className="h-6 px-2 text-xs"
            disabled={busy}
            aria-pressed={row.decision === decision}
            onClick={() => {
              onDecide(row.rowNumber, row.decision === decision ? null : decision)
            }}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function FindAndReplace({
  batch,
  onReplace,
  busy,
  labelFor,
}: {
  batch: Batch
  onReplace: (input: { targetId: string; find: string; replace: string }) => void
  busy: boolean
  labelFor: (targetId: string) => string
}) {
  const mapped = batch.columns.filter((column) => column.targetId !== null)
  const [targetId, setTargetId] = useState(mapped[0]?.targetId ?? '')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')

  if (mapped.length === 0) return null

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (find !== '') onReplace({ targetId, find, replace })
      }}
    >
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground block">In</span>
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="Column to replace in"
          value={targetId}
          onChange={(event) => {
            setTargetId(event.target.value)
          }}
        >
          {mapped.map((column) => (
            <option key={column.index} value={column.targetId as string}>
              {labelFor(column.targetId as string)}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground block">Find</span>
        <Input
          className="h-8 w-40"
          value={find}
          onChange={(event) => {
            setFind(event.target.value)
          }}
        />
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground block">Replace with</span>
        <Input
          className="h-8 w-40"
          value={replace}
          onChange={(event) => {
            setReplace(event.target.value)
          }}
        />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={busy || find === ''}>
        Replace all
      </Button>
    </form>
  )
}

function displayNameOf(row: Row): string {
  const first = row.mapped['first_name']
  const last = row.mapped['last_name']
  const name = [typeof first === 'string' ? first : '', typeof last === 'string' ? last : '']
    .join(' ')
    .trim()
  if (name !== '') return name
  const label = row.mapped['name']
  return typeof label === 'string' && label !== '' ? label : `Row ${String(row.rowNumber)}`
}

/** A cell's value as text. Arrays are `tags`, which the grid edits as a comma-separated list. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map((one) => String(one)).join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}
