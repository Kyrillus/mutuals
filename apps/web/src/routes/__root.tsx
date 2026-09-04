import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { Compass } from 'lucide-react'

import { AppShell } from '@/components/app-shell/app-shell.tsx'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { Toaster } from '@/ui/sonner.tsx'

/**
 * The router carries the query client in its context so a Stage-3 route loader can prefetch into
 * the same cache the components read. Without it a loader would have to import the singleton, and
 * tests would have no seam to put a fresh client in.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: RouteNotFound,
})

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
      <Toaster position="bottom-right" />
    </AppShell>
  )
}

function RouteNotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="This page does not exist"
      description="The link may be from a later stage of the build, or simply mistyped. Use the sidebar to get back."
    />
  )
}
