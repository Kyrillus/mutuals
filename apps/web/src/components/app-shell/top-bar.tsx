import { Plus } from 'lucide-react'

import { usePalette } from '@/features/palette/palette-provider.tsx'
import { Button } from '@/ui/button.tsx'

import { Breadcrumbs } from './breadcrumbs.tsx'

/**
 * §5.1's top bar: the breadcrumb, and §6.10's quick-capture `+`.
 *
 * The `+` and ⌘K → "Quick capture" open the same dialog. Two ways in for one feature is deliberate
 * here rather than sloppy: the shortcut is for the person who already knows it exists, and the
 * button is how anybody else finds out.
 */
export function TopBar() {
  const { openQuickCapture } = usePalette()

  return (
    <header className="border-border bg-background flex h-topbar shrink-0 items-center gap-3 border-b px-6">
      <Breadcrumbs />
      <div className="flex-1" />
      <Button
        size="sm"
        variant="outline"
        onClick={openQuickCapture}
        aria-label="Quick capture"
        title="Quick capture"
        className="gap-1.5"
      >
        <Plus className="size-3.5" />
        Capture
      </Button>
    </header>
  )
}
