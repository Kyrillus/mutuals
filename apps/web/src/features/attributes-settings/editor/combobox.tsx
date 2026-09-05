/**
 * The searchable popover the Type select and the Group combobox are both built from.
 *
 * `@/attributes/controls/picker.tsx` is the same idea for table cells, but it is not exported from
 * `@/attributes` and it is sized for a 40px row (`h-8`, no label, cell-shaped). This one is
 * dialog-sized, takes a full-height trigger and allows an item to be two lines tall — a type needs
 * its description under its name or `short_text` and `long_text` are a coin toss. The styling is
 * deliberately identical, so the day `ui/command.tsx` and `ui/popover.tsx` are added by
 * `shadcn add`, both files collapse into imports.
 */
import { Command } from 'cmdk'
import { ChevronsUpDown } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

import { useDialogContainer } from '@/ui/dialog.tsx'
import { cn } from '@/lib/utils.ts'

export const Combobox = PopoverPrimitive.Root

export function ComboboxTrigger({
  children,
  placeholder,
  empty,
  id,
  disabled,
  describedBy,
  labelledBy,
  required,
  invalid,
}: {
  children?: ReactNode
  placeholder?: string
  empty?: boolean
  id?: string
  disabled?: boolean
  describedBy?: string | undefined
  /**
   * The id of the visible label. Combined with this trigger's own id so the accessible name is
   * "Type Short text" — the field and its current value, the way a `<select>` announces itself.
   * A bare `<label for>` does not name a button (see `FieldRowIds.labelId`).
   */
  labelledBy?: string | undefined
  required?: boolean
  invalid?: boolean
}) {
  return (
    <PopoverPrimitive.Trigger
      id={id}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-labelledby={
        labelledBy === undefined || id === undefined ? undefined : `${labelledBy} ${id}`
      }
      aria-required={required}
      aria-invalid={invalid}
      className={cn(
        'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent',
        'px-3 text-left text-sm shadow-xs transition-[color,box-shadow] outline-none',
        'dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        'dark:aria-invalid:ring-destructive/40',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {empty === true ? (
          <span className="text-muted-foreground">{placeholder ?? 'Select…'}</span>
        ) : (
          children
        )}
      </span>
      <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
    </PopoverPrimitive.Trigger>
  )
}

export function ComboboxContent({
  children,
  search,
  onSearchChange,
  searchPlaceholder,
  footer,
}: {
  children: ReactNode
  search: string
  onSearchChange: (next: string) => void
  searchPlaceholder?: string
  /** The "use what I typed" row a free-text combobox needs; outside the list so it never scrolls. */
  footer?: ReactNode
}) {
  // Portalled into the dialog when there is one, so the dialog's scroll lock does not swallow
  // the wheel over this list (see `useDialogContainer`).
  const container = useDialogContainer()
  // The content deliberately does NOT prevent Radix's open-auto-focus, which is what the table's
  // picker does. This popover opens inside a Radix Dialog, and a Dialog traps focus: leaving the
  // popover's own focus scope inert lets the trap pull focus back into the dialog, and keystrokes
  // meant for the search box land in whichever input the dialog focuses instead — observed live,
  // with "Number" typed into the Slug field. Radix focuses the first tabbable element in the
  // content, which is the search box, so the first keystroke is not lost either.
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        align="start"
        sideOffset={4}
        className={cn(
          'bg-popover text-popover-foreground z-50 w-(--radix-popover-trigger-width) min-w-56',
          'rounded-md border p-0 shadow-md',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        )}
      >
        <Command loop className="flex max-h-80 w-full flex-col">
          <div className="border-b px-3">
            <Command.Input
              value={search}
              onValueChange={onSearchChange}
              placeholder={searchPlaceholder ?? 'Search…'}
              // A placeholder is a hint, not a name. Chromium falls back to it and other engines
              // do not, so the search box in a popover is nameless exactly where it matters.
              aria-label={searchPlaceholder?.replace(/…$/, '') ?? 'Search'}
              className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-none"
            />
          </div>
          <Command.List className="max-h-64 overflow-x-hidden overflow-y-auto p-1">
            {children}
          </Command.List>
          {footer}
        </Command>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

export function ComboboxEmpty({ children }: { children: ReactNode }) {
  return (
    <Command.Empty className="text-muted-foreground px-2 py-6 text-center text-sm">
      {children}
    </Command.Empty>
  )
}

/** `value` is what cmdk matches against, so it carries the words a person would type. */
export function ComboboxItem({
  children,
  value,
  keywords,
  onSelect,
}: {
  children: ReactNode
  value: string
  keywords?: string[]
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none"
    >
      {children}
    </Command.Item>
  )
}
