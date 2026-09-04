import { DownloadIcon, Trash2Icon, XIcon } from 'lucide-react'
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

/**
 * §5.2's bulk action bar.
 *
 * It floats over the footer rather than pushing the table up, so selecting a row never moves the
 * row under the pointer. §5.4's confirmation states the consequence in numbers before anything is
 * deleted.
 */
export function SelectionBar({
  count,
  noun,
  busy,
  onExport,
  onDelete,
  onClear,
}: {
  count: number
  /** Singular, lower case: "contact". The plural is the same word with an "s". */
  noun: string
  busy: boolean
  onExport: () => void
  onDelete: () => void
  onClear: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  if (count === 0) return null
  const subject = `${count.toLocaleString('en-GB')} ${noun}${count === 1 ? '' : 's'}`

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
        <div className="bg-popover text-popover-foreground pointer-events-auto flex items-center gap-1 rounded-lg border px-2 py-1.5 shadow-lg">
          <span className="px-2 text-sm font-medium tabular-nums">{subject} selected</span>
          <Button variant="ghost" size="sm" onClick={onExport} className="gap-1.5">
            <DownloadIcon />
            Export CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive gap-1.5"
            onClick={() => {
              setConfirming(true)
            }}
          >
            <Trash2Icon />
            Delete
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection">
            <XIcon />
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {subject}?</DialogTitle>
            <DialogDescription>
              This will delete {subject} and everything attached to them — interactions, follow-ups
              and the value history behind every field. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                onDelete()
              }}
            >
              Delete {subject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
