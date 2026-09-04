/**
 * §5.4's confirmation for §6.7's delete, stated in numbers.
 *
 * The numbers come from `previewDeleteAttributeDefinition`, one request per attribute, and the
 * Delete button does not exist until they have arrived: a dialog that says "this may affect some
 * contacts" is the vague warning §5.4 was written to forbid, and a count guessed from a stale
 * list would be worse than none. If the preview fails, the dialog says so and refuses to delete.
 *
 * The sentence itself is the API's (`preview.message`) rather than one assembled here. The server
 * already knows whether the noun is "contacts" or "organization records", and one wording that
 * two places could disagree about is one wording too many.
 */
import { AlertTriangleIcon, LockIcon } from 'lucide-react'

import { Button } from '@/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { useDeletePreviews, type DeletePreview } from './attribute-api.ts'

export interface DeleteAttributeDialogProps {
  /** The attributes the user asked to delete. Kept while the dialog animates out. */
  readonly ids: readonly string[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: (ids: readonly string[]) => void
  readonly isDeleting: boolean
}

export function DeleteAttributeDialog({
  ids,
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteAttributeDialogProps) {
  const previews = useDeletePreviews(ids, open)
  const loaded = previews.data ?? []
  const deletable = loaded.filter((preview) => !preview.isSystem)
  const locked = loaded.filter((preview) => preview.isSystem)
  const ready = previews.isSuccess && deletable.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title(loaded, ids.length)}</DialogTitle>
          <DialogDescription>
            Deleting a field deletes every value of it and the history behind those values. It
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {previews.isPending && (
          <div className="space-y-2" aria-label="Counting the values that would be deleted">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}

        {previews.isError && (
          <p className="text-destructive text-sm">
            The number of affected records could not be read: {previews.error.message}. Nothing has
            been deleted — close this and try again.
          </p>
        )}

        {previews.isSuccess && (
          <div className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              {deletable.map((preview) => (
                <li key={preview.id} className="flex gap-2">
                  <AlertTriangleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
                  <span>{preview.message}</span>
                </li>
              ))}
            </ul>

            {locked.length > 0 && (
              <p className="text-muted-foreground flex gap-2">
                <LockIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {locked.map((preview) => `“${preview.title}”`).join(', ')}{' '}
                  {locked.length === 1 ? 'is a built-in field and stays' : 'are built-in and stay'}.
                </span>
              </p>
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
          <Button
            variant="destructive"
            disabled={!ready || isDeleting}
            onClick={() => {
              onConfirm(deletable.map((preview) => preview.id))
            }}
          >
            {deleteLabel(deletable.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The name while it is known, the count while it is not — the dialog must not open blank. */
function title(previews: readonly DeletePreview[], requested: number): string {
  const first = previews[0]
  if (previews.length === 1 && first !== undefined) return `Delete “${first.title}”?`
  const count = previews.length === 0 ? requested : previews.length
  return count === 1 ? 'Delete this attribute?' : `Delete ${String(count)} attributes?`
}

function deleteLabel(count: number): string {
  if (count <= 1) return 'Delete attribute'
  return `Delete ${String(count)} attributes`
}
