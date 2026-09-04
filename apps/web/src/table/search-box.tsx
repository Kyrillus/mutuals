import { SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Input } from '@/ui/input.tsx'

/**
 * §5.2's quick substring search.
 *
 * `q` lives in the URL like every other part of the view, but a keystroke must not be a history
 * entry or a request, so the box holds its own text and pushes it after a pause. The URL is still
 * the truth: when it changes from anywhere else — a saved view, the back button — the box follows.
 *
 * The delay is deliberately longer than a typing pause and shorter than a thought.
 */
const DEBOUNCE_MS = 300

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string | null
  onChange: (next: string | null) => void
  placeholder: string
}) {
  const [text, setText] = useState(value ?? '')
  const committed = useRef(value ?? '')

  useEffect(() => {
    const next = value ?? ''
    if (next !== committed.current) {
      committed.current = next
      setText(next)
    }
  }, [value])

  useEffect(() => {
    if (text === committed.current) return
    const timer = setTimeout(() => {
      committed.current = text
      onChange(text.trim() === '' ? null : text)
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [text, onChange])

  return (
    <div className="relative">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          setText('')
          committed.current = ''
          onChange(null)
        }}
        className="h-8 w-56 pr-8 pl-8"
      />
      {text !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          onClick={() => {
            setText('')
            committed.current = ''
            onChange(null)
          }}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
