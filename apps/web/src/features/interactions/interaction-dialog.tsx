/**
 * Log or edit one interaction (§6.5).
 *
 * The date control is a plain `datetime-local`: an interaction has a *time*, not just a day, and
 * the attribute registry's date control is civil-date only by design. The value is converted
 * through the profile's timezone rather than the browser's, so logging a call at 23:30 from a
 * laptop set to UTC does not file it on the wrong day.
 *
 * `recordId` is optional so §6.10's palette can open this with nobody chosen. An interaction
 * belongs to somebody (§4.1), so without one the dialog asks — through the same `ContactPicker` the
 * follow-up dialog uses, rather than a second search box that behaves almost the same.
 */
import { INTERACTION_TYPES, type Interaction, type InteractionType } from '@mutuals/core'
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

import { ContactPicker, type PickedContact } from '@/features/follow-ups/contact-picker.tsx'

import { useCreateInteraction, useUpdateInteraction } from './use-interactions.ts'

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the *displayed* zone, not an ISO instant. */
function toLocalInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export function InteractionDialog({
  open,
  onOpenChange,
  recordId,
  contactId,
  organizationId,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whose timeline to invalidate. Absent when the dialog is opened without a record in hand. */
  recordId?: string
  contactId?: string
  organizationId?: string
  editing?: Interaction | null
}) {
  const { timeZone } = useDisplay()
  const [picked, setPicked] = useState<PickedContact | null>(null)

  // Whichever contact this is about: the one the caller fixed, or the one just chosen.
  const subjectId = recordId ?? picked?.id
  const create = useCreateInteraction(subjectId ?? '')
  const update = useUpdateInteraction(subjectId ?? '')

  const [type, setType] = useState<InteractionType>('Meeting')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [when, setWhen] = useState(() => toLocalInput(new Date().toISOString(), timeZone))

  // Refill when the dialog opens, so editing a second row does not show the first row's draft.
  useEffect(() => {
    if (!open) return
    setType(editing?.type ?? 'Meeting')
    setTitle(editing?.title ?? '')
    setBody(editing?.body ?? '')
    setWhen(toLocalInput(editing?.occurredAt ?? new Date().toISOString(), timeZone))
    setPicked(null)
  }, [open, editing, timeZone])

  const busy = create.isPending || update.isPending

  function save() {
    // `datetime-local` has no zone; the browser reads it as local time, which is what a person
    // typing into it means.
    const occurredAt = new Date(when).toISOString()
    const payload = {
      type,
      occurredAt,
      title: title.trim() === '' ? null : title.trim(),
      body: body.trim() === '' ? null : body.trim(),
    }

    if (editing != null) {
      update.mutate(
        { id: editing.id, body: payload },
        {
          onSuccess: () => {
            onOpenChange(false)
          },
        },
      )
      return
    }

    const participant = contactId ?? picked?.id
    create.mutate(
      {
        ...payload,
        ...(participant === undefined ? {} : { contactIds: [participant] }),
        ...(organizationId === undefined ? {} : { organizationIds: [organizationId] }),
      },
      {
        onSuccess: () => {
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing != null ? 'Edit activity' : 'Log an activity'}</DialogTitle>
          <DialogDescription>
            What happened, and when. This is what warmth (§4.7) is computed from.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {recordId === undefined && editing == null && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Contact</span>
              <ContactPicker value={picked} onChange={setPicked} />
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Type</span>
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value as InteractionType)
              }}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              {INTERACTION_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">When</span>
            <Input
              type="datetime-local"
              value={when}
              onChange={(event) => {
                setWhen(event.target.value)
              }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <Input
              value={title}
              placeholder="Coffee at Bits & Pretzels"
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Notes</span>
            <textarea
              value={body}
              rows={4}
              placeholder="What was said, what they need, what you promised."
              onChange={(event) => {
                setBody(event.target.value)
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
          <Button disabled={busy || subjectId === undefined} onClick={save}>
            {busy ? 'Saving…' : editing != null ? 'Save activity' : 'Log activity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
