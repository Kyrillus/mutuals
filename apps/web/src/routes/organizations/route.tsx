import { createFileRoute, Outlet } from '@tanstack/react-router'

/** As `contacts/route.tsx`: the crumb every organization page sits behind. */
export const Route = createFileRoute('/organizations')({
  component: Outlet,
  staticData: { crumb: 'Organizations' },
})
