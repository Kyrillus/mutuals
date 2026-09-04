import type { ReactNode } from 'react'

import { useSidebar } from '@/hooks/use-sidebar.ts'

import { Sidebar } from './sidebar.tsx'
import { TopBar } from './top-bar.tsx'

/**
 * The frame every page renders inside (§5.1): sidebar, top bar, and a content column capped at
 * ~1200px. Only `main` scrolls, so the sidebar and the breadcrumb stay put on a 10k-row table.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { collapsed, toggle, expand } = useSidebar()

  return (
    <div className="flex h-full min-h-0">
      {/*
        Seven sidebar stops sit before the content on every page, and on the contacts table the
        content itself is 200 rows of checkbox-and-link before anything after it. Without this a
        keyboard user pays that toll on every navigation. Visible only when focused, which is why
        it reads as nothing at all to everyone else.
      */}
      <a
        href="#main"
        className="bg-background text-foreground ring-ring sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:ring-2"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} onExpand={expand} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* `tabIndex={-1}` so the skip link can actually put focus here; without it the jump moves
            the scroll position and leaves focus behind in the sidebar. */}
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="mx-auto w-full max-w-content px-10 py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
