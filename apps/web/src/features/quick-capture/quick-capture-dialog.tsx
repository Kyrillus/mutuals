/**
 * §4.8's quick capture and §6.10's confirm, as one dialog with two states.
 *
 * Type → preview → confirm. The preview is editable, every card can be switched off, and **nothing
 * has been written** while it is on screen — the server said so and this component's only write is
 * the Save button.
 *
 * §6.10 asks that the preview "make clear which records are new and which are matched existing
 * (with a way to change the match)". That is the `New` / `Matched` toggle on the contact and
 * organization cards: matched shows the record it would attach to and lets the user pick a
 * different candidate or create a new record instead. A capture that silently attached a meeting to
 * the wrong Anna would be worse than one that asked.
 */
import type {
  CommitQuickCaptureResponse,
  QuickCaptureResponse,
  CaptureRecord,
  CaptureField,
} from '@mutuals/core'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { ApiError } from '@/lib/api.ts'
import { cn } from '@/lib/utils.ts'
import { Button } from '@/ui/button.tsx'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog.tsx'
import { Input } from '@/ui/input.tsx'

import { useCommitCapture, useQuickCapture } from './use-quick-capture.ts'

/** §4.8's own example, as the placeholder — it is the fastest way to explain what to type. */
const PLACEHOLDER =
  'Met Anna Berger from Northstar Ventures at Bits & Pretzels, she’s looking for climate-tech seed deals, follow up in 3 weeks'

/** Below this the field is shown with a marker: the model said it was guessing. */
const UNSURE = 0.6

type Draft = {
  contact: CaptureRecord | null
  organization: CaptureRecord | null
  interaction: QuickCaptureResponse['interaction']
  followUp: QuickCaptureResponse['followUp']
  note: string | null
}

type Keep = { contact: boolean; organization: boolean; interaction: boolean; followUp: boolean }

export function QuickCaptureDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [keep, setKeep] = useState<Keep>({
    contact: true,
    organization: true,
    interaction: true,
    followUp: true,
  })

  const capture = useQuickCapture()
  const commit = useCommitCapture()
  const navigate = useNavigate()

  const close = (): void => {
    onOpenChange(false)
    // Reset after the close animation rather than during it, so the dialog does not blank out
    // under the fade.
    setTimeout(() => {
      setText('')
      setDraft(null)
      capture.reset()
      commit.reset()
      setKeep({ contact: true, organization: true, interaction: true, followUp: true })
    }, 200)
  }

  const propose = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    capture.mutate(
      { text: trimmed },
      {
        onSuccess: (preview) => {
          setDraft(preview)
          setKeep({
            contact: preview.contact !== null,
            organization: preview.organization !== null,
            interaction: preview.interaction !== null,
            followUp: preview.followUp !== null,
          })
        },
      },
    )
  }

  const save = (): void => {
    if (draft === null) return
    commit.mutate(
      {
        contact: keep.contact && draft.contact !== null ? toCommit(draft.contact) : null,
        organization:
          keep.organization && draft.organization !== null ? toCommit(draft.organization) : null,
        interaction: keep.interaction ? draft.interaction : null,
        followUp: keep.followUp && keep.contact ? draft.followUp : null,
      },
      {
        onSuccess: (result: CommitQuickCaptureResponse) => {
          toast.success(saved(result))
          const contact = result.contact
          close()
          if (contact !== null) {
            void navigate({ to: '/contacts/$id', params: { id: contact.id } })
          }
        },
        onError: (error: Error) => {
          toast.error(error instanceof ApiError ? error.message : 'Could not save the capture.')
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Quick capture
          </DialogTitle>
        </DialogHeader>

        {draft === null ? (
          <div className="flex flex-col gap-3">
            <label className="text-muted-foreground text-sm" htmlFor="quick-capture-text">
              Type what happened. Nothing is saved until you confirm.
            </label>
            <textarea
              id="quick-capture-text"
              autoFocus
              rows={4}
              value={text}
              placeholder={PLACEHOLDER}
              onChange={(event) => {
                setText(event.target.value)
              }}
              onKeyDown={(event) => {
                // ⌘↵ from the textarea, because Enter inside it has to mean a newline.
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  propose()
                }
              }}
              className="border-input bg-background focus-visible:border-ring min-h-24 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
            />
            {capture.error !== null && (
              <p className="text-destructive text-sm" role="alert">
                {capture.error.message}
              </p>
            )}
          </div>
        ) : (
          <Preview
            draft={draft}
            keep={keep}
            onKeep={(next) => {
              setKeep({ ...keep, ...next })
            }}
            onDraft={setDraft}
          />
        )}

        <DialogFooter>
          {draft === null ? (
            <Button onClick={propose} disabled={text.trim() === '' || capture.isPending}>
              {capture.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {capture.isPending ? 'Reading…' : 'Preview'}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(null)
                }}
              >
                Back
              </Button>
              <Button onClick={save} disabled={commit.isPending || nothingKept(draft, keep)}>
                {commit.isPending && <Loader2 className="size-3.5 animate-spin" />}
                Save
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Preview({
  draft,
  keep,
  onKeep,
  onDraft,
}: {
  draft: Draft
  keep: Keep
  onKeep: (next: Partial<Keep>) => void
  onDraft: (next: Draft) => void
}) {
  return (
    <div
      className="flex max-h-[26rem] flex-col gap-3 overflow-y-auto pr-1"
      data-testid="capture-preview"
    >
      {draft.contact !== null && (
        <RecordCard
          title="Contact"
          record={draft.contact}
          kept={keep.contact}
          onKept={(next) => {
            onKeep({ contact: next, ...(next ? {} : { followUp: false }) })
          }}
          onChange={(next) => {
            onDraft({ ...draft, contact: next })
          }}
        />
      )}

      {draft.organization !== null && (
        <RecordCard
          title="Organization"
          record={draft.organization}
          kept={keep.organization}
          onKept={(next) => {
            onKeep({ organization: next })
          }}
          onChange={(next) => {
            onDraft({ ...draft, organization: next })
          }}
        />
      )}

      {draft.interaction !== null && (
        <Card
          title="Interaction"
          badge={draft.interaction.type}
          kept={keep.interaction}
          onKept={(next) => {
            onKeep({ interaction: next })
          }}
        >
          <Field
            label="Title"
            value={draft.interaction.title}
            onChange={(value) => {
              onDraft({
                ...draft,
                interaction:
                  draft.interaction === null ? null : { ...draft.interaction, title: value },
              })
            }}
          />
          {draft.interaction.body !== null && (
            <p className="text-muted-foreground px-1 text-xs">{draft.interaction.body}</p>
          )}
          <p className="text-muted-foreground px-1 text-xs">
            {draft.interaction.occurredAt.slice(0, 10)}
          </p>
        </Card>
      )}

      {draft.followUp !== null && (
        <Card
          title="Follow-up"
          badge={`due ${draft.followUp.dueAt}`}
          kept={keep.followUp && keep.contact}
          disabled={!keep.contact}
          disabledReason="A follow-up needs the contact."
          onKept={(next) => {
            onKeep({ followUp: next })
          }}
        >
          <Field
            label="Title"
            value={draft.followUp.title}
            onChange={(value) => {
              onDraft({
                ...draft,
                followUp: draft.followUp === null ? null : { ...draft.followUp, title: value },
              })
            }}
          />
        </Card>
      )}

      {draft.note !== null && (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
          {draft.note}
        </p>
      )}
    </div>
  )
}

function RecordCard({
  title,
  record,
  kept,
  onKept,
  onChange,
}: {
  title: string
  record: CaptureRecord
  kept: boolean
  onKept: (next: boolean) => void
  onChange: (next: CaptureRecord) => void
}) {
  const matched = record.action === 'match'
  const current = record.candidates.find((candidate) => candidate.id === record.matchId)

  return (
    <Card
      title={title}
      badge={matched ? 'Matched' : 'New'}
      badgeTone={matched ? 'matched' : 'new'}
      kept={kept}
      onKept={onKept}
    >
      <p className="px-1 text-sm font-medium">{record.displayName}</p>

      {record.candidates.length > 0 && (
        <div className="flex flex-col gap-1 px-1">
          {/*
            §6.10's "with a way to change the match". Radio-shaped rather than a dropdown, because
            the decision is between two or three named people and burying it costs more than the
            three lines it takes.
          */}
          <Choice
            label={`Create a new ${title.toLowerCase()}`}
            selected={!matched}
            onSelect={() => {
              onChange({ ...record, action: 'create', matchId: null })
            }}
          />
          {record.candidates.map((candidate) => (
            <Choice
              key={candidate.id}
              label={candidate.displayName}
              hint={candidate.evidence}
              selected={matched && record.matchId === candidate.id}
              onSelect={() => {
                onChange({ ...record, action: 'match', matchId: candidate.id })
              }}
            />
          ))}
        </div>
      )}

      {matched && current !== undefined && (
        <p className="text-muted-foreground px-1 text-xs">
          The fields below are added to {current.displayName}.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {record.fields.map((field, index) => (
          <Field
            key={field.slug + String(index)}
            label={field.label}
            value={field.value}
            unsure={field.confidence < UNSURE}
            onChange={(value) => {
              onChange({ ...record, fields: replace(record.fields, index, value) })
            }}
          />
        ))}
      </div>
    </Card>
  )
}

function Choice({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string
  hint?: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs',
        selected ? 'border-ring bg-accent/40' : 'border-border hover:bg-accent/20',
      )}
    >
      <span
        className={cn(
          'size-2.5 shrink-0 rounded-full border',
          selected ? 'border-ring bg-primary' : 'border-muted-foreground/50',
        )}
      />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {hint !== undefined && (
        <span className="text-muted-foreground min-w-0 max-w-[55%] truncate">{hint}</span>
      )}
    </button>
  )
}

function Card({
  title,
  badge,
  badgeTone = 'plain',
  kept,
  onKept,
  disabled = false,
  disabledReason,
  children,
}: {
  title: string
  badge?: string
  badgeTone?: 'new' | 'matched' | 'plain'
  kept: boolean
  onKept: (next: boolean) => void
  disabled?: boolean
  disabledReason?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'border-border rounded-lg border p-3',
        !kept && 'opacity-50',
        disabled && 'pointer-events-none',
      )}
    >
      <header className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={kept}
          disabled={disabled}
          aria-label={`Save the ${title.toLowerCase()}`}
          onChange={(event) => {
            onKept(event.target.checked)
          }}
          className="size-3.5"
        />
        <h4 className="text-sm font-medium">{title}</h4>
        {badge !== undefined && (
          <span
            className={cn(
              'rounded-full border px-1.5 py-px text-[0.7rem]',
              badgeTone === 'matched' && 'border-ring text-foreground',
              badgeTone === 'plain' && 'text-muted-foreground',
            )}
          >
            {badge}
          </span>
        )}
        {disabled && disabledReason !== undefined && (
          <span className="text-muted-foreground text-xs">{disabledReason}</span>
        )}
      </header>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

function Field({
  label,
  value,
  unsure = false,
  onChange,
}: {
  label: string
  value: string
  unsure?: boolean
  onChange: (next: string) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-28 shrink-0 truncate">{label}</span>
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        className="h-7 flex-1 text-xs"
      />
      {/* The model said it was guessing. Not an error — a hint about where to look first. */}
      {unsure && <span className="text-muted-foreground shrink-0 text-[0.7rem]">unsure</span>}
    </label>
  )
}

function replace(fields: readonly CaptureField[], index: number, value: string): CaptureField[] {
  return fields.map((field, at) => (at === index ? { ...field, value } : field))
}

function toCommit(record: CaptureRecord): {
  action: 'create' | 'match'
  matchId: string | null
  fields: { slug: string; value: string }[]
} {
  return {
    action: record.action,
    matchId: record.matchId,
    fields: record.fields
      .filter((field) => field.value.trim() !== '')
      .map((field) => ({ slug: field.slug, value: field.value })),
  }
}

function nothingKept(draft: Draft, keep: Keep): boolean {
  return (
    !(keep.contact && draft.contact !== null) &&
    !(keep.organization && draft.organization !== null) &&
    !(keep.interaction && draft.interaction !== null) &&
    !(keep.followUp && draft.followUp !== null)
  )
}

function saved(result: CommitQuickCaptureResponse): string {
  if (result.created.length === 0) return 'Nothing new to save.'
  const names: Record<string, string> = {
    contact: 'contact',
    organization: 'organization',
    interaction: 'interaction',
    followUp: 'follow-up',
  }
  const parts = result.created.map((one) => names[one] ?? one)
  return `Saved ${parts.join(', ')}.`
}
