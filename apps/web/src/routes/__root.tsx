import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { Compass, PlugZap } from 'lucide-react'

import { AppShell } from '@/components/app-shell/app-shell.tsx'
import { EmptyState } from '@/components/app-shell/page.tsx'
import { NetworkError } from '@/lib/api.ts'
import { Button } from '@/ui/button.tsx'
import { Toaster } from '@/ui/sonner.tsx'

/**
 * The router carries the query client in its context so a Stage-3 route loader can prefetch into
 * the same cache the components read. Without it a loader would have to import the singleton, and
 * tests would have no seam to put a fresh client in.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: RouteNotFound,
  errorComponent: RouteError,
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

/**
 * What a page shows when its loader threw — in practice, when the API is not answering.
 *
 * The router's stock error component is an unstyled `Something went wrong!` with a stack trace
 * underneath, which is the right default for a library and the wrong one for the screen a person
 * meets when they left the server off. `invalidate()` re-runs the loader without a full reload, so
 * "Try again" costs one request rather than a whole boot.
 */
function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const unreachable = error instanceof NetworkError

  return (
    <EmptyState
      icon={PlugZap}
      title={unreachable ? 'The app cannot reach its server' : 'This page could not be loaded'}
      description={
        unreachable
          ? `${error.message} Mutuals keeps everything in a database on this machine, so nothing is lost — start the server and try again.`
          : error.message
      }
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void router.invalidate()
        }}
      >
        Try again
      </Button>
    </EmptyState>
  )
}
