'use client'

import * as React from 'react'
import { cn } from '@/lib/utils.ts'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { Button } from '@/ui/button.tsx'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

/**
 * The dialog's own content node, published so a popover opened *inside* a dialog can portal into it
 * rather than into `document.body`.
 *
 * This is not cosmetic. Radix's Dialog locks scrolling with `react-remove-scroll`, which allows
 * wheel events only inside its own subtree. A popover portalled to the body is outside that subtree,
 * so its list scrolls in the DOM and refuses to scroll under the mouse — which is exactly what the
 * twelve-item type picker did: visible, scrollable, and immovable. Reported by Simon, 2026-09-04.
 */
const DialogContainerContext = React.createContext<HTMLElement | null>(null)

export function useDialogContainer(): HTMLElement | null {
  return React.useContext(DialogContainerContext)
}

/**
 * Gives focus back to whatever opened the dialog.
 *
 * Radix restores focus to a `DialogTrigger`, and **not one dialog in this app has one** — every one
 * of them is opened from controlled state, because the same dialog is reached from a button, a menu
 * item, a table row and the ⌘K palette. Measured on the built app: after Escape,
 * `document.activeElement` was `<body>` for the activity dialog and for the ⌘K palette, so a
 * keyboard user closing a dialog was returned to the top of the page every time.
 *
 * The opener cannot be read when the dialog mounts. Radix's own `onOpenAutoFocus` never fires for a
 * dialog whose first control carries `autoFocus` — React has already focused it, so Radix sees a
 * focused candidate inside the container and skips the whole step, which is also *why* its own
 * restore lands on the body. So focus is remembered at the document instead, and on close the
 * dialog asks for the most recent element that is still on the page and is not inside itself.
 *
 * That answer is right for the cases a simpler one gets wrong: a dialog opened from a dropdown item
 * that unmounted with its menu goes back to the menu's trigger, and a dialog opened from inside
 * another dialog goes back into that one rather than out to the page behind it.
 */
const FOCUS_HISTORY_LIMIT = 10

const focusHistory: HTMLElement[] = []

function rememberFocus(event: FocusEvent): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const seen = focusHistory.indexOf(target)
  if (seen !== -1) focusHistory.splice(seen, 1)
  focusHistory.push(target)
  if (focusHistory.length > FOCUS_HISTORY_LIMIT) focusHistory.shift()
}

let listening = false

function startRememberingFocus(): void {
  if (listening) return
  // Capture phase: `focusin` bubbles, but a listener inside a focus trap could stop it first.
  document.addEventListener('focusin', rememberFocus, true)
  listening = true
}

function lastFocusOutside(container: HTMLElement | null): HTMLElement | null {
  for (let index = focusHistory.length - 1; index >= 0; index -= 1) {
    const element = focusHistory[index]
    if (element === undefined || !element.isConnected) continue
    if (container !== null && container.contains(element)) continue
    return element
  }
  return null
}

export function useRestoreFocusOnClose(
  container: HTMLElement | null,
  onCloseAutoFocus?: (event: Event) => void,
): (event: Event) => void {
  React.useEffect(startRememberingFocus, [])

  return (event: Event) => {
    onCloseAutoFocus?.(event)
    // A dialog that knows better — `AddRecordDialog` holds a ref to its own trigger — wins.
    if (event.defaultPrevented) return

    const target = lastFocusOutside(container)
    if (target === null) return

    event.preventDefault()
    target.focus()
  }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  const restoreFocus = useRestoreFocusOnClose(container, onCloseAutoFocus)

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setContainer}
        onCloseAutoFocus={restoreFocus}
        data-slot="dialog-content"
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        <DialogContainerContext.Provider value={container}>
          {children}
        </DialogContainerContext.Provider>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
