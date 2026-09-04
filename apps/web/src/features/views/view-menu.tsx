/**
 * §5.2's three saved-view actions, and §6.6's picker.
 *
 * Which items are enabled is entirely `useViewState`'s `status` — see the state machine there. The
 * only judgement in this file is what each one *says*: "Save changes to view" names the view it
 * would overwrite, because overwriting the wrong saved view is the mistake worth one extra word.
 */
import { filterSetSchema, type ObjectType } from '@mutuals/core'
import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'

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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'
import { Input } from '@/ui/input.tsx'

import { useCreateView, useUpdateView } from './use-views.ts'
import type { ViewState } from './use-view-state.ts'

/** The `⋮` items. Rendered inside the table's own menu, which owns the trigger and the separator. */
export function ViewMenuItems({
  objectType,
  state,
  onSaveAsNew,
}: {
  objectType: ObjectType
  state: ViewState
  onSaveAsNew: () => void
}) {
  const update = useUpdateView(objectType)
  const dirty = state.status === 'dirty'

  return (
    <>
      <DropdownMenuItem
        disabled={!dirty}
        onSelect={() => {
          state.revert()
        }}
      >
        Revert changes
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!dirty}
        onSelect={() => {
          if (state.current === undefined) return
          update.mutate({
            id: state.current.id,
            body: {
              filters: state.snapshot.filter,
              sort: state.snapshot.sort,
              columns: state.snapshot.columns ?? [],
            },
          })
        }}
      >
        {state.current === undefined
          ? 'Save changes to view'
          : `Save changes to "${state.current.name}"`}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onSaveAsNew}>Save as new view</DropdownMenuItem>
    </>
  )
}

/** §6.6's picker, left of the filter bar: which view is open, and what else there is. */
export function ViewPicker({ state }: { state: ViewState }) {
  if (state.views.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          {state.current?.name ?? 'All'}
          {state.status === 'dirty' && (
            <span className="text-muted-foreground text-xs">· edited</span>
          )}
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        {state.views.map((view) => (
          <DropdownMenuItem
            key={view.id}
            onSelect={() => {
              state.open(view)
            }}
          >
            {view.id === state.current?.id ? (
              <Check className="size-3.5" />
            ) : (
              <span className="size-3.5" />
            )}
            {view.name}
          </DropdownMenuItem>
        ))}
        {state.current !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                state.detach()
              }}
            >
              Leave this view
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `Save as new view`: the one action that needs a name before it can do anything. */
export function SaveViewDialog({
  open,
  onOpenChange,
  objectType,
  state,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  objectType: ObjectType
  state: ViewState
}) {
  const create = useCreateView(objectType)
  const [name, setName] = useState('')

  function save() {
    if (name.trim() === '') return
    create.mutate(
      {
        objectType,
        name: name.trim(),
        columns: [...(state.snapshot.columns ?? [])],
        // Parsed rather than cast: it converts the domain's readonly arrays to the wire's mutable
        // ones by actually validating them, which is the same thing the API does on receipt.
        filters: filterSetSchema.parse(state.snapshot.filter),
        sort: state.snapshot.sort,
      },
      {
        onSuccess: (view) => {
          // Opening it is the point: saving a view and then still being on an unnamed working copy
          // would make the next edit look like a change to a view nobody is in.
          state.open(view)
          onOpenChange(false)
          setName('')
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as new view</DialogTitle>
          <DialogDescription>
            Saves the columns you have chosen, the filters and the sort under a name. The link stays
            shareable either way — a view is a name for what the address bar already says.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <Input
            value={name}
            autoFocus
            placeholder="Investors in Munich"
            onChange={(event) => {
              setName(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
        </label>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Cancel
          </Button>
          <Button disabled={create.isPending || name.trim() === ''} onClick={save}>
            {create.isPending ? 'Saving…' : 'Save view'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
