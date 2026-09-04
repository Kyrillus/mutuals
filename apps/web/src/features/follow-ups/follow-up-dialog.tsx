/**
 * §6.4's create/edit dialog: title, contact, due date with shortcuts, recurrence, notes.
 *
 * The due-date shortcuts add to **today**, which comes from the display context rather than from
 * `new Date()` — ADR-091's rule, and the reason "in 1 month" means the same thing here as the
 * server's idea of overdue does at midnight.
 */
import { addDays, addMonths, civil, isCivilDate, type Recurrence } from '@mutuals/core'
import { useEffect, useState } from 'react'

import { useDisplay } from '@/attributes/display-context.tsx'
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

import { ContactPicker, type PickedContact } from './contact-picker.tsx'
import { choiceOf, RECURRENCE_CHOICES } from './recurrence-label.ts'
import { useCreateFollowUp, useUpdateFollowUp } from './use-follow-ups.ts'
import type { FollowUp } from '@mutuals/core'

export function FollowUpDialog({
  open,
  onOpenChange,
  editing,
  fixedContact,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing?: FollowUp | null
  /** Set when the dialog is opened from a contact's own page: the picker is then not a question. */
  fixedContact?: PickedContact
}) {
  const { today } = useDisplay()
  const create = useCreateFollowUp()
  const update = useUpdateFollowUp()

  const [title, setTitle] = useState('')
  const [contact, setContact] = useState<PickedContact | null>(null)
  const [dueAt, setDueAt] = useState(today)
  const [choice, setChoice] = useState('none')
  const [notes, setNotes] = useState('')
  const [showErrors, setShowErrors] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(editing?.title ?? '')
    setContact(
      editing !== null && editing !== undefined
        ? { id: editing.contact.id, displayName: editing.contact.displayName }
        : (fixedContact ?? null),
    )
    // `CivilDateSchema` is `z.iso.date()`, so the wire hands back a plain string; `civil` is
    // the one place a string becomes the branded type the date helpers take.
    setDueAt(editing === null || editing === undefined ? today : civil(editing.dueAt))
    setChoice(choiceOf(editing?.recurrence ?? null))
    setNotes(editing?.notes ?? '')
    setShowErrors(false)
  }, [open, editing, fixedContact, today])

  const busy = create.isPending || update.isPending
  const titleMissing = title.trim() === ''
  const contactMissing = contact === null

  function ruleFor(value: string): Recurrence | null {
    return RECURRENCE_CHOICES.find((entry) => entry.value === value)?.rule ?? null
  }

  function save() {
    if (titleMissing || contactMissing) {
      setShowErrors(true)
      return
    }

    const done = {
      onSuccess: () => {
        onOpenChange(false)
      },
    }

    if (editing != null) {
      update.mutate(
        {
          id: editing.id,
          body: {
            title: title.trim(),
            contactId: contact.id,
            dueAt,
            notes: notes.trim() === '' ? null : notes.trim(),
            // `choice === 'custom'` means the rule came from outside this picker; leaving it out
            // keeps it rather than flattening it to the nearest offered option.
            ...(choice === 'custom' ? {} : { recurrence: ruleFor(choice) }),
          },
        },
        done,
      )
      return
    }

    create.mutate(
      {
        title: title.trim(),
        contactId: contact.id,
        dueAt,
        recurrence: ruleFor(choice),
        notes: notes.trim() === '' ? null : notes.trim(),
      },
      done,
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing != null ? 'Edit follow-up' : 'Create follow-up'}</DialogTitle>
          <DialogDescription>
            Fields marked * are required. A repeating follow-up schedules its next occurrence the
            moment you mark this one done.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Title <span className="text-destructive">*</span>
            </span>
            <Input
              value={title}
              autoFocus
              placeholder="Send the deck"
              aria-invalid={showErrors && titleMissing}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Contact <span className="text-destructive">*</span>
            </span>
            <ContactPicker
              value={contact}
              onChange={setContact}
              invalid={showErrors && contactMissing}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Due <span className="text-destructive">*</span>
              </span>
              <Input
                type="date"
                value={dueAt}
                onChange={(event) => {
                  // A half-typed date input reports "" and "2026-0"; only a whole one is a date.
                  const next = event.target.value
                  if (isCivilDate(next)) setDueAt(next)
                }}
              />
            </label>
            <div className="flex gap-1.5">
              {[
                { label: 'In 1 week', date: addDays(today, 7) },
                { label: 'In 1 month', date: addMonths(today, 1) },
                { label: 'In 3 months', date: addMonths(today, 3) },
              ].map((shortcut) => (
                <Button
                  key={shortcut.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDueAt(shortcut.date)
                  }}
                >
                  {shortcut.label}
                </Button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Repeats</span>
            <select
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value)
              }}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              {choice === 'custom' && <option value="custom">Custom (kept as it is)</option>}
              {RECURRENCE_CHOICES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Notes</span>
            <textarea
              value={notes}
              rows={3}
              onChange={(event) => {
                setNotes(event.target.value)
              }}
              className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? 'Saving…' : editing != null ? 'Save follow-up' : 'Create follow-up'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
