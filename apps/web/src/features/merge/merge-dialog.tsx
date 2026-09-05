/**
 * §6.9's merge: pick the other record, choose per field, confirm.
 *
 * Two screens in one dialog because they are one decision. Picking the other record is not
 * meaningful on its own — until you see the side-by-side you do not know whether it is the right
 * one — and the side-by-side is not meaningful without knowing which record you are absorbing.
 *
 * The whole thing is deliberately hard to do by accident. Merging cannot be undone, so the
 * confirmation states what moves in numbers, the destructive verb is on the button rather than in
 * the title, and the default for every contested field is the record the user was already looking
 * at.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Search } from 'lucide-react'
import { toast } from 'sonner'
import type { ObjectType } from '@mutuals/core'

import { ApiError } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import { Button } from '@/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog.tsx'
import { Input } from '@/ui/input.tsx'

import { mergeRecords, searchMergeCandidates, useMergePreview } from './merge-api.ts'

export function MergeDialog({
  open,
  onOpenChange,
  objectType,
  survivorId,
  survivorLabel,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  objectType: ObjectType
  survivorId: string
  survivorLabel: string
}) {
  const client = useQueryClient()

  const [loserId, setLoserId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [choices, setChoices] = useState<Record<string, 'survivor' | 'loser'>>({})

  const candidates = useQuery({
    queryKey: ['merge-candidates', objectType, search],
    queryFn: ({ signal }) => searchMergeCandidates(objectType, search, signal),
    enabled: open && loserId === null,
  })

  const preview = useMergePreview(objectType, survivorId, loserId)

  const merge = useMutation({
    mutationFn: () => mergeRecords(objectType, survivorId, { loserId: loserId as string, choices }),
    onSuccess: async (result) => {
      toast.success(
        `Merged. ${String(result.factsMoved)} values, ${String(result.interactionsMoved)} interactions and ${String(result.followUpsMoved)} follow-ups moved.`,
      )
      close()
      /**
       * Invalidate, do not navigate.
       *
       * A `navigate({ to: '.' })` here left the detail page blank: the survivor's route has an `$id`
       * param, and re-navigating to `.` without it does not resolve to the route the user is on.
       * Refetching in place is what was wanted anyway — the record did not move, it only changed.
       */
      await client.invalidateQueries({ queryKey: qk.records(objectType) })
      await client.invalidateQueries({ queryKey: qk.record(survivorId) })
    },
    onError: (error: unknown) => {
      toast.error(error instanceof ApiError ? error.message : 'The merge did not go through.')
    },
  })

  function close(): void {
    onOpenChange(false)
    setLoserId(null)
    setSearch('')
    setChoices({})
  }

  const label = objectType === 'organization' ? 'organization' : 'contact'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
        else onOpenChange(true)
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Merge into {survivorLabel}</DialogTitle>
          <DialogDescription>
            {loserId === null
              ? `Choose the ${label} to absorb. Everything it has moves here, and it is then deleted.`
              : `Choose which value to keep where they disagree. ${survivorLabel} is the ${label} that stays.`}
          </DialogDescription>
        </DialogHeader>

        {loserId === null ? (
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
                aria-hidden
              />
              <Input
                className="pl-8"
                placeholder={`Search ${label}s`}
                aria-label={`Search ${label}s to merge`}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                }}
              />
            </div>

            <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="Merge candidates">
              {(candidates.data ?? [])
                // The record itself is never a candidate: merging it into itself is the one thing
                // the server refuses outright, so it should not be offerable.
                .filter((candidate) => candidate.id !== survivorId)
                .map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      className="hover:bg-muted/60 w-full rounded-md px-3 py-2 text-left text-sm"
                      onClick={() => {
                        setLoserId(candidate.id)
                      }}
                    >
                      {candidate.label}
                    </button>
                  </li>
                ))}
              {candidates.isSuccess && (candidates.data ?? []).length <= 1 ? (
                <li className="text-muted-foreground px-3 py-6 text-center text-sm">
                  Nothing else to merge.
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            {preview.isPending ? (
              <p className="text-muted-foreground text-sm">Comparing…</p>
            ) : preview.data === undefined ? (
              <p className="text-destructive text-sm">Those two could not be compared.</p>
            ) : (
              <>
                <div className="max-h-80 overflow-y-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th scope="col" className="w-40 px-3 py-2 text-left font-medium">
                          Field
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          {preview.data.survivor.label}{' '}
                          <span className="text-muted-foreground">(stays)</span>
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          {preview.data.loser.label}{' '}
                          <span className="text-muted-foreground">(absorbed)</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.fields.map((field) => {
                        const key = field.attributeId ?? field.slug
                        const chosen = choices[key] ?? 'survivor'
                        return (
                          <tr key={key} className="border-t align-top">
                            <th scope="row" className="px-3 py-2 text-left font-normal">
                              {field.label}
                              {field.isMulti ? (
                                <span className="text-muted-foreground block text-xs">
                                  both are kept
                                </span>
                              ) : null}
                            </th>
                            {(['survivor', 'loser'] as const).map((side) => (
                              <td key={side} className="px-3 py-2">
                                {/*
                                  A radio only where there is a genuine choice. A field only one of
                                  them has is taken either way, and offering a radio there would ask
                                  someone to choose between a value and nothing.
                                */}
                                {field.conflicting && field.attributeId !== null ? (
                                  <label className="flex items-start gap-2">
                                    <input
                                      type="radio"
                                      className="mt-1"
                                      name={`merge-${key}`}
                                      checked={chosen === side}
                                      aria-label={`${field.label}: keep ${side === 'survivor' ? preview.data.survivor.label : preview.data.loser.label}`}
                                      onChange={() => {
                                        setChoices((previous) => ({ ...previous, [key]: side }))
                                      }}
                                    />
                                    <span>{field[side] ?? '—'}</span>
                                  </label>
                                ) : (
                                  <span
                                    className={field[side] === null ? 'text-muted-foreground' : ''}
                                  >
                                    {field[side] ?? '—'}
                                  </span>
                                )}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="bg-muted/40 flex items-start gap-2 rounded-lg border p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                  <p>
                    <strong>This cannot be undone.</strong> {preview.data.moves.interactions}{' '}
                    {preview.data.moves.interactions === 1 ? 'interaction' : 'interactions'} and{' '}
                    {preview.data.moves.followUps}{' '}
                    {preview.data.moves.followUps === 1 ? 'follow-up' : 'follow-ups'} move to{' '}
                    {preview.data.survivor.label}, and {preview.data.loser.label} is deleted.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {loserId === null ? (
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setLoserId(null)
                  setChoices({})
                }}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={merge.isPending || preview.data === undefined}
                onClick={() => {
                  merge.mutate()
                }}
              >
                {merge.isPending
                  ? 'Merging…'
                  : `Merge and delete ${preview.data?.loser.label ?? ''}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
