/**
 * The popover-with-a-search-box that `select`, `multi_select`, `tag_input` and `record_picker` are
 * all built from.
 *
 * It lives here rather than in `ui/` because `ui/` is a set of shadcn primitives copied in
 * verbatim (ADR-050) and this is not one of them — it is the shape those four controls share, and
 * the moment a `ui/command.tsx` and `ui/popover.tsx` are added by `shadcn add`, this file becomes
 * four imports. The styling deliberately matches `ui/dropdown-menu.tsx` so the swap is invisible.
 */
import { Command } from 'cmdk'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'

import { CONTROL_HEIGHT, CONTROL_SURFACE } from '../input-props.ts'

export const Picker = PopoverPrimitive.Root
export const PickerAnchor = PopoverPrimitive.Anchor

/**
 * The closed state: it has to look like the input it stands in for, because in a table it sits
 * where an input would and nothing else marks it as editable.
 */
export function PickerTrigger({
  children,
  className,
  placeholder,
  empty,
  ...props
}: {
  children?: ReactNode
  className?: string
  placeholder?: string
  empty?: boolean
  id?: string
  disabled?: boolean
  'aria-label'?: string
  'aria-invalid'?: boolean | undefined
  'aria-describedby'?: string | undefined
}) {
  return (
    <PopoverPrimitive.Trigger
      {...props}
      className={cn(
        CONTROL_SURFACE,
        CONTROL_HEIGHT,
        'flex items-center gap-1 px-2 text-left',
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {empty === true ? (
          <span className="text-muted-foreground">{placeholder ?? 'Empty'}</span>
        ) : (
          children
        )}
      </span>
      <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
    </PopoverPrimitive.Trigger>
  )
}

/**
 * `shouldFilter` is a prop because two of the four callers filter server-side: the record picker
 * asks Postgres, and cmdk re-ranking those results locally would fight the query it just ran.
 */
export function PickerContent({
  children,
  search,
  onSearchChange,
  searchPlaceholder,
  shouldFilter = true,
  className,
}: {
  children: ReactNode
  search: string
  onSearchChange: (next: string) => void
  searchPlaceholder?: string
  shouldFilter?: boolean
  className?: string
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align="start"
        sideOffset={4}
        // The popover opens over a row that scrolls; matching the trigger's width keeps it from
        // looking like a menu that belongs to the page rather than to the cell.
        className={cn(
          'bg-popover text-popover-foreground z-50 w-(--radix-popover-trigger-width) min-w-56 rounded-md border p-0 shadow-md',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
          className,
        )}
        onOpenAutoFocus={(event) => {
          // cmdk's own input takes focus; letting Radix focus the content first makes the first
          // keystroke go nowhere.
          event.preventDefault()
        }}
      >
        <Command shouldFilter={shouldFilter} loop className="flex max-h-72 w-full flex-col">
          <div className="border-b px-2">
            <Command.Input
              autoFocus
              value={search}
              onValueChange={onSearchChange}
              placeholder={searchPlaceholder ?? 'Search…'}
              className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-none"
            />
          </div>
          <Command.List className="max-h-60 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </Command.List>
        </Command>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/**
 * The same panel without cmdk, for the one caller that types into its own box rather than into the
 * popover: the tag input keeps focus in the chip field, so a search input inside the popover would
 * be a second place to type and cmdk's keyboard navigation would never see a key.
 */
export function PickerPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
        className={cn(
          'bg-popover text-popover-foreground z-50 max-h-60 w-(--radix-popover-trigger-width) min-w-56 overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

export function PickerEmpty({ children }: { children: ReactNode }) {
  return (
    <Command.Empty className="text-muted-foreground px-2 py-6 text-center text-sm">
      {children}
    </Command.Empty>
  )
}

export function PickerGroup({ children, heading }: { children: ReactNode; heading?: string }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs"
    >
      {children}
    </Command.Group>
  )
}

/**
 * `value` is what cmdk matches the search against, so it carries the label rather than the key —
 * typing "Inv" must find "Investor" even though the stored key is `investor`.
 */
export function PickerItem({
  children,
  value,
  keywords,
  selected,
  onSelect,
}: {
  children: ReactNode
  value: string
  keywords?: string[]
  selected?: boolean
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">{children}</span>
      {selected === true ? <Check className="size-3.5 shrink-0 opacity-70" /> : null}
    </Command.Item>
  )
}
