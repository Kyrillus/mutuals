import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { queryClient } from '@/lib/query.ts'
// Side-effect free, and imported for the `staticData.crumb` augmentation the routes rely on.
import '@/lib/route-meta.ts'
import '@/styles/globals.css'

import { routeTree } from './routeTree.gen.ts'

const router = createRouter({
  routeTree,
  // ADR-049: the server cache is one of the four state homes, so route loaders get the same client
  // the components read rather than importing the singleton behind the router's back.
  context: { queryClient },
  // `intent` prefetches on hover. Every navigation here is a sidebar link the user is already
  // pointing at, so the round trip is spent before the click rather than after it.
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('index.html has no #root element to mount into.')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
