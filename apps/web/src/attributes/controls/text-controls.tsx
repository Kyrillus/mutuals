/**
 * The six controls that are, underneath, a box you type in: `text_input`, `textarea`,
 * `number_input`, `url_input`, `email_input` and `phone_input`.
 *
 * They differ in three things and nothing else — the keyboard's shape (`inputMode`, `type`), what
 * Enter means, and whether the text has to be turned into something else before it leaves. So they
 * share one implementation and are distinguished by props, which is why adding a seventh text-ish
 * type is a line rather than a file.
 */
import { typeDef } from '@mutuals/core'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { cn } from '@/lib/utils.ts'

import { CONTROL_HEIGHT, CONTROL_SURFACE, type AttributeInputProps } from '../input-props.ts'

/** Enter commits, Escape abandons. Shift+Enter is left alone so a textarea can still wrap. */
function keyHandler(
  onCommit: (() => void) | undefined,
  onCancel: (() => void) | undefined,
  multiline: boolean,
) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel?.()
      return
    }
    if (event.key !== 'Enter') return
    // In a textarea, Enter is a newline; the commit gesture moves to the modifier, which is what
    // every comment box in the world has taught people to press.
    if (multiline && !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    onCommit?.()
  }
}

/**
 * Generic in the type rather than taking their union: `AttributeInputProps<T>` mentions `T` in both
 * a covariant and a contravariant position, which makes it invariant, so
 * `AttributeInputProps<'email'>` is not assignable to `AttributeInputProps<'email' | 'url'>` even
 * though the two are the same object. Inferring `T` per call site sidesteps that entirely.
 */
type TextLikeType = 'short_text' | 'url' | 'email' | 'phone'

function TextLike<T extends TextLikeType>({
  props,
  inputType,
  inputMode,
  autoComplete,
  className,
}: {
  props: AttributeInputProps<T>
  inputType: string
  inputMode?: 'text' | 'url' | 'email' | 'tel'
  autoComplete?: string
  className?: string
}) {
  const { value, onChange, onCommit, onCancel, error, errorId, definition } = props
  return (
    <input
      type={inputType}
      inputMode={inputMode}
      autoComplete={autoComplete}
      id={props.id}
      aria-label={props['aria-label'] ?? definition.title}
      aria-invalid={error === undefined ? undefined : true}
      aria-describedby={error === undefined ? undefined : errorId}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      value={value ?? ''}
      placeholder="Empty"
      onChange={(event) => {
        const next = event.target.value
        onChange(next === '' ? undefined : next)
      }}
      onKeyDown={keyHandler(onCommit, onCancel, false)}
      onBlur={() => {
        onCommit?.()
      }}
      className={cn(CONTROL_SURFACE, CONTROL_HEIGHT, 'px-2', className, props.className)}
    />
  )
}

export function TextControl(props: AttributeInputProps<'short_text'>) {
  return <TextLike props={props} inputType="text" inputMode="text" />
}

/** `type="url"` would let a browser reject `linkedin.com/in/anna`, which core happily accepts. */
export function UrlControl(props: AttributeInputProps<'url'>) {
  return <TextLike props={props} inputType="text" inputMode="url" autoComplete="url" />
}

export function EmailControl(props: AttributeInputProps<'email'>) {
  return <TextLike props={props} inputType="email" inputMode="email" autoComplete="email" />
}

export function PhoneControl(props: AttributeInputProps<'phone'>) {
  return (
    <TextLike
      props={props}
      inputType="tel"
      inputMode="tel"
      autoComplete="tel"
      className="tabular-nums"
    />
  )
}

/**
 * Markdown prose. Two rows by default so it still sits inside a table row when the editor opens
 * over one, and it grows to four in a dialog, where there is room.
 */
export function TextareaControl(props: AttributeInputProps<'long_text'>) {
  const { value, onChange, onCommit, onCancel, error, errorId, definition } = props
  return (
    <textarea
      id={props.id}
      rows={3}
      aria-label={props['aria-label'] ?? definition.title}
      aria-invalid={error === undefined ? undefined : true}
      aria-describedby={error === undefined ? undefined : errorId}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      value={value ?? ''}
      placeholder="Empty"
      onChange={(event) => {
        const next = event.target.value
        onChange(next === '' ? undefined : next)
      }}
      onKeyDown={keyHandler(onCommit, onCancel, true)}
      onBlur={() => {
        onCommit?.()
      }}
      className={cn(CONTROL_SURFACE, 'min-h-16 resize-y px-2 py-1.5 leading-snug', props.className)}
    />
  )
}

/**
 * A decimal, kept as text until it is understood.
 *
 * The parent's draft is only updated with a **canonical** decimal string, because that is what the
 * write path stores (ADR-039) — but the box keeps whatever was typed while it is being typed, so
 * `1.` and `1,250.5` are not rewritten under the cursor. Turning one into the other is
 * `number.coerce`, the same function the CSV importer uses, so a cell and a spreadsheet column
 * accept exactly the same spellings.
 */
export function NumberControl(props: AttributeInputProps<'number'>) {
  const { value, onChange, onCommit, onCancel, error, errorId, definition } = props
  const [text, setText] = useState(value ?? '')
  const [coercionError, setCoercionError] = useState<string | undefined>(undefined)
  const focused = useRef(false)

  // A value that changed elsewhere — an optimistic patch rolled back, another tab — has to reach
  // the box, but not while someone is typing into it.
  useEffect(() => {
    if (!focused.current) setText(value ?? '')
  }, [value])

  function apply(raw: string): boolean {
    if (raw.trim() === '') {
      setCoercionError(undefined)
      onChange(undefined)
      return true
    }
    const result = typeDef('number').coerce(raw, definition.config)
    if (!result.ok) {
      setCoercionError(result.issues[0]?.message ?? 'This is not a number.')
      return false
    }
    setCoercionError(undefined)
    onChange(result.value)
    return true
  }

  const message = error ?? coercionError

  return (
    <input
      type="text"
      inputMode="decimal"
      id={props.id}
      aria-label={props['aria-label'] ?? definition.title}
      aria-invalid={message === undefined ? undefined : true}
      aria-describedby={message === undefined ? undefined : errorId}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      value={text}
      placeholder="Empty"
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => {
        setText(event.target.value)
        apply(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel?.()
          return
        }
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (apply(text)) onCommit?.()
      }}
      onBlur={() => {
        focused.current = false
        // Committing while the text is not a number would save the last value that *was* one,
        // silently discarding the edit. The error stays on screen instead.
        if (apply(text)) onCommit?.()
      }}
      className={cn(
        CONTROL_SURFACE,
        CONTROL_HEIGHT,
        'px-2 text-right tabular-nums',
        props.className,
      )}
    />
  )
}
