/**
 * §6.7: "deleting an option that is in use asks whether to clear the values or remap them to
 * another option". This is that question, with the real number in it.
 *
 * The count is not a guess — it is one filtered list request through the same filter model the
 * table uses (`use-option-usage.ts`), so the sentence a person reads is the sentence the database
 * would answer.
 *
 * **What this dialog cannot yet do, and says so.** ADR-016 settles the outcome: an option that is
 * in use is *archived*, never deleted, because `fact.option_id` is `ON DELETE RESTRICT` and the
 * history still has to render the old label. `packages/db` has `archiveAttributeOption`, but no
 * route reaches it — `PATCH /attribute-definitions/:id` adds and relabels options and has no verb
 * for retiring one, and there is no `DELETE` for an option either (verified against the running
 * API). So the choice is collected and stated, and the confirm is held back with the reason rather
 * than clearing values into a state the picker would still offer.
 */
import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/ui/button.tsx'
import { Chip } from '@/ui/chip.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'
import type { ObjectType } from '@mutuals/core'

import type { OptionRow } from './draft.ts'
import { useOptionUsage } from './use-option-usage.ts'

/**
 * The one line to flip when the archive route lands. Everything below is written against it, so
 * enabling the flow is this constant plus the mutation call in {@link OptionRetireDialog}.
 */
export const OPTION_ARCHIVE_ENDPOINT_EXISTS: boolean = false

export type RetirePlan =
  { readonly mode: 'clear' } | { readonly mode: 'remap'; readonly toOptionKey: string }

export function OptionRetireDialog({
  option,
  others,
  objectType,
  attributeSlug,
  attributeType,
  open,
  onOpenChange,
}: {
  option: OptionRow | undefined
  /** The options the values could move to — every live one except this. */
  others: readonly OptionRow[]
  objectType: ObjectType
  attributeSlug: string
  attributeType: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [plan, setPlan] = useState<RetirePlan>({ mode: 'clear' })

  const usage = useOptionUsage({
    objectType,
    slug: attributeSlug,
    type: attributeType,
    optionKey: option?.key ?? '',
    enabled: open && option?.id !== undefined,
  })

  useEffect(() => {
    if (open) setPlan({ mode: 'clear' })
  }, [open, option?.rowId])

  if (option === undefined) return null

  const count = usage.data ?? null
  const noun = objectType === 'contact' ? 'contact' : 'record'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retire this option?</DialogTitle>
          <DialogDescription>
            <Chip color={option.color}>{option.label}</Chip> stops being offered. It is kept, not
            deleted, so values recorded before today still read correctly.
          </DialogDescription>
        </DialogHeader>

        {usage.isPending ? (
          <Skeleton className="h-4 w-56" />
        ) : usage.isError ? (
          <p className="text-destructive text-sm">
            Could not count the {noun}s using it: {usage.error.message}
          </p>
        ) : count === null || count === 0 ? (
          <p className="text-sm">No {noun}s have this value, so nothing has to be moved.</p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm">
              <span className="font-medium">
                {String(count)} {noun}
                {count === 1 ? '' : 's'}
              </span>{' '}
              currently have this value. What should happen to them?
            </legend>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="retire-plan"
                className="accent-primary mt-0.5"
                checked={plan.mode === 'clear'}
                onChange={() => {
                  setPlan({ mode: 'clear' })
                }}
              />
              <span>
                Clear the value
                <span className="text-muted-foreground block text-xs">
                  The field is left empty on those {noun}s. The old value stays in their history.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="retire-plan"
                className="accent-primary mt-0.5"
                disabled={others.length === 0}
                checked={plan.mode === 'remap'}
                onChange={() => {
                  const first = others[0]
                  if (first !== undefined) setPlan({ mode: 'remap', toOptionKey: first.key })
                }}
              />
              <span className="min-w-0 flex-1">
                Move them to another option
                {others.length === 0 ? (
                  <span className="text-muted-foreground block text-xs">
                    There is no other option to move them to.
                  </span>
                ) : (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {others.map((candidate) => (
                      <button
                        key={candidate.rowId}
                        type="button"
                        onClick={() => {
                          setPlan({ mode: 'remap', toOptionKey: candidate.key })
                        }}
                        className="focus-visible:ring-ring/50 rounded focus-visible:ring-[3px] focus-visible:outline-none"
                      >
                        <Chip
                          color={candidate.color}
                          className={
                            plan.mode === 'remap' && plan.toOptionKey === candidate.key
                              ? 'ring-ring ring-2'
                              : 'opacity-70'
                          }
                        >
                          {candidate.label}
                        </Chip>
                      </button>
                    ))}
                  </span>
                )}
              </span>
            </label>
          </fieldset>
        )}

        {!OPTION_ARCHIVE_ENDPOINT_EXISTS && (
          <p className="border-destructive/30 bg-destructive/5 text-destructive flex gap-2 rounded-md border p-3 text-xs">
            <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
            <span>
              Retiring an option needs an API operation that does not exist yet — the update
              endpoint can add and rename options but not archive one. Nothing has been changed.
              Renaming, recolouring and reordering all work in the meantime.
            </span>
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Cancel
          </Button>
          <Button variant="destructive" disabled={!OPTION_ARCHIVE_ENDPOINT_EXISTS}>
            Retire option
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
