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
      <Sidebar collapsed={collapsed} onToggle={toggle} onExpand={expand} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-content px-10 py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
