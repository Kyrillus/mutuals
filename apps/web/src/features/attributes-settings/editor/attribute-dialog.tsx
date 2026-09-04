/**
 * Create and edit an attribute — the dialog where a person who has never seen a database invents a
 * column, and it becomes filterable and sortable without anyone touching code (§6.7).
 *
 * Three things earn their weight here:
 *
 *  - **The slug follows the title until it does not.** `suggestSlug` runs on every keystroke while
 *    the slug is untouched, and stops for good the moment somebody edits it — because the slug is
 *    the one value in the product that cannot be fixed later (§4.2).
 *  - **Messages land under the control that caused them.** The client's rules and the API's
 *    `errors` array are keyed identically (`title`, `slug`, `options.0.label`, `config.decimals`),
 *    so a rejected save marks the same input a live rule would, in the same red, and never a toast.
 *  - **Nothing is shouted before it is asked for.** A field's message appears once that field has
 *    been touched, or once Save has been pressed — so an untouched form is quiet, and a form that
 *    refuses to save always says why.
 */
import { type AttributeType, type ObjectType } from '@mutuals/core'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { fieldErrors } from '@/attributes/errors.ts'
import { ApiError } from '@/lib/api.ts'
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
import { Skeleton } from '@/ui/skeleton.tsx'
import type { ChipColor } from '@/ui/chip-colors.ts'

import {
  addOption,
  createBody,
  draftFromDefinition,
  emptyDraft,
  hasOptions,
  moveOption,
  removeOption,
  setOptionColor,
  setOptionLabel,
  setSlug,
  setTitle,
  setType,
  updateBody,
  type AttributeDraft,
  type NumberDraft,
  type RelationDraft,
} from './draft.ts'
import { FieldRow, LockedNote } from './field-row.tsx'
import { GroupCombobox } from './group-combobox.tsx'
import { OptionRetireDialog } from './option-retire-dialog.tsx'
import { OptionsEditor } from './options-editor.tsx'
import { TypeConfig } from './type-config.tsx'
import { TypeDisplay, TypeSelect } from './type-select.tsx'
import { useAttributeDefinitions, groupsOf, takenSlugs } from './use-definitions.ts'
import { useCreateAttribute, useUpdateAttribute } from './use-attribute-mutations.ts'
import { mergeIssues, validateDraft } from './validation.ts'

export const SLUG_HELP = 'Unique, cannot be changed after creation'

export interface AttributeDialogProps {
  readonly objectType: ObjectType
  /** Absent means create. */
  readonly attributeId?: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function AttributeDialog({
  objectType,
  attributeId,
  open,
  onOpenChange,
}: AttributeDialogProps) {
  const mode = attributeId === undefined ? 'create' : 'edit'
  const definitions = useAttributeDefinitions(objectType)
  const all = useMemo(() => definitions.data ?? [], [definitions.data])
  const editing = useMemo(
    () => all.find((definition) => definition.id === attributeId),
    [all, attributeId],
  )

  const taken = useMemo(() => takenSlugs(all, attributeId), [all, attributeId])
  const groups = useMemo(() => groupsOf(all), [all])

  const [draft, setDraft] = useState<AttributeDraft>(() => emptyDraft(objectType))
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [retiring, setRetiring] = useState<string | null>(null)

  const create = useCreateAttribute(objectType)
  const update = useUpdateAttribute(objectType, attributeId)
  const saving = create.isPending || update.isPending

  // Reopening is a fresh form, and the definition may arrive after the dialog does, so the draft is
  // seeded again when it lands. The dependency is `updatedAt` rather than the object itself: a
  // background refetch hands back a new array every time, and re-seeding on identity would throw
  // away whatever the user had typed the moment any other save invalidated the cache.
  useEffect(() => {
    if (!open) return
    setDraft(editing === undefined ? emptyDraft(objectType) : draftFromDefinition(editing))
    setTouched(new Set())
    setSubmitted(false)
    setFailure(null)
    setRetiring(null)
  }, [open, objectType, attributeId, editing?.updatedAt])

  const savedDecimals = readSavedDecimals(editing?.config)
  const local = validateDraft(draft, { mode, takenSlugs: taken, objectType, savedDecimals })
  const remote = fieldErrors(failure)
  const issues = mergeIssues(local, remote)

  /** Quiet until asked: a message appears once its field has been touched, or once Save was hit. */
  const shown = (field: string): string | undefined =>
    submitted || touched.has(field) || remote.has(field) ? issues.get(field) : undefined

  const optionIssues: ReadonlyMap<string, string> = submitted || remote.size > 0 ? issues : EMPTY

  function touch(field: string) {
    setTouched((current) => new Set(current).add(field))
  }

  function edit(next: AttributeDraft) {
    setDraft(next)
    // A rejected save is about the body that was sent; the next keystroke makes it stale.
    if (failure !== null) setFailure(null)
  }

  function submit() {
    setSubmitted(true)
    if (local.size > 0) return

    const mutation = mode === 'create' ? create : update
    const body = mode === 'create' ? createBody(draft) : updateBody(draft)
    mutation.mutate(body, {
      onSuccess: (definition) => {
        toast.success(
          mode === 'create' ? `“${definition.title}” added` : `“${definition.title}” saved`,
          {
            description:
              mode === 'create'
                ? 'It is a column, a filter and a sort straight away — no reload needed.'
                : undefined,
          },
        )
        onOpenChange(false)
      },
      onError: (error) => {
        setFailure(error)
        // A 409 or a 500 has no field to point at, so it would otherwise vanish.
        if (!(error instanceof ApiError && error.status === 400 && error.errors.length > 0)) {
          toast.error('Could not save the field', { description: error.message })
        }
      },
    })
  }

  const retiringOption = draft.options.find((option) => option.rowId === retiring)
  const loading = mode === 'edit' && editing === undefined && definitions.isPending

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'Create new field' : 'Edit field'}</DialogTitle>
            <DialogDescription>
              {mode === 'create'
                ? 'It becomes a real column the moment you save: filterable, sortable, and on every contact.'
                : 'The name, the group and the help text can change at any time. What the field is cannot.'}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <FieldRow label="Title" required error={shown('title')}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    autoFocus
                    aria-describedby={describedBy}
                    aria-invalid={shown('title') !== undefined}
                    value={draft.title}
                    placeholder="Ticket size"
                    onChange={(event) => {
                      touch('title')
                      edit(setTitle(draft, event.target.value, taken))
                    }}
                  />
                )}
              </FieldRow>

              <FieldRow
                label="Slug"
                required
                error={mode === 'create' ? shown('slug') : undefined}
                help={
                  mode === 'create' ? (
                    SLUG_HELP
                  ) : (
                    <LockedNote>
                      {SLUG_HELP}. Every saved view and every link is written against this name.
                    </LockedNote>
                  )
                }
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={shown('slug') !== undefined}
                    disabled={mode === 'edit'}
                    value={draft.slug}
                    placeholder="ticket_size"
                    spellCheck={false}
                    className="font-mono text-xs disabled:opacity-60"
                    onChange={(event) => {
                      touch('slug')
                      edit(setSlug(draft, event.target.value, taken))
                    }}
                  />
                )}
              </FieldRow>

              <FieldRow
                label="Type"
                required
                help={
                  mode === 'edit' ? (
                    <LockedNote>
                      Fixed after creation: the values already stored are shaped by it, and the
                      database refuses to reinterpret them. Create a new field to change the shape.
                    </LockedNote>
                  ) : undefined
                }
              >
                {({ id, describedBy }) =>
                  mode === 'edit' ? (
                    <TypeDisplay id={id} value={draft.type} />
                  ) : (
                    <TypeSelect
                      id={id}
                      describedBy={describedBy}
                      value={draft.type}
                      onChange={(next: AttributeType) => {
                        edit(setType(draft, next))
                      }}
                    />
                  )
                }
              </FieldRow>

              <FieldRow
                label="Group"
                help="Where the field sits on a contact's page. Pick one, or type a new name."
              >
                {({ id, describedBy }) => (
                  <GroupCombobox
                    id={id}
                    describedBy={describedBy}
                    value={draft.group}
                    groups={groups}
                    onChange={(next) => {
                      edit({ ...draft, group: next })
                    }}
                  />
                )}
              </FieldRow>

              <FieldRow
                label="Description"
                help="Optional. Shown as help text wherever the field is filled in."
                error={shown('description')}
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={2}
                    value={draft.description}
                    placeholder="What belongs in this field?"
                    className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 placeholder:text-muted-foreground w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]"
                    onChange={(event) => {
                      edit({ ...draft, description: event.target.value })
                    }}
                  />
                )}
              </FieldRow>

              <TypeConfig
                draft={draft}
                issues={issues}
                locked={mode === 'edit'}
                onNumberChange={(next: NumberDraft) => {
                  edit({ ...draft, number: next })
                }}
                onRelationChange={(next: RelationDraft) => {
                  edit({ ...draft, relation: next })
                }}
              />

              {hasOptions(draft.type) && (
                <OptionsEditor
                  options={draft.options}
                  archivedCount={draft.archived.length}
                  orderIsSortOrder={draft.type === 'single_select'}
                  issues={optionIssues}
                  onLabelChange={(rowId, label) => {
                    edit(setOptionLabel(draft, rowId, label))
                  }}
                  onColorChange={(rowId, color: ChipColor) => {
                    edit(setOptionColor(draft, rowId, color))
                  }}
                  onMove={(from, to) => {
                    edit(moveOption(draft, from, to))
                  }}
                  onAdd={() => {
                    edit(addOption(draft))
                  }}
                  onRemove={(rowId) => {
                    edit(removeOption(draft, rowId))
                  }}
                  onRetire={setRetiring}
                />
              )}
            </div>
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
            <Button onClick={submit} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OptionRetireDialog
        option={retiringOption}
        others={draft.options.filter((option) => option.rowId !== retiring)}
        objectType={objectType}
        attributeSlug={draft.slug}
        attributeType={draft.type}
        open={retiring !== null && retiringOption !== undefined}
        onOpenChange={(next) => {
          if (!next) setRetiring(null)
        }}
      />
    </>
  )
}

const EMPTY: ReadonlyMap<string, string> = new Map()

function readSavedDecimals(config: Record<string, unknown> | undefined): number | undefined {
  const value = config?.['decimals']
  return typeof value === 'number' ? value : undefined
}
