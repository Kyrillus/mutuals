import { Search } from 'lucide-react'

import { usePalette } from '@/features/palette/palette-provider.tsx'
import { cn } from '@/lib/utils.ts'

const SHORTCUT_LABEL = navigatorIsApple() ? '⌘K' : 'Ctrl K'

function navigatorIsApple(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
}

/**
 * §5.1's search box, which is now a **button that opens §6.10's palette**.
 *
 * It reads as an input and it is not one. That is on purpose: the box is where people look for
 * search, and the palette is where search happens — typing into a sidebar box and then having the
 * results appear somewhere else would be two places to look. The shortcut lives in the palette
 * provider now, so the key works on every page rather than only where this component is mounted.
 *
 * `onExpand` stays in the signature: a collapsed sidebar still shows the icon, and clicking it now
 * opens the palette rather than unfolding the sidebar to reveal a box.
 */
export function GlobalSearch({
  collapsed,
  onExpand: _onExpand,
}: {
  collapsed: boolean
  onExpand: () => void
}) {
  const { openPalette } = usePalette()

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openPalette}
        aria-label={`Search (${SHORTCUT_LABEL})`}
        title={`Search (${SHORTCUT_LABEL})`}
        className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-8 place-items-center rounded-md"
      >
        <Search className="size-4" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Search records"
      className={cn(
        'border-sidebar-border bg-background text-muted-foreground relative flex h-8 w-full items-center rounded-md border pr-12 pl-8 text-left text-sm',
        'focus-visible:border-ring hover:text-foreground outline-none',
      )}
    >
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      Search
      <kbd className="text-muted-foreground border-sidebar-border pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1 py-px font-sans text-xs">
        {SHORTCUT_LABEL}
      </kbd>
    </button>
  )
}
