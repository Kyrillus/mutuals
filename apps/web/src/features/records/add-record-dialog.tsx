import { fieldValueKind, type AttributeDefinitionDto, type FieldDescriptor } from '@mutuals/core'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Plus } from 'lucide-react'
import { useMemo, useRef, useState, type RefObject } from 'react'

import { isEditable } from '@/attributes/attribute-input.tsx'
import { attributeFieldErrors, fieldErrors } from '@/attributes/errors.ts'
import { recordFieldResolver } from '@/table/fields.ts'
import { camelCase } from '@/table/record-row.ts'
import { Button } from '@/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'
import { Input } from '@/ui/input.tsx'

import { AttributeFormControl } from './attribute-control.tsx'
import type { RecordObjectType } from './record-api.ts'
import { useAttributeDefinitions } from './use-attribute-definitions.ts'
import { useCreateRecord } from './use-record-mutations.ts'

/** Ungrouped attributes fall here, exactly as §6.5's sidebar and the filter picker do with them. */
const DEFAULT_GROUP = 'Details'

/**
 * §5.2's primary action: a split button, `+ Add new` beside a chevron.
 *
 * Bulk import was shown disabled from Stage 2 so the menu would not grow an item later and move
 * the one people had already learnt. Stage 5 enabled it in place.
 */
export function AddRecordButton({
  objectType,
  label,
  primaryColumns,
}: {
  objectType: RecordObjectType
  label: string
  primaryColumns?: readonly string[]
}) {
  const [open, setOpen] = useState(false)

  // Radix returns focus to a `DialogTrigger` when the dialog closes. This dialog has none — it is
  // opened from two places, the button and the dropdown item — so without this the close drops
  // focus on the body and a keyboard user restarts from the top of the page.
  const trigger = useRef<HTMLButtonElement>(null)

  return (
    <>
      <div className="flex">
        <Button
          ref={trigger}
          size="sm"
          className="gap-1.5 rounded-r-none"
          onClick={() => {
            setOpen(true)
          }}
        >
          <Plus />
          Add new
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="rounded-l-none border-l border-l-white/25 px-1.5"
              aria-label="More ways to add"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onSelect={() => {
                setOpen(true)
              }}
            >
              Add single {label}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/import" search={{ objectType }}>
                Bulk import {label}s
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AddRecordDialog
        objectType={objectType}
        label={label}
        open={open}
        onOpenChange={setOpen}
        primaryColumns={primaryColumns}
        restoreFocusTo={trigger}
      />
    </>
  )
}

/**
 * §5.3's create dialog: required fields marked, system fields first, custom attributes grouped,
 * the rest collapsed under "More".
 *
 * Which attributes count as "the rest" is decided by a list of slugs the page passes in, not by
 * anything this file knows: adding a field in Settings puts it in this dialog — under "More" —
 * without an edit here.
 */
export function AddRecordDialog({
  objectType,
  label,
  open,
  onOpenChange,
  primaryColumns,
  restoreFocusTo,
}: {
  objectType: RecordObjectType
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  primaryColumns?: readonly string[]
  /** Where focus goes when the dialog closes. Radix cannot work it out without a `DialogTrigger`. */
  restoreFocusTo?: RefObject<HTMLButtonElement | null>
}) {
  const definitions = useAttributeDefinitions(objectType)
  const create = useCreateRecord(objectType)
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [showMore, setShowMore] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  const resolver = useMemo(
    () => recordFieldResolver(objectType, definitions.data ?? []),
    [objectType, definitions.data],
  )
  const bySlug = useMemo(
    () => new Map((definitions.data ?? []).map((entry) => [entry.slug, entry])),
    [definitions.data],
  )

  const writable = resolver.list().filter((field) => !field.readOnly)
  // §5.3's "system fields first". A writable system column of any other kind is behaviour rather
  // than description — `pinned_important` is a row action, not something you type on creation —
  // so only the text ones appear, and the record's own label is generated from them.
  const identity = writable.filter(
    (field) => field.source.kind === 'column' && fieldValueKind(field) === 'text',
  )
  const attributes = writable.filter((field) => bySlug.has(field.slug))
  const primary = attributes.filter((field) => primaryColumns?.includes(field.slug) ?? true)
  const more = attributes.filter((field) => !primary.includes(field))

  const bodyErrors = fieldErrors(failure)
  const attributeErrors = attributeFieldErrors(failure)
  const generalError =
    failure instanceof Error && bodyErrors.size === 0 ? failure.message : undefined

  function reset() {
    setDrafts({})
    setNames({})
    setShowMore(false)
    setFailure(null)
  }

  function submit() {
    const body: Record<string, unknown> = {}
    for (const field of identity) {
      const value = names[field.slug]?.trim() ?? ''
      if (value !== '') body[camelCase(field.slug)] = value
    }

    // `AttributeInput` already speaks the write shape and spells "empty" as `null`, so an
    // untouched field is simply absent from the body (ADR-031).
    const written: Record<string, unknown> = {}
    for (const field of attributes) {
      const write = drafts[field.slug]
      if (write === null || write === undefined) continue
      written[field.slug] = write
    }
    if (Object.keys(written).length > 0) body['attributes'] = written

    create.mutate(body, {
      onSuccess: () => {
        reset()
        onOpenChange(false)
      },
      onError: setFailure,
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          const target = restoreFocusTo?.current
          if (!target) return
          event.preventDefault()
          target.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Add {label}</DialogTitle>
          <DialogDescription>
            Fields marked <span className="text-destructive">*</span> are required. Everything else
            can be filled in later — nothing here is ever silently overwritten.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {identity.map((field) => (
            <label key={field.slug} className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">
                {field.label}
                <span className="text-destructive"> *</span>
              </span>
              <Input
                value={names[field.slug] ?? ''}
                onChange={(event) => {
                  setNames((current) => ({ ...current, [field.slug]: event.target.value }))
                }}
              />
              <FieldMessage message={bodyErrors.get(camelCase(field.slug))} />
            </label>
          ))}

          {primary.map((field) => (
            <AttributeFormField
              key={field.slug}
              field={field}
              definition={bySlug.get(field.slug)}
              drafts={drafts}
              setDrafts={setDrafts}
              error={attributeErrors.get(field.slug)}
            />
          ))}
        </div>

        {more.length > 0 && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowMore((current) => !current)
              }}
            >
              {showMore ? 'Fewer fields' : `More (${String(more.length)})`}
            </Button>
            {showMore && (
              <div className="mt-3 space-y-5">
                {[...groupBy(more)].map(([group, groupFields]) => (
                  <section key={group}>
                    <h3 className="text-muted-foreground mb-2 text-xs font-medium">{group}</h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {groupFields.map((field) => (
                        <AttributeFormField
                          key={field.slug}
                          field={field}
                          definition={bySlug.get(field.slug)}
                          drafts={drafts}
                          setDrafts={setDrafts}
                          error={attributeErrors.get(field.slug)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}

        <FieldMessage message={generalError} />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              reset()
            }}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : `Save ${label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AttributeFormField({
  field,
  definition,
  drafts,
  setDrafts,
  error,
}: {
  field: FieldDescriptor
  definition: AttributeDefinitionDto | undefined
  drafts: Record<string, unknown>
  setDrafts: (update: (current: Record<string, unknown>) => Record<string, unknown>) => void
  error: string | undefined
}) {
  if (definition === undefined || !isEditable(definition)) return null
  return (
    <AttributeFormControl
      definition={definition}
      value={drafts[field.slug] ?? null}
      error={error}
      onChange={(next) => {
        setDrafts((current) => ({ ...current, [field.slug]: next }))
      }}
    />
  )
}

function FieldMessage({ message }: { message: string | undefined }) {
  if (message === undefined) return null
  return <p className="text-destructive text-xs">{message}</p>
}

function groupBy(fields: readonly FieldDescriptor[]): Map<string, FieldDescriptor[]> {
  const groups = new Map<string, FieldDescriptor[]>()
  for (const field of fields) {
    const key = field.group ?? DEFAULT_GROUP
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [field])
    else bucket.push(field)
  }
  return groups
}
