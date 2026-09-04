import { Search } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils.ts'

const SHORTCUT_LABEL = navigatorIsApple() ? '⌘K' : 'Ctrl K'

function navigatorIsApple(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
}

/**
 * §5.1's search sits directly under the workspace name. The ⌘K palette is Stage 6 (§6.10), so what
 * exists now is the box itself and its shortcut: the key already goes somewhere, and when the
 * palette lands it replaces the focus handler rather than introducing a control nobody has learnt.
 */
export function GlobalSearch({
  collapsed,
  onExpand,
}: {
  collapsed: boolean
  onExpand: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      // Collapsed, there is no input to focus — so the shortcut opens the sidebar first and the
      // button takes focus, which is where the input will be on the next render.
      if (input.current === null) {
        onExpand()
        button.current?.focus()
      } else {
        input.current.focus()
        input.current.select()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onExpand])

  if (collapsed) {
    return (
      <button
        ref={button}
        type="button"
        onClick={onExpand}
        aria-label={`Search (${SHORTCUT_LABEL})`}
        title={`Search (${SHORTCUT_LABEL})`}
        className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-8 place-items-center rounded-md"
      >
        <Search className="size-4" />
      </button>
    )
  }

  return (
    <div className="relative">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <input
        ref={input}
        type="search"
        placeholder="Search"
        aria-label="Search records"
        className={cn(
          'border-sidebar-border bg-background text-foreground placeholder:text-muted-foreground h-8 w-full rounded-md border pr-12 pl-8 text-sm',
          'focus-visible:border-ring outline-none',
          // The browser's own clear affordance would be a second, differently styled control.
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      <kbd className="text-muted-foreground border-sidebar-border pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1 py-px font-sans text-xs">
        {SHORTCUT_LABEL}
      </kbd>
    </div>
  )
}
