/**
 * `tags` — §4.2's one type where a value can be **created inline**, without a trip to Settings.
 *
 * That single sentence is what makes the control different from a multi-select: there is no option
 * table behind it, so anything typed is valid, and the suggestion list is a convenience rather
 * than the set of legal answers. Enter commits what was typed; a comma or a semicolon does the
 * same, so pasting "Energy, Biotech, Open source" produces three chips; Backspace on an empty box
 * takes the last one back.
 *
 * The suggestion list is drawn by hand rather than with cmdk because focus has to stay in the chip
 * field — a search box inside the popover would be a second place to type for a control that
 * already has one.
 */
import { Plus } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { Chip } from '@/ui/chip.tsx'

import { CONTROL_SURFACE, type AttributeInputProps } from '../input-props.ts'
import { useTagSuggestions } from '../suggestions.ts'
import { RemovableChip } from './select-controls.tsx'
import { Picker, PickerAnchor, PickerPanel } from './picker.tsx'
import { addTags, isNewTag, removeTag, suggestTags } from './tag-input-model.ts'

/** Typing one of these ends a tag, which is what makes pasting a comma-separated cell work. */
const SEPARATORS = new Set([',', ';', '|'])

export function TagInputControl({
  definition,
  value,
  onChange,
  onCommit,
  onCancel,
  error,
  errorId,
  autoFocus,
  disabled,
  id,
  className,
  ...rest
}: AttributeInputProps<'tags'> & { readonly suggestions?: readonly string[] }) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const field = useRef<HTMLInputElement>(null)

  const tags = value ?? []
  const cached = useTagSuggestions(definition, open)
  const known = rest.suggestions ?? cached
  const matches = suggestTags(known, tags, text)
  const creating = isNewTag(known, tags, text)
  const rows = creating ? [...matches, null] : matches

  function commitText(raw: string) {
    const result = addTags(tags, raw, known)
    setText('')
    setActive(0)
    if (result.added.length > 0) onChange(result.tags)
  }

  function drop(tag: string) {
    const next = removeTag(tags, tag)
    onChange(next.length === 0 ? undefined : next)
  }

  return (
    <Picker open={open && rows.length > 0} onOpenChange={setOpen}>
      <PickerAnchor asChild>
        <div
          className={cn(
            CONTROL_SURFACE,
            'flex min-h-8 flex-wrap items-center gap-1 px-1.5 py-1',
            'focus-within:border-ring focus-within:ring-ring/80 focus-within:ring-[3px]',
            className,
          )}
          onClick={() => {
            field.current?.focus()
          }}
        >
          {tags.map((tag) => (
            <RemovableChip
              key={tag}
              label={tag}
              onRemove={() => {
                drop(tag)
              }}
            />
          ))}
          <input
            ref={field}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open && rows.length > 0}
            aria-autocomplete="list"
            aria-label={rest['aria-label'] ?? definition.title}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : errorId}
            autoFocus={autoFocus}
            disabled={disabled}
            value={text}
            placeholder={tags.length === 0 ? 'Add a tag…' : ''}
            className="placeholder:text-muted-foreground h-5 min-w-24 flex-1 bg-transparent text-sm outline-none"
            onFocus={() => {
              setOpen(true)
            }}
            onChange={(event) => {
              const next = event.target.value
              const last = next.at(-1)
              // A separator ends the tag rather than becoming part of it.
              if (last !== undefined && SEPARATORS.has(last)) {
                commitText(next)
                return
              }
              setText(next)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (open) setOpen(false)
                else onCancel?.()
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (rows.length === 0) return
                event.preventDefault()
                setOpen(true)
                setActive(
                  (current) =>
                    (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length,
                )
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const highlighted = rows[active]
                // `null` is the "create it" row; anything else is an existing value.
                commitText(highlighted ?? text)
                return
              }
              if (event.key === 'Backspace' && text === '') {
                const last = tags.at(-1)
                if (last !== undefined) {
                  event.preventDefault()
                  drop(last)
                }
              }
            }}
            onBlur={() => {
              // Whatever is half-typed is part of the edit, not a draft to be thrown away.
              if (text.trim() !== '') commitText(text)
              setOpen(false)
              onCommit?.()
            }}
          />
        </div>
      </PickerAnchor>

      <PickerPanel>
        {matches.map((tag, index) => (
          <SuggestionRow
            key={tag}
            active={index === active}
            onPick={() => {
              commitText(tag)
              field.current?.focus()
            }}
          >
            <Chip>{tag}</Chip>
          </SuggestionRow>
        ))}
        {creating ? (
          <SuggestionRow
            active={active === rows.length - 1}
            onPick={() => {
              commitText(text)
              field.current?.focus()
            }}
          >
            <Plus className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">
              Create <span className="font-medium">{text.trim()}</span>
            </span>
          </SuggestionRow>
        ) : null}
      </PickerPanel>
    </Picker>
  )
}

function SuggestionRow({
  children,
  active,
  onPick,
}: {
  children: ReactNode
  active: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      // Blur commits, so the field must keep focus while the click completes.
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onClick={onPick}
      className={cn(
        'flex h-8 w-full items-center gap-1.5 rounded-sm px-2 text-left text-sm outline-none',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      {children}
    </button>
  )
}
