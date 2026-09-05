/**
 * The command primitive of §6.10, as a dialog.
 *
 * `cmdk` is already in the tree — the attribute editor's combobox, the record picker and the option
 * picker all use it (`attributes/controls/picker.tsx`). What that file does not have is the
 * *dialog* form, because a picker belongs to a cell and a palette belongs to the window. This is
 * that form, and nothing else: the palette's behaviour lives in `features/palette/`.
 *
 * `shouldFilter` is off by default here, which is the opposite of the picker's default. The palette
 * searches Postgres on every keystroke, and cmdk re-ranking those rows locally would fight the query
 * that just ran — the same reasoning `PickerContent` gives, applied to a component whose *only*
 * source is the server.
 */
import { Command as CommandPrimitive } from 'cmdk'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useState, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { useRestoreFocusOnClose } from '@/ui/dialog.tsx'

export function CommandDialog({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Named for a screen reader; the dialog has no visible heading by design. */
  label: string
  children: ReactNode
}) {
  // The palette is opened from anywhere by ⌘K, so there is no trigger for Radix to hand focus back
  // to — see `useRestoreFocusOnClose`. Without it, Escape left focus on `<body>`.
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const restoreFocus = useRestoreFocusOnClose(container)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          ref={setContainer}
          aria-label={label}
          onCloseAutoFocus={restoreFocus}
          className={cn(
            'bg-popover text-popover-foreground fixed top-[20%] left-1/2 z-50 w-full max-w-xl -translate-x-1/2 rounded-lg border shadow-lg',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Command({
  shouldFilter = false,
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      shouldFilter={shouldFilter}
      loop
      className={cn('flex w-full flex-col', className)}
      {...props}
    />
  )
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="border-b px-3">
      <CommandPrimitive.Input
        autoFocus
        className={cn(
          'placeholder:text-muted-foreground h-12 w-full bg-transparent text-sm outline-none',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[24rem] overflow-x-hidden overflow-y-auto p-1', className)}
      {...props}
    />
  )
}

export function CommandEmpty({ children }: { children: ReactNode }) {
  return (
    <CommandPrimitive.Empty className="text-muted-foreground px-2 py-8 text-center text-sm">
      {children}
    </CommandPrimitive.Empty>
  )
}

export function CommandGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <CommandPrimitive.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs"
    >
      {children}
    </CommandPrimitive.Group>
  )
}

export function CommandItem({
  value,
  onSelect,
  children,
  keywords,
}: {
  /** What cmdk matches against, and what keyboard selection identifies. Unique per item. */
  value: string
  onSelect: () => void
  children: ReactNode
  keywords?: readonly string[]
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      keywords={keywords === undefined ? undefined : [...keywords]}
      onSelect={onSelect}
      className="data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none"
    >
      {children}
    </CommandPrimitive.Item>
  )
}
